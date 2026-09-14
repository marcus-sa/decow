/**
 * The Mastra binding against a REAL `Agent` and a real HTTP server, to settle
 * one question the injected-factory tests in `mastra.test.ts` cannot: what
 * Mastra's model router DOES with an OpenAI-compatible endpoint whose provider
 * it has never heard of.
 *
 * The open question was whether `{ providerId, modelId, url, apiKey }` reaches
 * `url`, or whether the router refuses because no gateway claims `acme-local`.
 * `findGatewayForModel` (`dist/gateway-helpers-Dh-2ojNA.js`) throws
 * `MODEL_ROUTER_NO_GATEWAY_FOUND` only when NO gateway is left, and `models.dev`
 * is the unconditional last resort — so an unknown prefix parses as
 * `providerId: "acme-local"` and routes. Then `config.url` short-circuits the
 * gateway twice over: `resolveAuth` returns the config's own key without asking
 * one (`dist/llm-BHZjvbfj.js:7880-7885`), and `resolveLanguageModel` builds
 * `createOpenAICompatible({ name: providerId, baseURL: config.url, ... })`
 * before any gateway is consulted (`:8011-8018`).
 *
 * This file proves that by exercise rather than by reading. NO REMOTE HOST IS
 * REACHED: a `Bun.serve` on port 0 answers the OpenAI chat-completions shape,
 * and every `fetch` is counted, so an outbound call to anywhere but that
 * loopback port would fail the test rather than pass it quietly.
 *
 * It is also the record of what an endpoint must SUPPORT. The asserted request
 * body is the contract: a `POST /v1/chat/completions` carrying
 * `response_format: { type: "json_schema", ... strict: true }`, which is how
 * the step's schema is put to a server that is not Anthropic.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Agent } from "@mastra/core/agent";
import { noopLogger } from "@mastra/core/logger";
import { z } from "zod";
import { stepOutput } from "../core/step.ts";
import { jsonSchemaDefects, strictJsonSchema } from "../core/strict-schema.ts";
import { DecomposeOutput } from "../../../../examples/nwave/roadmap/steps.ts";
import { mastraAgent, type AgentFactory } from "./mastra.ts";

const Answer = stepOutput(["yes", "no"] as const, { anchor: z.string() });
type Answer = z.infer<typeof Answer>;

const GOOD: Answer = { decision: "yes", payload: { anchor: "the sky" } };

const REQ = {
  step: { id: "fixture.answer", version: 1, role: "worker" as const, attempt: 1 },
  system: "You answer yes or no.",
  prompt: "Is the sky blue?",
  schema: Answer,
};

/** One request the fake endpoint received, as it arrived. */
type Received = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/**
 * The transport-level headers every HTTP client sets. Dropped from the
 * assertions so what remains is what MASTRA chose to send.
 */
const TRANSPORT_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "user-agent",
]);

const chosenHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !TRANSPORT_HEADERS.has(name)));

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let received: Received[] = [];
/** Every url `fetch` was called with, so "only loopback" is asserted, not assumed. */
let fetched: string[] = [];
const realFetch = globalThis.fetch;

/** A minimal OpenAI chat completion whose content is `object`, JSON-encoded. */
const completion = (object: unknown, usage?: Record<string, number>) => ({
  id: "chatcmpl-fixture",
  object: "chat.completion",
  created: 1,
  model: "test-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: JSON.stringify(object) },
      finish_reason: "stop",
    },
  ],
  ...(usage === undefined ? {} : { usage }),
});

/** What the next call is answered with. Set per test. */
let answer: { object: unknown; usage?: Record<string, number> } = { object: GOOD };

/**
 * A real `Agent`, built here only so its logger can be silenced.
 *
 * The one test below that asks the endpoint for an answer OUTSIDE the schema
 * makes Mastra log the rejection at `error`, and a suite that prints a stack
 * while reporting zero failures reads as broken. This is the SAME `Agent` the
 * default factory builds — the binding's `agent` option exists so a caller
 * owns construction, and this caller wants a quiet one. Every other test in
 * this file uses the default factory and therefore the default logger.
 */
const quiet: AgentFactory = (config) => {
  const agent = new Agent(config);
  agent.__setLogger(noopLogger);
  return { generate: (prompt, call) => agent.generate(prompt, call) };
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      received.push({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: JSON.parse(text) as Record<string, unknown>,
      });
      return Response.json(completion(answer.object, answer.usage));
    },
  });
  baseUrl = `http://localhost:${server.port}/v1`;
  globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
    fetched.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  server.stop(true);
});

afterEach(() => {
  received = [];
  fetched = [];
  answer = { object: GOOD };
});

/** Every url this test contacted, and the fake endpoint is the only one allowed. */
const onlyReachedTheEndpoint = (): void => {
  expect(fetched).toEqual(fetched.filter((url) => url.startsWith(baseUrl)));
  expect(fetched.length).toBeGreaterThan(0);
};

