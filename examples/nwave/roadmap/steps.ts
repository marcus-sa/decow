/**
 * The roadmap authoring workflow, leaf side.
 *
 * Two leaves, and they are deliberately unlike each other.
 *
 * `decompose` is the one place in this whole framework where frontier judgment
 * genuinely belongs. "Decompose a design into steps that are each
 * production-drivable vertical slices" is the highest-judgment act in the
 * pipeline, and the framework validates the roadmap's SHAPE and nothing about
 * whether the decomposition is good. So its worker slot is bound to a
 * frontier-class binding by the caller, its validator is a different-family
 * small model like everywhere else, and its output is a diff a person reads.
 *
 * `validate-slices` is the opposite: a small model answering one question per
 * step, with a verbatim anchor into that step's own observation. It is one
 * leaf rather than a fanout, and that choice is documented in `./graph.ts`.
 *
 * This file is consumer-side: the closed decision space of each leaf, its
 * requirement rows, and its prompt. The model bindings are injected, so a test
 * constructs no agent and spends no token.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import { verbatim } from "@des/core/checks/verbatim";
import type { Requirement } from "@des/core/requirement";
import { stepOutput, type ModelBinding, type StepDef } from "@des/core/step";
import {
  describeDefect,
  firstDefectOfKind,
  MINIMUM_OBSERVATION_CHARACTERS,
  type ShapeDefect,
} from "./shape.ts";
import { Roadmap, stepById, type RoadmapStep } from "./schema.ts";

/* ------------------------------------------------------------------ leaves */

export const ROADMAP_LEAF_IDS = ["decompose", "validate-slices"] as const;
export type RoadmapLeafId = (typeof ROADMAP_LEAF_IDS)[number];

/** Step id for a leaf. The journal keys on this. */
export const leafStepId = (leaf: RoadmapLeafId): string => `roadmap.${leaf}`;

/* --------------------------------------------------------------- decompose */

/**
 * Either a roadmap was proposed or the request could not be decomposed into
 * one. `cannot-decompose` is a first-class answer rather than a failure: a
 * request with no design source behind it, or one whose design names nothing
 * a production entry point could drive, has no honest decomposition, and
 * inventing three steps to look productive is the failure this avoids.
 */
export const DECOMPOSE_OUTCOMES = ["proposed", "cannot-decompose"] as const;
export type DecomposeOutcome = (typeof DECOMPOSE_OUTCOMES)[number];

/**
 * What `decompose` reads. Every field beyond the first two is FEEDBACK from a
 * previous iteration, and each has exactly one producer: `defects` comes from
 * `validate-shape`, `notSlices` from `validate-slices`, and `notes` from a
 * person who asked for a revision. All three are empty or absent on the first
 * attempt.
 */
export const DecomposeInput = z.object({
  request: z.string(),
  /** The design source, a string in this cut. */
  design: z.string(),
  /** Named shape defects the last proposal had. */
  defects: z.array(z.custom<ShapeDefect>(() => true)),
  /** Steps the slice check refused, with its verbatim anchor. */
  notSlices: z.array(z.object({ stepId: z.string(), verdict: z.string(), anchor: z.string() })),
  /** What a person wrote when they asked for a revision. */
  notes: z.string().optional(),
});
export type DecomposeInput = z.infer<typeof DecomposeInput>;

export const DecomposeOutput = stepOutput(DECOMPOSE_OUTCOMES, {
  roadmap: Roadmap,
  rationale: z.string().max(600),
});
export type DecomposeOutput = z.infer<typeof DecomposeOutput>;

export type DecomposeCtx = { input: DecomposeInput; output: DecomposeOutput };

/**
 * The three rules bound to `decompose`, each with a mechanical check, and each
 * check delegating to `shape.ts`. That delegation is the point: the same
 * predicate answers the step's own guardrail and the graph's `validate-shape`
 * gate, so a rule cannot hold at one and not the other. The duplication is
 * deliberate in the other direction — the guardrail runs before a validator
 * model is spent, and the gate runs on whatever got past it.
 *
 * A `cannot-decompose` answer carries no roadmap to check, so every check
 * passes vacuously there rather than demanding a shape the decision says does
 * not exist.
 */
const shapeRule = (
  id: string,
  sourceId: string,
  text: string,
  kind: Parameters<typeof firstDefectOfKind>[1],
) => (decisions: readonly string[]): Requirement<DecomposeCtx> => ({
  id,
  sourceId,
  text,
  decisions,
  check: ({ output }) => {
    if (output.decision !== "proposed") return null;
    const defect = firstDefectOfKind(output.payload.roadmap, kind);
    return defect === undefined ? null : { requirementId: id, evidence: describeDefect(defect) };
  },
});

