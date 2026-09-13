/**
 * The four graphs, as the server projects them for a drawing.
 *
 * The enumeration suites beside this one prove what the graphs DO. This proves
 * what a reader is shown of them: that every node reported is one the author
 * wrote, that a leaf is distinguishable from a step that merely runs code,
 * that every branch arrives with its closed edge table, that every loop
 * arrives with its bound and the nodes inside it, and that every suspension
 * arrives with the enum a person will be asked to choose from.
 *
 * It is on the consumer's side rather than in `@des/server`, and the direction
 * is the point: examples depend on the server, the server depends on the
 * framework, and nothing depends back.
 */

import { describe, expect, test } from "bun:test";
import { memoryJournal } from "@des/core/journal";
import type { Commands } from "@des/core/commands";
import type { ModelBinding } from "@des/core/step";
import { project, type GraphProjection, type ProjectedNode } from "@des/server";
import { deliverDefs } from "./deliver/steps.ts";
import { deliverGraph } from "./deliver/graph.ts";
import { obligationsDefs } from "./distill/obligations/steps.ts";
import { obligationsGraph } from "./distill/obligations/graph.ts";
import { oracleDefs } from "./distill/oracle/steps.ts";
import { oracleGraph } from "./distill/oracle/graph.ts";
import { roadmapDefs } from "./roadmap/steps.ts";
import { roadmapGraph } from "./roadmap/graph.ts";

/** A binding that fails the test if anything reaches a model. */
const forbidden = (id: string): ModelBinding => ({
  id,
  generate: async <T>(): Promise<T> => {
    throw new Error(`model "${id}" was called; a projection reads a node map and runs nothing`);
  },
});

const models = { worker: forbidden("worker"), validator: forbidden("validator") };

/** A declaration the projection never reads: `gates` builds it, nothing runs it. */
const commands: Commands = {
  typecheck: () => ["true"],
  lint: () => ["true"],
  tests: () => ["true"],
  oracle: () => ["true"],
};

const journal = () => memoryJournal();

const GRAPHS: Record<string, () => GraphProjection> = {
  roadmap: () => project(roadmapGraph(journal(), roadmapDefs(models))),
  obligations: () => project(obligationsGraph(journal(), obligationsDefs(models))),
  oracle: () => project(oracleGraph(journal(), oracleDefs(models))),
  deliver: () => project(deliverGraph(journal(), deliverDefs(models), commands)),
};

const nodeOf = (projection: GraphProjection, id: string): ProjectedNode => {
  const node = projection.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`${id} is not in the projection`);
  return node;
};

describe("the four graphs, projected", () => {
  for (const [name, build] of Object.entries(GRAPHS)) {
    test(`${name} projects every node under the id its author wrote`, () => {
      const projection = build();
      expect(projection.defects).toEqual([]);
      expect(projection.nodes.length).toBeGreaterThan(3);
      // Nothing the compiler mints reaches a reader: no `wf:` prefix, no `>`
      // path segment, no `#iteration`. Those name paths through a compile.
      expect(projection.nodes.filter((n) => /[>#]|^wf:/.test(n.id))).toEqual([]);
      // Every edge lands on a node the projection also reports.
      const ids = new Set(projection.nodes.map((n) => n.id));
      expect(projection.edges.filter((e) => !ids.has(e.to) || !ids.has(e.from))).toEqual([]);
      // And a graph always has somewhere to end.
      expect(projection.nodes.some((n) => n.kind === "terminal")).toBe(true);
    });

    test(`${name}'s branches each arrive with their whole edge table`, () => {
      const projection = build();
      const branches = projection.nodes.filter((n) => n.kind === "branch");
      expect(branches.length).toBeGreaterThan(0);
      for (const node of branches) {
        const edges = node.edges ?? {};
        expect(Object.keys(edges).length).toBeGreaterThan(0);
        // The keys are the closed decision space, and every one of them is an
        // edge a reader can follow.
        for (const [key, to] of Object.entries(edges)) {
          expect(projection.edges).toContainEqual({ from: node.id, to, key });
        }
      }
    });

    test(`${name}'s loops arrive with their bound and their body`, () => {
      const projection = build();
      for (const node of projection.nodes.filter((n) => n.kind === "loop")) {
        expect(Number.isInteger(node.max)).toBe(true);
        expect(node.max ?? 0).toBeGreaterThan(0);
        expect(node.body).toBeDefined();
        // The box a drawing puts round a loop is the set of nodes that take
        // part in an iteration, and the body node is one of them.
        const inside = projection.loops[node.id] ?? [];
        expect(inside).toContain(node.body as string);
      }
    });

    test(`${name}'s suspensions arrive with the enum a person answers from`, () => {
      const projection = build();
      for (const node of projection.nodes.filter((n) => n.kind === "suspend")) {
        expect(node.resume?.field).toBe("decision");
        expect((node.resume?.options ?? []).length).toBeGreaterThan(0);
      }
    });
  }

  test("a leaf is a model call and says which step id its attempts report", () => {
    const deliver = GRAPHS.deliver?.() as GraphProjection;
    expect(nodeOf(deliver, "implement")).toMatchObject({ kind: "leaf", stepId: "deliver.implement" });
    expect(nodeOf(deliver, "diagnose")).toMatchObject({ kind: "leaf", stepId: "deliver.diagnose" });
    // The two nodes the README insists are NOT leaves, because what they
    // answer is a command's exit status rather than a model's reading of one.
    expect(nodeOf(deliver, "run-tests").kind).toBe("step");
    expect(nodeOf(deliver, "gates").kind).toBe("step");
    expect(nodeOf(deliver, "run-tests").stepId).toBeUndefined();
  });

  test("DELIVER's three nested loops are reported as nested", () => {
    const deliver = GRAPHS.deliver?.() as GraphProjection;
    const loops = deliver.nodes.filter((n) => n.kind === "loop").map((n) => n.id);
    expect(loops.sort()).toEqual(["cycle", "gates-loop", "test-loop"]);
    // The outermost loop's body contains the other two, which is what makes
    // the drawing a box inside a box inside a box.
    expect(deliver.loops["cycle"]).toContain("test-loop");
    expect(deliver.loops["cycle"]).toContain("gates-loop");
    expect(deliver.loops["test-loop"]).not.toContain("cycle");
  });

  test("ROADMAP's two suspensions offer different answers, and the projection says so", () => {
    const roadmap = GRAPHS.roadmap?.() as GraphProjection;
    // The review sits INSIDE the author loop and takes three answers; the
    // block sits outside it and takes one. That difference is the whole of
    // what `revise` costs, and it is readable from the graph.
    expect(nodeOf(roadmap, "human-review").resume?.options).toEqual(["approve", "revise", "abandon"]);
    expect(nodeOf(roadmap, "human").resume?.options).toEqual(["abandon"]);
    expect(roadmap.loops["author"]).toContain("human-review");
    expect(roadmap.loops["author"]).not.toContain("human");
  });
});
