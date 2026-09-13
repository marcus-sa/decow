/**
 * The obligations graph, leaf side. One leaf.
 *
 * `des distill` has no model in it at all: it takes a manifest, validates it,
 * and persists it. The only reason one appears here is that something has to
 * PROPOSE the manifest, and turning an observation into a stimulus and an
 * expected result is the one part of it that is not a lookup.
 *
 * So the leaf's decision space is a SINGLETON. It proposes; whether the
 * proposal is admissible is `../manifest.ts`'s, and that is a pure function.
 * Giving the leaf a second decision would be asking a model to grade its own
 * manifest, which is the arrangement the validator exists to replace.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import type { Requirement } from "@des/core/requirement";
import { stepOutput, type ModelBinding, type StepDef } from "@des/core/step";
import { AcceptanceObligation, Roadmap } from "../../roadmap/schema.ts";
import {
  describeManifestDefect,
  manifestDefects,
  type ManifestDefect,
  type ManifestDefectKind,
} from "../manifest.ts";

export const OBLIGATIONS_LEAF_IDS = ["propose-obligations"] as const;
export type ObligationsLeafId = (typeof OBLIGATIONS_LEAF_IDS)[number];

/** Step id for the leaf. The journal keys on this. */
export const leafStepId = (leaf: ObligationsLeafId): string => `distill.${leaf}`;

/**
 * One proposal. Singleton, because the routable question downstream is whether
 * the manifest validates and that is not this leaf's to answer.
 */
export const PROPOSE_OUTCOMES = ["proposed"] as const;
export type ProposeOutcome = (typeof PROPOSE_OUTCOMES)[number];

export const ProposedValue = z.object({
  observation: z.string(),
  acceptance: z.array(AcceptanceObligation),
  oracle: z.string(),
  supports: z.array(z.string()),
});

export const ProposeInput = z.object({
  /** The roadmap the observations must come from, verbatim. */
  roadmap: Roadmap,
  /** The design source, so an obligation can be anchored in what it declares. */
  design: z.string(),
  /**
   * Where test substrate lives in this project, from `design.md`. The oracle
   * and every support go under one of these, and a manifest that named a
   * production path would be proposing to measure a value from inside it.
   */
  testPaths: z.array(z.string()),
  /** Named defects the last proposal had. Empty on the first attempt. */
  defects: z.array(z.custom<ManifestDefect>(() => true)),
});
export type ProposeInput = z.infer<typeof ProposeInput>;

export const ProposeOutput = stepOutput(PROPOSE_OUTCOMES, {
  values: z.array(ProposedValue),
  rationale: z.string().max(600),
});
export type ProposeOutput = z.infer<typeof ProposeOutput>;

export type ProposeCtx = { input: ProposeInput; output: ProposeOutput };

/* ------------------------------------------------------------ requirements */

/**
 * The rules bound to the leaf, each with a mechanical check, and each check
 * delegating to `manifest.ts`. That delegation is the point: the same
 * predicate answers the leaf's own guardrail — which runs before a validator
 * model is spent — and the graph's gate, which runs on whatever got past it,
 * so a rule cannot hold at one and not the other.
 *
 * The ONE rule these cannot carry is `support-ignored`, because it is a
 * question about the repository rather than about the manifest and the leaf's
 * context has no repository in it. The gate owns that one alone, and says so.
 */
const manifestRule =
  (id: string, sourceId: string, text: string, kind: ManifestDefectKind) =>
  (decisions: readonly string[]): Requirement<ProposeCtx> => ({
    id,
    sourceId,
    text,
    decisions,
    check: ({ input, output }) => {
      const defect = manifestDefects({
        manifest: { values: output.payload.values },
        roadmap: input.roadmap,
      }).find((d) => d.kind === kind);
      return defect === undefined ? null : { requirementId: id, evidence: describeManifestDefect(defect) };
    },
  });

export const everyValueIsARoadmapObservation = manifestRule(
  "distill.observation-comes-from-the-roadmap",
  "des.distill.handover-conflict",
  "Every value's `observation` is copied VERBATIM from a roadmap step. It is the key the value is " +
    "addressed by, so a near miss is a value about something else rather than a typo.",
  "unknown-observation",
);

export const everyRoadmapStepIsCovered = manifestRule(
  "distill.every-step-gets-a-value",
  "des.distill.handover-conflict",
  "Every step in the roadmap gets exactly one value. A step with no value reaches delivery with no " +
    "oracle, and nothing downstream can supply one.",
  "uncovered-value",
);

export const everyValueHasAnObligation = manifestRule(
  "distill.every-value-has-an-obligation",
  "des.distill.acceptance-facts-are-invalid",
  "Every value declares at least one acceptance obligation. A value that must satisfy nothing " +
    "cannot be measured, so there is nothing for an oracle to assert.",
  "no-obligations",
);

export const obligationIdsAreUnique = manifestRule(
  "distill.obligation-ids-are-unique",
  "des.distill.acceptance-facts-are-invalid",
  "Obligation ids are unique within a value. Two obligations claiming one id make every finding " +
    "about either of them ambiguous.",
  "duplicate-obligation-id",
);

export const oracleIsOneSafeLocator = manifestRule(
  "distill.oracle-is-one-safe-locator",
  "des.distill.oracle-locator-grammar",
  "Each value declares exactly ONE oracle, as a repository-relative `path::selector` or a bare " +
    "path. No absolute path and no `..`: the oracle is a thing this repository runs.",
  "oracle-not-a-locator",
);

