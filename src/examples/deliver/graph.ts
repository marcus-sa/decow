/**
 * The DELIVER step cycle as a graph. The design document's version of this
 * diagram draws back edges — `gates -> fix-lint -> gates`, `run-tests ->
 * implement -> run-tests`. Those are not edges here. They are three nested
 * `loop` nodes, each with a required bound:
 *
 *   cycle      repeat [ test-loop, refactor, gates-loop ] until gates are clean
 *     test-loop  repeat [ implement, run-tests ] until the test outcome is
 *                neither still-red nor broke-other
 *     gates-loop repeat [ gates, fix-lint ] until the gate outcome is not
 *                clippy-in-scope
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
import type { Effect, EffectResult } from "../../core/effects.ts";
import type { Journal } from "../../core/journal.ts";
import { runStep } from "../../core/step.ts";
import {
  branch,
  loop,
  suspend,
  type LoopExit,
  type Node,
  type NodeId,
  type Workflow,
} from "../../core/workflow.ts";
import {
  ACTIVATE_OUTCOMES,
  COMMIT_OUTCOMES,
  REFACTOR_OUTCOMES,
  type DeliverDefs,
  type GateOutcome,
  type LeafId,
  type LeafOutputFor,
  type RedOutcome,
  type StepUnderDelivery,
  type TestOutcome,
} from "./steps.ts";

/* ------------------------------------------------------------------- bounds */

/**
 * The three bounds. Two is the smallest value that still exercises every edge:
 * one iteration to reach a retry, a second to reach the bound. Raising them
 * multiplies the enumerated path space without adding an edge.
 */
export const MAX_TEST_ATTEMPTS = 2;
export const MAX_GATE_ATTEMPTS = 2;
export const MAX_CYCLES = 2;

export const LOOP_IDS = ["test-loop", "gates-loop", "cycle"] as const;
export type LoopId = (typeof LOOP_IDS)[number];

/* -------------------------------------------------------------------- state */

/** The outcome of landing a write, from `EffectResult`. */
export type WriteOutcome = EffectResult["outcome"];

/** The decision each leaf last returned. Cleared when its validator refused. */
export type Leaves = {
  "activate-at"?: LeafOutputFor<"activate-at">["decision"];
  "run-tests.red"?: RedOutcome;
  implement?: LeafOutputFor<"implement">["decision"];
  "run-tests"?: TestOutcome;
  refactor?: LeafOutputFor<"refactor">["decision"];
  gates?: GateOutcome;
  "fix-lint"?: LeafOutputFor<"fix-lint">["decision"];
  "add-test"?: LeafOutputFor<"add-test">["decision"];
  commit?: LeafOutputFor<"commit">["decision"];
};

/** The closed set of answers a person may give. */
export const HUMAN_DECISIONS = ["commit", "abandon"] as const;
export const HumanAnswer = z.object({ decision: z.enum(HUMAN_DECISIONS) });
export type HumanAnswer = z.infer<typeof HumanAnswer>;
export type HumanDecision = HumanAnswer["decision"];

/** The closed set of reasons this workflow may park for a person. */
export const HUMAN_REASONS = [
  "already-green",
  "harness-failed",
  "validator-exhausted",
  "write-infra-failed",
  "out-of-scope-structural",
  "test-loop-exhausted",
  "gates-loop-exhausted",
  "cycle-exhausted",
] as const;
export type HumanReason = (typeof HUMAN_REASONS)[number];

const LOOP_EXHAUSTED: Record<LoopId, HumanReason> = {
  "test-loop": "test-loop-exhausted",
  "gates-loop": "gates-loop-exhausted",
  cycle: "cycle-exhausted",
};

export type State = {
  step: StepUnderDelivery;
  /** Verbatim runner or gate output. Carried, not produced: no runner is wired. */
  evidence: string;
  /** The optimistic version the next `replace-symbol` claims. */
  symbolVersion: number;

  leaf: Leaves;
  /** How `implement`'s write landed. Cleared when `implement` did not write. */
  write?: WriteOutcome;
  /** The leaf whose validator was never satisfied, most recent wins. */
  exhausted?: LeafId;
  /** The first loop to run out of iterations. */
  loopExhausted?: LoopId;
  /** Iterations each loop last ran, folded in by that loop's `absorb`. */
  iterations: Partial<Record<LoopId, number>>;

  /** Absorbed by the `human` suspend node; read only by `human.route`. */
  human?: HumanAnswer;
};

