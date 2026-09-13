/**
 * The DELIVER step cycle as a graph. The design document's version of this
 * diagram draws back edges — `gates -> fix-lint -> gates`, `run-tests ->
 * implement -> run-tests`. Those are not edges here. They are three nested
 * `loop` nodes, each with a required bound:
 *
 *   cycle      repeat [ test-loop, refactor, gates-loop ] until gates are clean
 *     test-loop  repeat [ implement, select-tests, run-tests, diagnose ] until
 *                the test outcome is neither still-red nor broke-other
 *     gates-loop repeat [ gates, fix-lint ] until the gate outcome is not
 *                lint-failed
 *
 * `select-tests` sits between the write and the suite and decides one thing:
 * whether any test should run in ADDITION to the impact floor the VCS already
 * computed. Both of its decisions route to `run-tests`, because the selection
 * changes what runs rather than what happens next, and the ids it returns are
 * payload: a set of test ids is not a closed enum, and letting one drive an
 * edge would make the path space the size of the suite.
 *
 * THE CYCLE STARTS AT `implement`, and there is no RED node ahead of it. RED is
 * a fact this graph READS rather than one it establishes: `des oracle` authored
 * the oracle, software executed it, and the recorded verdict was `red` before
 * this row was ever ready (`examples/nwave/distill/oracle/`). A row with no
 * recorded red oracle never becomes ready, so "no edge bypasses RED" is a
 * readiness precondition here rather than a node — see `../distill/README` in
 * the nwave example's own README.
 *
 * `gates` is NOT a leaf either, and for the same reason `run-tests` is not:
 * whether the quality gate found anything is what RUNNING it answers. The node
 * emits a `run-command` effect built from the consumer's declared
 * `commands.lint` over the files this step writes, and `gate.route` is a pure
 * function of the result. Three answers, because three are what the graph
 * routes differently: exit zero is `clean`, any other exit is `lint-failed`,
 * and a command that could not be run at all is `infra-failed`, which is the
 * harness failing rather than the change being bad. `fix-lint` stays a leaf,
 * because writing the fix is judgement.
 *
 * `run-tests` is NOT a leaf. It emits a `run-tests` effect and `test.route`
 * routes the typed result, because whether the suite passed is what running it
 * answers. The split the branch reads is the failing ids against this step's
 * own acceptance tests: all of them its own is `still-red`, anything else is
 * `broke-other`, a refused selection is a contract violation that unwinds to a
 * person, and a conflict is impossible enough that treating it as a harness
 * failure is the honest arm.
 *
 * A still-red suite is classified before it is retried. `diagnose` answers
 * with the cause, and each cause goes to whoever owns it: `impl-wrong` is the
 * implement loop as it always was, `at-wrong` corrects the acceptance test and
 * re-runs the suite without re-implementing, `design-missing` leaves the cycle
 * for the architect and then a person, and `harness-failed` is the block it
 * already was one leaf up.
 *
 * A loop body leaves only through the loop's own id, so the "route this to a
 * person" edges the diagram draws from inside the cycle are, here, a block
 * recorded in state that makes every enclosing `until` true. The run unwinds
 * to `cycle.verdict` and that branch routes it to the one `human` node. That
 * is also how a bound being reached routes: the loop's `absorb` folds
 * `exhausted` into `loopExhausted`, `blockedReason` reads it, and the person
 * gets a distinct reason naming which loop ran out.
 *
 * Every decision function here is total over the state space the graph can
 * produce and closed over a named enum, so every edge table is exhaustive at
 * compile time.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import { normalizeCommand, type Commands } from "../../../src/core/commands.ts";
import { commandEffect, commandOf, commandOutput, type Effect, type EffectResult } from "../../../src/core/effects.ts";
import type { Journal } from "../../../src/core/journal.ts";
import type { StepObserver } from "../../../src/core/step.ts";
import {
  branch,
  leaf,
  loop,
  suspend,
  type LoopExit,
  type Node,
  type NodeId,
  type Workflow,
} from "../../../src/core/workflow.ts";
import {
  COMMIT_OUTCOMES,
  REFACTOR_OUTCOMES,
  SELECT_TESTS_OUTCOMES,
  type DeliverDefs,
  type DiagnoseOutcome,
  type LeafId,
  type LeafInput,
  type LeafOutputFor,
  type SelectTestsOutcome,
  type StepUnderDelivery,
} from "./steps.ts";

/* ------------------------------------------------------------------- bounds */

