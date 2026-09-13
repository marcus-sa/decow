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
import type { GraphProjection } from "./api.ts";
import { clusterId, layout, NODE_HEIGHT, NODE_WIDTH } from "./layout.ts";

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
});
