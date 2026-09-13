/**
 * Which model runs which leaf. The consumer's column of the design's
 * framework/consumer split, for the todo target.
 *
 * The shape the framework argues for is "many small models, one frontier call
 * per feature, and a mid-size model where the output is genuinely open":
 *
 *   decompose    opus     the one act the design says stays wide. Decomposing
 *                         a design into production-drivable slices is the
 *                         highest-judgement thing in the pipeline and the
 *                         framework validates its SHAPE and nothing about
 *                         whether it is good
 *   author-oracle sonnet  writing an executable oracle that falsifies every
 *                         obligation through a declared port is code
 *                         generation too, and it is validated the same way:
 *                         narrowly, plus a measurement software owns
 *   implement    sonnet   "make this acceptance test pass with the minimal
 *                         change" is code generation, not a closed-enum
 *                         decision. The document is explicit that this leaf
 *                         stays wide and is validated narrowly instead
 *   everything   haiku    classifications into two, three or four words, each
 *                         with a verbatim anchor and a mechanical check
 *   validators   haiku    every step's adversarial reviewer
 *
 * NO ESCALATION IS WIRED, deliberately. `escalateTo` fires once after the
 * attempt budget, and leaving it unset is what makes the report's exhaustion
 * count mean something: it is the number of decisions the SMALL models could
 * not get past their own validators, which is the open question this run
 * exists to produce evidence for. A Sonnet backstop would answer a different
 * question and hide that one.
 *
 * The validator is the same family as the worker for the Haiku leaves, which
 * the design says is the weaker arrangement — "a Haiku worker refuted by a
 * GPT-mini validator shares fewer blind spots than Haiku refuting Haiku". It is
 * what was asked for here; read the validator-rejection column with that in
 * mind.
 */

import { mastraAgent } from "../../../src/bindings/mastra.ts";
import type { ModelBinding } from "../../../src/core/step.ts";
import { deliverDefs, LEAF_IDS, type DeliverDefs, type LeafId } from "../../../src/examples/nwave/deliver/steps.ts";
import { obligationsDefs, type ObligationsDefs } from "../../../src/examples/nwave/distill/obligations/steps.ts";
import { oracleDefs, type OracleDefs } from "../../../src/examples/nwave/distill/oracle/steps.ts";
import { roadmapDefs, type RoadmapDefs } from "../../../src/examples/nwave/roadmap/steps.ts";

/** Mastra model-router ids: `provider/model`. No provider package needed. */
export const DECOMPOSE_MODEL = "anthropic/claude-opus-5";
/**
 * `author-oracle` runs on the same class as `implement`, and the reason is the
 * same one: the output is genuinely open. Writing an executable oracle that
 * falsifies every obligation through a declared port is code generation, not a
 * closed-enum decision, and the framework validates it narrowly instead — a
 * mechanical path check, a total-relation rule, and a real measurement.
 */
export const ORACLE_MODEL = "anthropic/claude-sonnet-5";
export const IMPLEMENT_MODEL = "anthropic/claude-sonnet-5";
export const WORKER_MODEL = "anthropic/claude-haiku-4-5";
export const VALIDATOR_MODEL = "anthropic/claude-haiku-4-5";

/** Every leaf that is not `implement` runs on the small worker. */
export const SMALL_LEAVES: readonly LeafId[] = LEAF_IDS.filter((leaf) => leaf !== "implement");

export type ModelsOptions = {
  /** Handed every call's raw usage, for the report. */
  onUsage?: (usage: unknown) => void;
};

const agent = (model: string, options: ModelsOptions): ModelBinding =>
  mastraAgent({ model, ...(options.onUsage === undefined ? {} : { onUsage: options.onUsage }) });

/** The roadmap workflow's two leaves: Opus proposes, Haiku judges and refutes. */
export const todoRoadmapDefs = (options: ModelsOptions = {}): RoadmapDefs =>
  roadmapDefs({
    worker: agent(WORKER_MODEL, options),
    validator: agent(VALIDATOR_MODEL, options),
    decomposeWith: agent(DECOMPOSE_MODEL, options),
  });

/** DISTILL's first half: one small model proposing, a pure function judging. */
export const todoObligationsDefs = (options: ModelsOptions = {}): ObligationsDefs =>
  obligationsDefs({
    worker: agent(WORKER_MODEL, options),
    validator: agent(VALIDATOR_MODEL, options),
  });

/** DISTILL's second half: the acceptance designer, on the open-output class. */
export const todoOracleDefs = (options: ModelsOptions = {}): OracleDefs =>
  oracleDefs({
    worker: agent(ORACLE_MODEL, options),
    validator: agent(VALIDATOR_MODEL, options),
  });

/** The DELIVER step cycle: Sonnet writes code, Haiku does everything else. */
export const todoDeliverDefs = (options: ModelsOptions = {}): DeliverDefs =>
  deliverDefs({
    worker: agent(WORKER_MODEL, options),
    validator: agent(VALIDATOR_MODEL, options),
    workers: { implement: agent(IMPLEMENT_MODEL, options) },
  });

/** What the commands print, so a reader knows what a report's numbers are of. */
export const describeModels = (): string =>
  [
    `decompose:     ${DECOMPOSE_MODEL}`,
    `author-oracle: ${ORACLE_MODEL}`,
    `implement:     ${IMPLEMENT_MODEL}`,
    `every other leaf: ${WORKER_MODEL}`,
    `validators:    ${VALIDATOR_MODEL}`,
    `escalation:    none`,
  ].join("\n");
