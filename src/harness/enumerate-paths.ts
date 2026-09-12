/**
 * The path space of a workflow is finite, so it can be walked before anything
 * runs. Two tools live here:
 *
 * - `cartesian`, for enumerating the decision space a set of steps can return.
 * - `inspectGraph`, a static walk of the graph itself, which rejects a graph
 *   with a dangling edge, an unreachable node, or no terminal — the structural
 *   defects the design says the harness must catch before any model runs.
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
    case "terminal":
      return [];
  }
};

export type GraphReport = {
  reachable: NodeId[];
  terminals: NodeId[];
  /** Edge targets that name a node the graph does not define. */
  danglingEdges: { from: NodeId; to: NodeId }[];
  /** Declared nodes no path from `start` can reach. */
  unreachable: NodeId[];
};

export const inspectGraph = <S>(wf: Workflow<S>): GraphReport => {
  const reachable: NodeId[] = [];
  const seen = new Set<NodeId>();
  const danglingEdges: { from: NodeId; to: NodeId }[] = [];
  const queue: NodeId[] = [wf.start];

  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!wf.nodes[id]) continue; // recorded as dangling by whoever pointed here
    reachable.push(id);
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
  };
};

/** Human-readable reasons the graph is malformed. Empty means well-formed. */
export const graphDefects = <S>(wf: Workflow<S>): string[] => {
  const r = inspectGraph(wf);
  return [
    ...r.danglingEdges.map((e) => `dangling edge: ${e.from} -> ${e.to} (no such node)`),
    ...r.unreachable.map((id) => `unreachable node: ${id}`),
    ...(r.terminals.length === 0 ? ["no terminal is reachable from start"] : []),
  ];
};