export const seed = (step: StepUnderDelivery, evidence: string): State => ({
  step,
  evidence,
  symbolVersion: 0,
  leaf: {},
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
  if (s.leaf["run-tests.red"] === "already-green") return "already-green";
  if (s.leaf["run-tests.red"] === "harness-failed" || s.leaf["run-tests"] === "harness-failed")
    return "harness-failed";
  if (s.exhausted !== undefined) return "validator-exhausted";
  if (s.write === "infra-failed") return "write-infra-failed";
  if (s.leaf.gates === "out-of-scope-structural") return "out-of-scope-structural";
  if (s.loopExhausted !== undefined) return LOOP_EXHAUSTED[s.loopExhausted];
  return undefined;
};

/**
 * A leaf's closed decision, or `exhausted` when its validator was never
 * satisfied and the leaf therefore decided nothing. Every branch that follows
 * a leaf routes over one of these.
 */
export type ActivateVerdict = (typeof ACTIVATE_OUTCOMES)[number] | "exhausted";
export type RedVerdict = RedOutcome | "exhausted";
export type WriteVerdict = WriteOutcome | "exhausted";
export type TestVerdict = TestOutcome | "exhausted";
export type RefactorVerdict = (typeof REFACTOR_OUTCOMES)[number] | "exhausted";
export type GateVerdict = GateOutcome | "exhausted";
export type CommitVerdict = (typeof COMMIT_OUTCOMES)[number] | "exhausted";
export type CycleVerdict = "clean" | "blocked";

export const activateVerdict = (s: State): ActivateVerdict => s.leaf["activate-at"] ?? "exhausted";
export const redVerdict = (s: State): RedVerdict => s.leaf["run-tests.red"] ?? "exhausted";
export const writeVerdict = (s: State): WriteVerdict => s.write ?? "exhausted";
export const testVerdict = (s: State): TestVerdict => s.leaf["run-tests"] ?? "exhausted";
export const refactorVerdict = (s: State): RefactorVerdict => s.leaf.refactor ?? "exhausted";
export const gateVerdict = (s: State): GateVerdict => s.leaf.gates ?? "exhausted";
export const commitVerdict = (s: State): CommitVerdict => s.leaf.commit ?? "exhausted";

/**
 * The test loop repeats while the suite is still red or the change broke
 * something else. The `undefined` guard is the write-retry case: a conflict or
 * a rejected write goes round again without the suite having run at all.
 */
export const testDone = (s: State): boolean =>
  blockedReason(s) !== undefined ||
  (s.leaf["run-tests"] !== undefined &&
    s.leaf["run-tests"] !== "still-red" &&
    s.leaf["run-tests"] !== "broke-other");

/** The gates loop repeats while clippy has findings inside the step's scope. */
export const gatesDone = (s: State): boolean =>
  blockedReason(s) !== undefined ||
  (s.leaf.gates !== undefined && s.leaf.gates !== "clippy-in-scope");

/** The cycle repeats until the gates come back clean. */
export const cycleDone = (s: State): boolean =>
  blockedReason(s) !== undefined || s.leaf.gates === "clean";

/**
 * The one branch after the outermost loop. `clean` is the only route to
 * COMMIT, and nothing reaches it except a clean gate run on an unblocked
 * cycle, which is what "no edge leads from partial to accepted" means here.
 */
export const cycleVerdict = (s: State): CycleVerdict =>
  blockedReason(s) === undefined && s.leaf.gates === "clean" ? "clean" : "blocked";

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
  { write: s.write, symbolVersion: s.symbolVersion },
  { exhausted: s.exhausted, loopExhausted: s.loopExhausted, iterations: s.iterations },
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
};

/**
 * Every leaf is one `runStep` call. On `ok` the leaf's closed decision lands in
 * `leaf[id]`; on `validator-exhausted` that slot is cleared and `exhausted`
 * names the leaf, so `blockedReason` sees it, every enclosing `until` goes
 * true, and the next branch routes the run to a person. The whole trail comes
 * along as an `append-trail` effect.
 */