/**
 * The three bounds. Two is the smallest value that still exercises every edge:
 * one iteration to reach a retry, a second to reach the bound. Raising them
 * multiplies the enumerated path space without adding an edge.
 *
 * `MAX_CYCLES` is 1, and with no mutation command declared it is the only
 * value that could matter: nothing inside the cycle can invalidate a green
 * verdict, so the body runs once whatever the bound says (see
 * `ExhaustibleLoopId`).
 *
 * It was a budget decision with a measurement behind it while the mutation
 * gate existed, and the measurement is kept because the day a consumer
 * declares a mutation command the decision comes back with it. `select-tests`
 * sits inside `test-loop`, which sits inside `cycle`, so its multiplier
 * compounds once per (cycle x test) iteration. Measured on the walk, with the
 * other two bounds at 2: cutting `MAX_CYCLES` to 1 gave 450 paths in ~4.5 s;
 * cutting `MAX_GATE_ATTEMPTS` to 1 instead gave 5615 paths in ~254 s, because
 * it is not one of the two loops the new leaf is inside; cutting
 * `MAX_TEST_ATTEMPTS` to 1 would also work on time (285 paths, ~2 s) and is
 * the most expensive in signal — five tests depend on the test loop running
 * twice, including the whole `at-wrong` re-run-without-re-implementing claim
 * and both write-retry claims. So the cycle is the one that gave way.
 */
export const MAX_TEST_ATTEMPTS = 2;
export const MAX_GATE_ATTEMPTS = 2;
export const MAX_CYCLES = 1;

export const LOOP_IDS = ["test-loop", "gates-loop", "cycle"] as const;
export type LoopId = (typeof LOOP_IDS)[number];

/**
 * The loops whose bound is a reason a person is handed.
 *
 * The CYCLE is not one, and that is a fact about what can ask for a second
 * pass rather than a decision. `cycleDone` is "blocked, or the gates came back
 * clean", and every way the body can end is one or the other: a clean gate
 * leaves, and everything else — a test loop that ran out, a refactor whose
 * validator refused, a gate still failing at its own bound, a gate that could
 * not be run — sets a block. So `until` is true after every body, the bound is
 * never what stops the cycle, and a `cycle-exhausted` reason would be a word
 * nothing produces.
 *
 * It was produced once. `mutation-below-gate` routed to an `add-test` leaf
 * that invalidated the green verdict and sent the run round again, and both
 * are gone with the model that classified a gate run. The loop NODE stays,
 * because the day a consumer declares a mutation command the second pass comes
 * back with it.
 */
export type ExhaustibleLoopId = Exclude<LoopId, "cycle">;

/* -------------------------------------------------------------------- state */

/** The outcome of landing a write, from `EffectResult`. */
export type WriteOutcome = EffectResult["outcome"];

/** The decision each leaf last returned. Cleared when its validator refused. */
export type Leaves = {
  implement?: LeafOutputFor<"implement">["decision"];
  "select-tests"?: SelectTestsOutcome;
  diagnose?: DiagnoseOutcome;
  "fix-acceptance-test"?: LeafOutputFor<"fix-acceptance-test">["decision"];
  "surface-design-gap"?: LeafOutputFor<"surface-design-gap">["decision"];
  refactor?: LeafOutputFor<"refactor">["decision"];
  "fix-lint"?: LeafOutputFor<"fix-lint">["decision"];
  commit?: LeafOutputFor<"commit">["decision"];
};

/** The closed set of answers a person may give. */
export const HUMAN_DECISIONS = ["commit", "abandon"] as const;
export const HumanAnswer = z.object({ decision: z.enum(HUMAN_DECISIONS) });
export type HumanAnswer = z.infer<typeof HumanAnswer>;
export type HumanDecision = HumanAnswer["decision"];

/** The closed set of reasons this workflow may park for a person. */
export const HUMAN_REASONS = [
  "harness-failed",
  "design-gap",
  "validator-exhausted",
  "write-infra-failed",
  "test-selection-refused",
  "test-loop-exhausted",
  "gates-loop-exhausted",
] as const;
export type HumanReason = (typeof HUMAN_REASONS)[number];

const LOOP_EXHAUSTED: Record<ExhaustibleLoopId, HumanReason> = {
  "test-loop": "test-loop-exhausted",
  "gates-loop": "gates-loop-exhausted",
};

