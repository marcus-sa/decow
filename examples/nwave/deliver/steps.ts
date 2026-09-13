/**
 * The DELIVER step cycle, leaf side.
 *
 * nWave's DELIVER wave runs each roadmap step through a RED -> GREEN -> COMMIT
 * cycle with a crafter, a reviewer, a quality gate, and a phase log. Today
 * that order is enforced after the fact, by hooks checking the log. Here RED is
 * enforced one layer up, as a readiness precondition: a row whose oracle has no
 * recorded `red` verdict never becomes ready, so no run of this cycle exists
 * that skipped it.
 *
 * This file is consumer-side: the closed decision space of each leaf, its
 * requirement rows, and its prompt. The model bindings are injected (see
 * `deliverDefs`), so a test constructs no agent and spends no token.
 *
 * ONE leaf classifies and its enum is the interesting one. The rest are
 * generative — "make this AT pass with the minimal change" is code generation,
 * not a closed-enum decision — so their decision space is a singleton and the
 * routable outcome downstream is the effect's result or the validator's.
 *
 * There is no leaf for "did the suite pass". There used to be, classifying
 * runner output the caller had seeded, and it was the wrong shape: a suite's
 * outcome is the outcome of running it, so the graph asks for a `run-tests`
 * effect and routes the typed result. A model is not needed to read an exit
 * code, and one that could disagree with it is a second source of truth for a
 * fact the runner already answered.
 *
 * There is no leaf for THE QUALITY GATE either, and it is the same argument
 * one node over. A gate run is a declared lint command, and whether it found
 * anything is its exit status. So `gates` is a step that emits a `run-command`
 * effect and a pure branch reads the result; the model that used to classify
 * that output now only ever sees it in order to FIX it, which is judgement and
 * stays a leaf.
 *
 * There is no leaf for RED either, for the same reason one layer further out.
 * `des oracle` authored the oracle and SOFTWARE executed it: the two roles that
 * hold an oracle cannot run it, so "this oracle fails on its assertion and not
 * on its scaffolding" is a property the runner owns and measures. The verdict
 * is a row this cycle reads, never a judgement it makes.
 *
 * Nothing else here runs a test, writes a symbol, or shells out. The leaves
 * are classifications over evidence the state carries, and `implement`'s
 * effect is handed to whatever executor the caller injected.
 */

import { z } from "zod";
import { verbatim } from "@des/core/checks/verbatim";
import type { Requirement } from "@des/core/requirement";
import { stepOutput, type ModelBinding, type StepDef } from "@des/core/step";

/**
 * One acceptance obligation of the row, as DISTILL left it: a stimulus and the
 * result it expects. The crafter reads both, because "what would I do and what
 * should I then see" is the question an implementation answers.
 */
export const AcceptanceObligation = z.object({
  id: z.string(),
  stimulus: z.string(),
  expected: z.string(),
});
export type AcceptanceObligation = z.infer<typeof AcceptanceObligation>;

/** The roadmap row under delivery. Authored upstream; never inferred here. */
export const StepUnderDelivery = z.object({
  id: z.string(),
  /** The acceptance criteria, verbatim from the roadmap row. */
  criteria: z.string(),
  /** The public API surface the accepted design declares, verbatim. */
  design: z.string(),
  /** A locator into the design source this step implements. */
  authority: z.string(),
  /** What the step must satisfy to be accepted. At least one. */
  acceptance: z.array(AcceptanceObligation),
  /** Symbol ids or paths the row predicted it would write. */
  predictedTouches: z.array(z.string()),
  /**
   * The oracle measuring this row, as DISTILL declared it. Carried so the
   * crafter can READ the assertion it is being measured against; the executor
   * is what stops it writing there.
   */
  oracle: z.string().optional(),
});
export type StepUnderDelivery = z.infer<typeof StepUnderDelivery>;

/**
 * What every leaf reads. `evidence` is verbatim runner or gate output and
 * `impacted` is the test-impact floor a VCS query produced; no runner and no
 * VCS are wired in this prototype, so the graph carries both rather than
 * producing them. Only some prompts read each field, the same way only some
 * read `evidence`.
 */
export const LeafInput = z.object({
  step: StepUnderDelivery,
  evidence: z.string(),
  /** Test ids the VCS impact graph considers impacted. Carried, not produced. */
  impacted: z.array(z.string()),
  /** The symbol `implement` rewrote, once it has. Its payload, carried. */
  wrote: z.string().optional(),
});
export type LeafInput = z.infer<typeof LeafInput>;

