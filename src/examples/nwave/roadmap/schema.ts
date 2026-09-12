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
 * One obligation the step must satisfy to be accepted.
 *
 * Three fields, and the split between the last two is the whole of it: a
 * STIMULUS a reader could apply and an EXPECTED result they could observe. One
 * sentence of prose saying "complete works" is neither, and an oracle author
 * handed it has to invent both halves before it can write an assertion. This
 * is `AcceptanceObligation` from nwave-experimental's
 * `des/domain/distill_document.py`, field for field.
 *
 * It carries no locator. Where the assertion lives is the VALUE's property
 * rather than the obligation's — one oracle per value, covering every
 * obligation it declares — so it sits on `RoadmapStep` beside `supports`.
 */
export const AcceptanceObligation = z.object({
  id: z.string(),
  /** What a reader would DO. "Complete a todo the store holds." */
  stimulus: z.string(),
  /** What they would then OBSERVE. "It is returned with done set." */
  expected: z.string(),
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
  /** Symbol ids or paths the step expects to write. */
  predictedTouches: z.array(z.string()),

  /* ---- the three fields DISTILL fills, and ROADMAP leaves empty --------- */

  /**
   * What the step must satisfy to be accepted. Empty as ROADMAP proposes it:
   * deciding what a value must be observed to do is DISTILL's act, not the
   * decomposer's, and a decomposer that filled these in would be answering a
   * question nobody asked it.
   */
  acceptance: z.array(AcceptanceObligation),
  /**
   * The ONE executable oracle covering this value's obligations, as a
   * `path::selector` or a bare path. Exactly one, because the thing that
   * measures a value has to be a thing software can run and read a verdict
   * off; two would make "the oracle was red" ambiguous.
   */
  oracle: z.string().optional(),
  /**
   * Whole-file test-substrate paths the oracle depends on: a driver, a
   * fixture, a builder. Whole FILES rather than locators, because a support is
   * a dependency of the oracle rather than a thing that is run.
   */
  supports: z.array(z.string()),
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
