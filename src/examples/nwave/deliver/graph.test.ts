/**
 * The exhaustive test for a graph with cycles in it.
 *
 * DISTILL's path space is a tuple: four classifiers answer once each, so a
 * cartesian product covers it. DELIVER's is a sequence, because a loop asks
 * the same leaf again on the next iteration. `enumeratePaths` walks the
 * reachable decision tree instead, on two axes: every leaf decision, and every
 * outcome the effects it asked for may come back with, up to every loop's
 * bound. **450 paths**, and the count is finite only because every loop
 * carries one.
 *
 * Zero model calls, no API key, no network. The stub journal throws on a miss
 * and the model bindings throw if called at all.
 */

import { describe, expect, test } from "bun:test";
import { memoryEffects, type Effect, type EffectResult } from "../../../core/effects.ts";
import { stepIdFromKey, type Journal } from "../../../core/journal.ts";
import type { StepResult } from "../../../core/step.ts";
import {
  loop,
  resume,
  run,
  type EffectExecutor,
  type Node,
  type Workflow,
} from "../../../core/workflow.ts";
import {
  enumeratePaths,
  graphDefects,
  inspectGraph,
  scriptedExecutor,
  type Choose,
  type EffectOutcomeSpace,
} from "../../../harness/enumerate-paths.ts";
import { describeTrace, endedOnDeclaredNode, isDeclaredOutcome, visitCount, visited } from "../../../harness/matchers.ts";
import { exhausted, ok, stubJournal } from "../../../harness/stub-journal.ts";
import {
  cycleDone,
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
import type { OracleIndex, TestSymbol } from "./oracle.ts";
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
  authority: "ADR-0023 § the action-shim executor boundary",
  acceptance: [
    {
      id: "02-03-AC-1",
      text: "a submitted allocation reaches Running through the production driver",
      oracleLocator: "tests/alloc.test.ts::a submitted allocation reaches Running",
    },
  ],
  predictedTouches: ["ExecDriver::start"],
};
const EVIDENCE = "test result: FAILED. assertion failed: expected Running, got Pending";

/**
 * The impact floor, as a VCS query would have answered it. Stubbed: no VCS is
 * wired to this graph, so the state carries the floor rather than producing it
 * — the same boundary `evidence` already sits on.
 */
const IMPACTED = ["test-submit-to-running", "test-exit-observer-writes-row"];

/**
 * This step's OWN acceptance test, and one that is not. The whole
 * still-red-versus-broke-other split is a set membership against the first, so
 * a scripted suite failure has to name one or the other.
 */
const OWN_AT = "test-submit-to-running";
const OTHER_TEST = "test-exit-observer-writes-row";

/** The acceptance test the step's one obligation names, pending as authored. */
const PENDING_AT: TestSymbol = {
  id: OWN_AT,
  version: 1,
  body: 'test.skip("a submitted allocation reaches Running", () => {\n  /* … */\n})',
};

/**
 * The inventory the `oracle` resolves against. A literal here rather than a
 * real one: the walk must be answerable without a database, and the VCS-backed
 * index is covered against a real temp project in `./oracle.test.ts`.
 */
const ORACLE: OracleIndex = {
  locate: async (locator) =>
    locator === STEP.acceptance[0]?.oracleLocator ? PENDING_AT : undefined,
};

/** An inventory that knows nothing, so every obligation is `missing-at`. */
const EMPTY_ORACLE: OracleIndex = { locate: async () => undefined };

/** An inventory whose acceptance test somebody already activated. */
const ACTIVE_ORACLE: OracleIndex = {
  locate: async () => ({
    ...PENDING_AT,
    body: 'test("a submitted allocation reaches Running", () => {\n  /* … */\n})',
  }),
};

const seedState = (): State => seed(STEP, EVIDENCE, IMPACTED);

/** One payload shape covers every leaf output schema; the graph reads none of them. */
const PAYLOAD = {
  anchor: "expected Running, got Pending",
  rationale: "stubbed",
  symbolId: "ExecDriver::start",
  body: "fn start(&self) { /* ... */ }",
  gap: "the design names no way to observe the allocation's state",
  extra: ["test-alloc-handle-is-dropped"],
};

/** The sentinel for "this leaf's validator was never satisfied". */
const EXHAUSTED = "$exhausted";

/** `EffectResult`'s outcome space, which the executor picks from. */
const WRITE_OUTCOMES = ["committed", "conflict", "rejected", "infra-failed"] as const;

