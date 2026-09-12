/**
 * The Claude Code binding, against an injected fake `query`.
 *
 * The real Agent SDK is never loaded here, let alone called: `claudeCode`
 * takes `query` as a dependency, the default is imported lazily, and every
 * test in this file supplies its own. A binding that could only be tested by
 * spawning an agent would not be a seam.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { memoryJournal } from "../core/journal.ts";
import { runStep, stepOutput, type StepDef } from "../core/step.ts";
import {
  claudeCode,
  type AgentSdkMessage,
  type AgentSdkOptions,
  type AgentSdkQuery,
} from "./claude-code.ts";

const Answer = stepOutput(["yes", "no"] as const, { anchor: z.string() });
type Answer = z.infer<typeof Answer>;

const REQ = { system: "You answer yes or no.", prompt: "Is the sky blue?", schema: Answer };
const GOOD: Answer = { decision: "yes", payload: { anchor: "the sky" } };

/** A result message carrying a structured output. */
const success = (structured_output: unknown): AgentSdkMessage => ({
  type: "result",
  subtype: "success",
  structured_output,
});

/**
 * A scripted `query`: one message script per call, in order, plus a record of
 * the prompt and options each call was handed.
 */
const scripted = (scripts: AgentSdkMessage[][]) => {
  const calls: { prompt: string; options?: AgentSdkOptions }[] = [];
  const query: AgentSdkQuery = (params) => {
    const script = scripts[calls.length] ?? scripts.at(-1) ?? [];
    calls.push({ prompt: params.prompt, options: params.options });
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of script) yield message;
      },
    };
  };
  return { calls, query };
};

const binding = (query: AgentSdkQuery, attempts = 2) =>
  claudeCode({
    agent: "nw-acceptance-designer",
    cwd: "/tmp/workspace",
    model: "sonnet",
    maxTurns: 7,
    attempts,
    query,
  });

