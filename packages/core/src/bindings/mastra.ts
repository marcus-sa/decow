/**
 * A `ModelBinding` over a Mastra Agent.
 *
 * This is the plain-model end of the binding seam: one call, one schema, no
 * tools, no workspace. `src/bindings/claude-code.ts` is the other end, where
 * the thing behind the seam is an agent that reads and edits a checkout.
 *
 * Bindings are consumer-owned per the design's framework/consumer split —
 * "which small models, which validator family" is the consumer's column — so
 * nothing in `core/` imports this file. The examples' smoke scripts do, and so
 * does `targets/todo/.des/models.ts`, which is the one seam a composition has.
 */

import { Agent } from "@mastra/core/agent";
import { getProviderConfig, parseModelString, type OpenAICompatibleConfig } from "@mastra/core/llm";
import type { z } from "zod";
import { SchemaFailure, type GenerateRequest, type ModelBinding } from "../core/step.ts";

/**
 * The agent's standing instructions. Every call overrides them with the step's
 * own `system`, so this exists only because `Agent` requires one.
 */
const PLACEHOLDER_INSTRUCTIONS =
  "You answer one question with one structured object. The step that calls you supplies " +
  "the instructions for that call.";

/**
 * Which model a call reaches, in the two shapes Mastra's own `MastraModelConfig`
 * admits without a provider package.
 *
 * A STRING is the model router's `provider/model` id, and the router resolves
 * that provider's key out of the environment itself. An OBJECT is an
 * OpenAI-compatible endpoint the caller names — its own `url`, its own
 * `apiKey`, its own headers — which is what a gateway, a proxy, or a model
 * served locally looks like from here. `OpenAICompatibleConfig` is Mastra's
 * type, imported rather than restated, so the two cannot drift.
 *
 * The rest of `MastraModelConfig` is deliberately not here: a binding that
 * took a `LanguageModelV2` instance would put an `@ai-sdk/*` provider package
 * back in the dependency graph, which is the thing the router removed.
 *
 * AN OBJECT'S `providerId` NEED NOT NAME A PROVIDER MASTRA KNOWS, and this
 * binding needs nothing to make that work. The router resolves a gateway for
 * every id and `models.dev` is the unconditional last resort, so an
 * unregistered prefix parses as `providerId` rather than raising
 * `MODEL_ROUTER_NO_GATEWAY_FOUND`; a config carrying a `url` then
 * short-circuits that gateway twice over — auth is the config's own `apiKey`
 * rather than an environment variable, and the model is
 * `createOpenAICompatible({ name: providerId, baseURL: url, headers })`
 * rather than anything the gateway builds. The endpoint is reached as named,
 * with no gateway consulted and no provider package installed.
 *
 * `mastra.endpoint.test.ts` is that claim EXERCISED rather than read: a real
 * `Agent` against a real HTTP server on a loopback port, answering as
 * `acme-local/test-model`. What arrives is one `POST <url>/chat/completions`
 * carrying `Authorization: Bearer <apiKey>` (absent entirely when no key is
 * given), the caller's own headers, `temperature`, the system and user turns,
 * and the step's schema as `response_format: { type: "json_schema", …,
 * strict: true }`. That last field is what an endpoint has to support.
 */
export type MastraModel = string | OpenAICompatibleConfig;

/**
 * What a model config is CALLED — the binding's `id`, and therefore
 * `Attempt.model` in a step's trail and `leaf_attempts.model_id` in the run
 * store.
 *
 * A string is its own name. An object's name is `providerId/modelId`, or the
 * `id` when the config is given in that form — the same `provider/model` shape
 * the router's strings have, so one column holds both and a reader does not
 * have to know which shape a run was configured with.
 */
export const modelId = (model: MastraModel): string =>
  typeof model === "string"
    ? model
    : "providerId" in model
      ? `${model.providerId}/${model.modelId}`
      : model.id;

