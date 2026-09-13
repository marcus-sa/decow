/**
 * The hand-written roadmaps. Committed, not a test file, imported only by
 * tests and by the enumeration walk.
 *
 * `KNOWN_GOOD` is the oracle: three steps, one declared dependency, and one
 * deliberate overlap between a pair the roadmap calls independent. It is what
 * the framework/consumer split means by "the known-good hand-written artifact
 * used to validate the authoring workflow" — the harness proves a roadmap is
 * well-formed, and this is the only thing that says a well-formed one is
 * right.
 *
 * The other four exist because the graph's two pure decision functions are
 * functions of the DATA. To reach `shape.route`'s `invalid` edge or
 * `disjointness.route`'s `consistent` and `drift-unresolvable` edges, the walk
 * has to vary the roadmap, not just the leaf decisions. So `decompose`'s
 * choice point in the walk is a choice of PROPOSAL, and these are the
 * proposals. That is the honest shape for a graph whose branches read a pure
 * function: enumerating the graph means enumerating enough data to reach every
 * edge.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { Roadmap, RoadmapStep } from "./schema.ts";

export const REQUEST =
  "A reconciler declares how the loop wakes it, and the loop honours the declaration.";

export const DESIGN_SOURCE =
  "ADR-0084 declares two additive, default-provided hooks on the Reconciler trait: " +
  "`resync_schedule() -> Option<ResyncSchedule>` and `interests() -> &'static [ObservationRowKind]`. " +
  "The convergence loop owns a next-wake table; the interest router owns a fan-out over accepted " +
  "observation-row changes and an unconditional periodic relist.";

/**
 * One PROPOSED row, which is what ROADMAP produces: no obligations, no oracle,
 * no supports. Those three are DISTILL's to fill, and a fixture that
 * pre-filled them would be testing a roadmap no decomposer could return.
 */
const step = (
  id: string,
  observation: string,
  dependencies: string[],
  authority: string,
  predictedTouches: string[],
): RoadmapStep => ({
  id,
  observation,
  dependencies,
  authority,
  predictedTouches,
  acceptance: [],
  supports: [],
});

/**
 * The oracle. Three steps; `01-02` depends on `01-01`; `01-01` and `01-03` are
 * declared independent and both write `Reconciler::interests`, which is the
 * deliberate overlap. Declaration order therefore resolves it as
 * `01-01 -> 01-03`, and `01-02` versus `01-03` measures disjoint, so the whole
 * roadmap comes back `edges-added` with exactly one edge.
 */
export const KNOWN_GOOD: Roadmap = {
  request: REQUEST,
  steps: [
    step(
      "01-01",
      "A deployed reconciler that declares interests() is woken by an accepted alloc_status change, observed as a converge tick in the trace.",
      [],
      "ADR-0084 § interests()",
      ["Reconciler::interests", "ObservationRow::kind"],
    ),
    step(
      "01-02",
      "A host-backed reconciler that declares resync_schedule() runs on its own cadence with no observation-row change at all.",
      ["01-01"],
      "ADR-0084 § resync_schedule()",
      ["Reconciler::resync_schedule", "ConvergenceLoop::next_wake"],
    ),
    step(
      "01-03",
      "A reconciler declaring neither hook is still woken by a producer handoff, so the migration adds no dead reconciler.",
      [],
      "ADR-0084 § the producer-push path",
      ["Reconciler::interests", "EvaluationBroker::submit"],
    ),
  ],
};

/**
 * What `KNOWN_GOOD` becomes once the overlap is resolved: `01-03` gains the
 * dependency declaration order implied. This is the roadmap `persist` writes,
 * and asserting on it is what makes "the resolution is not advice" testable.
 */
export const KNOWN_GOOD_RESOLVED: Roadmap = {
  ...KNOWN_GOOD,
  steps: KNOWN_GOOD.steps.map((s) =>
    s.id === "01-03" ? { ...s, dependencies: ["01-01"] } : s,
  ),
};