/**
 * The suite's outcome space, as the walk and the scripted tests both name it.
 * Five members, because five are what the graph ROUTES differently: a pass,
 * a failure inside this step's own acceptance tests, a failure outside them,
 * a refused selection, and a broken runner.
 */
const TEST_OUTCOMES = {
  committed: (effect: Effect): EffectResult => ({ effect, outcome: "committed", version: 1 }),
  "own-at-failed": (effect: Effect): EffectResult => ({
    effect,
    outcome: "rejected",
    by: "tests",
    detail: { failed: [OWN_AT] },
  }),
  "other-failed": (effect: Effect): EffectResult => ({
    effect,
    outcome: "rejected",
    by: "tests",
    detail: { failed: [OTHER_TEST] },
  }),
  "selection-refused": (effect: Effect): EffectResult => ({
    effect,
    outcome: "rejected",
    by: "contract",
  }),
  "infra-failed": (effect: Effect): EffectResult => ({ effect, outcome: "infra-failed" }),
} as const;
type TestOutcomeName = keyof typeof TEST_OUTCOMES;

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

/**
 * A scripted executor: one write outcome per `replace-symbol`, in order —
 * skipping the activation's own write, which lands cleanly. `activate-at`
 * writes the acceptance test and `implement` writes the production symbol;
 * these tests are about the second, and the two are told apart by which symbol
 * they name rather than by counting.
 */