/**
 * Which environment variables a model config needs ONE of, and an empty list
 * when it needs none. The rule the credential guard below is:
 *
 *  1. A config carrying an `apiKey` needs nothing from the environment: it
 *     brought its own.
 *  2. A config carrying a `url` needs nothing either. The endpoint is the
 *     caller's — a local server that authenticates nobody, or a gateway whose
 *     credential goes in `apiKey` or `headers` — and there is no variable the
 *     router would read for it.
 *  3. Otherwise the provider is what the router would parse out, and the
 *     variables are the ones MASTRA'S OWN registry declares for that provider
 *     (`ANTHROPIC_API_KEY`; both of `GOOGLE_API_KEY` and
 *     `GOOGLE_GENERATIVE_AI_API_KEY` for Google). Asking the registry rather
 *     than deriving `<PROVIDER>_API_KEY` is what keeps the refusal naming the
 *     variable the router actually reads.
 *  4. A provider the registry does not know needs nothing, because there is no
 *     variable to name. The call will fail at the router instead, which is the
 *     honest place for "no such provider" to be said.
 */
export const requiredCredential = (model: MastraModel): readonly string[] => {
  if (typeof model !== "string") {
    if (model.apiKey !== undefined && model.apiKey !== "") return [];
    if (model.url !== undefined && model.url !== "") return [];
  }
  const provider =
    typeof model === "string"
      ? parseModelString(model).provider
      : "providerId" in model
        ? model.providerId
        : parseModelString(model.id).provider;
  const declared = provider === null ? undefined : getProviderConfig(provider)?.apiKeyEnvVar;
  if (declared === undefined) return [];
  return typeof declared === "string" ? [declared] : declared;
};

/** One call, as this binding makes it. The step owns the system prompt. */
export type MastraCall<T> = {
  instructions: string;
  structuredOutput: { schema: z.ZodType<T> };
  modelSettings: { temperature: number };
};

/** The slice of Mastra's `Agent` this binding calls. */
export type MastraAgentLike = {
  generate<T>(prompt: string, call: MastraCall<T>): Promise<{ object?: unknown; usage?: unknown }>;
};

/**
 * How the binding gets its agent. Injected so the binding is unit-testable
 * without a network: `mastra.test.ts` supplies a factory that records the
 * config it was handed and answers from a fixture, so no `Agent` is
 * constructed and no socket is opened.
 */
export type AgentFactory = (config: {
  id: string;
  name: string;
  instructions: string;
  model: MastraModel;
}) => MastraAgentLike;

/** The real one. A Mastra `Agent`, narrowed to the one method this calls. */
const liveAgent: AgentFactory = (config) => {
  const agent = new Agent(config);
  return { generate: (prompt, call) => agent.generate(prompt, call) };
};

export type MastraAgentOptions = {
  /**
   * A model-router id, `provider/model`, or an OpenAI-compatible endpoint the
   * caller names. Passed to `Agent` as it is given.
   */
  model: MastraModel;
  /** Reported verbatim as `Attempt.model`. Defaults to `modelId(model)`. */
  id?: string;
  /** How the agent is constructed. Defaults to a real Mastra `Agent`. */
  agent?: AgentFactory;
};