describe("an OpenAI-compatible endpoint whose provider Mastra does not know", () => {
  test("is reached at its own url, with a real Agent and no provider package", async () => {
    const binding = mastraAgent({
      model: { providerId: "acme-local", modelId: "test-model", url: baseUrl, apiKey: "unused" },
    });

    // `acme-local` is in no registry, and the run is still named after it.
    expect(binding.id).toBe("acme-local/test-model");
    expect(await binding.generate(REQ)).toEqual(GOOD);

    onlyReachedTheEndpoint();
    expect(received).toHaveLength(1);
    const call = received[0];
    // The path is the OpenAI chat-completions one, appended to the url as given.
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/v1/chat/completions");
    // The key goes in the standard bearer header. An endpoint reads it there.
    expect(chosenHeaders(call?.headers ?? {})).toEqual({
      authorization: "Bearer unused",
      "content-type": "application/json",
    });
    // `modelId`, not the `provider/model` id: the provider was the routing
    // decision, and what the endpoint is asked for is the model it serves.
    expect(call?.body.model).toBe("test-model");
    expect(call?.body.temperature).toBe(0);
    expect(call?.body.messages).toEqual([
      { role: "system", content: REQ.system },
      { role: "user", content: REQ.prompt },
    ]);
  });

  test("puts the step's schema in `response_format`, as a strict json_schema", async () => {
    await mastraAgent({
      model: { providerId: "acme-local", modelId: "test-model", url: baseUrl, apiKey: "unused" },
    }).generate(REQ);

    // THIS IS WHAT AN ENDPOINT MUST SUPPORT. Not a tool call, not a prompt
    // instruction: OpenAI's structured-output `response_format`, with the
    // step's zod schema as draft-07 JSON Schema and `strict: true`.
    expect(received[0]?.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            decision: { type: "string", enum: ["yes", "no"] },
            payload: {
              type: "object",
              properties: { anchor: { type: "string" } },
              required: ["anchor"],
              additionalProperties: false,
            },
          },
          required: ["decision", "payload"],
          additionalProperties: false,
        },
      },
    });
  });

  test("a real leaf's schema arrives strict-clean, and is the one this repository computes", async () => {
    // The toy schema above is too small to say anything: the failure that made
    // `strict-schema.ts` exist was two levels down a nested array, in the
    // decompose leaf. So the assertion is made against THAT schema, and
    // against the body a real `Agent` actually sent rather than against a
    // conversion this file performed.
    answer = {
      object: {
        decision: "cannot-decompose",
        payload: { roadmap: { request: "r", steps: [] }, rationale: "no authority for it" },
      },
    };
    await mastraAgent({
      model: { providerId: "acme-local", modelId: "test-model", url: baseUrl, apiKey: "unused" },
    }).generate({
      ...REQ,
      schema: DecomposeOutput,
      prompt: "Decompose it.",
    });

    const sent = (received[0]?.body.response_format as { json_schema?: { schema?: unknown } })
      ?.json_schema?.schema;
    // Nothing in it a strict endpoint would refuse.
    expect(jsonSchemaDefects(sent)).toEqual([]);
    // And it is byte-for-byte what `strictJsonSchema` says the wire carries,
    // so the checker cannot pass a schema the binding then sends differently.
    expect(sent).toEqual(strictJsonSchema(DecomposeOutput));
  });

  test("reports what the endpoint said the call cost", async () => {
    answer = { object: GOOD, usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };
    const reported: unknown[] = [];

    await mastraAgent({
      model: { providerId: "acme-local", modelId: "test-model", url: baseUrl, apiKey: "unused" },
    }).generate({ ...REQ, onUsage: (usage) => reported.push(usage) });

    // The shape is the provider layer's, read by `readTokens` rather than
    // reshaped here — what matters is that the endpoint's counts arrive.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  });

  test("an output outside the step's schema throws rather than proceeding", async () => {
    answer = { object: { decision: "maybe", payload: { anchor: "the sky" } } };

    const refused = mastraAgent({
      model: { providerId: "acme-local", modelId: "test-model", url: baseUrl, apiKey: "unused" },
      agent: quiet,
    }).generate(REQ);

    // The endpoint answered, and the answer was not in the output space — so
    // the call throws, `runStep` records it in the trail, and the leaf
    // exhausts rather than the graph routing on a decision nobody made. This
    // is the failure a reader pointing at their own server will meet first.
    await expect(refused).rejects.toThrow(/decision/);
    expect(received).toHaveLength(1);
  });

  test("the `{ id, url }` form reaches the same endpoint the same way", async () => {
    const binding = mastraAgent({ model: { id: "acme-local/test-model", url: baseUrl, apiKey: "k" } });

    expect(binding.id).toBe("acme-local/test-model");
    expect(await binding.generate(REQ)).toEqual(GOOD);

    onlyReachedTheEndpoint();
    expect(received[0]?.path).toBe("/v1/chat/completions");
    expect(received[0]?.headers.authorization).toBe("Bearer k");
    expect(received[0]?.body.model).toBe("test-model");
  });

  test("headers the caller names arrive, and an endpoint with no key gets no bearer", async () => {
    await mastraAgent({
      model: {
        providerId: "acme-local",
        modelId: "test-model",
        url: baseUrl,
        apiKey: "k",
        headers: { "x-tenant": "t7" },
      },
    }).generate(REQ);
    // A gateway's own header survives the router: the binding passes the
    // config on rather than reassembling it, and the router merges it in.
    expect(received[0]?.headers["x-tenant"]).toBe("t7");

    received = [];
    await mastraAgent({
      model: { providerId: "acme-local", modelId: "test-model", url: baseUrl },
    }).generate(REQ);
    // No key, no `Authorization` — which is what a local server serving an
    // open port wants, and why `requiredCredential` refuses nothing here.
    expect(chosenHeaders(received[0]?.headers ?? {})).toEqual({ "content-type": "application/json" });
  });
});
