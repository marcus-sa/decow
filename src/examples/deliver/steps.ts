/**
 * The DELIVER step cycle, leaf side.
 *
 * nWave's DELIVER wave runs each roadmap step through a RED -> GREEN -> COMMIT
 * cycle with a crafter, a reviewer, a mutation gate, and a phase log. Today
 * that order is enforced after the fact, by hooks checking the log. Here it is
 * enforced by topology: no edge bypasses RED.
 *
 * This file is consumer-side: the closed decision space of each leaf, its
 * requirement rows, and its prompt. The model bindings are injected (see
 * `deliverDefs`), so a test constructs no agent and spends no token.
 *
 * Three leaves classify and their enums are the interesting ones. The rest are
 * generative — "make this AT pass with the minimal change" is code generation,
 * not a closed-enum decision — so their decision space is a singleton and the
 * routable outcome downstream is the effect's result or the validator's.
 *
 * Nothing here runs a test, writes a symbol, or shells out. The leaves are
 * classifications over evidence the state carries, and `implement`'s effect is
 * handed to whatever executor the caller injected. See the README's
 * "Not built yet".
 */

import { z } from "zod";
import { verbatim } from "../../checks/verbatim.ts";
import type { Requirement } from "../../core/requirement.ts";
import { stepOutput, type ModelBinding, type StepDef } from "../../core/step.ts";

/** The roadmap row under delivery. Authored upstream; never inferred here. */
export const StepUnderDelivery = z.object({
  id: z.string(),
  /** The acceptance criteria, verbatim from the roadmap row. */
  criteria: z.string(),
  /** The public API surface the accepted design declares, verbatim. */
  design: z.string(),
});
export type StepUnderDelivery = z.infer<typeof StepUnderDelivery>;

/**
 * What every leaf reads. `evidence` is verbatim runner or gate output; no
 * runner is wired in this prototype, so the graph carries it rather than
 * producing it.
 */
export const LeafInput = z.object({
  step: StepUnderDelivery,
  evidence: z.string(),
});
export type LeafInput = z.infer<typeof LeafInput>;

/* ------------------------------------------------------------------ leaves */

export const LEAF_IDS = [
  "activate-at",
  "run-tests.red",
  "implement",
  "run-tests",
  "refactor",
  "gates",
  "fix-lint",
  "add-test",
  "commit",
] as const;
export type LeafId = (typeof LEAF_IDS)[number];

/** The first run of the activated acceptance test, before any production code. */
export const RED_OUTCOMES = ["red-observed", "already-green", "harness-failed"] as const;
export type RedOutcome = (typeof RED_OUTCOMES)[number];

/** Every later run of the suite. */
export const TEST_OUTCOMES = ["green", "still-red", "broke-other", "harness-failed"] as const;
export type TestOutcome = (typeof TEST_OUTCOMES)[number];

/** The quality gate: clippy, the mutation kill rate, and scope. */
export const GATE_OUTCOMES = [
  "clean",
  "clippy-in-scope",
  "mutation-below-gate",
  "out-of-scope-structural",
] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** The generative leaves. One decision each: they did the work, or they did not. */
export const ACTIVATE_OUTCOMES = ["activated"] as const;
export const IMPLEMENT_OUTCOMES = ["written"] as const;
export const REFACTOR_OUTCOMES = ["refactored"] as const;
export const FIX_LINT_OUTCOMES = ["fixed"] as const;
export const ADD_TEST_OUTCOMES = ["added"] as const;
export const COMMIT_OUTCOMES = ["committed"] as const;

export type ActivateOutcome = (typeof ACTIVATE_OUTCOMES)[number];
export type ImplementOutcome = (typeof IMPLEMENT_OUTCOMES)[number];
export type RefactorOutcome = (typeof REFACTOR_OUTCOMES)[number];
export type FixLintOutcome = (typeof FIX_LINT_OUTCOMES)[number];
export type AddTestOutcome = (typeof ADD_TEST_OUTCOMES)[number];
export type CommitOutcome = (typeof COMMIT_OUTCOMES)[number];

/** The decision space of each leaf, by id. One table, read by the harness too. */
export const LEAF_DECISIONS = {
  "activate-at": ACTIVATE_OUTCOMES,
  "run-tests.red": RED_OUTCOMES,
  implement: IMPLEMENT_OUTCOMES,
  "run-tests": TEST_OUTCOMES,
  refactor: REFACTOR_OUTCOMES,
  gates: GATE_OUTCOMES,
  "fix-lint": FIX_LINT_OUTCOMES,
  "add-test": ADD_TEST_OUTCOMES,
  commit: COMMIT_OUTCOMES,
} as const satisfies Record<LeafId, readonly [string, ...string[]]>;

