/**
 * The compiler and the runner, against hand-built graphs.
 *
 * Graph bugs are caller errors — the graph was built wrong — so they throw
 * before anything runs. Everything a step or an effect can decide is data.
 */

import { describe, expect, test } from "bun:test";
import { createWorkflowStateReader } from "@mastra/core/workflows";
import { z } from "zod";
import { compileWorkflow, workflowRuntime } from "./compile.ts";
import type { Effect, EffectResult } from "./effects.ts";
import { branch, resume, run, suspend, type Node, type Workflow } from "./workflow.ts";

type S = { n: number; note?: string; answer?: "left" | "right" };

const noEffects = async (): Promise<EffectResult[]> => [];

const bump = (by: number, next: string): Node<S> => ({
  type: "step",
  run: async (s) => ({ state: { ...s, n: s.n + by }, effects: [] }),
  absorb: (s) => s,
  next,
});

const linear: Workflow<S> = {
  start: "a",
  nodes: {
    a: bump(1, "b"),
    b: bump(10, "done"),
    done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
  },
};

describe("run", () => {
  test("a chain of steps reaches its terminal, and the trace is the traversal", async () => {
    const outcome = await run<S>(linear, { n: 0 }, noEffects);
    expect(outcome.kind).toBe("terminal");
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.kind === "terminal" && outcome.terminal.state.n).toBe(11);
    expect(outcome.trace).toEqual(["a", "b", "done"]);
  });

  test("a rejected terminal carries its trail and stops the run", async () => {
    const wf: Workflow<S> = {
      start: "stop",
      nodes: {
        stop: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: ["why"] }) },
      },
    };
    const outcome = await run<S>(wf, { n: 0 }, noEffects);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(outcome.kind === "terminal" && outcome.terminal.kind === "rejected" && outcome.terminal.trail).toEqual([
      "why",
    ]);
  });

  test("effects are executed and their typed results absorbed", async () => {
    const seen: Effect[] = [];
    const execute = async (effects: Effect[]): Promise<EffectResult[]> => {
      seen.push(...effects);
      return effects.map((effect) => ({ effect, outcome: "committed" as const, version: 7 }));
    };
    const wf: Workflow<S> = {
      start: "write",
      nodes: {
        write: {
          type: "step",
          run: async (s) => ({ state: s, effects: [{ type: "append-trail", line: "hello" }] }),
          absorb: (s, results) => ({ ...s, note: results.map((r) => r.outcome).join(",") }),
          next: "done",
        },
        done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
      },
    };
    const outcome = await run<S>(wf, { n: 0 }, execute);
    expect(seen).toEqual([{ type: "append-trail", line: "hello" }]);
    expect(outcome.kind === "terminal" && outcome.terminal.state.note).toBe("committed");
  });

  test("a fanout merges each sub-step's own writes, never a whole-state overwrite", async () => {
    type F = { base: string; left?: string; right?: string };
    const slice = (key: "left" | "right"): Node<F> => ({
      type: "step",
      run: async (s) => ({ state: { ...s, [key]: `${s.base}-${key}` }, effects: [] }),
      absorb: (s) => s,
      next: "join",
    });
    const wf: Workflow<F> = {
      start: "fan",
      nodes: {
        fan: { type: "fanout", steps: ["l", "r"], join: "join" },
        l: slice("left"),
        r: slice("right"),
        join: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
      },
    };
    const outcome = await run<F>(wf, { base: "b" }, noEffects);
    expect(outcome.kind === "terminal" && outcome.terminal.state).toEqual({
      base: "b",
      left: "b-left",
      right: "b-right",
    });
    // Sub-steps are traced in declaration order, never completion order.
    expect(outcome.trace).toEqual(["fan", "l", "r", "join"]);
  });

  test("a node reachable from two edges is compiled once per path", async () => {
    const wf: Workflow<S> = {
      start: "pick",
      nodes: {
        pick: branch<S, "left" | "right">((s) => (s.n > 0 ? "left" : "right"), {
          left: "shared",
          right: "shared",
        }),
        shared: bump(100, "done"),
        done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
      },
    };
    const hot = await run<S>(wf, { n: 1 }, noEffects);
    const cold = await run<S>(wf, { n: -1 }, noEffects);
    expect(hot.trace).toEqual(["pick", "shared", "done"]);
    expect(cold.trace).toEqual(["pick", "shared", "done"]);
    expect(hot.kind === "terminal" && hot.terminal.state.n).toBe(101);
    expect(cold.kind === "terminal" && cold.terminal.state.n).toBe(99);
  });
});