export const everyStepNamesAnAuthority = shapeRule(
  "roadmap.every-step-names-an-authority",
  "handover.value-fields-are-invalid",
  "Every step names an authority: a locator into the design source that step implements. A step " +
    "with no authority is a step with nothing to implement to, and nothing to check it against.",
  "empty-authority",
);

export const observationsSayEnough = shapeRule(
  "roadmap.observation-says-enough-to-be-worked-from",
  "handover.value-fields-are-invalid",
  `Every step's observation is at least ${MINIMUM_OBSERVATION_CHARACTERS} characters and names ` +
    "what will be observably true. \"It works\" is not an observation; it is a hope with a full stop.",
  "observation-too-short",
);

/**
 * The wave boundary, as a rule the decomposer is held to.
 *
 * Deciding what a value must be OBSERVED to do is DISTILL's act. A decomposer
 * that filled in obligations, an oracle or a support list would be answering a
 * question nobody asked it, and the answer would be persisted as though a
 * wave had produced it.
 */
export const acceptanceIsDistills = (decisions: readonly string[]): Requirement<DecomposeCtx> => ({
  id: "roadmap.acceptance-facts-are-distills",
  sourceId: "des.distill.acceptance-facts",
  text:
    "Leave `acceptance`, `oracle` and `supports` empty on every step. What a value must be " +
    "observed to do, which oracle measures it, and what that oracle depends on are DISTILL's to " +
    "decide. Propose the decomposition, not its acceptance.",
  decisions,
  check: ({ output }) => {
    if (output.decision !== "proposed") return null;
    const filled = output.payload.roadmap.steps.find(
      (step) => step.acceptance.length > 0 || step.supports.length > 0 || step.oracle !== undefined,
    );
    return filled === undefined
      ? null
      : {
          requirementId: "roadmap.acceptance-facts-are-distills",
          evidence: `step ${filled.id} declares acceptance facts a decomposition does not decide`,
        };
  },
});

export const stepIdsAreUnique = shapeRule(
  "roadmap.step-ids-are-unique",
  "handover.value-fields-are-invalid",
  "Step ids are unique within the roadmap. Two rows claiming one identity make every dependency " +
    "naming it ambiguous.",
  "duplicate-id",
);

export const slicesAreProductionDrivable = (
  decisions: readonly string[],
): Requirement<DecomposeCtx> => ({
  id: "roadmap.steps-are-production-drivable-slices",
  sourceId: "claude.build-vertical-slices-through-production-entry-points",
  text:
    "Every step is a production-drivable vertical slice: its observation names behaviour reachable " +
    "through a production entry point, not a mechanism only a test can reach. A step that builds a " +
    "component no production path feeds is a horizontal layer, however green its tests are.",
  decisions,
});

export const cannotDecomposeIsAnHonestAnswer = (
  decisions: readonly string[],
): Requirement<DecomposeCtx> => ({
  id: "roadmap.cannot-decompose-is-an-honest-answer",
  sourceId: "claude.deferrals-require-issues",
  text:
    "When the design source does not support a decomposition, answer cannot-decompose. Do not " +
    "propose steps whose authority you had to invent, and do not fill a gap the design left with a " +
    "step that names it as future work.",
  decisions,
});

/* --------------------------------------------------------- validate-slices */

/**
 * One step's verdict. `cannot-tell` is the honest third answer, and it is a
 * route to a person rather than a coin flip — the same shape DISTILL's lane
 * classifiers use.
 */
export const SLICE_VERDICTS = ["is-slice", "not-slice", "cannot-tell"] as const;
export type SliceVerdict = (typeof SLICE_VERDICTS)[number];

/** One row of the per-step answer. `anchor` is verbatim from the observation. */
export const SliceVerdictRow = z.object({
  stepId: z.string(),
  verdict: z.enum(SLICE_VERDICTS),
  anchor: z.string().describe("Verbatim quote from THIS step's observation that justifies the verdict"),
});
export type SliceVerdictRow = z.infer<typeof SliceVerdictRow>;

export const SlicesInput = z.object({
  roadmap: Roadmap,
  /** The design source, so "the authority does not declare it" is checkable. */
  design: z.string(),
});
export type SlicesInput = z.infer<typeof SlicesInput>;

