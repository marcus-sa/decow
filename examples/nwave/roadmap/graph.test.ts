/**
 * The exhaustive test for the roadmap authoring workflow.
 *
 * This graph's path space is a SEQUENCE, like DELIVER's and unlike DISTILL's,
 * because it has a bounded loop: the same leaf answers again on the next
 * iteration. So `enumeratePaths` walks it rather than `cartesian`.
 *
 * Two things make this walk different from DELIVER's, and both are about this
 * graph putting a person in the middle rather than at the end.
 *
 * It RESUMES. DELIVER's person sits outside all three loops, so its walk can
 * stop at the suspension and leave `human.route` to the resume tests. Here the
 * review is inside the loop and `persist`, `accept` and both route nodes are
 * only reachable through an answer, so the walk answers: it runs, and while
 * the run is parked it chooses an answer from that node's closed enum and
 * resumes. The choice point's id is a function of the reason, which is a
 * function of the choices already made, which is exactly what the walker
 * requires.
 *
 * And its branches read PURE functions of the roadmap, not leaf decisions. To
 * reach `shape.route`'s `invalid` edge or `disjointness.route`'s `consistent`
 * and `drift-unresolvable` edges, the walk has to vary the DATA. So the choice
 * point at `decompose` is a choice of proposal, drawn from the hand-written
 * roadmaps in `./fixture.ts`. Enumerating a graph whose decisions are
 * functions of its data means enumerating enough data to reach every edge.
 *
 * Zero model calls, no API key, no network. Every leaf is stubbed at the
 * BINDING, a scripted worker with no entry for a step throws by name, and the
 * journal answers nothing, so a walk replays nothing.
 */

import { describe, expect, test } from "bun:test";
import { memoryEffects, type Effect, type EffectResult } from "@des/core/effects";
import type { ModelBinding } from "@des/core/step";
import { resume, run, type EffectExecutor } from "@des/core/workflow";
import { enumeratePaths, graphDefects, inspectGraph, type Choose } from "@des/core/harness";
import { describeTrace, endedOnDeclaredNode, isDeclaredOutcome, visitCount, visited } from "@des/core/harness";
import { noReplayJournal } from "@des/core/harness/no-replay";
import { scriptedBinding, throws, type ScriptedAnswer } from "@des/core/harness/scripted-binding";
import { measureDisjointness } from "./disjointness.ts";
import { shapeDefects } from "./shape.ts";
import {
  DESIGN_SOURCE,
  DISJOINT,
  KNOWN_GOOD,
  KNOWN_GOOD_RESOLVED,
  MALFORMED,
  REQUEST,
  UNRESOLVABLE,
  UNSHAPED,
} from "./fixture.ts";
import {
  BLOCK_REASONS,
  MAX_AUTHOR_ATTEMPTS,
  REVIEW_REASONS,
  ROADMAP_STEPS_TABLE,
  ROADMAP_TABLE,
  roadmapGraph,
  seed,
  type HumanAnswer,
  type ReviewAnswer,
  type State,
} from "./graph.ts";
import type { Roadmap, RoadmapStep } from "./schema.ts";
import {
  acceptanceIsDistills,
  observationsSayEnough,
  roadmapDefs,
  SLICE_VERDICTS,
  type SliceVerdict,
} from "./steps.ts";

/** The two leaf step ids, which are what a script is keyed by. */
const DECOMPOSE = "roadmap.decompose";
const SLICES = "roadmap.validate-slices";

/** The defs over one scripted binding, which serves all three slots. */
const defsFor = (binding: ModelBinding) =>
  roadmapDefs({ worker: binding, validator: binding, decomposeWith: binding });

/** The sentinel for "this leaf's validator was never satisfied". */
const EXHAUSTED = "$exhausted";

/** The proposals the walk draws from, and the shorthand a scripted test uses. */
const PROPOSALS = {
  "known-good": KNOWN_GOOD,
  disjoint: DISJOINT,
  unresolvable: UNRESOLVABLE,
  // Every defect at once, including three the LEAF's own checks carry — so
  // this one never reaches the gate, and the walk covers that route too.
  malformed: MALFORMED,
  // The defects the leaf cannot see, and only those: a dangling dependency
  // and a cycle. This is what makes `shape.route`'s `invalid` edge reachable.
  unshaped: UNSHAPED,
} as const;
type ProposalName = keyof typeof PROPOSALS;