/* ------------------------------------------------------------------ output */

/** The one decision each leaf may return, by leaf id. */
export type LeafDecision = { [K in LeafId]: (typeof LEAF_DECISIONS)[K][number] };

/**
 * The payload the graph carries but never reads. A classifying leaf quotes the
 * evidence; the one generative leaf that writes returns the symbol it rewrote.
 */
export type LeafPayload<K extends LeafId> = K extends "implement"
  ? { symbolId: string; body: string; rationale: string }
  : { anchor: string; rationale: string };

export type LeafOutputFor<K extends LeafId> = {
  decision: LeafDecision[K];
  payload: LeafPayload<K>;
};

/** A classifying leaf: the decision, plus the quote that justifies it. */
const classification = <D extends readonly [string, ...string[]]>(decisions: D) =>
  stepOutput(decisions, {
    anchor: z.string().describe("Verbatim quote from the evidence that justifies the decision"),
    rationale: z.string().max(300),
  });

/** The one generative leaf that writes: the decision, plus the symbol it rewrote. */
const change = <D extends readonly [string, ...string[]]>(decisions: D) =>
  stepOutput(decisions, {
    symbolId: z.string(),
    body: z.string(),
    rationale: z.string().max(300),
  });

/* ------------------------------------------------------------ requirements */

export type LeafCtx = { input: LeafInput; output: { decision: string; payload: Record<string, unknown> } };

/**
 * The mechanical check for a classifying leaf: it must quote the evidence it
 * classified. A verdict with no grounding in the runner output is the failure
 * this costs nothing to catch.
 */
export const anchorMustBeVerbatim = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.anchor-verbatim",
  sourceId: "verification.enforcement.unanchored-claims",
  text: "The justification must quote the test or gate output verbatim. Paraphrase is an unanchored claim.",
  decisions,
  check: verbatim(
    "deliver.anchor-verbatim",
    (ctx: LeafCtx) => ctx.input.evidence,
    (ctx: LeafCtx) => String(ctx.output.payload.anchor ?? ""),
  ),
});

/**
 * The rule a generative leaf is refuted against. It has no mechanical check
 * here: the symbol-set difference that would make it mechanical needs a symbol
 * inventory, which needs the VCS. See the README's "Not built yet".
 */
export const noInventedApi = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.implement-to-the-design",
  sourceId: "claude.implement-to-the-design",
  text:
    "Build only the API the design names. Do not add a public method, type, variant, trait, or " +
    "parameter to make a test pass or to fill a gap the design left underspecified. Surface the gap.",
  decisions,
});

export const minimalChange = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.minimal-change",
  sourceId: "claude.red-green-commit",
  text: "Make the acceptance test pass with the minimal change. Do not implement beyond the step's criteria.",
  decisions,
});

export const outcomesAreDistinct = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.harness-failure-is-not-a-red-test",
  sourceId: "testing.distinct-failure-modes",
  text:
    "A harness failure is not a failing test. Report harness-failed when the runner itself could not " +
    "produce a verdict, so a flaky run does not burn the implement retry budget.",
  decisions,
});

export const vacuousAtIsTestingTheatre = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.already-green-is-testing-theatre",
  sourceId: "testing.red-scaffolds-and-activation",
  text:
    "An acceptance test that passes before any production code is written proves nothing. Report " +
    "already-green; it is a testing-theatre signal, not a shortcut to COMMIT.",
  decisions,
});

export const scopeIsTheStep = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.gate-findings-are-in-scope-fixes",
  sourceId: "claude.deferrals-require-issues",
  text:
    "Clippy findings inside the step's own scope are in-scope fixes, not deferrals. A structural " +
    "problem outside the step's scope is out-of-scope-structural and goes to a person.",
  decisions,
});

/**
 * Which rules bind to which leaf. `decisions` is the closed space of the leaf
 * the row is bound to, so one rule text can bind to steps with different
 * decision spaces without either of them hardcoding the other.
 */