const writesLike = (outcomes: readonly WriteOutcome[]): EffectExecutor => {
  let n = 0;
  return async (effects) =>
    effects.map((effect) =>
      effect.type === "replace-symbol" && effect.symbolId === PENDING_AT.id
        ? writeResult(effect, "committed")
        : writeResult(effect, outcomes[n++] ?? "committed"),
    );
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

/** An executor that answers EVERY write the same way, activation included. */
const writesEveryWriteAs = (outcome: WriteOutcome): EffectExecutor => async (effects) =>
  effects.map((effect) => writeResult(effect, outcome));

/** A scripted executor: one named suite outcome per `run-tests`, in order. */
const testsLike = (names: readonly TestOutcomeName[]): EffectExecutor => {
  let n = 0;
  return async (effects) =>
    effects.map((effect) =>
      effect.type === "run-tests"
        ? TEST_OUTCOMES[names[n++] ?? "committed"](effect)
        : writeResult(effect, "committed"),
    );
};

const HAPPY: Script = {
  "run-tests.red": "red-observed",
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  gates: "clean",
  commit: "committed",
};

const start = (
  script: Script,
  execute: EffectExecutor = landsCleanly,
  oracle: OracleIndex = ORACLE,
) => run<State>(deliverGraph(journalFor(script), defs, oracle), seedState(), execute);

/** The loop-count row of what a person reads, for asserting on a parked run. */
const iterationsOf = (trail: readonly unknown[]) =>
  (trail[3] as { iterations: Record<string, number> }).iterations;

/** The design-gap row of the same trail. */
const designGapOf = (trail: readonly unknown[]) =>
  (trail[4] as { designGap?: string }).designGap;

describe("deliver graph", () => {
  test("the graph is structurally well-formed", () => {
    expect(graphDefects(deliverGraph(journalFor(HAPPY), defs, ORACLE))).toEqual([]);
  });

  test("the happy path runs RED, GREEN, the gates and COMMIT, in that order", async () => {
    const outcome = await start(HAPPY);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.trace).toEqual([
      "oracle",
      "oracle.route",
      "activate-at",
      "activate.verdict",
      "run-tests.red",
      "red",
      "cycle",
      "test-loop",
      "test-loop.head",
      "implement",
      "write.verdict",
      "select-tests",
      "select.verdict",
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

  // 450 runs through the real engine. No model, no key, no network.
  test("every leaf decision, effect outcome and loop count reaches a declared outcome", async () => {
    const seen = new Set<string>();
    const reasons = new Set<string>();
    const terminals = new Set<string>();

    const paths = await enumeratePaths(async (choose) => {
      // The `oracle` branch reads the INVENTORY, not a leaf's answer, so
      // reaching its `missing-at` edge means varying the data — the same
      // shape the roadmap walk has where two branches read pure functions of
      // the roadmap. Two inventories: one that locates, one that does not.
      const inventory = choose("oracle:inventory", [ORACLE, EMPTY_ORACLE]);
      const wf = deliverGraph(chooseJournal(choose), defs, inventory);
      const outcome = await run<State>(wf, seedState(), scriptedExecutor(choose, DELIVER_SPACE));

      expect(isDeclaredOutcome(outcome)).toBe(true);
      expect(endedOnDeclaredNode(wf, outcome)).toBe(true);
      expect(outcome.trace.at(-1)).toMatch(/^(accept|reject|human)$/);
      for (const id of outcome.trace) seen.add(id);
      if (outcome.kind === "suspended") reasons.add(outcome.reason);
      else terminals.add(outcome.terminal.kind);
      return outcome;
    });

    // The bounds are what make this a number rather than an infinity.
    expect(paths).toHaveLength(450);

    // Every node the graph declares was exercised, except the one that is only
    // reachable by answering a suspension. The resume tests below cover it.
    const reachable = inspectGraph(deliverGraph(journalFor(HAPPY), defs, ORACLE)).reachable;
    expect(reachable.filter((id) => !seen.has(id))).toEqual(["human.route"]);

    // Every declared reason a person can be handed actually occurs, including
    // one per loop bound.
    expect([...reasons].sort()).toEqual([...HUMAN_REASONS].sort());
    expect([...terminals].sort()).toEqual(["accepted", "rejected"]);
  }, 60_000);

  test("the test loop retries implement inside its bound, then hands the bound to a person", async () => {
    const outcome = await start(
      { ...HAPPY, diagnose: "impl-wrong" },
      testsLike(["own-at-failed", "own-at-failed"]),
    );

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
    const outcome = await start(HAPPY, testsLike(["other-failed", "other-failed"]));
    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
    expect(visitCount(outcome.trace, "implement")).toBe(MAX_TEST_ATTEMPTS);
  });

  test("a harness failure stops the test loop at once instead of spending the budget", async () => {
    const outcome = await start(HAPPY, testsLike(["infra-failed"]));
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
    // The one test that needs the cycle to run twice builds it twice. The
    // graph's own `MAX_CYCLES` is 1 so the enumeration walk stays inside its
    // budget (see the bounds comment in graph.ts); the behaviour under test
    // here is what a SECOND cycle does with an invalidated green verdict, so
    // this test rebuilds the `cycle` node at 2 rather than asserting against
    // a bound that would make the claim vacuous.
    const script = { ...HAPPY, gates: "mutation-below-gate", "add-test": "added" };
    const base = deliverGraph(journalFor(script), defs, ORACLE);
    const twoCycles: Workflow<State> = {
      ...base,
      nodes: {
        ...base.nodes,
        cycle: loop<State>({
          body: "test-loop",
          until: cycleDone,
          max: 2,
          absorb: (s, exit) => ({
            ...s,
            iterations: { ...s.iterations, cycle: exit.iterations },
            loopExhausted: exit.exhausted ? (s.loopExhausted ?? "cycle") : s.loopExhausted,
          }),
          next: "cycle.verdict",
        }),
      },
    };
    const outcome = await run<State>(twoCycles, seedState(), landsCleanly);

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("cycle-exhausted");
    expect(visitCount(outcome.trace, "cycle")).toBe(2);
    expect(visitCount(outcome.trace, "add-test")).toBe(2);
    // add-test invalidated the green verdict, so the test loop ran again.
    expect(visitCount(outcome.trace, "run-tests")).toBe(2);
    expect(iterationsOf(outcome.trail)["cycle"]).toBe(2);
  });

  test("the cycle bound is handed to a person with its own reason", async () => {
    // What the graph's own MAX_CYCLES = 1 still proves: a cycle that ends with
    // the gates unclean leaves anyway, and the person is told which budget was
    // spent rather than being handed a run that stopped for no stated reason.
    const outcome = await start({ ...HAPPY, gates: "mutation-below-gate", "add-test": "added" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("cycle-exhausted");
    expect(visitCount(outcome.trace, "cycle")).toBe(MAX_CYCLES);
    expect(iterationsOf(outcome.trail)["cycle"]).toBe(MAX_CYCLES);
  });

  test("out-of-scope-structural at the gates goes to a person, not to fix-lint", async () => {
    const outcome = await start({ ...HAPPY, gates: "out-of-scope-structural" });
    expect(outcome.kind === "suspended" && outcome.reason).toBe("out-of-scope-structural");
    expect(visited(outcome.trace, "fix-lint")).toBe(false);
  });

  test("the oracle locates the step's acceptance test and activates it before RED", async () => {
    const asked: Effect[] = [];
    const record: EffectExecutor = async (effects) => {
      asked.push(...effects);
      return effects.map((effect) =>
        effect.type === "run-tests" ? TEST_OUTCOMES.committed(effect) : writeResult(effect, "committed"),
      );
    };
    const outcome = await start(HAPPY, record);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    // The activation is a write like any other, and it claims the version the
    // inventory reported rather than a version the graph invented.
    expect(asked[0]).toEqual({
      type: "replace-symbol",
      symbolId: PENDING_AT.id,
      expectedVersion: PENDING_AT.version,
      body: 'test("a submitted allocation reaches Running", () => {\n  /* … */\n})',
    });
    // And it happened before RED, which is the ordering the node exists for.
    expect(outcome.trace.indexOf("activate-at")).toBeLessThan(outcome.trace.indexOf("run-tests.red"));
    // The located ids are what `test.route` reads as this step's own.
    expect(
      outcome.kind === "terminal" && outcome.terminal.kind === "accepted"
        ? outcome.terminal.state.acceptanceTests
        : undefined,
    ).toEqual([OWN_AT]);
  });

  test("an obligation with no acceptance test behind it goes to a person, unauthored", async () => {
    // Nothing in this graph may write an assertion the step is then measured
    // against; inventing one to have something to fail is the testing theatre
    // `already-green` catches one node later.
    const outcome = await start(HAPPY, landsCleanly, EMPTY_ORACLE);

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("missing-acceptance-test");
    expect(describeTrace(outcome.trace)).toBe("oracle -> oracle.route -> human");
    expect(outcome.trail[7]).toMatchObject({ missingAt: ["02-03-AC-1"] });
  });

  test("a step with no obligations at all is the same finding by another route", async () => {
    const bare = { ...STEP, acceptance: [] };
    const outcome = await run<State>(
      deliverGraph(journalFor(HAPPY), defs, ORACLE),
      seed(bare, EVIDENCE, IMPACTED),
      landsCleanly,
    );
    expect(outcome.kind === "suspended" && outcome.reason).toBe("missing-acceptance-test");
  });

  test("an acceptance test somebody already activated needs no write", async () => {
    const asked: Effect[] = [];
    const record: EffectExecutor = async (effects) => {
      asked.push(...effects);
      return effects.map((effect) =>
        effect.type === "run-tests" ? TEST_OUTCOMES.committed(effect) : writeResult(effect, "committed"),
      );
    };
    const outcome = await start(HAPPY, record, ACTIVE_ORACLE);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    // A write that replaced a body with itself would spend a lease and a
    // verification pass to change nothing, so the first write is implement's.
    expect(asked.filter((e) => e.type === "replace-symbol")).toHaveLength(1);
    expect(asked[0]).toMatchObject({ symbolId: PAYLOAD.symbolId });
  });

  test("an activation the world refuses goes to a person; there is no loop to retry into", async () => {
    for (const outcome of ["conflict", "rejected", "infra-failed"] as const) {
      const parked = await start(HAPPY, writesEveryWriteAs(outcome));
      expect(parked.kind === "suspended" && parked.reason).toBe("activation-failed");
      expect(visited(parked.trace, "run-tests.red")).toBe(false);
    }
  });

  test("already-green at the first RED run parks as testing theatre, before any implement", async () => {
    const outcome = await start({ ...HAPPY, "run-tests.red": "already-green" });
    expect(outcome.kind === "suspended" && outcome.reason).toBe("already-green");
    expect(visited(outcome.trace, "cycle")).toBe(false);
    expect(describeTrace(outcome.trace)).toBe(
      "oracle -> oracle.route -> activate-at -> activate.verdict -> " +
        "run-tests.red -> red -> human",
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
    // infra-failed. That is the honest outcome and it has its own edge — and
    // the first write of the run is the ACTIVATION, so that is the edge taken.
    const activation = await start(HAPPY, memoryEffects().execute);
    expect(activation.kind === "suspended" && activation.reason).toBe("activation-failed");
    expect(visited(activation.trace, "run-tests.red")).toBe(false);

    // With nothing to activate, the first write is `implement`'s, and the
    // same executor routes that one to its own reason.
    const write = await start(HAPPY, memoryEffects().execute, ACTIVE_ORACLE);
    expect(write.kind === "suspended" && write.reason).toBe("write-infra-failed");
  });

  test("a selection above the floor is carried to the suite, and both decisions run it", async () => {
    const chosen = await start({ ...HAPPY, "select-tests": "extra" });
    expect(chosen.kind === "terminal" && chosen.terminal.kind).toBe("accepted");
    expect(chosen.trace).toContain("select-tests");
    expect(
      chosen.kind === "terminal" && chosen.terminal.kind === "accepted"
        ? chosen.terminal.state.extra
        : undefined,
    ).toEqual(PAYLOAD.extra);

    // `no-extra` is the happy path's own answer, and it reaches the same node.
    const none = await start(HAPPY);
    expect(none.trace.indexOf("select-tests")).toBeLessThan(none.trace.indexOf("run-tests"));
    expect(
      none.kind === "terminal" && none.terminal.kind === "accepted"
        ? none.terminal.state.extra
        : undefined,
    ).toEqual([]);
  });

  test("the floor is never narrowed from inside the graph: a selection only adds", async () => {
    // The graph carries the floor and the addition separately, and it has no
    // node that can remove one. The union and the refusal live in the
    // executor, where the floor is recomputed — see src/vcs/executor.ts.
    const outcome = await start({ ...HAPPY, "select-tests": "extra" });
    if (outcome.kind !== "terminal" || outcome.terminal.kind !== "accepted") {
      throw new Error("expected the happy path to be accepted");
    }
    expect(outcome.terminal.state.impacted).toEqual(IMPACTED);
    expect(outcome.terminal.state.extra).toEqual(PAYLOAD.extra);
  });

  test("a selection whose validator refuses parks under validator-exhausted", async () => {
    const outcome = await start({ ...HAPPY, "select-tests": EXHAUSTED });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("validator-exhausted");
    expect(outcome.trail[3]).toMatchObject({ exhausted: "select-tests" });
    // It blocked before the suite ran: the selection is upstream of the run.
    expect(visited(outcome.trace, "run-tests")).toBe(false);
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
    start(
      { ...HAPPY, diagnose: diagnosis, ...extra },
      // Two failures naming this step's own acceptance test, so both
      // iterations of the test loop classify a genuinely still-red suite.
      testsLike(["own-at-failed", "own-at-failed"]),
    );

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

/**
 * `test.route` routes the EFFECT's outcome, not a leaf's reading of it. One
 * test per member of the outcome space, plus the two arms the space does not
 * name: a conflict, and a failure that names no failing test.
 */
describe("the suite's outcome decides, and the branch is a pure function of it", () => {
  test("committed is green: the cycle proceeds to refactor and commits", async () => {
    const outcome = await start(HAPPY, testsLike(["committed"]));

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(visited(outcome.trace, "diagnose")).toBe(false);
    expect(outcome.trace.slice(outcome.trace.indexOf("run-tests"), outcome.trace.indexOf("run-tests") + 4)).toEqual([
      "run-tests",
      "test.route",
      "test.verdict",
      "refactor",
    ]);
  });

  test("rejected: tests naming only this step's own AT is still-red, so it is diagnosed", async () => {
    const outcome = await start(
      { ...HAPPY, diagnose: "impl-wrong" },
      testsLike(["own-at-failed", "own-at-failed"]),
    );

    expect(outcome.trace.slice(outcome.trace.indexOf("test.route"), outcome.trace.indexOf("test.route") + 2)).toEqual([
      "test.route",
      "diagnose",
    ]);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
  });

  test("rejected: tests naming anything else is broke-other, which is not diagnosed", async () => {
    // A different owner, and the diagnosis leaf has no evidence about it.
    const outcome = await start(HAPPY, testsLike(["other-failed", "other-failed"]));

    expect(visited(outcome.trace, "diagnose")).toBe(false);
    expect(visitCount(outcome.trace, "implement")).toBe(MAX_TEST_ATTEMPTS);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
  });

  test("a failure naming NO test is broke-other, not a diagnosis on evidence nobody has", async () => {
    const unnamed: EffectExecutor = async (effects) =>
      effects.map((effect) =>
        effect.type === "run-tests"
          ? { effect, outcome: "rejected" as const, by: "tests" as const }
          : writeResult(effect, "committed"),
      );
    const outcome = await start({ ...HAPPY, diagnose: "impl-wrong" }, unnamed);

    expect(visited(outcome.trace, "diagnose")).toBe(false);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("test-loop-exhausted");
  });

  test("rejected: contract is the selection's own violation, and it goes to a person", async () => {
    // The floor is the VCS's. A selection that reached below it is not
    // something anything inside the cycle could repair, so the run unwinds
    // through the loop boundary and parks with its own reason.
    const outcome = await start({ ...HAPPY, "select-tests": "extra" }, testsLike(["selection-refused"]));

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("test-selection-refused");
    expect(visitCount(outcome.trace, "implement")).toBe(1);
    expect(visited(outcome.trace, "diagnose")).toBe(false);
    expect(outcome.trace.at(-1)).toBe("human");
  });

  test("infra-failed is harness-failed: a broken runner does not burn the budget", async () => {
    const outcome = await start(HAPPY, testsLike(["infra-failed"]));

    expect(outcome.kind === "suspended" && outcome.reason).toBe("harness-failed");
    expect(visitCount(outcome.trace, "implement")).toBe(1);
  });

  test("a conflict on a test run is harness-failed, because a run claims no version", async () => {
    // Nothing about running a suite takes an optimistic version, so there is
    // no check for it to lose. One arriving means the executor is wrong, which
    // is the harness failing rather than the change being bad.
    const conflicting: EffectExecutor = async (effects) =>
      effects.map((effect) =>
        effect.type === "run-tests"
          ? { effect, outcome: "conflict" as const, currentVersion: 9 }
          : writeResult(effect, "committed"),
      );
    const outcome = await start(HAPPY, conflicting);

    expect(outcome.kind === "suspended" && outcome.reason).toBe("harness-failed");
    expect(visitCount(outcome.trace, "implement")).toBe(1);
  });

  test("the suite is asked to run the selection above the floor, scoped to what was written", async () => {
    const asked: Effect[] = [];
    const record: EffectExecutor = async (effects) => {
      asked.push(...effects);
      return effects.map((effect) =>
        effect.type === "run-tests"
          ? TEST_OUTCOMES.committed(effect)
          : writeResult(effect, "committed"),
      );
    };
    await start({ ...HAPPY, "select-tests": "extra" }, record);

    // `impacted` is the symbol the write touched; `extra` is what the leaf
    // added. The floor itself is the executor's to recompute, which is why
    // the graph has no way to name it here.
    expect(asked.filter((e) => e.type === "run-tests")).toEqual([
      { type: "run-tests", impacted: [PAYLOAD.symbolId], extra: PAYLOAD.extra },
    ]);
  });
});

describe("deliver graph, resumed by a person", () => {
  const park = async () => {
    const wf = deliverGraph(journalFor({ ...HAPPY, "run-tests.red": "already-green" }), defs, ORACLE);
    const parked = await run<State>(wf, seedState(), landsCleanly);
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
      ORACLE,
    );
    const parked = await run<State>(wf, seedState(), landsCleanly);
    if (parked.kind !== "suspended") throw new Error("expected the run to park");

    const outcome = await resume<State>(wf, parked.runId, { decision: "commit" }, landsCleanly);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(visitCount(outcome.trace, "human")).toBe(1);
  });
});

describe("deliver graph defects", () => {
  const wf = deliverGraph(journalFor(HAPPY), defs, ORACLE);
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

/**
 * The walk's second axis: the outcomes each effect this graph emits may come
 * back with. Every effect type the graph emits is named here, because
 * `scriptedExecutor` refuses one that is not — a silent `committed` would make
 * the coverage claim a fiction for the edges the other outcomes route to.
 *
 * `append-trail` has one outcome and therefore forks nothing. It is declared
 * anyway: the leaf constructor emits it whenever a validator was never
 * satisfied, so leaving it out would fail the walk rather than pass it.
 */
const DELIVER_SPACE: EffectOutcomeSpace = {
  "replace-symbol": WRITE_OUTCOMES.map((outcome) => ({
    name: outcome,
    result: (effect: Effect) => writeResult(effect, outcome),
  })),
  "run-tests": (Object.keys(TEST_OUTCOMES) as TestOutcomeName[]).map((name) => ({
    name,
    result: TEST_OUTCOMES[name],
  })),
  "append-trail": [
    { name: "committed", result: (effect: Effect) => ({ effect, outcome: "committed", version: 1 }) },
  ],
};
