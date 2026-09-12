/**
 * The exhaustive test for a graph with cycles in it.
 *
 * DISTILL's path space is a tuple: four classifiers answer once each, so a
 * cartesian product covers it. DELIVER's is a sequence, because a loop asks
 * the same leaf again on the next iteration. `enumeratePaths` walks the
 * reachable decision tree instead: every leaf decision, every write outcome,
 * every loop count up to its bound. **1270 paths**, and the count is finite
 * only because every loop carries one.
 *
 * Zero model calls, no API key, no network. The stub journal throws on a miss
 * and the model bindings throw if called at all.
 */

import { describe, expect, test } from "bun:test";
import { memoryEffects, type Effect, type EffectResult } from "../../core/effects.ts";
import { stepIdFromKey, type Journal } from "../../core/journal.ts";
import type { StepResult } from "../../core/step.ts";
import {
  loop,
  resume,
  run,
  type EffectExecutor,
  type Node,
  type Workflow,
} from "../../core/workflow.ts";
import { enumeratePaths, graphDefects, inspectGraph, type Choose } from "../../harness/enumerate-paths.ts";
import { describeTrace, endedOnDeclaredNode, isDeclaredOutcome, visitCount, visited } from "../../harness/matchers.ts";
import { exhausted, ok, stubJournal } from "../../harness/stub-journal.ts";
import {
  deliverGraph,
  HUMAN_REASONS,
  MAX_CYCLES,
  MAX_GATE_ATTEMPTS,
  MAX_TEST_ATTEMPTS,
  seed,
  type HumanAnswer,
  type State,
  type WriteOutcome,
} from "./graph.ts";
import { deliverDefs, LEAF_DECISIONS, leafStepId, type LeafId } from "./steps.ts";

/** A model binding that fails the test if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T,>(): Promise<T> => {
    throw new Error(`model "${id}" was called; the enumeration suite must spend zero model calls`);
  },
});

const defs = deliverDefs({
  worker: forbidden("worker"),
  validator: forbidden("validator"),
  escalateTo: forbidden("escalate"),
});

const STEP = {
  id: "02-03",
  criteria: "a submitted allocation reaches Running through the production driver",
  design: "ExecDriver::start(&self, spec: &AllocSpec) -> Result<AllocHandle>",
};
const EVIDENCE = "test result: FAILED. assertion failed: expected Running, got Pending";

/** One payload shape covers every leaf output schema; the graph reads none of them. */
const PAYLOAD = {
  anchor: "expected Running, got Pending",
  rationale: "stubbed",
  symbolId: "ExecDriver::start",
  body: "fn start(&self) { /* ... */ }",
  gap: "the design names no way to observe the allocation's state",
};

/** The sentinel for "this leaf's validator was never satisfied". */
const EXHAUSTED = "$exhausted";

/** `EffectResult`'s outcome space, which the executor picks from. */
const WRITE_OUTCOMES = ["committed", "conflict", "rejected", "infra-failed"] as const;

type Script = Partial<Record<LeafId, string>>;

/** A journal seeded per leaf. An unscripted leaf throws rather than reaching a model. */
const journalFor = (script: Script) =>
  stubJournal(
    Object.fromEntries(
      Object.entries(script).map(([leaf, decision]) => [
        leafStepId(leaf as LeafId),
        decision === EXHAUSTED ? exhausted() : ok({ decision, payload: PAYLOAD }),
      ]),
    ) as Record<string, StepResult<unknown>>,
  );

/** Every write lands. The executor axis is exercised separately and in the walk. */
const landsCleanly: EffectExecutor = async (effects) =>
  effects.map((effect) => ({ effect, outcome: "committed" as const, version: 1 }));

/** A scripted executor: one write outcome per `replace-symbol`, in order. */
const writesLike = (outcomes: readonly WriteOutcome[]): EffectExecutor => {
  let n = 0;
  return async (effects) => effects.map((effect) => writeResult(effect, outcomes[n++] ?? "committed"));
};

const writeResult = (effect: Effect, outcome: WriteOutcome): EffectResult => {
  if (effect.type !== "replace-symbol") return { effect, outcome: "committed", version: 1 };
  switch (outcome) {
    case "committed":
      return { effect, outcome, version: effect.expectedVersion + 1 };
    case "conflict":
      return { effect, outcome, currentVersion: effect.expectedVersion + 1 };
    case "rejected":
      return { effect, outcome, by: "tests" };
    case "infra-failed":
      return { effect, outcome };
  }
};