type Script = {
  /** What `decompose` answers: a proposal name, `cannot-decompose`, or exhausted. */
  decompose?: ProposalName | "cannot-decompose" | typeof EXHAUSTED;
  /** What `validate-slices` answers. */
  slices?: SliceVerdict | typeof EXHAUSTED;
};

const decomposeAnswers = (answer: NonNullable<Script["decompose"]>): ScriptedAnswer[] => {
  if (answer === EXHAUSTED) return throws("the decomposer had nothing to say");
  if (answer === "cannot-decompose") {
    return [
      {
        decision: "cannot-decompose",
        payload: { roadmap: { request: REQUEST, steps: [] }, rationale: "no authority for it" },
      },
    ];
  }
  return [{ decision: "proposed", payload: { roadmap: PROPOSALS[answer], rationale: "three slices" } }];
};

/** Per-step verdicts that satisfy the leaf's own mechanical checks. */
const verdictsFor = (roadmap: Roadmap, verdict: SliceVerdict) =>
  roadmap.steps.map((step) => ({ stepId: step.id, verdict, anchor: step.observation }));

const slicesAnswers = (
  answer: NonNullable<Script["slices"]>,
  roadmap: Roadmap,
): ScriptedAnswer[] =>
  answer === EXHAUSTED
    ? throws("the judge had nothing to say")
    : [{ decision: answer, payload: { verdicts: verdictsFor(roadmap, answer), rationale: "judged" } }];

/** One binding per script. An unscripted leaf refuses by name on every attempt. */
const bindingFor = (script: Script): ModelBinding => {
  const proposal =
    script.decompose === undefined || script.decompose === EXHAUSTED || script.decompose === "cannot-decompose"
      ? KNOWN_GOOD
      : PROPOSALS[script.decompose];
  return scriptedBinding({
    ...(script.decompose === undefined ? {} : { [DECOMPOSE]: decomposeAnswers(script.decompose) }),
    ...(script.slices === undefined ? {} : { [SLICES]: slicesAnswers(script.slices, proposal) }),
  });
};

/** The happy script: a good proposal, every step a slice. */
const HAPPY: Script = { decompose: "known-good", slices: "is-slice" };

/** Every artifact row lands. The persist axis is exercised separately. */
const landsCleanly: EffectExecutor = async (effects) =>
  effects.map((effect) => ({ effect, outcome: "committed" as const, version: 1 }));

const start = (script: Script, execute: EffectExecutor = landsCleanly) =>
  run<State>(roadmapGraph(noReplayJournal(), defsFor(bindingFor(script))), seed(REQUEST, DESIGN_SOURCE), execute);

/** One fixture step, typed. `steps[i]` is `| undefined` under noUncheckedIndexedAccess. */
const stepAt = (roadmap: Roadmap, i: number): RoadmapStep => {
  const step = roadmap.steps[i];
  if (step === undefined) throw new Error(`fixture has no step at ${i}`);
  return step;
};

/** The roadmap a person reads, off the trail. */
const roadmapOf = (trail: readonly unknown[]) => (trail[0] as { roadmap: Roadmap }).roadmap;
/** The added edges, off the same trail. */
const edgesOf = (trail: readonly unknown[]) =>
  (trail[1] as { addedEdges: string[]; unresolvable?: { a: string; b: string } });
/** The defects, off the same trail. */
const defectsOf = (trail: readonly unknown[]) =>
  (trail[2] as { defects: { kind: string; stepId?: string }[] }).defects;