/* ------------------------------------------------------------------ leaves */

export const LEAF_IDS = [
  "implement",
  "select-tests",
  "diagnose",
  "fix-acceptance-test",
  "surface-design-gap",
  "refactor",
  "fix-lint",
  "commit",
] as const;
export type LeafId = (typeof LEAF_IDS)[number];

/**
 * Which tests to run, ABOVE the impact floor. The floor is the VCS's — the
 * impact graph derives it from the symbols the write touched — and this leaf
 * decides only whether anything should be added to it. The decision space is
 * therefore two words, and the ids themselves are payload the graph carries
 * and never branches on: a set of test ids is not a closed enum, so it cannot
 * be allowed to drive an edge, and keeping it out of the decision is also
 * what keeps the enumerated path space from multiplying by the size of the
 * suite.
 *
 * There is no `fewer`, and that is the rule rather than an omission. See
 * `src/core/effects.ts` on `run-tests`: the executor runs
 * `impactedTests(symbols) ∪ extra` and refuses a union that misses a test the
 * floor holds, so subtraction is not a decision this leaf could make.
 */
export const SELECT_TESTS_OUTCOMES = ["no-extra", "extra"] as const;
export type SelectTestsOutcome = (typeof SELECT_TESTS_OUTCOMES)[number];

/**
 * Why the suite is still red. Four causes, each owned by a different agent: the
 * implementation, the acceptance test, the design, or the runner. Classifying
 * before retrying is what stops a wrong acceptance test from burning the
 * implement budget, and what stops a missing design from being filled in by
 * inventing API.
 */
export const DIAGNOSE_OUTCOMES = [
  "impl-wrong",
  "at-wrong",
  "design-missing",
  "harness-failed",
] as const;
export type DiagnoseOutcome = (typeof DIAGNOSE_OUTCOMES)[number];

/** The generative leaves. One decision each: they did the work, or they did not. */
export const IMPLEMENT_OUTCOMES = ["written"] as const;
export const REFACTOR_OUTCOMES = ["refactored"] as const;
export const FIX_LINT_OUTCOMES = ["fixed"] as const;
export const COMMIT_OUTCOMES = ["committed"] as const;
export const FIX_AT_OUTCOMES = ["fixed"] as const;
export const DESIGN_GAP_OUTCOMES = ["surfaced"] as const;

export type ImplementOutcome = (typeof IMPLEMENT_OUTCOMES)[number];
export type RefactorOutcome = (typeof REFACTOR_OUTCOMES)[number];
export type FixLintOutcome = (typeof FIX_LINT_OUTCOMES)[number];
export type CommitOutcome = (typeof COMMIT_OUTCOMES)[number];
export type FixAtOutcome = (typeof FIX_AT_OUTCOMES)[number];
export type DesignGapOutcome = (typeof DESIGN_GAP_OUTCOMES)[number];

/** The decision space of each leaf, by id. One table, read by the harness too. */
export const LEAF_DECISIONS = {
  implement: IMPLEMENT_OUTCOMES,
  "select-tests": SELECT_TESTS_OUTCOMES,
  diagnose: DIAGNOSE_OUTCOMES,
  "fix-acceptance-test": FIX_AT_OUTCOMES,
  "surface-design-gap": DESIGN_GAP_OUTCOMES,
  refactor: REFACTOR_OUTCOMES,
  "fix-lint": FIX_LINT_OUTCOMES,
  commit: COMMIT_OUTCOMES,
} as const satisfies Record<LeafId, readonly [string, ...string[]]>;

/* ------------------------------------------------------------------ output */

/** The one decision each leaf may return, by leaf id. */
export type LeafDecision = { [K in LeafId]: (typeof LEAF_DECISIONS)[K][number] };

/**
 * The payload the graph carries but never reads. A classifying leaf quotes the
 * evidence; the one generative leaf that writes returns the symbol it rewrote;
 * the leaf that surfaces a design gap returns the description a person reads.
 */
export type LeafPayload<K extends LeafId> = K extends "implement"
  ? { symbolId: string; body: string; rationale: string }
  : K extends "surface-design-gap"
    ? { gap: string; rationale: string }
    : K extends "select-tests"
      ? { extra: string[]; rationale: string }
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

/**
 * The leaf that selects tests above the impact floor. The ids are payload, not
 * decision, so the graph carries them to the effect and never branches on
 * them.
 */