const HAPPY: Script = {
  "activate-at": "activated",
  "run-tests.red": "red-observed",
  implement: "written",
  "run-tests": "green",
  refactor: "refactored",
  gates: "clean",
  commit: "committed",
};

const start = (script: Script, execute: EffectExecutor = landsCleanly) =>
  run<State>(deliverGraph(journalFor(script), defs), seed(STEP, EVIDENCE), execute);

/** The loop-count row of what a person reads, for asserting on a parked run. */
const iterationsOf = (trail: readonly unknown[]) =>
  (trail[3] as { iterations: Record<string, number> }).iterations;

/** The design-gap row of the same trail. */
const designGapOf = (trail: readonly unknown[]) =>
  (trail[4] as { designGap?: string }).designGap;

describe("deliver graph", () => {
  test("the graph is structurally well-formed", () => {
    expect(graphDefects(deliverGraph(journalFor(HAPPY), defs))).toEqual([]);
  });

  test("the happy path runs RED, GREEN, the gates and COMMIT, in that order", async () => {
    const outcome = await start(HAPPY);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.trace).toEqual([
      "activate-at",
      "activate.verdict",
      "run-tests.red",
      "red",
      "cycle",
      "test-loop",
      "test-loop.head",
      "implement",
      "write.verdict",
      "run-tests",
      "test.route",
      "test.verdict",
      "refactor",
      "refactor.verdict",
      "gates-loop",
      "gates",
      "gate.route",
      "gate.verdict",
      "cycle.verdict",
      "commit",
      "commit.verdict",
      "accept",
    ]);
  });

  test("no edge bypasses RED: the acceptance test runs before any implement", async () => {
    const outcome = await start(HAPPY);
    expect(outcome.trace.indexOf("run-tests.red")).toBeLessThan(outcome.trace.indexOf("implement"));
  });

  // 1270 runs through the real engine. No model, no key, no network.
  test("every leaf decision, write outcome and loop count reaches a declared outcome", async () => {
    const seen = new Set<string>();
    const reasons = new Set<string>();
    const terminals = new Set<string>();

    const paths = await enumeratePaths(async (choose) => {
      const wf = deliverGraph(chooseJournal(choose), defs);
      const outcome = await run<State>(wf, seed(STEP, EVIDENCE), chooseExecutor(choose));

      expect(isDeclaredOutcome(outcome)).toBe(true);
      expect(endedOnDeclaredNode(wf, outcome)).toBe(true);
      expect(outcome.trace.at(-1)).toMatch(/^(accept|reject|human)$/);
      for (const id of outcome.trace) seen.add(id);
      if (outcome.kind === "suspended") reasons.add(outcome.reason);
      else terminals.add(outcome.terminal.kind);
      return outcome;
    });

    // The bounds are what make this a number rather than an infinity.
    expect(paths).toHaveLength(2215);

    // Every node the graph declares was exercised, except the one that is only
    // reachable by answering a suspension. The resume tests below cover it.
    const reachable = inspectGraph(deliverGraph(journalFor(HAPPY), defs)).reachable;
    expect(reachable.filter((id) => !seen.has(id))).toEqual(["human.route"]);

    // Every declared reason a person can be handed actually occurs, including
    // one per loop bound.
    expect([...reasons].sort()).toEqual([...HUMAN_REASONS].sort());
    expect([...terminals].sort()).toEqual(["accepted", "rejected"]);
  }, 60_000);

  test("the test loop retries implement inside its bound, then hands the bound to a person", async () => {
    const outcome = await start({ ...HAPPY, "run-tests": "still-red", diagnose: "impl-wrong" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("test-loop-exhausted");
    expect(visitCount(outcome.trace, "test-loop")).toBe(MAX_TEST_ATTEMPTS);
    expect(visitCount(outcome.trace, "implement")).toBe(MAX_TEST_ATTEMPTS);
    expect(iterationsOf(outcome.trail)["test-loop"]).toBe(MAX_TEST_ATTEMPTS);
    // The bound stopped it; nothing downstream of the test loop ran.
    expect(visited(outcome.trace, "refactor")).toBe(false);
  });

  test("broke-other retries like still-red rather than burning a different budget", async () => {
    const outcome = await start({ ...HAPPY, "run-tests": "broke-other" });
    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
    expect(visitCount(outcome.trace, "implement")).toBe(MAX_TEST_ATTEMPTS);
  });

  test("a harness failure stops the test loop at once instead of spending the budget", async () => {
    const outcome = await start({ ...HAPPY, "run-tests": "harness-failed" });
    expect(outcome.kind === "suspended" && outcome.reason).toBe("harness-failed");
    expect(visitCount(outcome.trace, "implement")).toBe(1);
  });

  test("the gates loop fixes lint inside its bound, then hands the bound to a person", async () => {
    const outcome = await start({ ...HAPPY, gates: "clippy-in-scope", "fix-lint": "fixed" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("gates-loop-exhausted");
    expect(visitCount(outcome.trace, "gates-loop")).toBe(MAX_GATE_ATTEMPTS);
    expect(visitCount(outcome.trace, "fix-lint")).toBe(MAX_GATE_ATTEMPTS);
    expect(iterationsOf(outcome.trail)["gates-loop"]).toBe(MAX_GATE_ATTEMPTS);
    // The inner loop ran out, so the cycle around it stopped after one pass.
    expect(visitCount(outcome.trace, "cycle")).toBe(1);
  });

  test("a surviving mutant re-enters the test loop on the next cycle", async () => {
    const outcome = await start({ ...HAPPY, gates: "mutation-below-gate", "add-test": "added" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("cycle-exhausted");
    expect(visitCount(outcome.trace, "cycle")).toBe(MAX_CYCLES);
    expect(visitCount(outcome.trace, "add-test")).toBe(MAX_CYCLES);
    // add-test invalidated the green verdict, so the test loop ran again.
    expect(visitCount(outcome.trace, "run-tests")).toBe(MAX_CYCLES);
    expect(iterationsOf(outcome.trail)["cycle"]).toBe(MAX_CYCLES);
  });

  test("out-of-scope-structural at the gates goes to a person, not to fix-lint", async () => {
    const outcome = await start({ ...HAPPY, gates: "out-of-scope-structural" });
    expect(outcome.kind === "suspended" && outcome.reason).toBe("out-of-scope-structural");
    expect(visited(outcome.trace, "fix-lint")).toBe(false);
  });

  test("already-green at the first RED run parks as testing theatre, before any implement", async () => {
    const outcome = await start({ ...HAPPY, "run-tests.red": "already-green" });
    expect(outcome.kind === "suspended" && outcome.reason).toBe("already-green");
    expect(visited(outcome.trace, "cycle")).toBe(false);
    expect(describeTrace(outcome.trace)).toBe(
      "activate-at -> activate.verdict -> run-tests.red -> red -> human",
    );
  });

  test("a lease conflict is a retry inside the bound, never an exception", async () => {
    const outcome = await start(HAPPY, writesLike(["conflict", "committed"]));

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(visitCount(outcome.trace, "implement")).toBe(2);
    // The retry rebased onto the version the world moved to.
    expect(
      outcome.kind === "terminal" && outcome.terminal.kind === "accepted"
        ? outcome.terminal.state.symbolVersion
        : undefined,
    ).toBe(2);
  });

  test("a rejected write retries; an infra failure does not", async () => {
    const retried = await start(HAPPY, writesLike(["rejected", "committed"]));
    expect(retried.kind === "terminal" && retried.terminal.kind).toBe("accepted");
    expect(visitCount(retried.trace, "implement")).toBe(2);

    const gaveUp = await start(HAPPY, writesLike(["infra-failed"]));
    expect(gaveUp.kind === "suspended" && gaveUp.reason).toBe("write-infra-failed");
    expect(visitCount(gaveUp.trace, "implement")).toBe(1);
  });

  test("the in-memory executor cannot land replace-symbol, and the graph routes that", async () => {
    // memoryEffects has no VCS behind it, so replace-symbol comes back
    // infra-failed. That is the honest outcome and it has its own edge.
    const outcome = await start(HAPPY, memoryEffects().execute);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("write-infra-failed");
  });

  test("an exhausted leaf parks under validator-exhausted and the trail names it", async () => {
    const outcome = await start({ ...HAPPY, gates: EXHAUSTED });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("validator-exhausted");
    expect(outcome.trail[3]).toMatchObject({ exhausted: "gates" });
  });
});

/**
 * The diagnosis branch. A still-red suite is classified before it is retried,
 * and the classification is the whole point: each cause has a different owner,
 * so each one has a different route. The four tests below are one per member of
 * the enum, plus the validator's own refusal.
 */
describe("deliver graph, the diagnosis branch", () => {
  const stillRed = (diagnosis: string, extra: Script = {}) =>
    start({ ...HAPPY, "run-tests": "still-red", diagnose: diagnosis, ...extra });

  test("impl-wrong retries implement, which is the loop it always was", async () => {
    const outcome = await stillRed("impl-wrong");

    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
    expect(visitCount(outcome.trace, "diagnose")).toBe(MAX_TEST_ATTEMPTS);
    // The implement loop ran again, which is the pre-diagnosis behaviour.
    expect(visitCount(outcome.trace, "implement")).toBe(MAX_TEST_ATTEMPTS);
    expect(visited(outcome.trace, "fix-acceptance-test")).toBe(false);
  });

  test("at-wrong corrects the test and re-runs the suite without re-implementing", async () => {
    const outcome = await stillRed("at-wrong", { "fix-acceptance-test": "fixed" });

    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
    expect(visited(outcome.trace, "fix-acceptance-test")).toBe(true);
    // The suite ran twice; the implementation was written once. That is the
    // whole difference between at-wrong and impl-wrong.
    expect(visitCount(outcome.trace, "run-tests")).toBe(MAX_TEST_ATTEMPTS);
    expect(visitCount(outcome.trace, "implement")).toBe(1);
    // The second iteration entered at `run-tests`, not at `implement`.
    const second = outcome.trace.lastIndexOf("test-loop.head");
    expect(outcome.trace.slice(second, second + 6)).toEqual([
      "test-loop.head",
      "run-tests",
      "test.route",
      "diagnose",
      "diagnose.route",
      "fix-acceptance-test",
    ]);
  });

  test("design-missing leaves the cycle, surfaces the gap, and parks under design-gap", async () => {
    const outcome = await stillRed("design-missing", { "surface-design-gap": "surfaced" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("design-gap");
    expect(outcome.trace.at(-1)).toBe("human");

    // It left the loop rather than spending the budget: one implement, one
    // cycle, no second test attempt. The body-boundary rule is what makes this
    // an unwind — `design-missing` routes to the loop's own id, `testDone` and
    // `cycleDone` go true because `blockedReason` sees it, and `cycle.verdict`
    // routes it on the way out.
    expect(visitCount(outcome.trace, "implement")).toBe(1);
    expect(visitCount(outcome.trace, "cycle")).toBe(1);
    expect(visitCount(outcome.trace, "test-loop")).toBe(1);
    expect(visited(outcome.trace, "commit")).toBe(false);

    // The architect's leaf ran between the cycle and the person, and what it
    // wrote is in the trail the person reads.
    expect(outcome.trace.slice(-3)).toEqual(["cycle.verdict", "surface-design-gap", "human"]);
    expect(designGapOf(outcome.trail)).toBe(PAYLOAD.gap);
  });

  test("harness-failed from the diagnosis blocks at once, like the one a leaf up", async () => {
    const outcome = await stillRed("harness-failed");

    expect(outcome.kind === "suspended" && outcome.reason).toBe("harness-failed");
    expect(visitCount(outcome.trace, "implement")).toBe(1);
    expect(visited(outcome.trace, "surface-design-gap")).toBe(false);
  });

  test("a diagnosis whose validator refuses parks under validator-exhausted", async () => {
    const outcome = await stillRed(EXHAUSTED);

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("validator-exhausted");
    expect(outcome.trail[3]).toMatchObject({ exhausted: "diagnose" });
  });

  test("an architect that cannot describe the gap still parks under design-gap", async () => {
    // `blockedReason` puts the design gap ahead of `exhausted` deliberately:
    // once a design gap is the finding, it stays the reason a person is handed.
    const outcome = await stillRed("design-missing", { "surface-design-gap": EXHAUSTED });

    expect(outcome.kind === "suspended" && outcome.reason).toBe("design-gap");
    expect(outcome.kind === "suspended" && outcome.trail[3]).toMatchObject({
      exhausted: "surface-design-gap",
    });
  });
});

describe("deliver graph, resumed by a person", () => {
  const park = async () => {
    const wf = deliverGraph(journalFor({ ...HAPPY, "run-tests.red": "already-green" }), defs);
    const parked = await run<State>(wf, seed(STEP, EVIDENCE), landsCleanly);
    if (parked.kind !== "suspended") throw new Error("expected the run to park");
    return { wf, parked };
  };

  test("commit continues the same run to accepted", async () => {
    const { wf, parked } = await park();
    const answer: HumanAnswer = { decision: "commit" };
    const outcome = await resume<State>(wf, parked.runId, answer, landsCleanly);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(visited(outcome.trace, "human.route")).toBe(true);
    // The trace spans both halves of the run: it survived the suspension.
    expect(outcome.trace.slice(0, parked.trace.length)).toEqual(parked.trace);
    expect(outcome.runId).toBe(parked.runId);
  });

  test("abandon reaches the rejected terminal with the trail attached", async () => {
    const { wf, parked } = await park();
    const answer: HumanAnswer = { decision: "abandon" };
    const outcome = await resume<State>(wf, parked.runId, answer, landsCleanly);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(outcome.trace.at(-1)).toBe("reject");
  });

  test("a commit whose validator refuses rejects rather than parking a second time", async () => {
    const wf = deliverGraph(
      journalFor({ ...HAPPY, "run-tests.red": "already-green", commit: EXHAUSTED }),
      defs,
    );
    const parked = await run<State>(wf, seed(STEP, EVIDENCE), landsCleanly);
    if (parked.kind !== "suspended") throw new Error("expected the run to park");

    const outcome = await resume<State>(wf, parked.runId, { decision: "commit" }, landsCleanly);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(visitCount(outcome.trace, "human")).toBe(1);
  });
});

describe("deliver graph defects", () => {
  const wf = deliverGraph(journalFor(HAPPY), defs);
  const withNode = (id: string, node: Node<State>): Workflow<State> => ({
    ...wf,
    nodes: { ...wf.nodes, [id]: node },
  });

  test("a loop with max 0 is rejected: an unbounded loop cannot be enumerated", () => {
    const broken = withNode(
      "test-loop",
      loop<State>({
        body: "implement",
        until: () => false,
        max: 0,
        absorb: (s) => s,
        next: "test.verdict",
      }),
    );
    expect(graphDefects(broken)).toContainEqual(
      expect.stringContaining("loop bound must be a positive integer: test-loop has max 0"),
    );
  });

  test("a loop whose body escapes is rejected", () => {
    // The obvious authoring mistake, and the one the design's own diagram
    // draws: route a finding from inside the cycle straight to the person.
    // gate.verdict is inside the cycle's body, and `human` cannot come back.
    const broken = withNode("gate.verdict", {
      type: "branch",
      on: () => "out-of-scope-structural",
      edges: {
        clean: "cycle",
        "clippy-in-scope": "cycle",
        "mutation-below-gate": "add-test",
        "out-of-scope-structural": "human",
        exhausted: "cycle",
      },
    });
    expect(graphDefects(broken)).toContainEqual(
      expect.stringContaining("loop body escapes: gate.verdict -> human leaves the body of cycle"),
    );
  });

  test("a raw back edge is rejected: repetition goes through a bounded loop", () => {
    const broken = withNode("commit.verdict", {
      type: "branch",
      on: () => "exhausted",
      edges: { committed: "accept", exhausted: "commit" },
    });
    expect(graphDefects(broken)).toContainEqual(
      expect.stringContaining("back edge: commit.verdict -> commit"),
    );
  });
});

/* ------------------------------------------------------------- walk wiring */

/** Answers every leaf from its own closed set, plus "the validator refused". */
const chooseJournal = (choose: Choose): Journal => ({
  async get<O>(key: string) {
    const leaf = stepIdFromKey(key).slice("deliver.".length) as LeafId;
    const decision = choose(`leaf:${leaf}`, [...LEAF_DECISIONS[leaf], EXHAUSTED]);
    return (decision === EXHAUSTED ? exhausted() : ok({ decision, payload: PAYLOAD })) as O;
  },
  async put() {
    // The walk never re-infers, so nothing is written back.
  },
});

/** Answers every `replace-symbol` from `EffectResult`'s own outcome space. */
const chooseExecutor = (choose: Choose): EffectExecutor => async (effects) =>
  effects.map((effect) =>
    effect.type === "replace-symbol"
      ? writeResult(effect, choose("effect:replace-symbol", WRITE_OUTCOMES))
      : { effect, outcome: "committed" as const, version: 1 },
  );