export type State = {
  step: StepUnderDelivery;
  /** Verbatim runner or gate output. Carried, not produced: no runner is wired. */
  evidence: string;
  /**
   * The test-impact floor, as a VCS query answered it. Carried, not produced:
   * no VCS is wired here either, and `select-tests` reads it to decide what to
   * ADD. It can never be narrowed from inside the graph — see the union rule
   * on `run-tests` in `src/core/effects.ts`.
   */
  impacted: string[];
  /** The optimistic version the next `replace-symbol` claims. */
  symbolVersion: number;
  /**
   * The repository-relative files this row writes, as the registry resolved
   * the row's predicted touches. Carried, not produced: the same boundary
   * `impacted` sits on, and for the same reason — a symbol id is opaque and
   * only the VCS can say which file holds it.
   *
   * This is what `gates` lints. An empty set is handed to the declared lint
   * command as an empty set; what a linter does with no paths is the
   * consumer's declaration to make, not this graph's.
   */
  paths: string[];

  leaf: Leaves;
  /**
   * The test ids of this step's own oracle, as the inventory reported them
   * when the row was made ready. Carried rather than resolved here: the oracle
   * was authored and measured red in its own run, and this graph reads the
   * result rather than re-deriving it.
   *
   * They are the set membership `test.route` uses to tell "my own oracle is
   * still red" from "I broke something else".
   */
  acceptanceTests: string[];
  /** How `implement`'s write landed. Cleared when `implement` did not write. */
  write?: WriteOutcome;
  /**
   * What came back from running the suite. The whole `EffectResult`, because
   * the routable facts are spread across it: the outcome, the gate that
   * refused, and the ids that failed. Cleared when a new run is asked for.
   */
  testRun?: EffectResult;
  /**
   * What came back from the quality gate: the declared lint command, run. The
   * whole `EffectResult` again, because the outcome is what the branch routes
   * and the output is what `fix-lint` reads. Cleared when a new gate run is
   * asked for.
   */
  gateRun?: EffectResult;
  /** The symbol `implement` last rewrote. Payload; never branched on. */
  wrote?: string;
  /**
   * Test ids `select-tests` chose above the floor. Payload; never branched on.
   * A `run-tests` effect would carry it as `extra`, and the executor would run
   * the union of it and the floor. See the README's "Not built yet".
   */
  extra: string[];
  /** The leaf whose validator was never satisfied, most recent wins. */
  exhausted?: LeafId;
  /** The first loop to run out of iterations. Never the cycle; see above. */
  loopExhausted?: ExhaustibleLoopId;
  /** Iterations each loop last ran, folded in by that loop's `absorb`. */
  iterations: Partial<Record<LoopId, number>>;
  /** What `surface-design-gap` wrote for a person. Payload; never branched on. */
  designGap?: string;

  /** Absorbed by the `human` suspend node; read only by `human.route`. */
  human?: HumanAnswer;
};

export const seed = (
  step: StepUnderDelivery,
  evidence: string,
  /** The impact floor a VCS query produced. Empty when nothing supplied one. */
  impacted: readonly string[] = [],
  /** The files this row writes, as the registry resolved them. */
  paths: readonly string[] = [],
): State => ({
  step,
  evidence,
  impacted: [...impacted],
  symbolVersion: 0,
  paths: [...paths],
  leaf: {},
  acceptanceTests: [],
  extra: [],
  iterations: {},
});

/* ------------------------------------------------------- decision functions */

/**
 * What is blocking, if anything. One pure function, read by every `until` and
 * by the branch after the outermost loop, so "this run needs a person" is
 * decided in one place and routed in several.
 *
 * First match wins. A run normally has exactly one block: whatever set it made
 * the enclosing loops' `until` true, and the run unwound immediately.
 */
export const blockedReason = (s: State): HumanReason | undefined => {
  if (
    testVerdict(s) === "harness-failed" ||
    s.leaf.diagnose === "harness-failed" ||
    // A declared lint command that could not be run at all. Not the change
    // being bad, so it must not burn the gates budget either.
    gateOutcome(s) === "infra-failed"
  ) {
    return "harness-failed";
  }
  // A selection that reached below the impact floor is the selecting leaf's
  // own contract violation, and there is nothing in the cycle that could
  // repair it: the floor is the VCS's and the leaf may only add to it.
  if (testVerdict(s) === "selection-refused") return "test-selection-refused";
  // Ahead of `exhausted` deliberately: once a design gap is the finding, it
  // stays the reason a person is handed, even when the leaf that was supposed
  // to describe it could not satisfy its own validator.
  if (s.leaf.diagnose === "design-missing") return "design-gap";
  if (s.exhausted !== undefined) return "validator-exhausted";
  if (s.write === "infra-failed") return "write-infra-failed";
  if (s.loopExhausted !== undefined) return LOOP_EXHAUSTED[s.loopExhausted];
  return undefined;
};

/**
 * A leaf's closed decision, or `exhausted` when its validator was never
 * satisfied and the leaf therefore decided nothing. Every branch that follows
 * a leaf routes over one of these.
 */