describe("roadmap graph", () => {
  test("the graph is structurally well-formed", () => {
    expect(graphDefects(roadmapGraph(noReplayJournal(), defsFor(bindingFor(HAPPY))))).toEqual([]);
  });

  test("a good proposal reaches a person, who is the only route to persist", async () => {
    const parked = await start(HAPPY);

    expect(parked.kind).toBe("suspended");
    if (parked.kind !== "suspended") return;
    // The fixture's deliberate overlap was measured and ordered, so the person
    // is told what changed rather than handed the roadmap they asked for.
    expect(parked.reason).toBe("edges-added");
    expect(describeTrace(parked.trace)).toBe(
      "author -> decompose -> decompose.route -> validate-shape -> shape.route -> " +
        "validate-slices -> slices.route -> measure-disjointness -> disjointness.route -> human-review",
    );
    // Nothing was written before a person saw it.
    expect(visited(parked.trace, "persist")).toBe(false);
  });

  test("a roadmap with no overlap parks as ready rather than as edited", async () => {
    const parked = await start({ decompose: "disjoint", slices: "is-slice" });
    expect(parked.kind === "suspended" && parked.reason).toBe("roadmap-ready");
    expect(parked.kind === "suspended" && edgesOf(parked.trail).addedEdges).toEqual([]);
  });

  test("a defect the leaf's own check catches never reaches the gate", async () => {
    // `decompose` carries `empty-authority`, `observation-too-short` and
    // `duplicate-id` as mechanical checks. A proposal breaking one is refused
    // before a validator is spent, and a worker that keeps proposing it
    // exhausts its budget at the LEAF — which is a different block from the
    // gate's, and one a seeded journal could not tell apart because it would
    // never run the check.
    const outcome = await start({ decompose: "malformed", slices: "is-slice" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("validator-exhausted");
    expect(visitCount(outcome.trace, "decompose")).toBe(1);
    expect(visited(outcome.trace, "validate-shape")).toBe(false);
  });

  test("an invalid shape iterates rather than blocking, with the defects named", async () => {
    const outcome = await start({ decompose: "unshaped", slices: "is-slice" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    // Two attempts at the same unshaped proposal is the bound, and the person
    // is told which budget was spent.
    expect(outcome.reason).toBe("author-loop-exhausted");
    expect(visitCount(outcome.trace, "decompose")).toBe(MAX_AUTHOR_ATTEMPTS);
    expect(visitCount(outcome.trace, "validate-shape")).toBe(MAX_AUTHOR_ATTEMPTS);
    // It never reached the slice check: an unvalidatable shape is not judged.
    expect(visited(outcome.trace, "validate-slices")).toBe(false);

    // The person reads the same named defects `decompose` was re-prompted
    // with, which is the whole reason they are named rather than a boolean.
    // The two the gate owns alone, and only those: the other three never get
    // this far, because the leaf's own checks refuse a proposal carrying one.
    expect([...new Set(defectsOf(outcome.trail).map((d) => d.kind))].sort()).toEqual([
      "cycle",
      "dangling-dependency",
    ]);
  });

  test("a step that is not a slice iterates, carrying the refusal back to decompose", async () => {
    const outcome = await start({ decompose: "known-good", slices: "not-slice" });

    expect(outcome.kind === "suspended" && outcome.reason).toBe("author-loop-exhausted");
    expect(visitCount(outcome.trace, "validate-slices")).toBe(MAX_AUTHOR_ATTEMPTS);
    expect(visited(outcome.trace, "measure-disjointness")).toBe(false);
  });

  test("cannot-tell goes to a person, because a judgement nobody could make is not a re-prompt", async () => {
    const outcome = await start({ decompose: "known-good", slices: "cannot-tell" });

    expect(outcome.kind === "suspended" && outcome.reason).toBe("slices-cannot-tell");
    // It left after one attempt rather than spending the budget.
    expect(visitCount(outcome.trace, "decompose")).toBe(1);
    expect(outcome.trace.at(-1)).toBe("human");
  });

  test("cannot-decompose is an honest answer routed to a person, not a retry", async () => {
    const outcome = await start({ decompose: "cannot-decompose" });

    expect(outcome.kind === "suspended" && outcome.reason).toBe("cannot-decompose");
    expect(visitCount(outcome.trace, "decompose")).toBe(1);
    expect(visited(outcome.trace, "validate-shape")).toBe(false);
  });

  test("an unresolvable overlap names the offending pair and leaves the loop", async () => {
    const outcome = await start({ decompose: "unresolvable", slices: "is-slice" });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("drift-unresolvable");
    expect(edgesOf(outcome.trail).unresolvable).toMatchObject({ a: "02-02", b: "02-03" });
    // The edge it did manage to add before stopping is in the trail too.
    expect(edgesOf(outcome.trail).addedEdges).toHaveLength(1);
    expect(visitCount(outcome.trace, "decompose")).toBe(1);
  });

  test("an exhausted validator parks under validator-exhausted, naming the leaf", async () => {
    const fromDecompose = await start({ decompose: EXHAUSTED });
    expect(fromDecompose.kind === "suspended" && fromDecompose.reason).toBe("validator-exhausted");

    const fromSlices = await start({ decompose: "known-good", slices: EXHAUSTED });
    expect(fromSlices.kind === "suspended" && fromSlices.reason).toBe("validator-exhausted");
    expect(
      fromSlices.kind === "suspended"
        ? (fromSlices.trail[4] as { exhausted?: string }).exhausted
        : undefined,
    ).toBe("validate-slices");
  });
});

/**
 * The walk. Every leaf answer, every proposal, every artifact-row outcome,
 * every person's answer, and both loop counts, once each.
 */
describe("roadmap graph, exhaustively", () => {
  test("every decision, proposal, row outcome and answer reaches a declared outcome", async () => {
    const seen = new Set<string>();
    const reasons = new Set<string>();
    const terminals = new Set<string>();

    const paths = await enumeratePaths(async (choose) => {
      const wf = roadmapGraph(noReplayJournal(), defsFor(chooseBinding(choose)));
      const execute = chooseExecutor(choose);
      let outcome = await run<State>(wf, seed(REQUEST, DESIGN_SOURCE), execute);

      // The walk answers the person. Every node past `human-review` is only
      // reachable through an answer, so a walk that stopped at the suspension
      // would leave a third of the graph unvisited.
      for (let guard = 0; outcome.kind === "suspended"; guard += 1) {
        if (guard > MAX_AUTHOR_ATTEMPTS + 2) throw new Error("the run never reached a terminal");
        for (const id of outcome.trace) seen.add(id);
        reasons.add(outcome.reason);
        const answer = choose(`resume:${outcome.reason}`, answersFor(outcome.reason));
        outcome = await resume<State>(wf, outcome.runId, answer, execute);
      }

      expect(isDeclaredOutcome(outcome)).toBe(true);
      expect(endedOnDeclaredNode(wf, outcome)).toBe(true);
      for (const id of outcome.trace) seen.add(id);
      terminals.add(outcome.terminal.kind);
      return outcome;
    });

    // The bound is what makes this a number rather than an infinity.
    //
    // Stubbing at the binding runs the six mechanical checks `decompose`
    // carries and the three `validate-slices` does, so the walk draws from a
    // fifth proposal to keep the gate's own `invalid` edge reachable —
    // `MALFORMED` breaks three rules the LEAF owns, so it exhausts there, and
    // `UNSHAPED` breaks only the two the gate owns alone.
    expect(paths).toHaveLength(176);

    // Every node the graph declares was exercised. Nothing is excused here:
    // the walk resumes, so there is no node only a resume test can reach.
    const reachable = inspectGraph(roadmapGraph(noReplayJournal(), defsFor(bindingFor(HAPPY)))).reachable;
    expect(reachable.filter((id) => !seen.has(id))).toEqual([]);

    // Every declared reason either suspend node may park under occurs.
    expect([...reasons].sort()).toEqual([...REVIEW_REASONS, ...BLOCK_REASONS].sort());
    expect([...terminals].sort()).toEqual(["accepted", "rejected"]);
  }, 120_000);
});

/**
 * `validate-shape` is a pure function, so its defects are unit-testable
 * without the engine. One test per defect kind the graph declares, each
 * asserting the defect is NAMED rather than that the roadmap was refused.
 */
describe("validate-shape names its defects", () => {
  const defectsIn = (roadmap: Roadmap) =>
    shapeDefects(roadmap).map((d) => `${d.kind}${"stepId" in d ? `:${d.stepId}` : ""}`);

  test("a well-formed roadmap has none", () => {
    expect(shapeDefects(KNOWN_GOOD)).toEqual([]);
  });

  test("a cycle is named by the path that closes it", () => {
    const cyclic = {
      ...KNOWN_GOOD,
      steps: [
        { ...(stepAt(KNOWN_GOOD, 0)), dependencies: ["01-02"] },
        { ...(stepAt(KNOWN_GOOD, 1)), dependencies: ["01-01"] },
        stepAt(KNOWN_GOOD, 2),
      ],
    };
    const cycle = shapeDefects(cyclic).find((d) => d.kind === "cycle");
    expect(cycle).toMatchObject({ kind: "cycle", stepIds: ["01-01", "01-02", "01-01"] });
  });

  test("a dependency naming no step is named with both ends", () => {
    const dangling = {
      ...KNOWN_GOOD,
      steps: [{ ...(stepAt(KNOWN_GOOD, 0)), dependencies: ["01-99"] }, ...KNOWN_GOOD.steps.slice(1)],
    };
    expect(shapeDefects(dangling)).toContainEqual({
      kind: "dangling-dependency",
      stepId: "01-01",
      dependency: "01-99",
    });
  });

  test("a duplicate id is named", () => {
    const duplicated = { ...KNOWN_GOOD, steps: [...KNOWN_GOOD.steps, stepAt(KNOWN_GOOD, 0)] };
    expect(shapeDefects(duplicated)).toContainEqual({ kind: "duplicate-id", stepId: "01-01" });
  });

  test("an observation too short to be worked from is named, with its length", () => {
    // Obligations are DISTILL's to state, so what ROADMAP asks is whether the
    // observation says enough to decide anything about.
    const terse = {
      ...KNOWN_GOOD,
      steps: [{ ...(stepAt(KNOWN_GOOD, 0)), observation: "it works" }, ...KNOWN_GOOD.steps.slice(1)],
    };
    expect(shapeDefects(terse)).toContainEqual({
      kind: "observation-too-short",
      stepId: "01-01",
      characters: 8,
    });
  });

  test("a proposal with no obligations at all is well-formed, because they are DISTILL's", () => {
    // The boundary this wave keeps. Refusing a roadmap for not having done a
    // later wave's job would refuse every roadmap.
    expect(KNOWN_GOOD.steps.every((step) => step.acceptance.length === 0)).toBe(true);
    expect(shapeDefects(KNOWN_GOOD)).toEqual([]);
  });

  test("a step whose authority is blank is named, whitespace included", () => {
    const unanchored = {
      ...KNOWN_GOOD,
      steps: [{ ...(stepAt(KNOWN_GOOD, 0)), authority: "  \n " }, ...KNOWN_GOOD.steps.slice(1)],
    };
    expect(shapeDefects(unanchored)).toContainEqual({ kind: "empty-authority", stepId: "01-01" });
  });

  test("an empty roadmap is one defect rather than every check passing vacuously", () => {
    // The schema admits it, because that is what `cannot-decompose` returns.
    // Reaching `human-review` with it would be a proposal worth approving.
    expect(shapeDefects({ request: REQUEST, steps: [] })).toEqual([{ kind: "no-steps" }]);
  });

  test("the malformed fixture reaches every defect kind the graph declares", () => {
    expect(defectsIn(MALFORMED).sort()).toEqual([
      "cycle",
      "dangling-dependency:03-01",
      "duplicate-id:03-01",
      "empty-authority:03-02",
      "observation-too-short:03-01",
      "observation-too-short:03-01",
      "observation-too-short:03-02",
      "observation-too-short:03-03",
      "observation-too-short:03-04",
    ]);
  });
});

/**
 * `decompose`'s own mechanical guardrails, which run before a validator model
 * is spent. Each delegates to `shape.ts`, so the step's guardrail and the
 * graph's gate cannot drift; the exception is the wave boundary, which is
 * about what a decomposition is ALLOWED to decide rather than about shape.
 */
describe("decompose's mechanical guardrails", () => {
  const check = (
    row: (d: readonly string[]) => { check?: (ctx: never) => unknown },
    output: unknown,
  ) => row(["proposed", "cannot-decompose"]).check?.({ output } as never);

  test("a proposal that fills in acceptance facts is refused at the model boundary", () => {
    // The wave boundary, mechanical. What a value must be observed to do is
    // DISTILL's act; a decomposer that answered it would have its answer
    // persisted as though a wave had produced it.
    const filled = {
      decision: "proposed",
      payload: {
        roadmap: {
          ...KNOWN_GOOD,
          steps: [
            {
              ...(stepAt(KNOWN_GOOD, 0)),
              acceptance: [{ id: "x", stimulus: "do it", expected: "it happened" }],
            },
            ...KNOWN_GOOD.steps.slice(1),
          ],
        },
      },
    };
    expect(check(acceptanceIsDistills, filled)).toMatchObject({
      requirementId: "roadmap.acceptance-facts-are-distills",
    });
    // An oracle and a support list are the same finding by the same rule.
    const oracled = {
      decision: "proposed",
      payload: {
        roadmap: {
          ...KNOWN_GOOD,
          steps: [{ ...(stepAt(KNOWN_GOOD, 0)), oracle: "test/a.test.ts::x" }, ...KNOWN_GOOD.steps.slice(1)],
        },
      },
    };
    expect(check(acceptanceIsDistills, oracled)).not.toBeNull();
  });

  test("the known-good proposal passes every guardrail", () => {
    const proposed = { decision: "proposed", payload: { roadmap: KNOWN_GOOD } };
    expect(check(acceptanceIsDistills, proposed)).toBeNull();
    expect(check(observationsSayEnough, proposed)).toBeNull();
  });

  test("a cannot-decompose answer carries no roadmap, so every guardrail passes vacuously", () => {
    const refused = {
      decision: "cannot-decompose",
      payload: { roadmap: { request: REQUEST, steps: [] } },
    };
    expect(check(acceptanceIsDistills, refused)).toBeNull();
    expect(check(observationsSayEnough, refused)).toBeNull();
  });
});

/**
 * `measure-disjointness` is the other pure function. Its four claims are the
 * ones `parallel_safety.py` makes plus the resolution this graph adds.
 */
describe("measure-disjointness", () => {
  test("declared-independent pairs with disjoint scopes are consistent", () => {
    const measured = measureDisjointness(DISJOINT);
    expect(measured.verdict).toBe("consistent");
    expect(measured.addedEdges).toEqual([]);
    // Consistent means untouched: the resolution is not a rewrite.
    expect(measured.resolved).toEqual(DISJOINT);
  });

  test("an overlapping independent pair gets an edge in declaration order", () => {
    const measured = measureDisjointness(KNOWN_GOOD);

    expect(measured.verdict).toBe("edges-added");
    expect(measured.addedEdges).toEqual([
      { a: "01-01", b: "01-03", shared: ["Reconciler::interests"] },
    ]);
    // The lower-ordinal step comes first, and the higher one gains the
    // dependency. That is the whole of the resolution rule.
    expect(measured.resolved).toEqual(KNOWN_GOOD_RESOLVED);
  });

  test("an overlap whose resolving edge would close a cycle is unresolvable", () => {
    const measured = measureDisjointness(UNRESOLVABLE);

    expect(measured.verdict).toBe("drift-unresolvable");
    expect(measured.unresolvable).toEqual({ a: "02-02", b: "02-03", shared: ["shared::bravo"] });
    // It names how far it got: 02-01 -> 02-02 landed, and the next edge would
    // have closed 02-01 -> 02-02 -> 02-03 -> 02-01.
    expect(measured.addedEdges).toEqual([
      { a: "02-01", b: "02-02", shared: ["shared::alpha"] },
    ]);
  });

  test("a pair already ordered by a dependency path is never flagged", () => {
    // 01-01 and 01-02 share nothing, so make them share everything. The
    // roadmap declares 01-02 after 01-01, so there is nothing to measure.
    const ordered = {
      ...KNOWN_GOOD,
      steps: [
        stepAt(KNOWN_GOOD, 0),
        { ...(stepAt(KNOWN_GOOD, 1)), predictedTouches: ["Reconciler::interests"] },
        { ...(stepAt(KNOWN_GOOD, 2)), predictedTouches: ["EvaluationBroker::submit"] },
      ],
    };
    const measured = measureDisjointness(ordered);
    expect(measured.verdict).toBe("consistent");
  });

  test("a transitive dependency path counts as ordered, not just a direct edge", () => {
    const chained = {
      request: REQUEST,
      steps: [
        { ...(stepAt(KNOWN_GOOD, 0)), id: "a", dependencies: [], predictedTouches: ["x"] },
        { ...(stepAt(KNOWN_GOOD, 1)), id: "b", dependencies: ["a"], predictedTouches: [] },
        { ...(stepAt(KNOWN_GOOD, 2)), id: "c", dependencies: ["b"], predictedTouches: ["x"] },
      ],
    };
    expect(measureDisjointness(chained).verdict).toBe("consistent");
  });
});

/** One test per answer a person may give, at each of the two suspend nodes. */
describe("roadmap graph, resumed by a person", () => {
  const park = async (script: Script = HAPPY, execute: EffectExecutor = landsCleanly) => {
    const wf = roadmapGraph(noReplayJournal(), defsFor(bindingFor(script)));
    const parked = await run<State>(wf, seed(REQUEST, DESIGN_SOURCE), execute);
    if (parked.kind !== "suspended") throw new Error("expected the run to park");
    return { wf, parked, execute };
  };

  test("approve continues the same run through persist to accepted", async () => {
    const { wf, parked, execute } = await park();
    const answer: ReviewAnswer = { decision: "approve" };
    const outcome = await resume<State>(wf, parked.runId, answer, execute);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.trace.slice(-5)).toEqual([
      "review.route",
      "author.verdict",
      "persist",
      "persist.verdict",
      "accept",
    ]);
    // The trace spans both halves of the run: it survived the suspension.
    expect(outcome.trace.slice(0, parked.trace.length)).toEqual(parked.trace);
    expect(outcome.runId).toBe(parked.runId);
    // What the person approved is the resolved roadmap, not the proposal.
    expect(roadmapOf(parked.trail)).toEqual(KNOWN_GOOD_RESOLVED);
  });

  test("revise re-runs decompose with the person's notes, inside the bound", async () => {
    const { wf, parked, execute } = await park();
    const answer: ReviewAnswer = { decision: "revise", notes: "01-03 is a mechanism, not a slice" };
    const outcome = await resume<State>(wf, parked.runId, answer, execute);

    // The second iteration ran, parked again, and this time the bound is what
    // ends it — a person who keeps asking for revisions is told which budget
    // was spent rather than being asked a third time.
    expect(outcome.kind === "suspended" && outcome.reason).toBe("edges-added");
    expect(visitCount(outcome.trace, "decompose")).toBe(2);
    expect(visitCount(outcome.trace, "human-review")).toBe(2);

    const second = await resume<State>(wf, outcome.runId, { decision: "revise" }, execute);
    expect(second.kind === "suspended" && second.reason).toBe("author-loop-exhausted");
    expect(second.trace.at(-1)).toBe("human");
  });

  test("abandon reaches the rejected terminal with the trail attached", async () => {
    const { wf, parked, execute } = await park();
    const answer: ReviewAnswer = { decision: "abandon" };
    const outcome = await resume<State>(wf, parked.runId, answer, execute);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(outcome.trace.at(-1)).toBe("reject");
    expect(visited(outcome.trace, "persist")).toBe(false);
  });

  test("a blocked run parks at the other node, where the one answer ends it", async () => {
    const { wf, parked, execute } = await park({ decompose: "cannot-decompose" });
    expect(parked.trace.at(-1)).toBe("human");

    const answer: HumanAnswer = { decision: "abandon" };
    const outcome = await resume<State>(wf, parked.runId, answer, execute);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(outcome.trace.slice(-2)).toEqual(["human.route", "reject"]);
  });
});

/**
 * `persist` through the in-memory executor. This is the one place the roadmap
 * stops being a value in state and becomes rows with a version column.
 */
describe("roadmap graph, persisted", () => {
  const approve = async (effects: ReturnType<typeof memoryEffects>) => {
    const wf = roadmapGraph(noReplayJournal(), defsFor(bindingFor(HAPPY)));
    const parked = await run<State>(wf, seed(REQUEST, DESIGN_SOURCE), effects.execute);
    if (parked.kind !== "suspended") throw new Error("expected the run to park");
    return await resume<State>(wf, parked.runId, { decision: "approve" }, effects.execute);
  };

  test("the roadmap and every step land as rows at version 1", async () => {
    const effects = memoryEffects();
    const outcome = await approve(effects);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect([...effects.artifacts.keys()].sort()).toEqual([
      `${ROADMAP_STEPS_TABLE}/01-01`,
      `${ROADMAP_STEPS_TABLE}/01-02`,
      `${ROADMAP_STEPS_TABLE}/01-03`,
      `${ROADMAP_TABLE}/${REQUEST}`,
    ]);
    expect([...effects.artifacts.values()].every((a) => a.version === 1)).toBe(true);

    // The rows are the RESOLVED roadmap: 01-03 carries the dependency the
    // disjointness rule added, so what gets persisted is what was measured.
    expect(effects.artifacts.get(`${ROADMAP_STEPS_TABLE}/01-03`)?.row).toEqual(
      KNOWN_GOOD_RESOLVED.steps[2],
    );
    expect(effects.artifacts.get(`${ROADMAP_TABLE}/${REQUEST}`)?.row).toEqual({
      request: REQUEST,
      stepIds: ["01-01", "01-02", "01-03"],
    });
  });

  test("a second persist at expectedVersion 0 conflicts and routes to a person", async () => {
    const effects = memoryEffects();
    await approve(effects);
    const second = await approve(effects);

    // The world moved to version 1 and this run still claims 0. That is an
    // edge to a person with its own reason, not an exception.
    expect(second.kind === "suspended" && second.reason).toBe("persist-conflict");
    expect(second.trace.slice(-3)).toEqual(["persist", "persist.verdict", "human"]);
    // And the conflicting run changed nothing.
    expect([...effects.artifacts.values()].every((a) => a.version === 1)).toBe(true);
  });

  test("the terminal carries the resolved roadmap, which is what a scheduler reads", async () => {
    const outcome = await approve(memoryEffects());
    if (outcome.kind !== "terminal" || outcome.terminal.kind !== "accepted") {
      throw new Error("expected the approved run to be accepted");
    }
    expect(outcome.terminal.state.roadmap).toEqual(KNOWN_GOOD_RESOLVED);
  });
});

/* ------------------------------------------------------------- walk wiring */

/** Every answer a person may give at the node that parked under this reason. */
const answersFor = (reason: string): (ReviewAnswer | HumanAnswer)[] =>
  (REVIEW_REASONS as readonly string[]).includes(reason)
    ? [{ decision: "approve" }, { decision: "revise" }, { decision: "abandon" }]
    : [{ decision: "abandon" }];

/**
 * Answers `decompose` from the proposal set, and `validate-slices` from its
 * own. Consulted once per INVOCATION, because `scriptedBinding` holds the
 * chosen answers across a leaf's retries — so a leaf a mechanical check
 * refused and re-drove is one choice point rather than two.
 */
const chooseBinding = (choose: Choose): ModelBinding => {
  /**
   * The roadmap `decompose` last proposed on this path.
   *
   * `validate-slices` carries `everyStepIsAnswered` and
   * `sliceAnchorsAreVerbatim` as mechanical checks, and both are about the
   * roadmap it was ASKED about — so a verdict set shaped against the wrong
   * fixture is refused rather than judged. A binding is answered by step id
   * and never sees the input, so the walk remembers what it proposed: the two
   * leaves run in that order on every path, so this is read after it is set.
   */
  let proposed: Roadmap = KNOWN_GOOD;

  return scriptedBinding(({ step }) => {
    if (step.id === DECOMPOSE) {
      const proposals: NonNullable<Script["decompose"]>[] = [
        ...(Object.keys(PROPOSALS) as ProposalName[]),
        "cannot-decompose",
        EXHAUSTED,
      ];
      const answer = choose("leaf:decompose", proposals);
      proposed = answer === EXHAUSTED || answer === "cannot-decompose" ? KNOWN_GOOD : PROPOSALS[answer];
      return decomposeAnswers(answer);
    }
    const slices: NonNullable<Script["slices"]>[] = [...SLICE_VERDICTS, EXHAUSTED];
    return slicesAnswers(choose("leaf:validate-slices", slices), proposed);
  });
};

/** Answers every artifact-row batch from `EffectResult`'s own outcome space. */
const PERSIST_OUTCOMES = ["committed", "conflict", "rejected", "infra-failed"] as const;

const chooseExecutor = (choose: Choose): EffectExecutor => async (effects) => {
  const persists = effects.some((e) => e.type === "upsert-artifact");
  if (!persists) {
    return effects.map((effect): EffectResult => ({ effect, outcome: "committed", version: 1 }));
  }
  const outcome = choose("effect:upsert-artifact", PERSIST_OUTCOMES);
  return effects.map((effect) => artifactResult(effect, outcome));
};

const artifactResult = (effect: Effect, outcome: (typeof PERSIST_OUTCOMES)[number]): EffectResult => {
  switch (outcome) {
    case "committed":
      return { effect, outcome, version: 1 };
    case "conflict":
      return { effect, outcome, currentVersion: 1 };
    case "rejected":
      return { effect, outcome, by: "schema" };
    case "infra-failed":
      return { effect, outcome };
  }
};