describe("claudeCode", () => {
  test("the binding id names the agent, so a trail says which one answered", () => {
    const { query } = scripted([[success(GOOD)]]);
    expect(binding(query).id).toBe("claude-code:nw-acceptance-designer");
    expect(claudeCode({ agent: "nw-solution-architect", cwd: "/w", query }).id).toBe(
      "claude-code:nw-solution-architect",
    );
  });

  test("a well-formed reply parses, validates, and comes back typed", async () => {
    const { calls, query } = scripted([
      [{ type: "system", subtype: "init" }, { type: "assistant" }, success(GOOD)],
    ]);

    const answer = await binding(query).generate(REQ);

    expect(answer).toEqual(GOOD);
    expect(calls).toHaveLength(1);
  });

  test("the subagent, the workspace and the schema are what the SDK is handed", async () => {
    const { calls, query } = scripted([[success(GOOD)]]);
    await binding(query).generate(REQ);

    const options = calls[0]?.options;
    expect(options?.agent).toBe("nw-acceptance-designer");
    expect(options?.cwd).toBe("/tmp/workspace");
    expect(options?.model).toBe("sonnet");
    expect(options?.maxTurns).toBe(7);
    // "project" is what loads .claude/agents from cwd, so the agent resolves.
    expect(options?.settingSources).toEqual(["user", "project"]);
    expect(options?.outputFormat?.type).toBe("json_schema");
    expect(options?.outputFormat?.schema).toMatchObject({
      type: "object",
      properties: { decision: { enum: ["yes", "no"] } },
    });

    // The agent's own prompt is its system prompt, so the step's system leads
    // the turn rather than replacing the agent's.
    expect(calls[0]?.prompt).toBe(`${REQ.system}\n\n${REQ.prompt}`);
  });

  test("a reply the zod schema rejects is retried within the bound, then throws", async () => {
    // Well-formed JSON, wrong decision: the SDK's draft-07 projection is a
    // widening of the zod schema, so this is the re-parse the binding owns.
    const wrong = success({ decision: "maybe", payload: { anchor: "the sky" } });
    const { calls, query } = scripted([[wrong], [wrong]]);

    const failed = binding(query, 2).generate(REQ);
    await expect(failed).rejects.toThrow(
      /claude-code:nw-acceptance-designer produced no schema-conforming output in 2 attempts/,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.prompt).not.toContain("Your previous reply could not be used");
    // The second attempt carries what the first got wrong, verbatim.
    expect(calls[1]?.prompt).toContain("Your previous reply could not be used");
    expect(calls[1]?.prompt).toContain("did not satisfy the step's schema");
  });

  test("a malformed reply that later conforms is accepted on the retry", async () => {
    const { calls, query } = scripted([
      [success({ decision: "maybe", payload: { anchor: "the sky" } })],
      [success(GOOD)],
    ]);

    expect(await binding(query, 2).generate(REQ)).toEqual(GOOD);
    expect(calls).toHaveLength(2);
  });

  test("the SDK's own failure modes are reported rather than swallowed", async () => {
    const retriesExhausted: AgentSdkMessage = {
      type: "result",
      subtype: "error_max_structured_output_retries",
      errors: ["schema validation failed twice"],
    };
    const { query: a } = scripted([[retriesExhausted]]);
    await expect(binding(a, 1).generate(REQ)).rejects.toThrow(
      /error_max_structured_output_retries: schema validation failed twice/,
    );

    // A success carrying no structured output is a failure too; the SDK
    // documents that case and it is not the same as a schema mismatch.
    const { query: b } = scripted([[{ type: "result", subtype: "success" }]]);
    await expect(binding(b, 1).generate(REQ)).rejects.toThrow(
      /the run succeeded but carried no structured output/,
    );

    // No result message at all.
    const { query: c } = scripted([[{ type: "assistant" }]]);
    await expect(binding(c, 1).generate(REQ)).rejects.toThrow(
      /the run produced no result message/,
    );
  });

  test("a thrown stream is a reported failure, not an escaping exception", async () => {
    const query: AgentSdkQuery = () => ({
      async *[Symbol.asyncIterator]() {
        throw new Error("the CLI exited 1");
        yield { type: "result" }; // unreachable; satisfies the generator's type
      },
    });
    await expect(binding(query, 1).generate(REQ)).rejects.toThrow(/the run threw.*the CLI exited 1/s);
  });
});

describe("claudeCode inside runStep", () => {
  /** A validator that must never be reached: the worker never produces output. */
  const unreachableValidator = {
    id: "validator",
    generate: async <T,>(): Promise<T> => {
      throw new Error("the validator ran on an attempt that produced no output");
    },
  };

  test("a binding that cannot satisfy the schema becomes trail entries, not an exception", async () => {
    const { calls, query } = scripted([[success({ decision: "maybe", payload: { anchor: "x" } })]]);
    const worker = binding(query, 2);

    const def: StepDef<{ text: string }, Answer> = {
      id: "bindings.claude-code",
      version: 1,
      input: z.object({ text: z.string() }),
      output: Answer,
      requirements: [],
      worker: { model: worker, system: REQ.system, prompt: (i) => i.text },
      validator: { model: unreachableValidator },
      maxAttempts: 2,
    };

    const result = await runStep(def, { text: "Is the sky blue?" }, memoryJournal());

    expect(result.decision).toBe("validator-exhausted");
    if (result.decision !== "validator-exhausted") return;
    // Two step attempts, each spending the binding's own two-attempt bound.
    expect(result.trail).toHaveLength(2);
    expect(calls).toHaveLength(4);
    expect(result.trail.map((a) => a.model)).toEqual([
      "claude-code:nw-acceptance-designer",
      "claude-code:nw-acceptance-designer",
    ]);
    expect(result.trail.every((a) => a.error?.includes("no schema-conforming output"))).toBe(true);
    expect(result.trail.every((a) => a.output === undefined)).toBe(true);
  });
});
