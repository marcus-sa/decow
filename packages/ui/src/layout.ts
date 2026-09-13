/**
 * Where every node goes, where every edge's label goes, and how big each loop's
 * box is.
 *
 * dagre decides all three, and it decides over a COMPOUND MULTIGRAPH. Compound
 * because each loop's body is a cluster, so the nodes that take part in an
 * iteration are laid out together and come back with a box around them.
 * Multigraph because a branch routinely sends two or three edges to the SAME
 * target — every loop-exit edge converges on the loop node — and a simple
 * graph collapses them into one, which is one edge, one label position, and
 * three labels stacked on top of each other.
 *
 * EDGE LABELS ARE A DAGRE PROBLEM, not a painting one. Given an edge's label
 * dimensions, dagre reserves a rank for it, routes the edge through it, and
 * hands back the point it chose as `edge.x` / `edge.y`. The drawing then puts
 * the label THERE rather than at the edge's midpoint — which would put
 * `exhausted`, `cannot-decompose` and `invalid` in the same place, all three
 * edges running between the same pair of ranks at the same x.
 *
 * Its own module, with no JointJS in it: this is arithmetic over the
 * projection, it runs without a DOM, and a test can therefore assert that a
 * loop's body really does land inside its own box and that two edges out of
 * one node do not share a label position.
 */

import dagre from "@dagrejs/dagre";
import type { GraphProjection } from "@des/server";

export const NODE_WIDTH = 190;
export const NODE_HEIGHT = 48;
const CLUSTER_PADDING = 26;

/** The monospace label the drawing paints, at the size it paints it. */
const LABEL_CHAR_WIDTH = 6.2;
const LABEL_PADDING = 10;
const LABEL_HEIGHT = 16;

/**
 * The box one edge label occupies, so dagre can reserve room for it.
 *
 * Measured rather than guessed would need a DOM, and this module has none. The
 * drawing paints edge labels at 10px in `ui-monospace`, where a character is
 * about 6.2px wide — so the estimate is exact enough to keep two labels apart,
 * which is the whole job. An estimate that is too WIDE costs a little
 * horizontal space; one that is too narrow costs a collision, so it rounds up.
 */
export const labelSize = (key: string): { width: number; height: number } => ({
  width: Math.ceil(key.length * LABEL_CHAR_WIDTH) + LABEL_PADDING * 2,
  height: LABEL_HEIGHT,
});

/** One edge, addressed the way the projection lists it. */
export const edgeKey = (at: number): string => `edge:${at}`;

/** dagre's placement of every node, every edge label, and every loop box. */
export type Layout = {
  nodes: Map<string, { x: number; y: number }>;
  /** Per edge INDEX in `projection.edges`, the point dagre chose for its label. */
  labels: Map<number, { x: number; y: number }>;
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
  // A MULTIGRAPH, because a branch may send two edges to one target and each
  // carries its own key. A simple graph keeps the last one and the drawing
  // then has one place to put three labels.
  const graph = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  // `ranksep` is doubled against the gap actually wanted, because dagre halves
  // it when it makes room for edge labels: a labelled edge spans two ranks,
  // one of which holds the label. So 64 here is the 32 the drawing gets.
  graph.setGraph({ rankdir: "TB", ranksep: 64, nodesep: 36, edgesep: 16, marginx: 24, marginy: 24 });
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
  // `labelpos: "c"` centres the label ON the edge rather than beside it, which
  // is what makes the point dagre returns the point to paint at. A sized edge
  // is what makes dagre return one at all.
  projection.edges.forEach((edge, at) => {
    const sized = edge.key === undefined ? {} : { ...labelSize(edge.key), labelpos: "c" as const };
    graph.setEdge(edge.from, edge.to, sized, edgeKey(at));
  });

  dagre.layout(graph);

  const nodes = new Map<string, { x: number; y: number }>();
  const labels = new Map<number, { x: number; y: number }>();
  const clusters = new Map<string, { x: number; y: number; width: number; height: number }>();

  projection.edges.forEach((edge, at) => {
    if (edge.key === undefined) return;
    const placed = graph.edge(edge.from, edge.to, edgeKey(at)) as { x?: number; y?: number };
    if (placed?.x === undefined || placed.y === undefined) return;
    labels.set(at, { x: placed.x, y: placed.y });
  });

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
    labels,
    clusters,
    width: (size.width ?? 900) + 48,
    height: (size.height ?? 600) + 48,
  };
};
