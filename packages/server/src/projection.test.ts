/**
 * The authored graph, projected.
 *
 * What is asserted is that the projection reports the ids the AUTHOR wrote and
 * the shapes a drawing needs — a branch's edge table, a loop's body and bound,
 * a suspend node's answer space, and which nodes are model calls — rather than
 * anything about how the compiler threads them onto a chain builder.
 */

import { describe, expect, test } from "bun:test";
import { project, resumeOptionsOf } from "./projection.ts";
import { memoryJournal } from "@des/core/journal";
import { gateGraph, gateModels, GateAnswer, spinGraph } from "./fixture.ts";
import { z } from "zod";

const gate = () => project(gateGraph(memoryJournal(), gateModels("ready", "x")));

describe("the authored projection", () => {
  test("every reachable node is reported under the id the author wrote", () => {
    const projection = gate();
    expect(projection.start).toBe("classify");
    expect(projection.nodes.map((n) => n.id).sort()).toEqual([
      "accept",
      "ask",
      "ask.route",
      "classify",
      "classify.route",
      "persist",
      "reject",
    ]);
    // Nothing the compiler mints — no `wf:`, no `>`, no `#iteration` — reaches
    // a reader. Those are names for paths, and this is a graph.
    expect(projection.nodes.every((n) => !/[>#]|^wf:/.test(n.id))).toBe(true);
    expect(projection.defects).toEqual([]);
  });

  test("a leaf is a leaf, and it carries the step id its attempts report", () => {
    const byId = new Map(gate().nodes.map((n) => [n.id, n] as const));
    expect(byId.get("classify")?.kind).toBe("leaf");
    expect(byId.get("classify")?.stepId).toBe("fixture.classify");
    // A step that emits an effect is a step: the compiler cannot tell them
    // apart and neither should a drawing pretend to.
    expect(byId.get("persist")?.kind).toBe("step");
    expect(byId.get("persist")?.stepId).toBeUndefined();
    expect(byId.get("classify.route")?.kind).toBe("branch");
    expect(byId.get("ask")?.kind).toBe("suspend");
    expect(byId.get("accept")?.kind).toBe("terminal");
  });

  test("a branch reports its edge table, and every edge carries its key", () => {
    const projection = gate();
    const route = projection.nodes.find((n) => n.id === "classify.route");
    expect(route?.edges).toEqual({ ready: "persist", "needs-a-person": "ask" });

    const keyed = projection.edges.filter((e) => e.from === "classify.route");
    expect(keyed).toEqual([
      { from: "classify.route", to: "persist", key: "ready" },
      { from: "classify.route", to: "ask", key: "needs-a-person" },
    ]);
  });

  test("a suspend node reports the closed enum a person answers from", () => {
    const ask = gate().nodes.find((n) => n.id === "ask");
    expect(ask?.resume?.field).toBe("decision");
    expect(ask?.resume?.options).toEqual(["approve", "reject"]);
    // The whole schema travels too, because `notes` is part of the answer and
    // a form has to know it exists.
    expect(ask?.resume?.schema).toMatchObject({ properties: { notes: { type: "string" } } });
  });

  test("a loop reports its body, its bound, and the nodes inside it", () => {
    const projection = project(spinGraph());
    const spin = projection.nodes.find((n) => n.id === "spin");
    expect(spin?.kind).toBe("loop");
    expect(spin?.body).toBe("bump");
    expect(spin?.max).toBe(3);
    expect(spin?.next).toBe("spin.verdict");
    // The body is what a drawing puts a box round: the nodes that take part in
    // an iteration, computed the same way the compiler computes them.
    expect(projection.loops["spin"]).toEqual(["bump"]);
    // Its two edges are labelled, so a reader can tell the iteration from the
    // way out.
    expect(projection.edges.filter((e) => e.from === "spin")).toEqual([
      { from: "spin", to: "bump", key: "body" },
      { from: "spin", to: "spin.verdict", key: "done" },
    ]);
  });

  test("a schema with no enum reports its shape and offers no buttons", () => {
    const free = resumeOptionsOf(z.object({ notes: z.string() }));
    expect(free.options).toBeUndefined();
    expect(free.field).toBeUndefined();
    expect(free.schema).toMatchObject({ properties: { notes: { type: "string" } } });
  });

  test("the answer the options describe is one the node's own schema accepts", () => {
    // The point of reading the buttons off the schema rather than off a second
    // declaration: what the UI offers is by construction what the node parses.
    const options = resumeOptionsOf(GateAnswer).options ?? [];
    expect(options.length).toBeGreaterThan(0);
    for (const decision of options) {
      expect(GateAnswer.safeParse({ decision }).success).toBe(true);
    }
    expect(GateAnswer.safeParse({ decision: "maybe" }).success).toBe(false);
  });
});