export type WriteVerdict = WriteOutcome | "exhausted";
export type SelectVerdict = SelectTestsOutcome | "exhausted";

/**
 * What one run of the suite said, as a function of the effect's own typed
 * result. No leaf answers this: running the suite is what decides whether it
 * passed, and a model asked the same question is a second source of truth for
 * a fact the runner already produced.
 *
 * `not-run` is the honest answer for an iteration where the suite never ran —
 * a write that conflicted goes round again without a run — and it is not a
 * block, so the loop iterates.
 */
export const TEST_VERDICTS = [
  "green",
  "still-red",
  "broke-other",
  "harness-failed",
  "selection-refused",
  "not-run",
] as const;
export type TestVerdict = (typeof TEST_VERDICTS)[number];

export type DiagnoseVerdict = DiagnoseOutcome | "exhausted";
export type RefactorVerdict = (typeof REFACTOR_OUTCOMES)[number] | "exhausted";
export type CommitVerdict = (typeof COMMIT_OUTCOMES)[number] | "exhausted";

/**
 * What one run of the quality gate said. Three members, because three are what
 * the graph routes differently, and no leaf answers any of them: whether the
 * declared lint command found something is its exit status.
 *
 * `infra-failed` is a command that could not be RUN — it was never spawned, or
 * it was killed at its timeout — which is the harness failing rather than the
 * change being bad, and the same distinction `run-tests` draws one loop over.
 */
export const GATE_VERDICTS = ["clean", "lint-failed", "infra-failed"] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];
export type CycleVerdict = "clean" | "design-gap" | "blocked";

/**
 * Where the next iteration of the test loop starts. An acceptance test that
 * has just been corrected is re-run, not re-implemented: `fix-acceptance-test`
 * left its verdict in the slot, so the head routes to `run-tests` once and
 * `run-tests` clears the slot on its way past.
 */
export type TestPhase = "implement" | "run-tests";

export const writeVerdict = (s: State): WriteVerdict => s.write ?? "exhausted";
export const selectVerdict = (s: State): SelectVerdict => s.leaf["select-tests"] ?? "exhausted";

/**
 * The suite's outcome, from the effect result and the step's own acceptance
 * tests. Pure, total, and the only thing that decides whether the suite
 * passed.
 *
 * The `rejected: tests` split is the one that earns its keep. A failure whose
 * failing tests are all the step's own is `still-red` — the implementation has
 * not satisfied the criterion yet, which is what `diagnose` then classifies.
 * A failure that names anything else is `broke-other`: a different owner, and
 * not something the diagnosis leaf has evidence about.
 *
 * A `rejected: tests` that names NO failing test is `broke-other` too, and
 * deliberately. "The suite failed and nobody can say which test" is not the
 * same claim as "this step's own acceptance test is still failing", and
 * treating it as the second would spend the diagnosis leaf on evidence that
 * does not exist.
 */
export const testVerdict = (s: State): TestVerdict => {
  const result = s.testRun;
  if (result === undefined) return "not-run";
  switch (result.outcome) {
    case "committed":
      return "green";
    case "infra-failed":
      return "harness-failed";
    // A test run cannot conflict: nothing about running a suite claims a
    // version, so there is no optimistic check for it to lose. One arriving
    // means the executor is wrong, which is the harness failing rather than
    // the change being bad — and that distinction is exactly why the two
    // outcomes are separate members.
    case "conflict":
      return "harness-failed";
    case "rejected": {
      if (result.by === "contract") return "selection-refused";
      // Any other gate answering a test run is answering out of its own
      // vocabulary, which is the harness, not the change.
      if (result.by !== "tests") return "harness-failed";
      const failed = result.detail?.failed ?? [];
      const own = new Set(s.acceptanceTests);
      return failed.length > 0 && failed.every((id) => own.has(id)) ? "still-red" : "broke-other";
    }
  }
};

export const diagnoseVerdict = (s: State): DiagnoseVerdict => s.leaf.diagnose ?? "exhausted";
export const testPhase = (s: State): TestPhase =>
  s.leaf["fix-acceptance-test"] === undefined ? "implement" : "run-tests";
export const refactorVerdict = (s: State): RefactorVerdict => s.leaf.refactor ?? "exhausted";
export const commitVerdict = (s: State): CommitVerdict => s.leaf.commit ?? "exhausted";

/**
 * What the gate said, or `undefined` when it has not run.
 *
 * The absence is a real state and it is not a fourth verdict: `blockedReason`
 * is read from inside the test loop, long before any gate runs, and a function
 * that answered `infra-failed` there would block every run on a gate that was
 * never asked for. So the partial function is what the predicates read, and
 * the branch below is the total one.
 */
