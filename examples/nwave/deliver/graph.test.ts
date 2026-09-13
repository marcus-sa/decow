/**
 * The exhaustive test for a graph with cycles in it.
 *
 * DISTILL's path space is a tuple: four classifiers answer once each, so a
 * cartesian product covers it. DELIVER's is a sequence, because a loop asks
 * the same leaf again on the next iteration. `enumeratePaths` walks the
 * reachable decision tree instead, on two axes: every leaf decision, and every
 * outcome the effects it asked for may come back with, up to every loop's
 * bound. **347 paths**, and the count is finite only because every loop
 * carries one.
 *
 * Zero model calls, no API key, no network. The stub journal throws on a miss
 * and the model bindings throw if called at all.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS, type Commands } from "../../../src/core/commands.ts";
import { memoryEffects, type Effect, type EffectResult } from "../../../src/core/effects.ts";
import { stepIdFromKey, type Journal } from "../../../src/core/journal.ts";
import type { StepResult } from "../../../src/core/step.ts";
import {
  loop,
  resume,
  run,
  type EffectExecutor,
  type Node,
  type Workflow,
} from "../../../src/core/workflow.ts";
import {
  enumeratePaths,
  graphDefects,
  inspectGraph,
  scriptedExecutor,
  type Choose,
  type EffectOutcomeSpace,
} from "../../../src/harness/enumerate-paths.ts";
import { endedOnDeclaredNode, isDeclaredOutcome, visitCount, visited } from "../../../src/harness/matchers.ts";
import { exhausted, ok, stubJournal } from "../../../src/harness/stub-journal.ts";
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
      stimulus: "Submit an allocation through the production driver.",
      expected: "It reaches Running, observed as an alloc_status row.",
    },
  ],
  predictedTouches: ["ExecDriver::start"],
  oracle: "tests/alloc.test.ts::a submitted allocation reaches Running",
};
const EVIDENCE = "test result: FAILED. assertion failed: expected Running, got Pending";

/**
 * The files the row writes, as the registry resolved them. Carried like
 * `impacted` is: no VCS is wired to this graph, and the quality gate lints
 * what the row writes rather than deriving it.
 */
const PATHS = ["src/exec_driver.rs"];

/**
 * The consumer's declared commands. Only `lint` is reached from this graph —
 * the other three belong to the write path — and what matters is that the
 * `gates` node composes THIS declaration rather than a hardcoded one.
 */
const COMMANDS: Commands = {
  typecheck: () => ["declared-typecheck"],
  lint: ({ paths }) => ["declared-lint", ...paths],
  tests: ({ file }) => ["declared-tests", file],
  oracle: ({ file }) => ["declared-oracle", file],
};

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

/**
 * The row's own oracle, as the inventory reported it when the row was made
 * ready. Carried into the seed rather than resolved here: this graph reads the
 * fact, it does not establish it.
 */
const seedState = (): State => ({
  ...seed(STEP, EVIDENCE, IMPACTED, PATHS),
  acceptanceTests: [OWN_AT],
});

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

/** Every write lands and the gate is clean. The axis is exercised separately. */
const landsCleanly: EffectExecutor = async (effects) =>
  effects.map((effect) =>
    effect.type === "run-command"
      ? LINT_OUTCOMES.clean(effect)
      : { effect, outcome: "committed" as const, version: 1 },
  );

