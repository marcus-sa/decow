/**
 * The path space of a workflow is finite, so it can be walked before anything
 * runs. Two tools live here:
 *
 * - `cartesian`, for enumerating the decision space a set of steps can return.
 * - `inspectGraph`, a static walk of the graph itself, which rejects a graph
 *   with a dangling edge, an unreachable node, a fanout target that is not a
 *   step, a back edge, or no terminal — the structural defects the design says
 *   the harness must catch before any model runs.
 *
 * `graphDefects` is also the compiler's admission gate: `compileWorkflow`
 * refuses to build any graph this function rejects, so a graph bug is one
 * error in one place rather than a mis-compiled workflow.
 *
 * Branch predicates are not evaluated here: the walk follows every edge in
 * every edge table, which is exactly the closed set guarantee 1 buys us.
 */

import type { NodeId, Workflow } from "../core/workflow.ts";

/** All n-length tuples over `xs`, in a stable order. */
export const cartesian = <T>(xs: readonly T[], n: number): T[][] =>
  n === 0 ? [[]] : cartesian(xs, n - 1).flatMap((rest) => xs.map((x) => [x, ...rest]));

/** Every node id an edge from `id` can lead to. */
export const outEdges = <S>(wf: Workflow<S>, id: NodeId): NodeId[] => {
  const node = wf.nodes[id];
  if (!node) return [];
  switch (node.type) {
    case "step":
      return [node.next];
    case "fanout":
      return [...node.steps, node.join];
    case "branch":
      return Object.values(node.edges);
    case "suspend":
      return [node.next];
    case "terminal":
      return [];
  }
};

export type Edge = { from: NodeId; to: NodeId };

export type GraphReport = {
  reachable: NodeId[];
  terminals: NodeId[];
  /** Edge targets that name a node the graph does not define. */
  danglingEdges: Edge[];
  /** Declared nodes no path from `start` can reach. */
  unreachable: NodeId[];
  /** Fanout targets that are not `step` nodes. */
  badFanoutTargets: Edge[];
  /** Edges that close a loop: the target is already on the walk's own path. */
  backEdges: Edge[];
};

/**
 * Depth-first walk collecting every edge whose target is already on the
 * current path. Those are exactly the back edges, and a graph with one is
 * cyclic.
 */
const findBackEdges = <S>(wf: Workflow<S>): Edge[] => {
  const backEdges: Edge[] = [];
  const onPath = new Set<NodeId>();
  const settled = new Set<NodeId>();

  const walk = (id: NodeId): void => {
    if (!wf.nodes[id] || settled.has(id)) return;
    onPath.add(id);
    for (const to of outEdges(wf, id)) {
      if (onPath.has(to)) backEdges.push({ from: id, to });
      else walk(to);
    }
    onPath.delete(id);
    settled.add(id);
  };

  walk(wf.start);
  return backEdges;
};

export const inspectGraph = <S>(wf: Workflow<S>): GraphReport => {
  const reachable: NodeId[] = [];
  const seen = new Set<NodeId>();
  const danglingEdges: Edge[] = [];
  const badFanoutTargets: Edge[] = [];
  const queue: NodeId[] = [wf.start];

  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = wf.nodes[id];
    if (!node) continue; // recorded as dangling by whoever pointed here
    reachable.push(id);
    if (node.type === "fanout") {
      for (const to of node.steps) {
        if (wf.nodes[to] && wf.nodes[to]?.type !== "step") badFanoutTargets.push({ from: id, to });
      }
    }
    for (const to of outEdges(wf, id)) {
      if (!wf.nodes[to]) danglingEdges.push({ from: id, to });
      else queue.push(to);
    }
  }
  if (!wf.nodes[wf.start]) danglingEdges.push({ from: "<start>", to: wf.start });

  return {
    reachable,
    terminals: reachable.filter((id) => wf.nodes[id]?.type === "terminal"),
    danglingEdges,
    unreachable: Object.keys(wf.nodes).filter((id) => !seen.has(id)),
    badFanoutTargets,
    backEdges: findBackEdges(wf),
  };
};

/** Human-readable reasons the graph is malformed. Empty means well-formed. */
export const graphDefects = <S>(wf: Workflow<S>): string[] => {
  const r = inspectGraph(wf);
  return [
    ...r.danglingEdges.map((e) => `dangling edge: ${e.from} -> ${e.to} (no such node)`),
    ...r.badFanoutTargets.map(
      (e) => `fanout target is not a step: ${e.from} -> ${e.to} (${wf.nodes[e.to]?.type})`,
    ),
    ...r.backEdges.map(
      (e) =>
        `back edge: ${e.from} -> ${e.to} — cycles are not supported by the Mastra compiler in this cut`,
    ),
    ...r.unreachable.map((id) => `unreachable node: ${id}`),
    ...(r.terminals.length === 0 ? ["no terminal is reachable from start"] : []),
  ];
};