const selection = <D extends readonly [string, ...string[]]>(decisions: D) =>
  stepOutput(decisions, {
    extra: z
      .array(z.string())
      .describe("Test ids to run in ADDITION to the impact floor. Empty when no-extra."),
    rationale: z.string().max(300),
  });

/** The leaf that surfaces a design gap: the description a person has to read. */
const gapReport = <D extends readonly [string, ...string[]]>(decisions: D) =>
  stepOutput(decisions, {
    gap: z
      .string()
      .describe("The surface the acceptance test needs that the design does not name"),
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

/**
 * The rule that makes `design-missing` a route rather than a judgement call. A
 * gap the design left is surfaced to a person; it is never closed by inventing
 * the surface the test happens to need.
 */
export const designGapIsNotInventedApi = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.design-gap-goes-to-a-person",
  sourceId: "claude.implement-to-the-design",
  text:
    "When the acceptance test needs a public surface the accepted design does not name, that is " +
    "design-missing. Do not report impl-wrong and do not invent the surface: the gap is surfaced " +
    "to a person, who decides.",
  decisions,
});

/**
 * The rule that stops `at-wrong` becoming a licence to weaken the test. Fixing
 * an acceptance test changes how the criterion is asserted, never which one.
 */
export const atFixPreservesTheCriterion = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.at-fix-preserves-the-criterion",
  sourceId: "testing.red-scaffolds-and-activation",
  text:
    "An acceptance test may be corrected only in how it asserts the step's criterion, never in " +
    "which criterion it asserts. An assertion weakened until the suite is green is testing theatre.",
  decisions,
});

/** The `extra` array a selection returned, defensively. */
const extraOf = (ctx: LeafCtx): string[] => {
  const raw = ctx.output.payload.extra;
  return Array.isArray(raw) ? raw.map(String) : [];
};

/**
 * The union rule, as the rule text the selecting leaf is refuted against. The
 * floor is not this leaf's to shrink — the executor recomputes it and refuses
 * a union that misses one of its tests — so what the leaf is held to here is
 * the honest framing of what it may do.
 */
export const testsMayBeAddedNeverRemoved = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.tests-may-be-added-never-removed",
  sourceId: "testing.impact-floor-is-the-vcs",
  text:
    "The impact floor is every test the VCS considers impacted by the symbols this step wrote, and " +
    "it always runs. You may ADD test ids the static impact graph cannot see. You may never remove " +
    "one, narrow the floor, or propose running fewer tests than it holds.",
  decisions,
});

/**
 * The mechanical half: the decision and the payload must agree. `no-extra`
 * with ids in `extra` and `extra` with none are the two ways a selection can
 * contradict itself, and neither costs a model call to catch.
 */
export const selectionMatchesItsDecision = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.selection-matches-its-decision",
  sourceId: "framework.decision-is-the-only-field-the-graph-reads",
  text:
    "Report `extra` with at least one test id, or `no-extra` with an empty list. The decision is " +
    "what the graph routes and the list is what runs; a decision its own payload contradicts is " +
    "not a selection.",
  decisions,
  check: (ctx) => {
    const extra = extraOf(ctx);
    const id = "deliver.selection-matches-its-decision";
    if (ctx.output.decision === "no-extra" && extra.length > 0) {
      return { requirementId: id, evidence: `no-extra with ${extra.length} id(s): ${extra.join(", ")}` };
    }
    if (ctx.output.decision === "extra" && extra.length === 0) {
      return { requirementId: id, evidence: "extra with an empty list" };
    }
    return null;
  },
});

export const scopeIsTheStep = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.gate-findings-are-in-scope-fixes",
  sourceId: "claude.deferrals-require-issues",
  text:
    "Lint findings inside the step's own scope are in-scope fixes, not deferrals. Fix what the " +
    "declared lint command reported about this step's own files, and nothing else.",
  decisions,
});

/**
 * Which rules bind to which leaf. `decisions` is the closed space of the leaf
 * the row is bound to, so one rule text can bind to steps with different
 * decision spaces without either of them hardcoding the other.
 */
const REQUIREMENTS: { [K in LeafId]: ((d: readonly string[]) => Requirement<LeafCtx>)[] } = {
  implement: [noInventedApi, minimalChange],
  "select-tests": [testsMayBeAddedNeverRemoved, selectionMatchesItsDecision],
  diagnose: [anchorMustBeVerbatim, outcomesAreDistinct, designGapIsNotInventedApi],
  "fix-acceptance-test": [atFixPreservesTheCriterion, noInventedApi],
  "surface-design-gap": [designGapIsNotInventedApi, noInventedApi],
  refactor: [noInventedApi],
  "fix-lint": [noInventedApi, scopeIsTheStep],
  commit: [noInventedApi],
};

