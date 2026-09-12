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

const step = (
  id: string,
  observation: string,
  dependencies: string[],
  authority: string,
  acceptance: string,
  predictedTouches: string[],
): RoadmapStep => ({
  id,
  observation,
  dependencies,
  authority,
  acceptance: [{ id: `${id}-AC-1`, text: acceptance }],
  predictedTouches,
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
      "overdrive serve boots, overdrive deploy writes an alloc_status row, and the interested reconciler runs within one relist period.",
      ["Reconciler::interests", "ObservationRow::kind"],
    ),
    step(
      "01-02",
      "A host-backed reconciler that declares resync_schedule() runs on its own cadence with no observation-row change at all.",
      ["01-01"],
      "ADR-0084 § resync_schedule()",
      "overdrive serve boots with no workload deployed and the host-backed reconciler ticks once per declared period.",
      ["Reconciler::resync_schedule", "ConvergenceLoop::next_wake"],
    ),
    step(
      "01-03",
      "A reconciler declaring neither hook is still woken by a producer handoff, so the migration adds no dead reconciler.",
      [],
      "ADR-0084 § the producer-push path",
      "overdrive deploy drives a handoff-woken reconciler to a converged view with both hooks left at their defaults.",
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
      "A declares the hook and is woken, observed through a deploy.",
      ["02-03"],
      "ADR-0084 § interests()",
      "a deploy wakes A.",
      ["shared::alpha"],
    ),
    step(
      "02-02",
      "B declares the cadence and ticks, observed through a boot.",
      [],
      "ADR-0084 § resync_schedule()",
      "a boot ticks B.",
      ["shared::alpha", "shared::bravo"],
    ),
    step(
      "02-03",
      "C keeps the producer handoff working, observed through a deploy.",
      [],
      "ADR-0084 § the producer-push path",
      "a deploy wakes C.",
      ["shared::bravo"],
    ),
  ],
};

/**
 * Every shape defect at once, so one proposal reaches `shape.route`'s
 * `invalid` edge and the defect list has something to say about each row:
 * `03-01` is duplicated, depends on nothing that exists, and has no
 * acceptance obligation; `03-02` names no authority; and the pair `03-03` /
 * `03-04` declare each other, which is a cycle.
 */
export const MALFORMED: Roadmap = {
  request: REQUEST,
  steps: [
    {
      id: "03-01",
      observation: "a mechanism exists",
      dependencies: ["03-09"],
      authority: "ADR-0084",
      acceptance: [],
      predictedTouches: [],
    },
    {
      id: "03-01",
      observation: "the same mechanism exists again",
      dependencies: [],
      authority: "ADR-0084",
      acceptance: [{ id: "03-01-AC-1", text: "it exists." }],
      predictedTouches: [],
    },
    {
      id: "03-02",
      observation: "something is observable",
      dependencies: [],
      authority: "   ",
      acceptance: [{ id: "03-02-AC-1", text: "it is observable." }],
      predictedTouches: [],
    },
    {
      id: "03-03",
      observation: "a deploy reaches C",
      dependencies: ["03-04"],
      authority: "ADR-0084",
      acceptance: [{ id: "03-03-AC-1", text: "a deploy reaches C." }],
      predictedTouches: [],
    },
    {
      id: "03-04",
      observation: "a deploy reaches D",
      dependencies: ["03-03"],
      authority: "ADR-0084",
      acceptance: [{ id: "03-04-AC-1", text: "a deploy reaches D." }],
      predictedTouches: [],
    },
  ],
};
