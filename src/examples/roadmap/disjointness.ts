/**
 * `measure-disjointness`, as a pure function. No model.
 *
 * This mirrors nwave-experimental's `domain/parallel_safety.py`, whose whole
 * claim is one sentence: two steps a roadmap declares independent are
 * MEASURED-SAFE when their scopes are disjoint and DRIFT when they overlap,
 * and the overlapping entries ARE the finding — the tool names them rather
 * than adjudicating which side is wrong. One axis here (`predictedTouches`)
 * against that module's three (touched files, boundary files, consumer
 * symbols), because that is the one axis a roadmap row declares.
 *
 * What is added on top of it is a RESOLUTION, because this graph has somewhere
 * to put the answer. An overlap between two steps with no dependency path
 * between them means the author called them independent and they are not, and
 * the deterministic repair is to order them: add a dependency edge from the
 * lower-ordinal step to the higher, in DECLARATION order. Declaration order is
 * the only total order the roadmap carries, so it is the only choice that does
 * not need a model to make it.
 *
 * The measurement is taken ONCE, against the roadmap as the author declared
 * it, and only then are the edges applied. That ordering is load-bearing in
 * both directions. It is what makes `drift-unresolvable` reachable at all:
 * adding a lower-to-higher edge for a pair with no path either way cannot
 * close a cycle on its own, so a cycle can only come from an EARLIER repair
 * having ordered things since. Three steps declared A, B, C with C declared as
 * a dependency of A: A and B are independent and overlap, so A -> B is added;
 * B and C are independent and overlap, and B -> C would close
 * A -> B -> C -> A. The pair whose edge closed it is what a person is handed.
 *
 * And it is what keeps the findings honest. Re-measuring after each repair
 * would let the tool's own edge silence a second disagreement the author made
 * — B and C would come back ordered transitively and never be reported —
 * which is exactly the adjudication `parallel_safety.py` refuses to do. The
 * disagreement is the finding; the repair does not get to erase the next one.
 *
 * In production `predictedTouches` comes from the VCS symbol inventory rather
 * than from a model's guess, and whatever this measurement misses the DELIVER
 * lease catches at write time as a `conflict`. So this is the cheap check that
 * runs before anything is dispatched, not the guarantee.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { Roadmap, RoadmapStep } from "./schema.ts";

/** An overlap between two steps the roadmap declares independent. */
export type Drift = {
  /** The lower-ordinal step, in declaration order. */
  a: string;
  /** The higher-ordinal step. */
  b: string;
  /** The `predictedTouches` entries they share, sorted. */
  shared: string[];
};

/**
 * A dependency edge the resolution rule added: `from` must be accepted before
 * `to`. It always points from the lower-ordinal step to the higher one.
 */
export type AddedEdge = Drift;

/** What the branch after `measure-disjointness` routes on. */
export const DISJOINTNESS_VERDICTS = ["consistent", "edges-added", "drift-unresolvable"] as const;
export type DisjointnessVerdict = (typeof DISJOINTNESS_VERDICTS)[number];

export type Disjointness = {
  verdict: DisjointnessVerdict;
  /** The edges the rule added, in the order it added them. */
  addedEdges: AddedEdge[];
  /** The overlap whose resolving edge would close a cycle. */
  unresolvable?: Drift;
  /**
   * The roadmap with the added edges applied. This is what gets persisted: the
   * resolution is not advice, it is the roadmap the author's own declaration
   * implied once the overlap was measured. Identical to the input on
   * `consistent`, and on `drift-unresolvable` it carries the edges added
   * before the offending one so a person can see how far the rule got.
   */
  resolved: Roadmap;
};

/** The steps `id` must wait for, transitively, over the given edges. */
const ancestorsOf = (edges: ReadonlyMap<string, readonly string[]>, id: string): Set<string> => {
  const seen = new Set<string>();
  const stack = [...(edges.get(id) ?? [])];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return seen;
};

/**
 * True when the two steps are ordered by a dependency path in either
 * direction. A pair that is ordered is not declared independent, so it is
 * never flagged however much its scopes overlap — the author already said one
 * comes first.
 */
const ordered = (edges: ReadonlyMap<string, readonly string[]>, a: string, b: string): boolean =>
  ancestorsOf(edges, a).has(b) || ancestorsOf(edges, b).has(a);

/** The `predictedTouches` two steps share, sorted. */
export const sharedTouches = (a: RoadmapStep, b: RoadmapStep): string[] => {
  const theirs = new Set(b.predictedTouches);
  return [...new Set(a.predictedTouches.filter((t) => theirs.has(t)))].sort();
};

/**
 * Every pair the roadmap declares independent whose scopes overlap, in
 * declaration order (lower ordinal first, then by the other member's ordinal).
 *
 * This is `classify_pair` over every unordered pair, keeping only the DRIFT
 * verdicts: a MEASURED-SAFE pair has nothing to report and nothing to fix.
 */
export const drifts = (roadmap: Roadmap): Drift[] => {
  const edges = new Map(roadmap.steps.map((s) => [s.id, s.dependencies] as const));
  const found: Drift[] = [];
  for (let i = 0; i < roadmap.steps.length; i += 1) {
    for (let j = i + 1; j < roadmap.steps.length; j += 1) {
      const a = roadmap.steps[i] as RoadmapStep;
      const b = roadmap.steps[j] as RoadmapStep;
      if (ordered(edges, a.id, b.id)) continue;
      const shared = sharedTouches(a, b);
      if (shared.length > 0) found.push({ a: a.id, b: b.id, shared });
    }
  }
  return found;
};

/** `to` gains a dependency on `from`, without touching any other row. */
const withEdge = (roadmap: Roadmap, edge: AddedEdge): Roadmap => ({
  ...roadmap,
  steps: roadmap.steps.map((step) =>
    step.id === edge.b ? { ...step, dependencies: [...step.dependencies, edge.a] } : step,
  ),
});

/** True when the declared edges contain a cycle. */
const hasCycle = (roadmap: Roadmap): boolean => {
  const edges = new Map(roadmap.steps.map((s) => [s.id, s.dependencies] as const));
  return roadmap.steps.some((step) => ancestorsOf(edges, step.id).has(step.id));
};

/**
 * Measure the roadmap's declared independence against its declared scopes, and
 * resolve what it can.
 *
 * `consistent` means every pair the roadmap called independent measures
 * disjoint. `edges-added` means one or more did not and declaration order said
 * which way to order them. `drift-unresolvable` means ordering one of them
 * would close a cycle, and that is a decomposition a rule cannot repair: the
 * pair is named and a person decides.
 */
export const measureDisjointness = (roadmap: Roadmap): Disjointness => {
  // Measured against the declaration, once. See the header for why the repair
  // does not get to re-measure.
  const measured = drifts(roadmap);
  const addedEdges: AddedEdge[] = [];
  let resolved = roadmap;

  for (const edge of measured) {
    const next = withEdge(resolved, edge);
    if (hasCycle(next)) {
      return { verdict: "drift-unresolvable", addedEdges, unresolvable: edge, resolved };
    }
    addedEdges.push(edge);
    resolved = next;
  }

  return addedEdges.length === 0
    ? { verdict: "consistent", addedEdges, resolved }
    : { verdict: "edges-added", addedEdges, resolved };
};

/** One added edge, rendered for a prompt or for the person reviewing it. */
export const describeEdge = (edge: AddedEdge): string =>
  `${edge.a} -> ${edge.b} (both write ${edge.shared.join(", ")})`;
