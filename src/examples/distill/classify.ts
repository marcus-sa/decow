/**
 * DISTILL test-lane classification.
 *
 * Input: one test scenario. Output: which lanes it needs, from
 * `testing.md § Classify external execution` and the DISTILL completeness
 * gate. Four classifiers fan out, each a small model answering one question
 * with one of three words.
 *
 * This file is consumer-side: requirement rows, prompts, and the shape of the
 * closed decision space. The model bindings are injected (see
 * `classifierDefs`), so a test constructs no agent and spends no token.
 */

import { z } from "zod";
import type { Requirement } from "../../core/requirement.ts";
import { stepOutput, type ModelBinding, type StepDef } from "../../core/step.ts";
import { verbatim } from "../../checks/verbatim.ts";

export const Scenario = z.object({
  id: z.string(),
  text: z.string(),
  /** Set upstream by DISTILL, not inferred here. */
  crossesBoundary: z.boolean(),
});
export type Scenario = z.infer<typeof Scenario>;

export const LANES = ["needed", "not-needed", "cannot-tell"] as const;
export const Lane = z.enum(LANES);
export type Lane = z.infer<typeof Lane>;

/** `anchor` and `rationale` are payload. The graph cannot read them. */
export const Classification = stepOutput(LANES, {
  anchor: z.string().describe("Verbatim quote from the scenario that justifies the decision"),
  rationale: z.string().max(300),
});
export type Classification = z.infer<typeof Classification>;

export type ClassifyCtx = { input: Scenario; output: Classification };

export const KINDS = ["e2e", "expectation", "benchmark", "dst"] as const;
export type Kind = (typeof KINDS)[number];

export const anchorMustBeVerbatim: Requirement<ClassifyCtx> = {
  id: "distill.anchor-verbatim",
  sourceId: "verification.enforcement.unanchored-claims",
  text: "The justification must quote the scenario verbatim. Paraphrase is an unanchored claim.",
  decisions: LANES,
  check: verbatim(
    "distill.anchor-verbatim",
    (ctx: ClassifyCtx) => ctx.input.text,
    (ctx: ClassifyCtx) => ctx.output.payload.anchor,
  ),
};

/** One row per cross-cutting rule the classifier must not dodge. */
export const LANE_REQUIREMENTS: Record<Kind, Requirement<ClassifyCtx>[]> = {
  e2e: [
    {
      id: "testing.e2e.deterministic-contract",
      sourceId: "testing.classify-external-execution",
      text:
        "An E2E or conformance test answers whether the assembled system continues to satisfy a " +
        "deterministic contract, and is rerun in the appropriate test lane.",
      decisions: LANES,
    },
  ],
  expectation: [
    {
      id: "testing.expectation.point-in-time",
      sourceId: "testing.classify-external-execution",
      text:
        "An EDD verification expectation is one point-in-time capture, retained as SHA-pinned evidence. " +
        "It is not a CI regression test and is not meant to be rerun.",
      decisions: LANES,
    },
    {
      id: "testing.expectation.cohort-is-never-expectation",
      sourceId: "testing.classify-external-execution",
      text:
        "A repeated cohort or fault/load matrix is never an expectation. If the purpose is to prove every " +
        "run satisfies a contract, it is an E2E, conformance, stress, or soak test.",
      decisions: LANES,
    },
  ],
  benchmark: [
    {
      id: "testing.benchmark.repeated-samples",
      sourceId: "testing.classify-external-execution",
      text:
        "A benchmark answers how fast, how much, or how variable. It requires repeated samples on a " +
        "controlled substrate, raw measurements, and a stated statistical method.",
      decisions: LANES,
    },
  ],
  dst: [
    {
      id: "testing.dst.ordering-timing-concurrency",
      sourceId: "testing.tier-1-deterministic-simulation",
      text:
        "Correctness that depends on ordering, timing, concurrency, retry, or convergence needs a seeded " +
        "simulation invariant, with the seed printed and the triggering sequence retained.",
      decisions: LANES,
    },
  ],
};

export const QUESTION: Record<Kind, string> = {
  e2e: "Does the assembled system need to keep satisfying a deterministic contract, rerun in CI?",
  expectation:
    "Is this a one-time, point-in-time operator-observable claim to capture as SHA-pinned evidence?",
  benchmark:
    "Does this ask how fast, how much, or how variable, needing repeated samples and a statistical method?",
  dst:
    "Does correctness depend on ordering, timing, concurrency, retry, or convergence, needing a seeded simulation invariant?",
};

const WORKER_SYSTEM =
  "You classify a single test scenario. Answer only the question asked. " +
  "Quote the scenario verbatim in `anchor`.";

/**
 * The model bindings a consumer supplies. Injected rather than constructed
 * here, so the enumeration suite runs with no agent, no key, and no network.
 */
export type ClassifierModels = {
  worker: ModelBinding;
  validator: ModelBinding;
  escalateTo?: ModelBinding;
};

export const classifier = (
  kind: Kind,
  models: ClassifierModels,
): StepDef<Scenario, Classification> => ({
  id: `distill.classify.${kind}`,
  version: 1,
  input: Scenario,
  output: Classification,
  requirements: [anchorMustBeVerbatim, ...(LANE_REQUIREMENTS[kind] ?? [])],
  worker: {
    model: models.worker,
    system: WORKER_SYSTEM,
    prompt: (s) => `${QUESTION[kind]}\n\nScenario ${s.id}:\n${s.text}`,
  },
  validator: { model: models.validator },
  maxAttempts: 2,
  escalateTo: models.escalateTo,
});

export const classifierDefs = (models: ClassifierModels): Record<Kind, StepDef<Scenario, Classification>> =>
  Object.fromEntries(KINDS.map((kind) => [kind, classifier(kind, models)])) as Record<
    Kind,
    StepDef<Scenario, Classification>
  >;

/** Step id for a kind. The stub journal keys on this. */
export const classifierStepId = (kind: Kind): string => `distill.classify.${kind}`;