const REQUIREMENTS: { [K in LeafId]: ((d: readonly string[]) => Requirement<LeafCtx>)[] } = {
  "activate-at": [noInventedApi],
  "run-tests.red": [anchorMustBeVerbatim, vacuousAtIsTestingTheatre, outcomesAreDistinct],
  implement: [noInventedApi, minimalChange],
  "run-tests": [anchorMustBeVerbatim, outcomesAreDistinct],
  refactor: [noInventedApi],
  gates: [anchorMustBeVerbatim, scopeIsTheStep],
  "fix-lint": [noInventedApi, scopeIsTheStep],
  "add-test": [noInventedApi],
  commit: [noInventedApi],
};

/* ----------------------------------------------------------------- prompts */

const SYSTEM: Record<LeafId, string> = {
  "activate-at":
    "You remove the pending marker from one acceptance test and change nothing else. Report `activated`.",
  "run-tests.red":
    "You classify the FIRST run of a newly activated acceptance test, before any production code. " +
    "Answer with one word. Quote the runner output verbatim in `anchor`.",
  implement:
    "You make one acceptance test pass with the minimal change to one symbol. Build only the API the " +
    "design names. Report `written` and return the symbol and its new body.",
  "run-tests":
    "You classify one run of the suite. Answer with one word. Quote the runner output verbatim in `anchor`.",
  refactor:
    "You refactor the change you just made without altering behaviour or public surface. Report `refactored`.",
  gates:
    "You classify one quality-gate run: clippy, the mutation kill rate, and scope. Answer with one word. " +
    "Quote the gate output verbatim in `anchor`.",
  "fix-lint": "You fix the clippy findings inside this step's scope and nothing else. Report `fixed`.",
  "add-test": "You add one test that kills the surviving mutant named in the gate output. Report `added`.",
  commit: "You write the step's commit with its phase trailers. Report `committed`.",
};

const PROMPT: Record<LeafId, (i: LeafInput) => string> = {
  "activate-at": (i) => `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}`,
  "run-tests.red": (i) => `Step ${i.step.id}\n\nRunner output:\n${i.evidence}`,
  implement: (i) =>
    `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}\n\n` +
    `The design declares exactly this surface:\n${i.step.design}\n\nRunner output:\n${i.evidence}`,
  "run-tests": (i) => `Step ${i.step.id}\n\nRunner output:\n${i.evidence}`,
  refactor: (i) => `Step ${i.step.id}\n\nThe design declares exactly this surface:\n${i.step.design}`,
  gates: (i) => `Step ${i.step.id}\n\nGate output:\n${i.evidence}`,
  "fix-lint": (i) => `Step ${i.step.id}\n\nGate output:\n${i.evidence}`,
  "add-test": (i) => `Step ${i.step.id}\n\nGate output:\n${i.evidence}`,
  commit: (i) => `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}`,
};

/* -------------------------------------------------------------- step defs */

/**
 * The model bindings a consumer supplies. Injected rather than constructed
 * here, so the enumeration suite runs with no agent, no key, and no network.
 */
export type DeliverModels = {
  worker: ModelBinding;
  validator: ModelBinding;
  escalateTo?: ModelBinding;
};

/** Step id for a leaf. The journal keys on this. */
export const leafStepId = (leaf: LeafId): string => `deliver.${leaf}`;

export type LeafDef<K extends LeafId> = StepDef<LeafInput, LeafOutputFor<K>>;

export const leafDef = <K extends LeafId>(leaf: K, models: DeliverModels): LeafDef<K> => {
  const decisions = LEAF_DECISIONS[leaf];
  return {
    id: leafStepId(leaf),
    version: 1,
    input: LeafInput,
    // One cast, here and nowhere else: the concrete zod schema per leaf is
    // what `generateObject` is handed, and `LeafOutputFor<K>` is what the
    // graph sees. The two agree by construction of LEAF_DECISIONS.
    output: (leaf === "implement" ? change(decisions) : classification(decisions)) as unknown as z.ZodType<
      LeafOutputFor<K>
    >,
    requirements: REQUIREMENTS[leaf].map((row) => row(decisions)) as Requirement<{
      input: LeafInput;
      output: LeafOutputFor<K>;
    }>[],
    worker: { model: models.worker, system: SYSTEM[leaf], prompt: PROMPT[leaf] },
    validator: { model: models.validator },
    maxAttempts: 2,
    escalateTo: models.escalateTo,
  };
};

export type DeliverDefs = { [K in LeafId]: LeafDef<K> };

export const deliverDefs = (models: DeliverModels): DeliverDefs =>
  Object.fromEntries(LEAF_IDS.map((leaf) => [leaf, leafDef(leaf, models)])) as DeliverDefs;
