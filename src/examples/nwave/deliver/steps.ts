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
 * There is no leaf for "activate the acceptance test" either, and for the same
 * kind of reason one step further: locating a test by its declared locator is
 * a lookup and stripping a pending marker is a string operation. See
 * `./oracle.ts`.
 *
 * There is no leaf for "did the suite pass". There used to be, classifying
 * runner output the caller had seeded, and it was the wrong shape: a suite's
 * outcome is the outcome of running it, so the graph asks for a `run-tests`
 * effect and routes the typed result. A model is not needed to read an exit
 * code, and one that could disagree with it is a second source of truth for a
 * fact the runner already answered. `run-tests.red` is still a leaf, because
 * its question is not "did it pass" but "is this acceptance test vacuous",
 * which is a judgement about WHY it passed rather than a reading of whether it
 * did.
 *
 * Nothing else here runs a test, writes a symbol, or shells out. The leaves
 * are classifications over evidence the state carries, and `implement`'s
 * effect is handed to whatever executor the caller injected.
 */

import { z } from "zod";
import { verbatim } from "../../../checks/verbatim.ts";
import type { Requirement } from "../../../core/requirement.ts";
import { stepOutput, type ModelBinding, type StepDef } from "../../../core/step.ts";

/**
 * One acceptance obligation of the row, as the roadmap declared it.
 * `oracleLocator` names where its assertion lives when the acceptance designer
 * has already placed it; an obligation without one has no oracle for the
 * `oracle` node to locate, which is the normal state of a roadmap authored
 * before its tests were written.
 */
export const AcceptanceObligation = z.object({
  id: z.string(),
  text: z.string(),
  oracleLocator: z.string().optional(),
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
  "run-tests.red",
  "implement",
  "select-tests",
  "diagnose",
  "fix-acceptance-test",
  "surface-design-gap",
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

/** The quality gate: clippy, the mutation kill rate, and scope. */
export const GATE_OUTCOMES = [
  "clean",
  "clippy-in-scope",
  "mutation-below-gate",
  "out-of-scope-structural",
] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** The generative leaves. One decision each: they did the work, or they did not. */
export const IMPLEMENT_OUTCOMES = ["written"] as const;
export const REFACTOR_OUTCOMES = ["refactored"] as const;
export const FIX_LINT_OUTCOMES = ["fixed"] as const;
export const ADD_TEST_OUTCOMES = ["added"] as const;
export const COMMIT_OUTCOMES = ["committed"] as const;
export const FIX_AT_OUTCOMES = ["fixed"] as const;
export const DESIGN_GAP_OUTCOMES = ["surfaced"] as const;

export type ImplementOutcome = (typeof IMPLEMENT_OUTCOMES)[number];
export type RefactorOutcome = (typeof REFACTOR_OUTCOMES)[number];
export type FixLintOutcome = (typeof FIX_LINT_OUTCOMES)[number];
export type AddTestOutcome = (typeof ADD_TEST_OUTCOMES)[number];
export type CommitOutcome = (typeof COMMIT_OUTCOMES)[number];
export type FixAtOutcome = (typeof FIX_AT_OUTCOMES)[number];
export type DesignGapOutcome = (typeof DESIGN_GAP_OUTCOMES)[number];

/** The decision space of each leaf, by id. One table, read by the harness too. */
export const LEAF_DECISIONS = {
  "run-tests.red": RED_OUTCOMES,
  implement: IMPLEMENT_OUTCOMES,
  "select-tests": SELECT_TESTS_OUTCOMES,
  diagnose: DIAGNOSE_OUTCOMES,
  "fix-acceptance-test": FIX_AT_OUTCOMES,
  "surface-design-gap": DESIGN_GAP_OUTCOMES,
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

export const vacuousAtIsTestingTheatre = (decisions: readonly string[]): Requirement<LeafCtx> => ({
  id: "deliver.already-green-is-testing-theatre",
  sourceId: "testing.red-scaffolds-and-activation",
  text:
    "An acceptance test that passes before any production code is written proves nothing. Report " +
    "already-green; it is a testing-theatre signal, not a shortcut to COMMIT.",
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
  "run-tests.red": [anchorMustBeVerbatim, vacuousAtIsTestingTheatre, outcomesAreDistinct],
  implement: [noInventedApi, minimalChange],
  "select-tests": [testsMayBeAddedNeverRemoved, selectionMatchesItsDecision],
  diagnose: [anchorMustBeVerbatim, outcomesAreDistinct, designGapIsNotInventedApi],
  "fix-acceptance-test": [atFixPreservesTheCriterion, noInventedApi],
  "surface-design-gap": [designGapIsNotInventedApi, noInventedApi],
  refactor: [noInventedApi],
  gates: [anchorMustBeVerbatim, scopeIsTheStep],
  "fix-lint": [noInventedApi, scopeIsTheStep],
  "add-test": [noInventedApi],
  commit: [noInventedApi],
};

/* ----------------------------------------------------------------- prompts */

const SYSTEM: Record<LeafId, string> = {
  "run-tests.red":
    "You classify the FIRST run of a newly activated acceptance test, before any production code. " +
    "Answer with one word. Quote the runner output verbatim in `anchor`.",
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
  gates:
    "You classify one quality-gate run: clippy, the mutation kill rate, and scope. Answer with one word. " +
    "Quote the gate output verbatim in `anchor`.",
  "fix-lint": "You fix the clippy findings inside this step's scope and nothing else. Report `fixed`.",
  "add-test": "You add one test that kills the surviving mutant named in the gate output. Report `added`.",
  commit: "You write the step's commit with its phase trailers. Report `committed`.",
};

const PROMPT: Record<LeafId, (i: LeafInput) => string> = {
  "run-tests.red": (i) => `Step ${i.step.id}\n\nRunner output:\n${i.evidence}`,
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
