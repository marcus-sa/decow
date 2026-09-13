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
import type { GenerateRequest, ModelBinding } from "../core/step.ts";

/**
 * The agent's standing instructions. Every call overrides them with the step's
 * own `system`, so this exists only because `Agent` requires one.
 */
const PLACEHOLDER_INSTRUCTIONS =
  "You answer one question with one structured object. The step that calls you supplies " +
  "the instructions for that call.";

export type MastraAgentOptions = {
  /** Mastra model-router id, `provider/model`. No provider package needed. */
  model: string;
  /** Reported verbatim as `Attempt.model`. Defaults to `model`. */
  id?: string;
};

/**
 * Binds a step's model slot to a Mastra Agent with structured output at
 * temperature 0. Temperature zero is not for determinism; it narrows the
 * distribution so retries with feedback converge instead of wandering.
 *
 * Mastra's model router resolves `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from
 * the environment itself, so a caller supplies a `provider/model` string and
 * nothing else.
 *
 * WHAT A CALL COST IS REPORTED THROUGH THE REQUEST, verbatim and unshaped.
 * The shape is not ours and has more than one version in the dependency graph:
 * `@mastra/core`'s own `TokenUsage` is flat, the AI SDK's nests. `runStep`
 * reads whichever arrived, through `readTokens`, and puts the counts on the
 * attempt it was making — so the number belongs to one call of one step of one
 * run by construction rather than by the order a queue happened to drain in.
 */
export const mastraAgent = (options: MastraAgentOptions): ModelBinding => {
  const agent = new Agent({
    id: `dw-${options.model.replace(/[^a-z0-9]+/gi, "-")}`,
    name: options.model,
    instructions: PLACEHOLDER_INSTRUCTIONS,
    model: options.model,
  });

  return {
    id: options.id ?? options.model,
    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      const response = await agent.generate(req.prompt, {
        // Per-call override: the step, not the agent, owns the system prompt.
        instructions: req.system,
        structuredOutput: { schema: req.schema },
        modelSettings: { temperature: 0 },
      });
      // Before the parse, so a call whose output fails the schema still
      // reports what it cost. A refused attempt is spent money too.
      req.onUsage?.((response as { usage?: unknown }).usage);
      // Mastra validates against the schema, but the step's guarantee is that
      // the output space IS the schema, so re-parse rather than trust the
      // provider layer. A failure throws and runStep records it in the trail.
      return req.schema.parse(response.object);
    },
  };
};