/* ----------------------------------------------------------------- prompts */

const SYSTEM: Record<LeafId, string> = {
  implement:
    "You make one acceptance test pass with the minimal change to one symbol. Build only the API the " +
    "design names. Report `written` and return the symbol and its new body.",
  "select-tests":
    "You choose whether any test should run IN ADDITION to the impact floor the VCS already " +
    "computed. The floor always runs and you cannot narrow it. Report `extra` with the ids to add, " +
    "or `no-extra` with an empty list.",
  diagnose:
    "You classify WHY one acceptance test is still red, so the failure is routed to whoever owns " +
    "it: impl-wrong (the production code), at-wrong (the test asserts the criterion wrongly), " +
    "design-missing (the test needs a surface the design does not name), harness-failed (the " +
    "runner produced no verdict). Answer with one word. Quote the runner output verbatim in `anchor`.",
  "fix-acceptance-test":
    "You correct how one acceptance test asserts its step's criterion, and nothing else. You do " +
    "not change which criterion it asserts and you do not touch production code. Report `fixed`.",
  "surface-design-gap":
    "You describe the public surface the acceptance test needs that the accepted design does not " +
    "name. You do not invent it and you do not write code. Report `surfaced` and put the " +
    "description in `gap`.",
  refactor:
    "You refactor the change you just made without altering behaviour or public surface. Report `refactored`.",
  "fix-lint": "You fix the lint findings inside this step's scope and nothing else. Report `fixed`.",
  commit: "You write the step's commit with its phase trailers. Report `committed`.",
};

const PROMPT: Record<LeafId, (i: LeafInput) => string> = {
  implement: (i) =>
    `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}\n\n` +
    `The design declares exactly this surface:\n${i.step.design}\n\nRunner output:\n${i.evidence}`,
  "select-tests": (i) =>
    `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}\n\n` +
    `The symbol this step wrote:\n${i.wrote ?? "(nothing written yet)"}\n\n` +
    `The impact floor already runs these tests:\n` +
    `${i.impacted.length === 0 ? "(none)" : i.impacted.map((t) => `- ${t}`).join("\n")}`,
  diagnose: (i) =>
    `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}\n\n` +
    `The design declares exactly this surface:\n${i.step.design}\n\nRunner output:\n${i.evidence}`,
  "fix-acceptance-test": (i) =>
    `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}\n\nRunner output:\n${i.evidence}`,
  "surface-design-gap": (i) =>
    `Step ${i.step.id}\n\nAcceptance criteria:\n${i.step.criteria}\n\n` +
    `The design declares exactly this surface:\n${i.step.design}\n\nRunner output:\n${i.evidence}`,
  refactor: (i) => `Step ${i.step.id}\n\nThe design declares exactly this surface:\n${i.step.design}`,
  "fix-lint": (i) => `Step ${i.step.id}\n\nLint output:\n${i.evidence}`,
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
  /**
   * Per-leaf worker override, falling back to `worker`. The diagnosis branch
   * routes each cause to the agent that owns it, and "which agent" is a
   * binding, so the routing is expressed here rather than in the graph. A test
   * that supplies only `worker` stubs every leaf the same way.
   */
  workers?: Partial<Record<LeafId, ModelBinding>>;
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
    output: (leaf === "implement"
      ? change(decisions)
      : leaf === "surface-design-gap"
        ? gapReport(decisions)
        : leaf === "select-tests"
          ? selection(decisions)
          : classification(decisions)) as unknown as z.ZodType<LeafOutputFor<K>>,
    requirements: REQUIREMENTS[leaf].map((row) => row(decisions)) as Requirement<{
      input: LeafInput;
      output: LeafOutputFor<K>;
    }>[],
    worker: {
      model: models.workers?.[leaf] ?? models.worker,
      system: SYSTEM[leaf],
      prompt: PROMPT[leaf],
    },
    validator: { model: models.validator },
    maxAttempts: 2,
    escalateTo: models.escalateTo,
  };
};

export type DeliverDefs = { [K in LeafId]: LeafDef<K> };

export const deliverDefs = (models: DeliverModels): DeliverDefs =>
  Object.fromEntries(LEAF_IDS.map((leaf) => [leaf, leafDef(leaf, models)])) as DeliverDefs;
