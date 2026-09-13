/**
 * The Mastra binding, against an injected agent factory.
 *
 * No `Agent` is constructed here and no socket is opened: `mastraAgent` takes
 * the factory as a dependency, the default is the real one, and every test in
 * this file supplies its own and keeps the config it was handed. What the
 * tests are about is the config that reaches `Agent` — a router string and an
 * OpenAI-compatible endpoint both arrive UNCHANGED — and the two rules built
 * on top of it: what the binding is called, and which credential a call needs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { stepOutput } from "../core/step.ts";
import {
  mastraAgent,
  modelId,
  requiredCredential,
  type AgentFactory,
  type MastraModel,
} from "./mastra.ts";

const Answer = stepOutput(["yes", "no"] as const, { anchor: z.string() });
type Answer = z.infer<typeof Answer>;

/** Which call a binding is answering. Fixed here: this file is about the model. */
const CALL = { id: "fixture.answer", version: 1, role: "worker" as const, attempt: 1 };

const REQ = { step: CALL, system: "You answer yes or no.", prompt: "Is the sky blue?", schema: Answer };
const GOOD: Answer = { decision: "yes", payload: { anchor: "the sky" } };

/** The config `Agent` was handed, and a scripted answer in its place. */
const recorded = (object: unknown = GOOD, usage?: unknown) => {
  const configs: { id: string; name: string; instructions: string; model: MastraModel }[] = [];
  const calls: { prompt: string; instructions: string; temperature: number }[] = [];
  const agent: AgentFactory = (config) => {
    configs.push(config);
    return {
      generate: async (prompt, call) => {
        calls.push({
          prompt,
          instructions: call.instructions,
          temperature: call.modelSettings.temperature,
        });
        return { object, usage };
      },
    };
  };
  return { configs, calls, agent };
};

/** Every variable a test in this file touches, restored after each one. */
const VARIABLES = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
const saved = new Map(VARIABLES.map((name) => [name, process.env[name]]));
const set = (name: (typeof VARIABLES)[number], value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

afterEach(() => {
  for (const [name, value] of saved) set(name, value);
});

const ENDPOINT = {
  providerId: "openai-compatible",
  modelId: "qwen3:8b",
  url: "http://localhost:11434/v1",
  apiKey: "unused",
} as const;

describe("mastraAgent", () => {
  test("a router string reaches Agent unchanged, and names the binding", async () => {
    set("ANTHROPIC_API_KEY", "k");
    const { configs, calls, agent } = recorded();

    const binding = mastraAgent({ model: "anthropic/claude-haiku-4-5", agent });
    expect(binding.id).toBe("anthropic/claude-haiku-4-5");
    expect(configs[0]?.model).toBe("anthropic/claude-haiku-4-5");

    expect(await binding.generate(REQ)).toEqual(GOOD);
    // The step owns the system prompt, and temperature stays at zero.
    expect(calls[0]).toEqual({
      prompt: REQ.prompt,
      instructions: REQ.system,
      temperature: 0,
    });
  });

  test("an endpoint object reaches Agent unchanged, and is named provider/model", async () => {
    const { configs, agent } = recorded();

    const binding = mastraAgent({ model: ENDPOINT, agent });
    expect(binding.id).toBe("openai-compatible/qwen3:8b");
    // The SAME object, field for field: the binding passes it on rather than
    // reassembling it, so a header or a key it does not know about survives.
    expect(configs[0]?.model).toEqual(ENDPOINT);
    expect(configs[0]?.model).toBe(ENDPOINT);

    expect(await binding.generate(REQ)).toEqual(GOOD);
  });

  test("an endpoint given as `{ id, url }` is named by its id", () => {
    const model = { id: "openai/gpt-4o", url: "https://gateway.example/v1" } as const;
    const { configs, agent } = recorded();

    expect(mastraAgent({ model, agent }).id).toBe("openai/gpt-4o");
    expect(configs[0]?.model).toBe(model);
    expect(modelId(model)).toBe("openai/gpt-4o");
  });

  test("`id` overrides both, because a trail names what the consumer called it", () => {
    const { configs, agent } = recorded();

    expect(mastraAgent({ model: "anthropic/claude-haiku-4-5", id: "worker", agent }).id).toBe("worker");
    expect(mastraAgent({ model: ENDPOINT, id: "validator", agent }).id).toBe("validator");
    // The override renames the BINDING and nothing else: both agents are still
    // built from their own model, and the agent's own name is the model's.
    expect(configs.map((c) => c.name)).toEqual([
      "anthropic/claude-haiku-4-5",
      "openai-compatible/qwen3:8b",
    ]);
    expect(configs.map((c) => c.model)).toEqual(["anthropic/claude-haiku-4-5", ENDPOINT]);
  });

  test("the credential guard does not fire for an endpoint carrying its own key", async () => {
    set("ANTHROPIC_API_KEY", undefined);
    set("OPENAI_API_KEY", undefined);
    const { agent } = recorded();

    expect(requiredCredential(ENDPOINT)).toEqual([]);
    // The endpoint is reached with nothing in the environment at all.
    expect(await mastraAgent({ model: ENDPOINT, agent }).generate(REQ)).toEqual(GOOD);
  });

  test("nor for one that names a url but no key, because there is no variable to name", async () => {
    set("OPENAI_API_KEY", undefined);
    const model = { providerId: "openai", modelId: "gpt-4o", url: "http://localhost:8080/v1" };
    const { agent } = recorded();

    expect(requiredCredential(model)).toEqual([]);
    expect(await mastraAgent({ model, agent }).generate(REQ)).toEqual(GOOD);
  });

  test("it does fire for a bare router string with no key in the environment", async () => {
    set("ANTHROPIC_API_KEY", undefined);
    const { calls, agent } = recorded();

    // The variable is Mastra's own registry's to name, not a derivation.
    expect(requiredCredential("anthropic/claude-haiku-4-5")).toEqual(["ANTHROPIC_API_KEY"]);

    const refused = mastraAgent({ model: "anthropic/claude-haiku-4-5", agent }).generate(REQ);
    await expect(refused).rejects.toThrow(
      /anthropic\/claude-haiku-4-5: ANTHROPIC_API_KEY is not set, so this leaf cannot call a model/,
    );
    // Refused BEFORE the call, so nothing was spent and nothing was fabricated.
    expect(calls).toEqual([]);

    // And the same config with the key present is not refused.
    set("ANTHROPIC_API_KEY", "k");
    expect(await mastraAgent({ model: "anthropic/claude-haiku-4-5", agent }).generate(REQ)).toEqual(GOOD);
  });

  test("a provider the registry does not know needs nothing, because nothing can be named", () => {
    expect(requiredCredential("acme-llm/tiny")).toEqual([]);
    expect(requiredCredential({ providerId: "acme-llm", modelId: "tiny" })).toEqual([]);
  });

  test("usage is handed over verbatim, before the parse", async () => {
    set("ANTHROPIC_API_KEY", "k");
    const usage = { promptTokens: 11, completionTokens: 3 };
    const { agent } = recorded({ decision: "maybe" }, usage);
    const reported: unknown[] = [];

    // The output does not satisfy the schema, so the call throws — and the
    // cost is still reported, because a refused attempt is spent money too.
    const failed = mastraAgent({ model: "anthropic/claude-haiku-4-5", agent }).generate({
      ...REQ,
      onUsage: (u) => reported.push(u),
    });
    await expect(failed).rejects.toThrow();
    expect(reported).toEqual([usage]);
  });
});