/**
 * Binds a step's model slot to a Mastra Agent with structured output at
 * temperature 0. Temperature zero is not for determinism; it narrows the
 * distribution so retries with feedback converge instead of wandering.
 *
 * Mastra's model router resolves `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from
 * the environment itself, so a caller supplies a `provider/model` string and
 * nothing else. A caller whose model sits behind an OpenAI-compatible URL of
 * its own supplies the object form instead, and the binding hands it to
 * `Agent` unchanged rather than reassembling it.
 *
 * THE CREDENTIAL IS REFUSED AT THE LEAF, not at the door. A server that
 * checked for a key and exited would make the graphs, the projections, the
 * artifact store and the event stream unreadable to say one thing about a
 * leaf — so a call that needs a variable the environment does not have throws
 * HERE, `runStep` records it as a trail entry the way it records any provider
 * error, and the graph routes the exhausted leaf wherever it routes one. What
 * the call needs is `requiredCredential`'s to say: an endpoint carrying its
 * own `apiKey`, or one named by `url`, needs nothing and is not refused.
 *
 * A SCHEMA FAILURE IS NAMED RATHER THAN LEFT TO BE READ OFF A MESSAGE. Two
 * routes reach the same state — Mastra refusing the answer against the schema
 * (`STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED`), and the re-parse below
 * failing — and both throw `SchemaFailure`. That is what tells `runStep` the
 * attempt budget buys nothing: the next attempt asks the same endpoint the
 * same question with the same schema. Everything else throws unchanged and
 * keeps its retries.
 *
 * WHAT A CALL COST IS REPORTED THROUGH THE REQUEST, verbatim and unshaped.
 * The shape is not ours and has more than one version in the dependency graph:
 * `@mastra/core`'s own `TokenUsage` is flat, the AI SDK's nests. `runStep`
 * reads whichever arrived, through `readTokens`, and puts the counts on the
 * attempt it was making — so the number belongs to one call of one step of one
 * run by construction rather than by the order a queue happened to drain in.
 * An endpoint that reports no usage at all yields an EMPTY object rather than
 * a zero, because "nobody said" and "it was free" are different claims.
 */
/**
 * Mastra's own name for the provider layer refusing an answer against the
 * schema. Matched on the message because that is where it arrives.
 */
const MASTRA_SCHEMA_REFUSAL = "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED";

/**
 * A provider-layer schema refusal, named as one. Anything else is returned
 * unchanged, so a socket, a rate limit or a missing credential stays the
 * transport error it is and keeps the step's retry budget.
 */
const wrapIfSchema = (id: string, error: unknown): unknown =>
  String(error).includes(MASTRA_SCHEMA_REFUSAL)
    ? new SchemaFailure(`${id}: ${String(error)}`, { cause: error })
    : error;

export const mastraAgent = (options: MastraAgentOptions): ModelBinding => {
  const name = modelId(options.model);
  const id = options.id ?? name;
  const agent = (options.agent ?? liveAgent)({
    id: `dw-${name.replace(/[^a-z0-9]+/gi, "-")}`,
    name,
    instructions: PLACEHOLDER_INSTRUCTIONS,
    model: options.model,
  });

  return {
    id,
    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      const needs = requiredCredential(options.model);
      if (needs.length > 0 && !needs.some((variable) => process.env[variable])) {
        throw new Error(
          `${id}: ${needs.join(" or ")} is not set, so this leaf cannot call a model. ` +
            "Everything else about this run is readable; nothing here fabricates an answer.",
        );
      }

      let response: { object?: unknown; usage?: unknown };
      try {
        response = await agent.generate(req.prompt, {
          // Per-call override: the step, not the agent, owns the system prompt.
          instructions: req.system,
          structuredOutput: { schema: req.schema },
          modelSettings: { temperature: 0 },
        });
      } catch (error) {
        // Mastra can refuse the answer against the schema before the re-parse
        // below ever runs — `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED` — and
        // that is a different kind of failure from a socket or a rate limit.
        // Saying which is the binding's job; what `runStep` does with it is
        // the step's. Everything else is rethrown unchanged.
        throw wrapIfSchema(id, error);
      }
      // Before the parse, so a call whose output fails the schema still
      // reports what it cost. A refused attempt is spent money too.
      req.onUsage?.(response.usage);
      // Mastra validates against the schema, but the step's guarantee is that
      // the output space IS the schema, so re-parse rather than trust the
      // provider layer.
      const parsed = req.schema.safeParse(response.object);
      if (parsed.success) return parsed.data;
      throw new SchemaFailure(
        `${id}: the endpoint answered outside the step's output space: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    },
  };
};