/**
 * The leaf's own decision is the AGGREGATE, because that is what the graph
 * routes: a set of per-step verdicts is not a closed enum. The per-step rows
 * ride in the payload, where they are the feedback `decompose` reads and the
 * evidence a person reads, and the aggregate is the worst verdict across them
 * — one step that is not a slice makes the roadmap not decomposable as
 * proposed, and one step nobody could decide makes it undecidable.
 */
export const SlicesOutput = stepOutput(SLICE_VERDICTS, {
  verdicts: z.array(SliceVerdictRow),
  rationale: z.string().max(600),
});
export type SlicesOutput = z.infer<typeof SlicesOutput>;

export type SlicesCtx = { input: SlicesInput; output: SlicesOutput };

/**
 * The verbatim check, per step. `verbatim` is the framework's own mechanical
 * check and it is reused here once per row rather than reimplemented over the
 * whole payload: the source each anchor is checked against is THAT step's
 * observation, so a quote lifted from a neighbouring step's observation is a
 * violation rather than a near miss.
 */
export const sliceAnchorsAreVerbatim = (decisions: readonly string[]): Requirement<SlicesCtx> => ({
  id: "roadmap.slice-anchor-verbatim",
  sourceId: "verification.enforcement.unanchored-claims",
  text:
    "Each step's verdict quotes THAT step's observation verbatim. Paraphrase is an unanchored " +
    "claim, and a quote from another step's observation is not evidence about this one.",
  decisions,
  check: (ctx) => {
    for (const row of ctx.output.payload.verdicts) {
      const step = stepById(ctx.input.roadmap, row.stepId);
      const violation = verbatim<null>(
        "roadmap.slice-anchor-verbatim",
        () => step?.observation ?? "",
        () => row.anchor,
      )(null);
      if (violation !== null) {
        return { requirementId: violation.requirementId, evidence: `${row.stepId}: ${violation.evidence}` };
      }
    }
    return null;
  },
});

/**
 * Every step gets a verdict and no verdict names a step that is not there.
 * Both directions in one check, because both are the same failure: the answer
 * is not about the roadmap it was asked about.
 */
export const everyStepIsAnswered = (decisions: readonly string[]): Requirement<SlicesCtx> => ({
  id: "roadmap.every-step-is-answered",
  sourceId: "framework.decision-is-the-only-field-the-graph-reads",
  text:
    "Return exactly one verdict per step in the roadmap, keyed by step id. A missing step is an " +
    "unanswered question and an unknown step id is an answer about something else.",
  decisions,
  check: (ctx) => {
    const asked = new Set(ctx.input.roadmap.steps.map((s) => s.id));
    const answered = new Set(ctx.output.payload.verdicts.map((v) => v.stepId));
    const id = "roadmap.every-step-is-answered";
    const missing = [...asked].filter((s) => !answered.has(s));
    if (missing.length > 0) return { requirementId: id, evidence: `unanswered: ${missing.join(", ")}` };
    const unknown = [...answered].filter((s) => !asked.has(s));
    if (unknown.length > 0) return { requirementId: id, evidence: `not a step: ${unknown.join(", ")}` };
    return null;
  },
});

export const slicesAreReachableThroughProduction = (
  decisions: readonly string[],
): Requirement<SlicesCtx> => ({
  id: "roadmap.step-is-a-production-drivable-slice",
  sourceId: "claude.build-vertical-slices-through-production-entry-points",
  text:
    "The step is a production-drivable vertical slice: its observation names behaviour reachable " +
    "through a production entry point, not a mechanism only a test can reach. Report not-slice when " +
    "the observation is about a component rather than about behaviour a deploy would exercise.",
  decisions,
});

export const slicesNeedNoUndeclaredApi = (
  decisions: readonly string[],
): Requirement<SlicesCtx> => ({
  id: "roadmap.step-needs-no-undeclared-api",
  sourceId: "claude.implement-to-the-design",
  text:
    "The step does not require public API the authority does not declare. A step whose observation " +
    "can only be reached by adding surface the design does not name is a design gap wearing a " +
    "roadmap row, and it is reported not-slice rather than accepted.",
  decisions,
});

/* ----------------------------------------------------------------- prompts */

const DECOMPOSE_SYSTEM =
  "You decompose one request into an ordered roadmap of production-drivable vertical slices. " +
  "Every step names an authority — a locator into the design source it implements — states an " +
  `observation of at least ${MINIMUM_OBSERVATION_CHARACTERS} characters saying what will be ` +
  "observably true when it is done, lists the steps it depends on, and predicts the symbols it " +
  "will write. Step ids are unique. Leave `acceptance`, `oracle` and `supports` EMPTY: what a " +
  "value must be observed to do is decided in a later wave, not here. If the design source does " +
  "not support a decomposition, report cannot-decompose with an empty step list; do not invent " +
  "an authority.";