export const gateOutcome = (s: State): GateVerdict | undefined => {
  const result = s.gateRun;
  if (result === undefined) return undefined;
  switch (result.outcome) {
    case "committed":
      return "clean";
    case "rejected":
      return "lint-failed";
    // A command claims no version, so there is no optimistic check for it to
    // lose. One arriving means the executor is wrong, which is the harness.
    case "conflict":
    case "infra-failed":
      return "infra-failed";
  }
};

/**
 * The gate's verdict, for the two branches that read it. Both sit after the
 * gates loop body has run at least once, so an absent verdict there is a graph
 * bug rather than a decision.
 */
export const gateVerdict = (s: State): GateVerdict => {
  const verdict = gateOutcome(s);
  if (verdict === undefined) {
    throw new Error("graph bug: a gate branch was reached before the gate ran");
  }
  return verdict;
};

/**
 * The test loop leaves when the suite is green, or when something is
 * blocking. Everything else is an iteration: still-red and broke-other are
 * retries, and `not-run` is the write-retry case — a conflicting or rejected
 * write goes round again without the suite having run at all.
 */
export const testDone = (s: State): boolean =>
  blockedReason(s) !== undefined || testVerdict(s) === "green";

/** The gates loop repeats while the declared lint command is still failing. */
export const gatesDone = (s: State): boolean => {
  if (blockedReason(s) !== undefined) return true;
  const verdict = gateOutcome(s);
  return verdict !== undefined && verdict !== "lint-failed";
};

/** The cycle repeats until the gates come back clean. */
export const cycleDone = (s: State): boolean =>
  blockedReason(s) !== undefined || gateOutcome(s) === "clean";

/**
 * The one branch after the outermost loop. `clean` is the only route to
 * COMMIT, and nothing reaches it except a clean gate run on an unblocked
 * cycle, which is what "no edge leads from partial to accepted" means here.
 */
export const cycleVerdict = (s: State): CycleVerdict => {
  const blocked = blockedReason(s);
  if (blocked === "design-gap") return "design-gap";
  return blocked === undefined && gateOutcome(s) === "clean" ? "clean" : "blocked";
};

/**
 * `human` is reachable only from a branch that already established a block, so
 * an absent reason is a graph bug, not a decision.
 */
export const humanReason = (s: State): HumanReason => {
  const reason = blockedReason(s);
  if (reason === undefined) throw new Error("graph bug: the human node was reached with nothing blocking");
  return reason;
};

/** The evidence a person reads: every leaf verdict and every loop's count. */
export const humanTrail = (s: State): unknown[] => [
  { step: s.step.id, criteria: s.step.criteria },
  { leaves: s.leaf },
  { write: s.write, symbolVersion: s.symbolVersion, wrote: s.wrote },
  { exhausted: s.exhausted, loopExhausted: s.loopExhausted, iterations: s.iterations },
  { designGap: s.designGap },
  { impacted: s.impacted, extra: s.extra, paths: s.paths, gate: gateOutcome(s) },
  { tests: testVerdict(s), acceptanceTests: s.acceptanceTests, testRun: s.testRun },
];

/**
 * `human.route` is reachable only through the `human` suspend node, which
 * always absorbs an answer first.
 */
export const humanDecision = (s: State): HumanDecision => {
  if (!s.human) throw new Error("graph bug: human.route reached with no answer absorbed");
  return s.human.decision;
};

/* -------------------------------------------------------------------- nodes */

type LeafSpec = {
  next: NodeId;
  /** What the leaf asks the runner to execute once it has decided. */
  effects?: (s: State, payload: Record<string, unknown>) => Effect[];
  /** Fold the typed effect results back into state. */
  absorb?: (s: State, results: EffectResult[]) => State;
  /** Slots this leaf invalidates, applied whether it decided or not. */
  reset?: (s: State) => State;
  /** Carry one payload field into state. The graph never branches on it. */
  carry?: (s: State, payload: Record<string, unknown>) => State;
};

/**
 * Every leaf is one `runStep` call. On `ok` the leaf's closed decision lands in
 * `leaf[id]`; on `validator-exhausted` that slot is cleared and `exhausted`
 * names the leaf, so `blockedReason` sees it, every enclosing `until` goes
 * true, and the next branch routes the run to a person. The `leaf` constructor
 * owns the trail: the whole thing comes along as an `append-trail` effect
 * whether this file remembers to ask for it or not.
 */
