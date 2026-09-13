/**
 * Where every node goes, and how big each loop's box is.
 *
 * dagre decides, and it decides over a COMPOUND graph: each loop's body is a
 * cluster, so the nodes that take part in an iteration are laid out together
 * and come back with a box around them. That box is the one thing in the
 * drawing that is not a node-per-node translation of the projection, and it is
 * what makes a bounded loop legible as a bound rather than as an arrow that
 * goes backwards.
 *
 * Its own module, with no JointJS in it: this is arithmetic over the
 * projection, it runs without a DOM, and a test can therefore assert that a
 * loop's body really does land inside its own box.
 */

import dagre from "@dagrejs/dagre";
import type { GraphProjection } from "@des/server";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 48;
const CLUSTER_PADDING = 26;

/** dagre's placement of every node and every loop box. */
export type Layout = {
  nodes: Map<string, { x: number; y: number }>;
  clusters: Map<string, { x: number; y: number; width: number; height: number }>;
  width: number;
  height: number;
};

export const clusterId = (loop: string): string => `cluster:${loop}`;

/**
 * Lay the graph out top to bottom, with each loop's body in a cluster.
 *
 * A loop's own node is NOT in its cluster: it sits outside, with one edge into
 * the body and one out to what follows, which is what the node map says. The
 * cluster is the body — the nodes that take part in an iteration — and it is
 * what the box is drawn round.
 */
export const layout = (projection: GraphProjection): Layout => {
  const graph = new dagre.graphlib.Graph({ compound: true });
  graph.setGraph({ rankdir: "TB", ranksep: 56, nodesep: 36, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of projection.nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const [loop, inside] of Object.entries(projection.loops)) {
    if (inside.length === 0) continue;
    graph.setNode(clusterId(loop), { label: loop });
    for (const id of inside) {
      if (projection.nodes.some((n) => n.id === id)) graph.setParent(id, clusterId(loop));
    }
  }
  for (const edge of projection.edges) graph.setEdge(edge.from, edge.to);

  dagre.layout(graph);

  const nodes = new Map<string, { x: number; y: number }>();
  const clusters = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const id of graph.nodes()) {
    const placed = graph.node(id) as { x?: number; y?: number; width?: number; height?: number };
    if (placed?.x === undefined || placed.y === undefined) continue;
    if (id.startsWith("cluster:")) {
      clusters.set(id.slice("cluster:".length), {
        x: placed.x - (placed.width ?? 0) / 2 - CLUSTER_PADDING,
        y: placed.y - (placed.height ?? 0) / 2 - CLUSTER_PADDING,
        width: (placed.width ?? 0) + CLUSTER_PADDING * 2,
        height: (placed.height ?? 0) + CLUSTER_PADDING * 2,
      });
      continue;
    }
    nodes.set(id, { x: placed.x - NODE_WIDTH / 2, y: placed.y - NODE_HEIGHT / 2 });
  }

  const size = graph.graph() as { width?: number; height?: number };
  return {
    nodes,
    clusters,
    width: (size.width ?? 900) + 48,
    height: (size.height ?? 600) + 48,
  };
};
