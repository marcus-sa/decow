/**
 * The Claude Code binding, against an injected fake `query`.
 *
 * The real Agent SDK is never loaded here, let alone called: `claudeCode`
 * takes `query` as a dependency, the default is imported lazily, and every
 * test in this file supplies its own. A binding that could only be tested by
 * spawning an agent would not be a seam.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Effect } from "../core/effects.ts";
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

/**
 * The PROPOSAL shape: the agent edits a scratch copy, and what it changed
 * becomes effects the runner can lease, verify and roll back.
 *
 * The fake `query` here writes files into the scratch directory it is handed,
 * which is exactly what an agent with `Edit` does. That is the whole seam: the
 * binding never trusts what the turn SAYS it wrote, it reads what is there.
 */
describe("claudeCode, the proposal shape", () => {
  const Authored = stepOutput(["authored", "cannot-express"] as const, {
    reason: z.string(),
    proposal: z.array(z.custom<Effect>(() => true)).optional(),
  });
  const AUTHOR_REQ = { system: "Write the oracle.", prompt: "value 01-01", schema: Authored };

  /** A source tree with one production file and one existing test. */
  const source = () => {
    const root = mkdtempSync(join(tmpdir(), "dw-source-"));
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "src.ts"), "export const alpha = () => 1;\n", "utf8");
    writeFileSync(join(root, "test", "existing.test.ts"), "// before\n", "utf8");
    return root;
  };

  /** A `query` that edits the scratch copy it was given, then answers. */
  const writing = (edits: Record<string, string>, answer: unknown = { decision: "authored", payload: { reason: "done" } }) => {
    const calls: (AgentSdkOptions | undefined)[] = [];
    const query: AgentSdkQuery = (params) => {
      calls.push(params.options);
      const cwd = params.options?.cwd;
      if (cwd !== undefined) {
        for (const [path, body] of Object.entries(edits)) {
          mkdirSync(dirname(join(cwd, path)), { recursive: true });
          writeFileSync(join(cwd, path), body, "utf8");
        }
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield success(answer);
        },
      };
    };
    return { calls, query };
  };

  test("a file the turn created becomes a write-file effect on the payload", async () => {
    const root = source();
    const { calls, query } = writing({ "test/oracle.test.ts": "// authored\n" });
    const answer = await claudeCode({
      agent: "nw-acceptance-designer",
      cwd: root,
      query,
      proposal: { source: root, allowed: ["test"] },
    }).generate(AUTHOR_REQ);

    expect(answer.decision).toBe("authored");
    expect(answer.payload.proposal).toEqual([
      { type: "write-file", path: "test/oracle.test.ts", body: "// authored\n" },
    ]);
    // The turn ran in the SCRATCH copy, not in the source tree, and the source
    // is untouched.
    expect(calls[0]?.cwd).not.toBe(root);
    expect(existsSync(join(root, "test/oracle.test.ts"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("an existing file becomes a replace-symbol when the caller can name the symbol", async () => {
    // A symbol id is the VCS's to assign, so the binding asks rather than
    // guessing: with no port it proposes the whole file instead.
    const root = source();
    const { query } = writing({ "test/existing.test.ts": "// after\n" });
    const withPort = await claudeCode({
      agent: "nw-acceptance-designer",
      cwd: root,
      query,
      proposal: {
        source: root,
        allowed: ["test"],
        symbolFor: (change) => (change.path === "test/existing.test.ts" ? { id: "sym-7", version: 3 } : undefined),
      },
    }).generate(AUTHOR_REQ);
    expect(withPort.payload.proposal).toEqual([
      { type: "replace-symbol", symbolId: "sym-7", expectedVersion: 3, body: "// after\n" },
    ]);

    const { query: second } = writing({ "test/existing.test.ts": "// after\n" });
    const withoutPort = await claudeCode({
      agent: "nw-acceptance-designer",
      cwd: root,
      query: second,
      proposal: { source: root, allowed: ["test"] },
    }).generate(AUTHOR_REQ);
    expect(withoutPort.payload.proposal).toEqual([
      { type: "write-file", path: "test/existing.test.ts", body: "// after\n" },
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  test("a byte outside the allowed paths refuses the whole turn, before any effect", async () => {
    // Not "most of what it did". A turn that wrote where it may not proposes
    // nothing, and the refusal is what the next attempt is told.
    const root = source();
    const { query } = writing({ "test/ok.test.ts": "// fine\n", "src.ts": "export const alpha = () => 42;\n" });
    await expect(
      claudeCode({
        agent: "nw-acceptance-designer",
        cwd: root,
        attempts: 1,
        query,
        proposal: { source: root, allowed: ["test"] },
      }).generate(AUTHOR_REQ),
    ).rejects.toThrow(/src\.ts, which is outside test/);
    rmSync(root, { recursive: true, force: true });
  });

  test("a turn that changed nothing proposes nothing, and that is not an error", async () => {
    // The `cannot-express` shape: a rejecting author owns no byte.
    const root = source();
    const { query } = writing({}, { decision: "cannot-express", payload: { reason: "the port names no way to observe it" } });
    const answer = await claudeCode({
      agent: "nw-acceptance-designer",
      cwd: root,
      query,
      proposal: { source: root, allowed: ["test"] },
    }).generate(AUTHOR_REQ);

    expect(answer.decision).toBe("cannot-express");
    expect(answer.payload.proposal).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("the opaque shape is unchanged: no scratch copy, and no proposal", async () => {
    const root = source();
    const { calls, query } = writing({ "test/oracle.test.ts": "// authored\n" });
    const answer = await claudeCode({ agent: "a", cwd: root, query }).generate(AUTHOR_REQ);

    expect(calls[0]?.cwd).toBe(root);
    expect(answer.payload.proposal).toBeUndefined();
    // And the write went straight into the workspace, outside the effect
    // boundary — which is what "opaque" means and why a conflict cannot be
    // represented there.
    expect(existsSync(join(root, "test/oracle.test.ts"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the proposal diff, as the pure function it is", () => {
  test("a removal is refused rather than dropped: no effect expresses it", async () => {
    // `Effect` has no way to remove a file. A turn that deleted an oracle
    // proposed something the framework cannot commit, and saying so beats
    // committing the rest.
    const root = mkdtempSync(join(tmpdir(), "dw-source-"));
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test/gone.test.ts"), "// here\n", "utf8");
    const { query } = (() => {
      const q: AgentSdkQuery = (params) => {
        rmSync(join(params.options?.cwd ?? "", "test/gone.test.ts"), { force: true });
        return {
          async *[Symbol.asyncIterator]() {
            yield success({ decision: "authored", payload: { reason: "removed it" } });
          },
        };
      };
      return { query: q };
    })();

    await expect(
      claudeCode({
        agent: "a",
        cwd: root,
        attempts: 1,
        query,
        proposal: { source: root, allowed: ["test"] },
      }).generate({
        system: "s",
        prompt: "p",
        schema: stepOutput(["authored"] as const, {
          reason: z.string(),
          proposal: z.array(z.custom<Effect>(() => true)).optional(),
        }),
      }),
    ).rejects.toThrow(/was emptied or removed/);
    rmSync(root, { recursive: true, force: true });
  });
});
