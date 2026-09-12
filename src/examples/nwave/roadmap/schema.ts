/**
 * The roadmap is DATA, not a workflow.
 *
 * This is the distinction the whole example rests on. An agent does not
 * generate a workflow per feature; it generates ROWS, and a scheduler
 * instantiates the fixed DELIVER step cycle once per row. So what an authoring
 * run produces is a typed structure with a version column, and the graph that
 * produces it is fixed and hand-written like the other two examples.
 *
 * The shape mirrors nwave-experimental's `handover.json` — `StoredHandover` is
 * a request plus an ordered tuple of `HandoverValue`s, each carrying an
 * `observation` (what will be observably true), `dependencies` (values that
 * must come first), an `authority` (the locator into the durable design source
 * the value implements) and `acceptance` obligations. The naming here is ours
 * and the fields are the same facts, with one addition: `predictedTouches`,
 * which is the input to the disjointness measurement in `./disjointness.ts`.
 *
 * A step output schema and an artifact row schema are the same type, from one
 * place (the design's "artifacts are typed rows, not documents"). These
 * schemas are what `decompose` returns AND what `persist` writes, so a
 * proposal cannot have a shape the table could not hold.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";

/**
 * One obligation the step must satisfy to be accepted, in the roadmap's own
 * words. `oracleLocator` names where the assertion lives when the acceptance
 * designer has already placed it; a roadmap authored before the tests exist
 * has obligations without oracles, which is the normal case.
 */
export const AcceptanceObligation = z.object({
  id: z.string(),
  text: z.string(),
  oracleLocator: z.string().optional(),
});
export type AcceptanceObligation = z.infer<typeof AcceptanceObligation>;

/**
 * One roadmap row. Every field is an input: nothing here is derived from
 * anything else, which is what lets the pure validators below be re-run
 * against a changed policy without a migration.
 */
export const RoadmapStep = z.object({
  /** Stable, and unique within the roadmap. */
  id: z.string(),
  /** What will be observably true when the step is done. */
  observation: z.string(),
  /** Step ids that must be accepted first. */
  dependencies: z.array(z.string()),
  /** A locator into the design source this step implements. */
  authority: z.string(),
  /** At least one, enforced by `validate-shape` rather than by the schema. */
  acceptance: z.array(AcceptanceObligation),
  /** Symbol ids or paths the step expects to write. */
  predictedTouches: z.array(z.string()),
});
export type RoadmapStep = z.infer<typeof RoadmapStep>;

/**
 * The whole roadmap. `steps` is deliberately allowed to be empty by the
 * schema: that is the shape `decompose` returns when it answers
 * `cannot-decompose`, and an empty roadmap is refused by `validate-shape` as a
 * named defect rather than by the parser, so the refusal reaches the graph as
 * data.
 *
 * Declaration order is significant. It is the total order the disjointness
 * resolution rule uses to decide which way a new dependency edge points, and
 * nwave-experimental's handover relies on the same order for the same reason.
 */
export const Roadmap = z.object({
  request: z.string(),
  steps: z.array(RoadmapStep),
});
export type Roadmap = z.infer<typeof Roadmap>;

/** The roadmap's own row key. nwave keys a handover by its request; so do we. */
export const roadmapId = (roadmap: Roadmap): string => roadmap.request;

/** The step ids, in declaration order. */
export const stepIds = (roadmap: Roadmap): string[] => roadmap.steps.map((s) => s.id);

/** The step with this id, or `undefined`. */
export const stepById = (roadmap: Roadmap, id: string): RoadmapStep | undefined =>
  roadmap.steps.find((s) => s.id === id);

/** The empty roadmap for a request nothing could be decomposed into. */
export const noSteps = (request: string): Roadmap => ({ request, steps: [] });