const leafNode = <K extends LeafId>(
  id: K,
  defs: DeliverDefs,
  journal: Journal,
  spec: LeafSpec,
  observe?: StepObserver,
): Node<State> => {
  const rebase = (s: State): State => (spec.reset ? spec.reset(s) : s);
  return leaf<State, LeafInput, LeafOutputFor<K>>({
    id,
    def: defs[id],
    journal,
    input: (s) => ({ step: s.step, evidence: s.evidence, impacted: s.impacted, wrote: s.wrote }),
    absorb: (s, r) => {
      const base = rebase(s);
      if (r.decision !== "ok") {
        return { ...base, leaf: { ...base.leaf, [id]: undefined }, exhausted: id };
      }
      const decided: State = { ...base, leaf: { ...base.leaf, [id]: r.output.decision } };
      return spec.carry?.(decided, r.output.payload as Record<string, unknown>) ?? decided;
    },
    effects: (s, r) =>
      r.decision === "ok"
        ? spec.effects?.(rebase(s), r.output.payload as Record<string, unknown>) ?? []
        : [],
    absorbEffects: spec.absorb,
    ...(observe === undefined ? {} : { observe }),
    next: spec.next,
  });
};

/**
 * A loop's exit facts. `iterations` is what a person reads; `exhausted` is what
 * the graph routes on, and the first loop to run out owns the reason — an
 * inner bound is a more specific answer than the cycle around it.
 */
const absorbLoop =
  (id: LoopId) =>
  (s: State, exit: LoopExit): State => ({
    ...s,
    iterations: { ...s.iterations, [id]: exit.iterations },
    // The cycle's iteration count is reported and its exhaustion is not,
    // because the cycle cannot run out: see `ExhaustibleLoopId`.
    loopExhausted:
      exit.exhausted && id !== "cycle" ? (s.loopExhausted ?? id) : s.loopExhausted,
  });