export const supportsAreWholeFiles = manifestRule(
  "distill.supports-are-whole-files",
  "des.distill.support-locator-grammar",
  "Each support is a repository-relative whole FILE, never a locator with a selector: a support is " +
    "a dependency of the oracle rather than a thing that is run.",
  "support-not-a-whole-file",
);

export const supportsAreNotTheOracle = manifestRule(
  "distill.a-support-is-not-the-oracle",
  "des.distill.support-locator-grammar",
  "A support never names the oracle's own file. The oracle is the one path the crafter may not " +
    "write and a support is one it may; a path that is both makes the wall ambiguous.",
  "support-is-the-oracle",
);

/**
 * The obligation's own shape, as a rule the model is refuted against. It has no
 * mechanical check beyond blankness, because the difference between "complete
 * works" and a stimulus with an expected result is a judgement about meaning.
 */
export const obligationsAreStimulusAndResult = (
  decisions: readonly string[],
): Requirement<ProposeCtx> => ({
  id: "distill.obligation-is-a-stimulus-and-a-result",
  sourceId: "des.distill.acceptance-obligation",
  text:
    "Each obligation is a STIMULUS a reader could apply and the EXPECTED result they would then " +
    "observe, both through the public surface the design declares. Neither is a restatement of " +
    "the observation, and neither names a private field, a helper, or an internal step.",
  decisions,
});

/**
 * Completeness, as the rule it actually is. Not a checklist and not a count:
 * a TOTAL RELATION in both directions, which is nwave's
 * `nw-at-completeness-check` verbatim.
 */
export const completenessIsATotalRelation = (
  decisions: readonly string[],
): Requirement<ProposeCtx> => ({
  id: "distill.completeness-is-a-total-relation",
  sourceId: "nw-at-completeness-check",
  text:
    "Every declared obligation maps to one or more falsifiable observations, and every observation " +
    "the oracle will make maps to exactly one declared obligation. Both directions, or the value " +
    "is not covered. Never invent coverage from a fixed checklist, a scenario count, a percentage, " +
    "a test pyramid or a framework convention.",
  decisions,
});

export const substrateLivesInTestPaths = (decisions: readonly string[]): Requirement<ProposeCtx> => ({
  id: "distill.oracle-and-supports-are-test-substrate",
  sourceId: "des.oracle.designer-owns-test-paths",
  text:
    "The oracle and every support live under one of the declared test paths. A path is test " +
    "substrate because of where it sits, and naming it somewhere else never moves it.",
  decisions,
  check: ({ input, output }) => {
    const under = (path: string) =>
      input.testPaths.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`));
    for (const value of output.payload.values) {
      const paths = [value.oracle.split("::")[0] ?? value.oracle, ...value.supports];
      const outside = paths.find((path) => !under(path));
      if (outside !== undefined) {
        return {
          requirementId: "distill.oracle-and-supports-are-test-substrate",
          evidence: `${outside} is not under ${input.testPaths.join(", ")}`,
        };
      }
    }
    return null;
  },
});

/* ----------------------------------------------------------------- prompts */

const SYSTEM =
  "You state, for every step of one roadmap, what it must be OBSERVED to do. Each obligation is a " +
  "stimulus a reader could apply through the declared public surface and the expected result they " +
  "would then see. You also name the ONE oracle file that will measure the value and any " +
  "whole-file test substrate it depends on. You do not write the test; you say what it has to " +
  "establish and where it will live.";

const renderDefects = (defects: readonly ManifestDefect[]): string =>
  defects.length === 0
    ? ""
    : `\n\nYour last manifest was refused:\n${defects.map((d) => `- ${describeManifestDefect(d)}`).join("\n")}`;

const prompt = (i: ProposeInput): string =>
  [
    `Design source:\n${i.design}`,
    `Test substrate lives under: ${i.testPaths.join(", ")}`,
    `Roadmap for: ${i.roadmap.request}`,
    i.roadmap.steps
      .map((step) =>
        [
          `- id: ${step.id}`,
          `  observation: ${step.observation}`,
          `  authority: ${step.authority}`,
          `  predictedTouches: ${step.predictedTouches.join(", ") || "(none)"}`,
        ].join("\n"),
      )
      .join("\n"),
  ].join("\n\n") + renderDefects(i.defects);

/* --------------------------------------------------------------- step defs */

export type ObligationsModels = {
  worker: ModelBinding;
  validator: ModelBinding;
  escalateTo?: ModelBinding;
};

export type ObligationsDefs = {
  "propose-obligations": StepDef<ProposeInput, ProposeOutput>;
};

export const obligationsDefs = (models: ObligationsModels): ObligationsDefs => ({
  "propose-obligations": {
    id: leafStepId("propose-obligations"),
    version: 1,
    input: ProposeInput,
    output: ProposeOutput,
    requirements: [
      everyValueIsARoadmapObservation,
      everyRoadmapStepIsCovered,
      everyValueHasAnObligation,
      obligationIdsAreUnique,
      oracleIsOneSafeLocator,
      supportsAreWholeFiles,
      supportsAreNotTheOracle,
      substrateLivesInTestPaths,
      obligationsAreStimulusAndResult,
      completenessIsATotalRelation,
    ].map((row) => row(PROPOSE_OUTCOMES)),
    worker: { model: models.worker, system: SYSTEM, prompt },
    validator: { model: models.validator },
    maxAttempts: 2,
    ...(models.escalateTo === undefined ? {} : { escalateTo: models.escalateTo }),
  },
});