/** Every pair measures disjoint, so the verdict is `consistent`. */
export const DISJOINT: Roadmap = {
  request: REQUEST,
  steps: [
    { ...(KNOWN_GOOD.steps[0] as RoadmapStep) },
    { ...(KNOWN_GOOD.steps[1] as RoadmapStep) },
    {
      ...(KNOWN_GOOD.steps[2] as RoadmapStep),
      predictedTouches: ["EvaluationBroker::submit"],
    },
  ],
};

/**
 * An overlap whose resolving edge closes a cycle.
 *
 * `A`, `B`, `C` in declaration order, with `C` declared as a dependency of
 * `A` — the one backward edge that makes this reachable. `A` and `B` are
 * independent and overlap, so `A -> B` is added. `B` and `C` are then still
 * independent and overlap, and `B -> C` would close `A -> B -> C -> A`. The
 * rule stops and names the pair.
 */
export const UNRESOLVABLE: Roadmap = {
  request: REQUEST,
  steps: [
    step(
      "02-01",
      "A declares the hook and is woken by a change, observed through a deploy.",
      ["02-03"],
      "ADR-0084 § interests()",
      ["shared::alpha"],
    ),
    step(
      "02-02",
      "B declares the cadence and ticks on it, observed through a clean boot.",
      [],
      "ADR-0084 § resync_schedule()",
      ["shared::alpha", "shared::bravo"],
    ),
    step(
      "02-03",
      "C keeps the producer handoff working, observed through a deploy.",
      [],
      "ADR-0084 § the producer-push path",
      ["shared::bravo"],
    ),
  ],
};

/**
 * Every shape defect at once, so one proposal reaches `shape.route`'s
 * `invalid` edge and the defect list has something to say about each row:
 * `03-01` is duplicated and depends on nothing that exists; `03-02` names no
 * authority; the pair `03-03` / `03-04` declare each other, which is a cycle;
 * and every observation here is too short to be worked from, which is the
 * defect that replaced `no-acceptance` when obligations became DISTILL's.
 */
const malformed = (
  id: string,
  observation: string,
  dependencies: string[],
  authority: string,
): RoadmapStep => ({
  id,
  observation,
  dependencies,
  authority,
  predictedTouches: [],
  acceptance: [],
  supports: [],
});

export const MALFORMED: Roadmap = {
  request: REQUEST,
  steps: [
    malformed("03-01", "a mechanism exists", ["03-09"], "ADR-0084"),
    malformed("03-01", "the same mechanism exists again", [], "ADR-0084"),
    malformed("03-02", "something is observable", [], "   "),
    malformed("03-03", "a deploy reaches C", ["03-04"], "ADR-0084"),
    malformed("03-04", "a deploy reaches D", ["03-03"], "ADR-0084"),
  ],
};

/**
 * The defects the LEAF's own checks cannot see, and nothing else.
 *
 * `decompose` carries `empty-authority`, `observation-too-short` and
 * `duplicate-id` as mechanical checks, so a proposal breaking one of those
 * never reaches `validate-shape`: the check refuses it and the worker is
 * re-driven. The three the leaf does NOT carry — `no-steps`,
 * `dangling-dependency` and `cycle` — are the gate's alone, and they are what
 * makes `shape.route`'s `invalid` edge reachable at all.
 *
 * So every row here is well-formed on its own: a unique id, a real authority,
 * an observation past the floor. `04-01` depends on a step nobody declared,
 * and `04-02` / `04-03` declare each other.
 */
export const UNSHAPED: Roadmap = {
  request: REQUEST,
  steps: [
    step(
      "04-01",
      "A deployed reconciler waking on a row change is observed as a converge tick in the trace.",
      ["04-09"],
      "ADR-0084 § interests()",
      ["Reconciler::interests"],
    ),
    step(
      "04-02",
      "A deployed reconciler ticking on its own cadence is observed as a converge tick after a clean boot.",
      ["04-03"],
      "ADR-0084 § resync_schedule()",
      ["Reconciler::resync_schedule"],
    ),
    step(
      "04-03",
      "The producer handoff still wakes its consumer, observed as a converge tick after a deploy.",
      ["04-02"],
      "ADR-0084 § the interest router",
      ["ExitObserver::write"],
    ),
  ],
};
