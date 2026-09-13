/**
 * The one piece of the drawing that is arithmetic rather than translation.
 *
 * A node maps to a rectangle and an edge maps to a line; neither is worth a
 * test. What IS worth one is the claim the loop box makes: that the nodes
 * inside a bounded loop's body are drawn inside the box labelled with that
 * loop's bound. Get it wrong and the drawing says a node repeats when it does
 * not, which is the one thing about these graphs a reader most needs to be
 * able to trust.
 *
 * No DOM and no JointJS here, which is why the layout is its own module.
 */

import { describe, expect, test } from "bun:test";
import type { GraphProjection } from "@des/server";
import { clusterId, edgeKey, labelSize, layout, NODE_HEIGHT, NODE_WIDTH } from "./layout.ts";

/** A loop over two body nodes, a branch after it, and two terminals. */
const projection: GraphProjection = {
  start: "spin",
  nodes: [
    { id: "spin", kind: "loop", body: "work", max: 3, next: "spin.verdict" },
    { id: "work", kind: "leaf", next: "check", stepId: "fixture.work" },
    { id: "check", kind: "step", next: "spin" },
    { id: "spin.verdict", kind: "branch", edges: { done: "accept", stuck: "reject" } },
    { id: "accept", kind: "terminal" },
    { id: "reject", kind: "terminal" },
  ],
  edges: [
    { from: "spin", to: "work", key: "body" },
    { from: "spin", to: "spin.verdict", key: "done" },
    { from: "work", to: "check" },
    { from: "check", to: "spin" },
    { from: "spin.verdict", to: "accept", key: "done" },
    { from: "spin.verdict", to: "reject", key: "stuck" },
  ],
  loops: { spin: ["work", "check"] },
  reachable: ["spin", "work", "check", "spin.verdict", "accept", "reject"],
  defects: [],
};

describe("the layout", () => {
  test("every node the projection reports is placed", () => {
    const placed = layout(projection);
    for (const node of projection.nodes) {
      expect(placed.nodes.get(node.id)).toBeDefined();
    }
    expect(placed.width).toBeGreaterThan(NODE_WIDTH);
    expect(placed.height).toBeGreaterThan(NODE_HEIGHT);
  });

  test("a loop's body is drawn inside the loop's own box", () => {
    const placed = layout(projection);
    const box = placed.clusters.get("spin");
    expect(box).toBeDefined();
    if (box === undefined) return;

    for (const id of projection.loops["spin"] ?? []) {
      const at = placed.nodes.get(id);
      expect(at).toBeDefined();
      if (at === undefined) continue;
      expect(at.x).toBeGreaterThanOrEqual(box.x);
      expect(at.y).toBeGreaterThanOrEqual(box.y);
      expect(at.x + NODE_WIDTH).toBeLessThanOrEqual(box.x + box.width);
      expect(at.y + NODE_HEIGHT).toBeLessThanOrEqual(box.y + box.height);
    }
  });

  test("the loop node itself is outside its own body's box", () => {
    // The loop is not part of an iteration: it is the thing that decides
    // whether there is another one. Drawing it inside the box would say the
    // opposite.
    const placed = layout(projection);
    const box = placed.clusters.get("spin");
    const at = placed.nodes.get("spin");
    expect(box).toBeDefined();
    expect(at).toBeDefined();
    if (box === undefined || at === undefined) return;
    const inside = at.y >= box.y && at.y + NODE_HEIGHT <= box.y + box.height;
    expect(inside).toBe(false);
  });

  test("a graph with no loop has no box, and still places everything", () => {
    const flat: GraphProjection = {
      start: "a",
      nodes: [
        { id: "a", kind: "step", next: "b" },
        { id: "b", kind: "terminal" },
      ],
      edges: [{ from: "a", to: "b" }],
      loops: {},
      reachable: ["a", "b"],
      defects: [],
    };
    const placed = layout(flat);
    expect(placed.clusters.size).toBe(0);
    expect(placed.nodes.size).toBe(2);
  });

  test("a loop's box is addressed by an id no authored node can collide with", () => {
    // Node ids are the author's and may be anything a label may be; the box is
    // the drawing's own and is prefixed so the two cannot meet.
    expect(clusterId("spin")).toBe("cluster:spin");
    expect(projection.nodes.some((n) => n.id.startsWith("cluster:"))).toBe(false);
  });

  test("every labelled edge gets a point of its own", () => {
    const placed = layout(projection);
    const labelled = projection.edges
      .map((edge, at) => ({ edge, at }))
      .filter(({ edge }) => edge.key !== undefined);

    expect(labelled.length).toBeGreaterThan(0);
    for (const { at } of labelled) expect(placed.labels.get(at)).toBeDefined();
    // An unlabelled edge asks dagre for no room and gets no point.
    const bare = projection.edges.findIndex((edge) => edge.key === undefined);
    expect(placed.labels.get(bare)).toBeUndefined();
  });

  test("two edges out of one node do not share a label position", () => {
    // `spin` sends `body` one way and `done` the other, and an edge's own
    // midpoint is the same place for both — edges that share an endpoint and
    // run between the same two ranks coincide there. Several graphs here have
    // three such edges converging on one loop node, so all three labels would
    // land on top of each other.
    const placed = layout(projection);
    const from = (id: string) =>
      projection.edges
        .map((edge, at) => ({ edge, at }))
        .filter(({ edge }) => edge.from === id && edge.key !== undefined)
        .map(({ at }) => placed.labels.get(at))
        .filter((point): point is { x: number; y: number } => point !== undefined);

    for (const id of ["spin", "spin.verdict"]) {
      const points = from(id);
      expect(points.length).toBe(2);
      const apart = points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`);
      expect(new Set(apart).size).toBe(points.length);
    }
  });

  test("a label's box is wide enough for the text it holds, and rounds up", () => {
    // Too wide costs a little horizontal space; too narrow costs a collision,
    // which is the thing this exists to stop.
    const short = labelSize("body");
    const long = labelSize("cannot-decompose");
    expect(long.width).toBeGreaterThan(short.width);
    expect(short.width).toBeGreaterThan("body".length * 6);
    expect(Number.isInteger(short.width)).toBe(true);
    expect(short.height).toBe(long.height);
  });

  test("an edge is addressed by its index, so two edges between one pair stay two", () => {
    // The layout graph is a multigraph and this is the name each edge is put
    // in under. A simple graph would keep one of them, and one edge is one
    // label position for two keys.
    expect(edgeKey(0)).not.toBe(edgeKey(1));
    const twice: GraphProjection = {
      ...projection,
      edges: [
        { from: "spin.verdict", to: "accept", key: "done" },
        { from: "spin.verdict", to: "accept", key: "stuck" },
      ],
    };
    const placed = layout(twice);
    expect(placed.labels.size).toBe(2);
  });
});