const SLICES_SYSTEM =
  "You judge, for every step of one roadmap, whether it is a production-drivable vertical slice " +
  "whose observation is reachable through a production entry point, and whether it needs public " +
  "API its authority does not declare. Answer one verdict per step, each quoting that step's own " +
  "observation verbatim in `anchor`. Your own decision is the worst verdict across the steps.";

const renderStep = (step: RoadmapStep): string =>
  [
    `- id: ${step.id}`,
    `  observation: ${step.observation}`,
    `  authority: ${step.authority}`,
    `  dependencies: ${step.dependencies.length === 0 ? "(none)" : step.dependencies.join(", ")}`,
    `  acceptance: ${step.acceptance.map((a) => `${a.id}: ${a.stimulus} -> ${a.expected}`).join(" | ") || "(none)"}`,
    `  predictedTouches: ${step.predictedTouches.join(", ") || "(none)"}`,
  ].join("\n");

const decomposePrompt = (i: DecomposeInput): string => {
  const feedback = [
    i.defects.length === 0 ? "" : `Shape defects in your last proposal:\n${i.defects.map((d) => `- ${describeDefect(d)}`).join("\n")}`,
    i.notSlices.length === 0
      ? ""
      : `Steps refused as not production-drivable slices:\n${i.notSlices
          .map((v) => `- ${v.stepId}: ${v.verdict}, anchored on "${v.anchor}"`)
          .join("\n")}`,
    i.notes === undefined || i.notes.length === 0 ? "" : `What a person asked you to change:\n${i.notes}`,
  ].filter((part) => part.length > 0);

  return [
    `Request:\n${i.request}`,
    `Design source:\n${i.design}`,
    ...feedback,
  ].join("\n\n");
};

const slicesPrompt = (i: SlicesInput): string =>
  [
    `Design source:\n${i.design}`,
    `Roadmap for: ${i.roadmap.request}`,
    i.roadmap.steps.map(renderStep).join("\n"),
  ].join("\n\n");

/* -------------------------------------------------------------- step defs */

/**
 * The model bindings a consumer supplies. `decompose` takes its own, because
 * it is the one leaf this framework expects to be frontier-class: it is the
 * act the design says stays wide. It falls back to `worker` so a test can stub
 * every leaf the same way.
 */
export type RoadmapModels = {
  worker: ModelBinding;
  validator: ModelBinding;
  escalateTo?: ModelBinding;
  /** The frontier-class binding `decompose` runs on. Falls back to `worker`. */
  decomposeWith?: ModelBinding;
};

export type RoadmapDefs = {
  decompose: StepDef<DecomposeInput, DecomposeOutput>;
  "validate-slices": StepDef<SlicesInput, SlicesOutput>;
};

export const roadmapDefs = (models: RoadmapModels): RoadmapDefs => ({
  decompose: {
    id: leafStepId("decompose"),
    version: 1,
    input: DecomposeInput,
    output: DecomposeOutput,
    requirements: [
      everyStepNamesAnAuthority,
      observationsSayEnough,
      acceptanceIsDistills,
      stepIdsAreUnique,
      slicesAreProductionDrivable,
      cannotDecomposeIsAnHonestAnswer,
    ].map((row) => row(DECOMPOSE_OUTCOMES)),
    worker: {
      model: models.decomposeWith ?? models.worker,
      system: DECOMPOSE_SYSTEM,
      prompt: decomposePrompt,
    },
    validator: { model: models.validator },
    maxAttempts: 2,
    ...(models.escalateTo === undefined ? {} : { escalateTo: models.escalateTo }),
  },

  "validate-slices": {
    id: leafStepId("validate-slices"),
    version: 1,
    input: SlicesInput,
    output: SlicesOutput,
    requirements: [
      sliceAnchorsAreVerbatim,
      everyStepIsAnswered,
      slicesAreReachableThroughProduction,
      slicesNeedNoUndeclaredApi,
    ].map((row) => row(SLICE_VERDICTS)),
    worker: { model: models.worker, system: SLICES_SYSTEM, prompt: slicesPrompt },
    validator: { model: models.validator },
    maxAttempts: 2,
    ...(models.escalateTo === undefined ? {} : { escalateTo: models.escalateTo }),
  },
});