export const deliverGraph = (
  journal: Journal,
  defs: DeliverDefs,
  /**
   * How this consumer's project is linted. The `gates` node builds
   * `commands.lint` into the `run-command` effect it emits, so the framework
   * owns the JOB and the consumer owns the COMMAND.
   */
  commands: Commands,
  /**
   * Where each leaf's attempts are reported. Optional and inert: a leaf is
   * still one `runStep` call whose `decision` is the only thing the graph
   * reads, and nothing here branches on an observation.
   */
  observe?: StepObserver,
): Workflow<State> => ({
  start: "cycle",
  nodes: {
    /* ---- the cycle: test, refactor, gate, repeat until clean ------------ */

    cycle: loop<State>({
      body: "test-loop",
      until: cycleDone,
      max: MAX_CYCLES,
      absorb: absorbLoop("cycle"),
      next: "cycle.verdict",
    }),

    /* ---- GREEN: implement until the suite is green ---------------------- */

    "test-loop": loop<State>({
      body: "test-loop.head",
      until: testDone,
      max: MAX_TEST_ATTEMPTS,
      absorb: absorbLoop("test-loop"),
      next: "test.verdict",
    }),

    // An iteration normally implements and then runs the suite. The one
    // exception is an iteration that follows a corrected acceptance test:
    // re-implementing then would answer a question nobody asked.
    "test-loop.head": branch<State, TestPhase>(testPhase, {
      implement: "implement",
      "run-tests": "run-tests",
    }),

    implement: leafNode("implement", defs, journal, {
      next: "write.verdict",
      // The one leaf that writes. Its output schema admits a replace-symbol
      // effect and nothing else; whether it lands is the executor's answer.
      effects: (s, payload) => [
        {
          type: "replace-symbol",
          symbolId: String(payload.symbolId ?? ""),
          expectedVersion: s.symbolVersion,
          body: String(payload.body ?? ""),
        },
      ],
      absorb: (s, results) => {
        const landed = results.find((r) => r.effect.type === "replace-symbol");
        if (landed === undefined) return s;
        if (landed.outcome === "committed")
          return { ...s, write: "committed", symbolVersion: landed.version };
        // A lease conflict is an edge to a rebase-and-retry, never an
        // exception: take the version the world moved to and go round again.
        if (landed.outcome === "conflict")
          return { ...s, write: "conflict", symbolVersion: landed.currentVersion };
        return { ...s, write: landed.outcome };
      },
      // The symbol it rewrote is what `select-tests` reads next, so it is
      // carried out of the payload rather than re-derived from the effect.
      carry: (s, payload) => ({ ...s, wrote: String(payload.symbolId ?? "") }),
      // A leaf that decided nothing wrote nothing, so last iteration's
      // outcome must not be read as this one's.
      reset: (s) => ({ ...s, write: undefined, wrote: undefined }),
    }, observe),

    // `infra-failed` is distinct from `rejected` so a flaky harness does not
    // burn the implement budget on a change that was fine. Both retry edges
    // stay inside the bound; both block edges let `testDone` stop the loop.
    "write.verdict": branch<State, WriteVerdict>(writeVerdict, {
      committed: "select-tests",
      conflict: "test-loop",
      rejected: "test-loop",
      "infra-failed": "test-loop",
      exhausted: "test-loop",
    }),

    // Between the write and the suite: which tests, above the floor. The
    // floor is the VCS's and always runs; this leaf may only ADD to it, which
    // is why its decision space has no `fewer` and why the ids it returns are
    // payload rather than a decision. A set of test ids could not drive an
    // edge without making the path space the size of the suite.
    "select-tests": leafNode("select-tests", defs, journal, {
      next: "select.verdict",
      // `no-extra` means nothing was added, so the ids are not carried on
      // that decision even if the payload holds some. The mechanical check
      // `deliver.selection-matches-its-decision` refuses the contradiction at
      // the model boundary; reading the decision here makes it structural, so
      // a journal replay that never ran the check cannot smuggle one through.
      carry: (s, payload) => ({
        ...s,
        extra:
          s.leaf["select-tests"] === "extra" && Array.isArray(payload.extra)
            ? payload.extra.map(String)
            : [],
      }),
      // Last iteration's selection is not this one's.
      reset: (s) => ({ ...s, extra: [] }),
    }, observe),

    // Both decisions run the suite: the selection changed what runs, not what
    // happens next. `exhausted` is the block every other leaf's is — the slot
    // is cleared, `blockedReason` sees it, and the loop unwinds.
    "select.verdict": branch<State, SelectVerdict>(selectVerdict, {
      "no-extra": "run-tests",
      extra: "run-tests",
      exhausted: "test-loop",
    }),

    /**
     * Run the suite. Not a leaf: whether the suite passed is what running it
     * answers, and the effect's typed result is the answer. The union the
     * executor runs is the impact floor for the symbols this batch wrote plus
     * whatever `select-tests` added; the floor is recomputed by the VCS, so a
     * selection that reached below it comes back `rejected: contract` rather
     * than as a smaller run.
     *
     * A run invalidates both the previous diagnosis and the acceptance-test
     * correction that produced it: the head routes to `implement` again from
     * here on unless a new diagnosis says otherwise.
     */
    "run-tests": {
      type: "step",
      run: async (s) => ({
        state: {
          ...s,
          testRun: undefined,
          leaf: { ...s.leaf, diagnose: undefined, "fix-acceptance-test": undefined },
        },
        effects: [
          {
            type: "run-tests",
            // The symbols the run is scoped to: what `implement` wrote. The
            // floor the executor enforces is computed from the same write, so
            // this scope cannot narrow it.
            impacted: s.wrote === undefined ? [] : [s.wrote],
            extra: s.extra,
          },
        ],
      }),
      absorb: (s, results) => {
        const ran = results.find((r) => r.effect.type === "run-tests");
        return ran === undefined ? s : { ...s, testRun: ran };
      },
      next: "test.route",
    },

    // A still-red suite is classified before it is retried, rather than
    // looping straight back to `implement`. `selection-refused` is a block
    // that unwinds through the loop boundary, like `design-missing`: there is
    // nothing inside the cycle that could repair a selection which reached
    // below the floor.
    "test.route": branch<State, TestVerdict>(testVerdict, {
      green: "test-loop",
      "still-red": "diagnose",
      "broke-other": "test-loop",
      "harness-failed": "test-loop",
      "selection-refused": "test-loop",
      "not-run": "test-loop",
    }),

    diagnose: leafNode("diagnose", defs, journal, { next: "diagnose.route" }, observe),

    // Each cause routes to whoever owns it. `impl-wrong` is the loop it always
    // was. `at-wrong` corrects the test. `design-missing` and `harness-failed`
    // are blocks: `blockedReason` sees them, every enclosing `until` goes true,
    // and the run unwinds to `cycle.verdict` rather than jumping out of the
    // body, which the boundary rule does not allow.
    "diagnose.route": branch<State, DiagnoseVerdict>(diagnoseVerdict, {
      "impl-wrong": "test-loop",
      "at-wrong": "fix-acceptance-test",
      "design-missing": "test-loop",
      "harness-failed": "test-loop",
      exhausted: "test-loop",
    }),

    "fix-acceptance-test": leafNode("fix-acceptance-test", defs, journal, { next: "test-loop" }, observe),

    // still-red, broke-other and not-run are reachable here only at the
    // bound: below it, `testDone` is false and the loop went round again.
    "test.verdict": branch<State, TestVerdict>(testVerdict, {
      green: "refactor",
      "still-red": "cycle",
      "broke-other": "cycle",
      "harness-failed": "cycle",
      "selection-refused": "cycle",
      "not-run": "cycle",
    }),

    refactor: leafNode("refactor", defs, journal, { next: "refactor.verdict" }, observe),

    "refactor.verdict": branch<State, RefactorVerdict>(refactorVerdict, {
      refactored: "gates-loop",
      exhausted: "cycle",
    }),

    /* ---- COMMIT: the quality gate ---------------------------------------- */

    "gates-loop": loop<State>({
      body: "gates",
      until: gatesDone,
      max: MAX_GATE_ATTEMPTS,
      absorb: absorbLoop("gates-loop"),
      next: "gate.verdict",
    }),

    /**
     * The quality gate. NOT a leaf: whether the declared lint command found
     * anything is what running it answers, and a model asked the same question
     * would be a second source of truth for a fact the command already
     * produced.
     *
     * The command is the consumer's `commands.lint` over the files this row
     * writes; what comes back is an `EffectResult` and `gate.route` is a pure
     * function of it. The gate's own output becomes `evidence`, so the leaf
     * that fixes a finding reads the linter's words rather than a paraphrase
     * of them.
     */
    gates: {
      type: "step",
      run: async (s) => ({
        state: { ...s, gateRun: undefined },
        effects: [commandEffect(normalizeCommand(commands.lint({ paths: s.paths })))],
      }),
      absorb: (s, results) => {
        const ran = results.find((r) => r.effect.type === "run-command");
        if (ran === undefined) return s;
        // A FINDING becomes the evidence, because `fix-lint` is the one leaf
        // that reads it and a finding is exactly what it has to repair. A
        // clean run does not: it has nothing to say, no leaf downstream reads
        // it, and overwriting the suite's output with "no fixes applied" would
        // re-key every later leaf's journal entry against a string nobody
        // asked about.
        const output = commandOutput(commandOf(ran));
        const found = ran.outcome === "rejected" && output.length > 0;
        return { ...s, gateRun: ran, ...(found ? { evidence: output } : {}) };
      },
      next: "gate.route",
    },

    // Inside the gates loop, only a lint finding has more work to do; every
    // other verdict goes to the loop boundary and `gatesDone` stops there.
    "gate.route": branch<State, GateVerdict>(gateVerdict, {
      clean: "gates-loop",
      "lint-failed": "fix-lint",
      "infra-failed": "gates-loop",
    }),

    "fix-lint": leafNode("fix-lint", defs, journal, { next: "gates-loop" }, observe),

    // lint-failed is reachable here only at the gates bound.
    "gate.verdict": branch<State, GateVerdict>(gateVerdict, {
      clean: "cycle",
      "lint-failed": "cycle",
      "infra-failed": "cycle",
    }),

    /* ---- out of the cycle: commit, or a person ---------------------------- */

    "cycle.verdict": branch<State, CycleVerdict>(cycleVerdict, {
      clean: "commit",
      "design-gap": "surface-design-gap",
      blocked: "human",
    }),

    // The design is the contract, and a gap in it is not a thing a model may
    // close by inventing the surface a test happens to need. The architect
    // describes what is missing; the description rides the trail; a person
    // decides. This leaf writes nothing and has no branch: whether it managed
    // to describe the gap or not, the run parks under `design-gap`.
    "surface-design-gap": leafNode("surface-design-gap", defs, journal, {
      next: "human",
      carry: (s, payload) => ({ ...s, designGap: String(payload.gap ?? "") }),
    }, observe),

    human: suspend<State, HumanAnswer>({
      reason: humanReason,
      trail: humanTrail,
      resumeSchema: HumanAnswer,
      absorb: (s, answer) => ({ ...s, human: answer }),
      next: "human.route",
    }),

    // A person answers from a closed enum and the graph branches on it exactly
    // the way it branches on a model's answer.
    "human.route": branch<State, HumanDecision>(humanDecision, {
      commit: "commit",
      abandon: "reject",
    }),

    commit: leafNode("commit", defs, journal, { next: "commit.verdict" }, observe),

    // Terminal on every verdict. A person has already had their turn on every
    // path that reaches here through `human`, so nothing routes back to them.
    "commit.verdict": branch<State, CommitVerdict>(commitVerdict, {
      committed: "accept",
      exhausted: "reject",
    }),

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: humanTrail(s) }) },
  },
});