describe("graph bugs throw before anything runs", () => {
  const compile = <T>(wf: Workflow<T>) => () => compileWorkflow(wf, noEffects);

  test("a dangling edge names the edge", () => {
    expect(
      compile<S>({
        start: "a",
        nodes: { a: bump(1, "nowhere") },
      }),
    ).toThrow(/dangling edge: a -> nowhere/);
  });

  test("a back edge names the edge and says cycles are out of scope", () => {
    const cyclic: Workflow<S> = {
      start: "a",
      nodes: {
        a: bump(1, "gate"),
        gate: branch<S, "again" | "done">((s) => (s.n < 3 ? "again" : "done"), {
          again: "a",
          done: "done",
        }),
        done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
      },
    };
    expect(compile(cyclic)).toThrow(
      /back edge: gate -> a — cycles are not supported by the Mastra compiler in this cut/,
    );
  });

  test("a fanout target that is not a step names the target", () => {
    expect(
      compile<S>({
        start: "fan",
        nodes: {
          fan: { type: "fanout", steps: ["done"], join: "done" },
          done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
        },
      }),
    ).toThrow(/fanout target is not a step: fan -> done \(terminal\)/);
  });

  test("an unreachable node is a defect too", () => {
    expect(
      compile<S>({
        start: "done",
        nodes: {
          done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
          orphan: bump(1, "done"),
        },
      }),
    ).toThrow(/unreachable node: orphan/);
  });

  test("an unhandled decision names the branch and the key", async () => {
    const wf: Workflow<S> = {
      start: "pick",
      // `on` is typed to "left" | "right"; a cast is how a caller gets here.
      nodes: {
        pick: { type: "branch", on: () => "sideways", edges: { left: "done", right: "done" } },
        done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
      },
    };
    expect(run<S>(wf, { n: 0 }, noEffects)).rejects.toThrow(
      /graph bug: pick has no edge for sideways/,
    );
  });
});

describe("suspension is snapshot-backed", () => {
  const parking: Workflow<S> = {
    start: "ask",
    nodes: {
      ask: suspend<S, { answer: "left" | "right" }>({
        reason: () => "needs-a-person",
        trail: (s) => [{ n: s.n }],
        resumeSchema: z.object({ answer: z.enum(["left", "right"]) }),
        absorb: (s, a) => ({ ...s, answer: a.answer }),
        next: "route",
      }),
      route: branch<S, "left" | "right">((s) => s.answer ?? "left", {
        left: "done",
        right: "done",
      }),
      done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    },
  };

  test("the snapshot in storage holds the suspended step, its payload, and the trace", async () => {
    const parked = await run<S>(parking, { n: 5 }, noEffects);
    expect(parked.kind).toBe("suspended");
    if (parked.kind !== "suspended") return;

    const compiled = compileWorkflow(parking, noEffects);
    const persisted = await compiled.getWorkflowRunById(parked.runId);
    expect(persisted).toBeTruthy();

    const reader = createWorkflowStateReader(persisted as never);
    expect(reader.getStatus()).toBe("suspended");
    const step = reader.getSuspendedStep();
    expect(step?.path).toEqual(["ask"]);
    expect(step?.suspendPayload).toMatchObject({ reason: "needs-a-person", trail: [{ n: 5 }] });

    // The same snapshot is what a fresh compile reattaches to.
    const resumed = await resume<S>(parking, parked.runId, { answer: "right" }, noEffects);
    expect(resumed.kind === "terminal" && resumed.terminal.state.answer).toBe("right");
    expect(resumed.trace).toEqual(["ask", "route", "done"]);
  });

  test("Run.restart() replays a completed run from its snapshot", async () => {
    // `restart()` is a Mastra Run method, not part of this framework's surface,
    // so this exercises it through the compiled workflow directly. No crash is
    // faked: the run completes, its handle is discarded, and a fresh handle
    // bound to the same runId restarts it from the persisted snapshot.
    const compiled = compileWorkflow(linear, noEffects);
    const handle = await compiled.createRun();
    const first = await handle.start({ inputData: { n: 0 }, initialState: { trace: [] } });
    expect(first.status).toBe("success");

    const store = await workflowRuntime().getStorage()?.getStore("workflows");
    const snapshot = await store?.loadWorkflowSnapshot({
      runId: handle.runId,
      workflowName: "wf:a",
    });
    expect(snapshot?.status).toBe("success");

    const fresh = await compiled.createRun({ runId: handle.runId });
    const restarted = await fresh.restart({});
    expect(restarted.status).toBe("success");
    if (restarted.status !== "success" || first.status !== "success") return;
    expect(restarted.result).toEqual(first.result);
  });
});