/** A scripted executor: one write outcome per `replace-symbol`, in order. */
const writesLike = (outcomes: readonly WriteOutcome[]): EffectExecutor => {
  let n = 0;
  return async (effects) =>
    effects.map((effect) =>
      effect.type === "replace-symbol"
        ? writeResult(effect, outcomes[n++] ?? "committed")
        : effect.type === "run-command"
          ? LINT_OUTCOMES.clean(effect)
          : writeResult(effect, "committed"),
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

/**
 * What one run of the declared lint command did. Three, because three are what
 * the gate branch routes differently, and every one of them is an exit status
 * rather than a judgement.
 */
const LINT_OUTCOMES = {
  clean: (effect: Effect): EffectResult => ({
    effect,
    outcome: "committed",
    version: 1,
    command: { exitCode: 0, stdout: "Checked 1 file. No fixes applied.", stderr: "", durationMs: 3, timedOut: false },
  }),
  found: (effect: Effect): EffectResult => ({
    effect,
    outcome: "rejected",
    by: "command",
    command: {
      exitCode: 1,
      stdout: "src/exec_driver.rs:12 lint/suspicious/noDoubleEquals",
      stderr: "",
      durationMs: 4,
      timedOut: false,
    },
  }),
  unrunnable: (effect: Effect): EffectResult => ({ effect, outcome: "infra-failed" }),
} as const;
type LintOutcomeName = keyof typeof LINT_OUTCOMES;

/** A scripted executor: one named lint outcome per `run-command`, in order. */
const lintsLike = (names: readonly LintOutcomeName[]): EffectExecutor => {
  let n = 0;
  return async (effects) =>
    effects.map((effect) =>
      effect.type === "run-command"
        ? LINT_OUTCOMES[names[n++] ?? "clean"](effect)
        : writeResult(effect, "committed"),
    );
};

/** A scripted executor: one named suite outcome per `run-tests`, in order. */
const testsLike = (names: readonly TestOutcomeName[]): EffectExecutor => {
  let n = 0;
  return async (effects) =>
    effects.map((effect) =>
      effect.type === "run-tests"
        ? TEST_OUTCOMES[names[n++] ?? "committed"](effect)
        : effect.type === "run-command"
          ? LINT_OUTCOMES.clean(effect)
          : writeResult(effect, "committed"),
    );
};

const HAPPY: Script = {
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  commit: "committed",
};

const start = (script: Script, execute: EffectExecutor = landsCleanly) =>
  run<State>(deliverGraph(journalFor(script), defs, COMMANDS), seedState(), execute);

/** The loop-count row of what a person reads, for asserting on a parked run. */
const iterationsOf = (trail: readonly unknown[]) =>
  (trail[3] as { iterations: Record<string, number> }).iterations;

/** The design-gap row of the same trail. */
const designGapOf = (trail: readonly unknown[]) =>
  (trail[4] as { designGap?: string }).designGap;

describe("deliver graph", () => {
  test("the graph is structurally well-formed", () => {
    expect(graphDefects(deliverGraph(journalFor(HAPPY), defs, COMMANDS))).toEqual([]);
  });

  test("the happy path implements, runs the suite, refactors, gates and COMMITs", async () => {
    const outcome = await start(HAPPY);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.trace).toEqual([
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

  test("the cycle starts at implement: RED is a fact the row carries in", async () => {
    // The oracle was authored and measured red in its own run, and the row only
    // became ready because that verdict was recorded. Nothing here re-decides
    // it, so the first node is the loop and the first leaf is the crafter's.
    const outcome = await start(HAPPY);
    expect(outcome.trace[0]).toBe("cycle");
    expect(outcome.trace.filter((id) => id.endsWith(".red"))).toEqual([]);
  });

  // 347 runs through the real engine. No model, no key, no network.
  test("every leaf decision, effect outcome and loop count reaches a declared outcome", async () => {
    const seen = new Set<string>();
    const reasons = new Set<string>();
    const terminals = new Set<string>();

    const paths = await enumeratePaths(async (choose) => {
      const wf = deliverGraph(chooseJournal(choose), defs, COMMANDS);
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
    expect(paths).toHaveLength(347);

    // Every node the graph declares was exercised, except the one that is only
    // reachable by answering a suspension. The resume tests below cover it.
    const reachable = inspectGraph(deliverGraph(journalFor(HAPPY), defs, COMMANDS)).reachable;
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
    // The gate is a declared command now, so what makes it fail is the
    // command's exit status rather than a leaf's word for it.
    const outcome = await start({ ...HAPPY, "fix-lint": "fixed" }, lintsLike(["found", "found"]));

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("gates-loop-exhausted");
    expect(visitCount(outcome.trace, "gates-loop")).toBe(MAX_GATE_ATTEMPTS);
    expect(visitCount(outcome.trace, "gates")).toBe(MAX_GATE_ATTEMPTS);
    expect(visitCount(outcome.trace, "fix-lint")).toBe(MAX_GATE_ATTEMPTS);
    expect(iterationsOf(outcome.trail)["gates-loop"]).toBe(MAX_GATE_ATTEMPTS);
    // The inner loop ran out, so the cycle around it stopped after one pass.
    expect(visitCount(outcome.trace, "cycle")).toBe(1);
  });

  test("a lint run that fixes itself inside the bound reaches COMMIT", async () => {
    const outcome = await start({ ...HAPPY, "fix-lint": "fixed" }, lintsLike(["found", "clean"]));

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(visitCount(outcome.trace, "gates")).toBe(2);
    expect(visitCount(outcome.trace, "fix-lint")).toBe(1);
  });

  test("the gate runs the CONSUMER's declared lint command over the row's files", async () => {
    // The whole point of the gate being a step: the framework knows the job,
    // and the command is a declaration it reads. Nothing here is `bunx biome`
    // because nothing in the framework knows what a linter is called.
    const asked: Effect[] = [];
    const record: EffectExecutor = async (effects) => {
      asked.push(...effects);
      return effects.map((effect) =>
        effect.type === "run-command" ? LINT_OUTCOMES.clean(effect) : writeResult(effect, "committed"),
      );
    };
    await start(HAPPY, record);

    expect(asked.filter((e) => e.type === "run-command")).toEqual([
      {
        type: "run-command",
        argv: ["declared-lint", ...PATHS],
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
      },
    ]);
  });

  test("the gate's own output becomes the evidence the fixing leaf reads", async () => {
    // A finding is quoted to whoever has to repair it, verbatim. Handing the
    // leaf a paraphrase would be handing it a paraphrase of the thing it has
    // to fix, which is the same rule the oracle measurement follows one wave
    // over. The run is parked and then answered only so the state the gate
    // left behind can be read off a terminal.
    const wf = deliverGraph(journalFor({ ...HAPPY, "fix-lint": "fixed" }), defs, COMMANDS);
    const parked = await run<State>(wf, seedState(), lintsLike(["found", "found"]));
    if (parked.kind !== "suspended") throw new Error("expected the gates bound to park the run");
    expect(parked.reason).toBe("gates-loop-exhausted");

    const outcome = await resume<State>(wf, parked.runId, { decision: "commit" }, landsCleanly);
    if (outcome.kind !== "terminal" || outcome.terminal.kind !== "accepted") {
      throw new Error("expected the answered run to be accepted");
    }
    expect(outcome.terminal.state.evidence).toContain("noDoubleEquals");
    // And the evidence the run STARTED with is gone, because it was about a
    // different question.
    expect(outcome.terminal.state.evidence).not.toBe(EVIDENCE);
  });

  test("a lint command that cannot be run is the harness, not a finding", async () => {
    // `infra-failed` is distinct from a non-zero exit for the same reason it
    // is on a write: a gate that could not be RUN says nothing about the
    // change, so it must not spend the gates budget proving it.
    const outcome = await start({ ...HAPPY, "fix-lint": "fixed" }, lintsLike(["unrunnable"]));

    expect(outcome.kind === "suspended" && outcome.reason).toBe("harness-failed");
    expect(visitCount(outcome.trace, "gates")).toBe(1);
    expect(visited(outcome.trace, "fix-lint")).toBe(false);
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
    // infra-failed. That is the honest outcome and it has its own edge, which
    // is routed rather than hidden.
    const write = await start(HAPPY, memoryEffects().execute);
    expect(write.kind === "suspended" && write.reason).toBe("write-infra-failed");
    expect(visitCount(write.trace, "implement")).toBe(1);
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
    const outcome = await start({ ...HAPPY, refactor: EXHAUSTED });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("validator-exhausted");
    expect(outcome.trail[3]).toMatchObject({ exhausted: "refactor" });
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
          : effect.type === "run-command"
            ? LINT_OUTCOMES.clean(effect)
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
          : effect.type === "run-command"
            ? LINT_OUTCOMES.clean(effect)
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
          : effect.type === "run-command"
            ? LINT_OUTCOMES.clean(effect)
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
    const wf = deliverGraph(journalFor({ ...HAPPY, refactor: EXHAUSTED }), defs, COMMANDS);
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
    const wf = deliverGraph(journalFor({ ...HAPPY, refactor: EXHAUSTED, commit: EXHAUSTED }), defs, COMMANDS);
    const parked = await run<State>(wf, seedState(), landsCleanly);
    if (parked.kind !== "suspended") throw new Error("expected the run to park");

    const outcome = await resume<State>(wf, parked.runId, { decision: "commit" }, landsCleanly);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(visitCount(outcome.trace, "human")).toBe(1);
  });
});

describe("deliver graph defects", () => {
  const wf = deliverGraph(journalFor(HAPPY), defs, COMMANDS);
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
  "run-command": (Object.keys(LINT_OUTCOMES) as LintOutcomeName[]).map((name) => ({
    name,
    result: LINT_OUTCOMES[name],
  })),
  "append-trail": [
    { name: "committed", result: (effect: Effect) => ({ effect, outcome: "committed", version: 1 }) },
  ],
};