const leafNode = <K extends LeafId>(
  id: K,
  defs: DeliverDefs,
  journal: Journal,
  spec: LeafSpec,
): Node<State> => ({
  type: "step",
  run: async (s) => {
    const base = spec.reset ? spec.reset(s) : s;
    const result = await runStep(defs[id], { step: s.step, evidence: s.evidence }, journal);
    if (result.decision !== "ok") {
      return {
        state: { ...base, leaf: { ...base.leaf, [id]: undefined }, exhausted: id },
        effects: [{ type: "append-trail", line: JSON.stringify({ leaf: id, trail: result.trail }) }],
      };
    }
    const payload = result.output.payload as Record<string, unknown>;
    return {
      state: { ...base, leaf: { ...base.leaf, [id]: result.output.decision } },
      effects: spec.effects?.(base, payload) ?? [],
    };
  },
  absorb: spec.absorb ?? ((s) => s),
  next: spec.next,
});

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
    loopExhausted: exit.exhausted ? (s.loopExhausted ?? id) : s.loopExhausted,
  });

export const deliverGraph = (journal: Journal, defs: DeliverDefs): Workflow<State> => ({
  start: "activate-at",
  nodes: {
    /* ---- RED: activate the acceptance test and observe it fail ---------- */

    "activate-at": leafNode("activate-at", defs, journal, { next: "activate.verdict" }),

    "activate.verdict": branch<State, ActivateVerdict>(activateVerdict, {
      activated: "run-tests.red",
      exhausted: "human",
    }),

    "run-tests.red": leafNode("run-tests.red", defs, journal, { next: "red" }),

    // A test that passes before implementation is testing theatre, and a
    // harness failure is not a red test. Both are first-class outcomes routed
    // to a person rather than swallowed.
    red: branch<State, RedVerdict>(redVerdict, {
      "red-observed": "cycle",
      "already-green": "human",
      "harness-failed": "human",
      exhausted: "human",
    }),

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
      body: "implement",
      until: testDone,
      max: MAX_TEST_ATTEMPTS,
      absorb: absorbLoop("test-loop"),
      next: "test.verdict",
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
      // A leaf that decided nothing wrote nothing, so last iteration's
      // outcome must not be read as this one's.
      reset: (s) => ({ ...s, write: undefined }),
    }),

    // `infra-failed` is distinct from `rejected` so a flaky harness does not
    // burn the implement budget on a change that was fine. Both retry edges
    // stay inside the bound; both block edges let `testDone` stop the loop.
    "write.verdict": branch<State, WriteVerdict>(writeVerdict, {
      committed: "run-tests",
      conflict: "test-loop",
      rejected: "test-loop",
      "infra-failed": "test-loop",
      exhausted: "test-loop",
    }),

    "run-tests": leafNode("run-tests", defs, journal, { next: "test-loop" }),

    // still-red and broke-other are reachable here only at the bound: below
    // it, `testDone` is false and the loop went round again.
    "test.verdict": branch<State, TestVerdict>(testVerdict, {
      green: "refactor",
      "still-red": "cycle",
      "broke-other": "cycle",
      "harness-failed": "cycle",
      exhausted: "cycle",
    }),

    refactor: leafNode("refactor", defs, journal, { next: "refactor.verdict" }),

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

    gates: leafNode("gates", defs, journal, { next: "gate.route" }),

    // Inside the gates loop, only a clippy finding has more work to do; every
    // other verdict goes to the loop boundary and `gatesDone` stops there.
    "gate.route": branch<State, GateVerdict>(gateVerdict, {
      clean: "gates-loop",
      "clippy-in-scope": "fix-lint",
      "mutation-below-gate": "gates-loop",
      "out-of-scope-structural": "gates-loop",
      exhausted: "gates-loop",
    }),

    "fix-lint": leafNode("fix-lint", defs, journal, { next: "gates-loop" }),

    // clippy-in-scope is reachable here only at the gates bound.
    "gate.verdict": branch<State, GateVerdict>(gateVerdict, {
      clean: "cycle",
      "clippy-in-scope": "cycle",
      "mutation-below-gate": "add-test",
      "out-of-scope-structural": "cycle",
      exhausted: "cycle",
    }),

    // A surviving mutant means the suite did not defend the change. The new
    // test invalidates the green verdict, so the next cycle re-enters the test
    // loop rather than proceeding.
    "add-test": leafNode("add-test", defs, journal, {
      next: "cycle",
      reset: (s) => ({ ...s, leaf: { ...s.leaf, "run-tests": undefined }, write: undefined }),
    }),

    /* ---- out of the cycle: commit, or a person ---------------------------- */

    "cycle.verdict": branch<State, CycleVerdict>(cycleVerdict, {
      clean: "commit",
      blocked: "human",
    }),

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

    commit: leafNode("commit", defs, journal, { next: "commit.verdict" }),

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
