/**
 * The compiler and the runner, against hand-built graphs.
 *
 * Graph bugs are caller errors — the graph was built wrong — so they throw
 * before anything runs. Everything a step or an effect can decide is data.
 */

import { describe, expect, test } from "bun:test";
import { createWorkflowStateReader } from "@mastra/core/workflows";
import { z } from "zod";
import { visitCount } from "../harness/matchers.ts";
import { noReplayJournal } from "../harness/no-replay.ts";
import { says, scriptedBinding, throws } from "../harness/scripted-binding.ts";
import { compileWorkflow, workflowRuntime } from "./compile.ts";
import type { Effect, EffectResult } from "./effects.ts";
import { stepOutput, type Attempt, type ModelBinding, type StepDef, type StepResult } from "./step.ts";
import { branch, leaf, loop, resume, run, suspend, type Node, type Workflow } from "./workflow.ts";

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

  test("a raw back edge names the edge and points at the loop node", () => {
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
      /back edge: gate -> a — repetition goes through a bounded loop node, not a raw back edge/,
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

describe("loops are bounded, and the bound is part of the graph", () => {
  type L = { n: number; answer?: "bump" | "hold"; iterations?: number; stuck?: boolean };

  const Answer = z.object({ answer: z.enum(["bump", "hold"]) });

  /** spin: ask a person, apply their answer, iterate. Bounded at `max`. */
  const spinning = (max: number, until: (s: L) => boolean): Workflow<L> => ({
    start: "spin",
    nodes: {
      spin: loop<L>({
        body: "ask",
        until,
        max,
        absorb: (s, exit) => ({ ...s, iterations: exit.iterations, stuck: exit.exhausted }),
        next: "done",
      }),
      ask: suspend<L, z.infer<typeof Answer>>({
        reason: () => "needs-a-person",
        trail: (s) => [{ n: s.n }],
        resumeSchema: Answer,
        absorb: (s, a) => ({ ...s, answer: a.answer }),
        next: "apply",
      }),
      apply: {
        type: "step",
        run: async (s) => ({ state: { ...s, n: s.answer === "bump" ? s.n + 1 : s.n }, effects: [] }),
        absorb: (s) => s,
        next: "spin",
      },
      done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    },
  });

  const counting = (max: number, target: number): Workflow<L> => ({
    start: "spin",
    nodes: {
      spin: loop<L>({
        body: "bump",
        until: (s) => s.n >= target,
        max,
        absorb: (s, exit) => ({ ...s, iterations: exit.iterations, stuck: exit.exhausted }),
        next: "done",
      }),
      bump: {
        type: "step",
        run: async (s) => ({ state: { ...s, n: s.n + 1 }, effects: [] }),
        absorb: (s) => s,
        next: "spin",
      },
      done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    },
  });

  test("the body runs until the condition holds, and the loop id marks each pass", async () => {
    const outcome = await run<L>(counting(10, 3), { n: 0 }, noEffects);
    expect(outcome.kind === "terminal" && outcome.terminal.state.n).toBe(3);
    expect(outcome.trace).toEqual(["spin", "bump", "spin", "bump", "spin", "bump", "done"]);
    expect(visitCount(outcome.trace, "spin")).toBe(3);
  });

  test("the body always runs once, even when the condition already holds", async () => {
    const outcome = await run<L>(counting(10, 0), { n: 0 }, noEffects);
    expect(outcome.trace).toEqual(["spin", "bump", "done"]);
    expect(outcome.kind === "terminal" && outcome.terminal.state.iterations).toBe(1);
  });

  test("reaching the bound leaves the loop with exhausted true, not with an exception", async () => {
    const outcome = await run<L>(counting(2, 99), { n: 0 }, noEffects);
    expect(outcome.kind).toBe("terminal");
    expect(outcome.kind === "terminal" && outcome.terminal.state.iterations).toBe(2);
    expect(outcome.kind === "terminal" && outcome.terminal.state.stuck).toBe(true);
    expect(visitCount(outcome.trace, "bump")).toBe(2);
  });

  test("finishing inside the bound leaves with exhausted false", async () => {
    const outcome = await run<L>(counting(5, 2), { n: 0 }, noEffects);
    expect(outcome.kind === "terminal" && outcome.terminal.state.stuck).toBe(false);
    expect(outcome.kind === "terminal" && outcome.terminal.state.iterations).toBe(2);
  });

  test("a suspension inside a loop body resumes into the SAME iteration", async () => {
    const wf = spinning(3, (s) => s.n >= 2);
    const parked = await run<L>(wf, { n: 0 }, noEffects);

    expect(parked.kind === "suspended" && parked.reason).toBe("needs-a-person");
    expect(parked.trace).toEqual(["spin", "ask"]);

    // Resuming picks up AFTER `ask` in iteration 1 — `apply` runs before the
    // next `spin`. A restart of the iteration would show `spin` twice over.
    const second = await resume<L>(wf, parked.runId, { answer: "bump" }, noEffects);
    expect(second.kind).toBe("suspended");
    expect(second.trace).toEqual(["spin", "ask", "apply", "spin", "ask"]);

    const third = await resume<L>(wf, parked.runId, { answer: "bump" }, noEffects);
    expect(third.trace).toEqual(["spin", "ask", "apply", "spin", "ask", "apply", "done"]);
    expect(third.kind === "terminal" && third.terminal.state.n).toBe(2);
    // The count survived two suspensions: it lives in the engine's state.
    expect(third.kind === "terminal" && third.terminal.state.iterations).toBe(2);
    expect(third.kind === "terminal" && third.terminal.state.stuck).toBe(false);
  });

  test("a loop nested in a loop counts from zero on every re-entry", async () => {
    type N = { inner: number; outer: number; log: string[] };
    const wf: Workflow<N> = {
      start: "outer",
      nodes: {
        outer: loop<N>({
          body: "inner",
          until: (s) => s.outer >= 2,
          max: 4,
          absorb: (s, exit) => ({ ...s, log: [...s.log, `outer=${exit.iterations}`] }),
          next: "done",
        }),
        inner: loop<N>({
          body: "bump-inner",
          until: (s) => s.inner >= 2,
          max: 4,
          absorb: (s, exit) => ({ ...s, log: [...s.log, `inner=${exit.iterations}`] }),
          next: "bump-outer",
        }),
        "bump-inner": {
          type: "step",
          run: async (s) => ({ state: { ...s, inner: s.inner + 1 }, effects: [] }),
          absorb: (s) => s,
          next: "inner",
        },
        "bump-outer": {
          type: "step",
          run: async (s) => ({ state: { ...s, outer: s.outer + 1, inner: 0 }, effects: [] }),
          absorb: (s) => s,
          next: "outer",
        },
        done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
      },
    };

    const outcome = await run<N>(wf, { inner: 0, outer: 0, log: [] }, noEffects);
    expect(outcome.kind === "terminal" && outcome.terminal.state.log).toEqual([
      "inner=2",
      "inner=2",
      "outer=2",
    ]);
    expect(visitCount(outcome.trace, "inner")).toBe(4);
    expect(visitCount(outcome.trace, "outer")).toBe(2);
  });
});

describe("malformed loops throw before anything runs", () => {
  type L = { n: number };
  const compile = <T>(wf: Workflow<T>) => () => compileWorkflow(wf, noEffects);
  const terminal: Node<L> = { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) };
  const step = (next: string): Node<L> => ({
    type: "step",
    run: async (s) => ({ state: s, effects: [] }),
    absorb: (s) => s,
    next,
  });
  const spin = (over: Partial<Parameters<typeof loop<L>>[0]> = {}): Node<L> =>
    loop<L>({ body: "body", until: () => true, max: 2, absorb: (s) => s, next: "done", ...over });

  test("max 0 names the bound and says why it cannot be enumerated", () => {
    expect(
      compile<L>({
        start: "spin",
        nodes: { spin: spin({ max: 0 }), body: step("spin"), done: terminal },
      }),
    ).toThrow(/loop bound must be a positive integer: spin has max 0/);
  });

  test("a fractional bound is refused too", () => {
    expect(
      compile<L>({
        start: "spin",
        nodes: { spin: spin({ max: 1.5 }), body: step("spin"), done: terminal },
      }),
    ).toThrow(/loop bound must be a positive integer: spin has max 1.5/);
  });

  test("a body with no edge back to the loop is not a body", () => {
    expect(
      compile<L>({
        start: "spin",
        nodes: { spin: spin(), body: step("done"), done: terminal },
      }),
    ).toThrow(/loop body never returns to the loop: spin -> body has no path back to spin/);
  });

  test("a body that escapes names the edge that leaves", () => {
    expect(
      compile<L>({
        start: "spin",
        nodes: {
          spin: spin(),
          body: {
            type: "branch",
            on: () => "again",
            edges: { again: "spin", out: "done" },
          },
          done: terminal,
        },
      }),
    ).toThrow(/loop body escapes: body -> done leaves the body of spin/);
  });

  test("an exit that re-enters the body is refused", () => {
    expect(
      compile<L>({
        start: "spin",
        nodes: { spin: spin({ next: "body" }), body: step("spin"), done: terminal },
      }),
    ).toThrow(/loop exit re-enters its own body: spin -> body/);
  });

  test("a jump into the middle of a body is refused", () => {
    expect(
      compile<L>({
        start: "gate",
        nodes: {
          gate: branch<L, "in" | "spin">((s) => (s.n > 0 ? "in" : "spin"), {
            in: "body",
            spin: "spin",
          }),
          spin: spin(),
          body: step("spin"),
          done: terminal,
        },
      }),
    ).toThrow(/loop body entered from outside: gate -> body is inside the body of spin/);
  });
});

/**
 * The `leaf` constructor. Two things are worth pinning: the exhaustion trail is
 * the constructor's, not the graph author's, so it cannot be forgotten; and
 * `absorb` sees the `StepResult` verbatim rather than some projection of it.
 */
describe("leaf", () => {
  type LeafState = { text: string; decision?: string; trail?: number; landed?: string };

  const Text = z.object({ text: z.string() });
  const Answer = stepOutput(["yes", "no"] as const, { anchor: z.string() });
  type Answer = z.infer<typeof Answer>;

  /** A binding that fails the test if anything reaches a model. */
  const forbidden: ModelBinding = {
    id: "forbidden",
    generate: async <T,>(): Promise<T> => {
      throw new Error("a leaf test must spend zero model calls");
    },
  };

  const ANSWER: Answer = { decision: "yes", payload: { anchor: "quoted" } };
  const REFUSED = "the scripted worker had nothing to say";

  /** The leaf's step, bound to whatever the test scripted. */
  const def = (model: ModelBinding): StepDef<{ text: string }, Answer> => ({
    id: "leaf.answer",
    version: 1,
    input: Text,
    output: Answer,
    requirements: [],
    worker: { model, system: "answer", prompt: (i) => i.text },
    validator: { model },
    maxAttempts: 1,
  });

  /**
   * The trail one refused attempt produces. `runStep` builds it — the leaf
   * constructor only has to carry it — so it is read back rather than
   * supplied, which is what makes the assertion about the constructor.
   */
  // `transport`, because a scripted worker that throws a plain Error is a call
  // that failed rather than an answer outside the schema — so the leaf spends
  // its budget and exhausts, which is what these tests are about.
  const TRAIL: Attempt<Answer>[] = [
    { model: "scripted", violations: [], error: `Error: ${REFUSED}`, cause: "transport" },
  ];

  /** Run one leaf node in isolation and report what it produced. */
  const fire = async (node: Node<LeafState>, state: LeafState) => {
    if (node.type !== "step") throw new Error("leaf must produce a step node");
    const out = await node.run(state);
    return { ...out, absorb: node.absorb, next: node.next };
  };

  /** A leaf spec over one scripted answer. The journal never replays here. */
  const answering = (answers: ReturnType<typeof says>) => ({
    def: def(scriptedBinding({ "leaf.answer": answers })),
    journal: noReplayJournal(),
  });

  const decides = () => answering(says("yes", { anchor: "quoted" }));
  const refuses = () => answering(throws(REFUSED));

  test("exhaustion emits the trail line even when the leaf declares no effects", async () => {
    const node = leaf<LeafState, { text: string }, Answer>({
      ...refuses(),
      input: (s) => ({ text: s.text }),
      absorb: (s) => s,
      // no `effects` hook at all: the constructor still owes the trail
      next: "after",
    });

    const { effects } = await fire(node, { text: "t" });
    expect(effects).toEqual([
      { type: "append-trail", line: JSON.stringify({ leaf: "leaf.answer", trail: TRAIL }) },
    ]);
  });

  test("exhaustion adds the trail line to whatever the leaf's own effects returned", async () => {
    const node = leaf<LeafState, { text: string }, Answer>({
      id: "short",
      ...refuses(),
      input: (s) => ({ text: s.text }),
      absorb: (s) => s,
      effects: () => [{ type: "append-trail", line: "mine" }],
      next: "after",
    });

    const { effects } = await fire(node, { text: "t" });
    expect(effects.map((e) => (e.type === "append-trail" ? e.line : e.type))).toEqual([
      "mine",
      JSON.stringify({ leaf: "short", trail: TRAIL }),
    ]);
  });

  test("a decided leaf emits only the effects it asked for", async () => {
    const node = leaf<LeafState, { text: string }, Answer>({
      ...decides(),
      input: (s) => ({ text: s.text }),
      absorb: (s) => s,
      effects: () => [{ type: "append-trail", line: "mine" }],
      next: "after",
    });

    const { effects } = await fire(node, { text: "t" });
    expect(effects).toEqual([{ type: "append-trail", line: "mine" }]);
  });

  test("absorb receives the exact StepResult, both ways round", async () => {
    const seen: StepResult<Answer>[] = [];
    const build = (spec: ReturnType<typeof decides>) =>
      leaf<LeafState, { text: string }, Answer>({
        ...spec,
        input: (s) => ({ text: s.text }),
        absorb: (s, r) => {
          seen.push(r);
          return r.decision === "ok"
            ? { ...s, decision: r.output.decision }
            : { ...s, trail: r.trail.length };
        },
        next: "after",
      });

    const decided = await fire(build(decides()), { text: "t" });
    const refused = await fire(build(refuses()), { text: "t" });

    expect(seen).toEqual([
      { decision: "ok", output: ANSWER },
      { decision: "validator-exhausted", trail: TRAIL },
    ]);
    expect(decided.state.decision).toBe("yes");
    expect(refused.state.trail).toBe(1);
  });

  test("absorbEffects folds the executor's results, and defaults to identity", async () => {
    const spec = {
      ...decides(),
      input: (s: LeafState) => ({ text: s.text }),
      absorb: (s: LeafState) => s,
      effects: () => [{ type: "append-trail" as const, line: "mine" }],
      next: "after",
    };
    const results: EffectResult[] = [
      { effect: { type: "append-trail", line: "mine" }, outcome: "committed", version: 1 },
    ];

    const folding = await fire(
      leaf<LeafState, { text: string }, Answer>({
        ...spec,
        absorbEffects: (s, r) => ({ ...s, landed: r[0]?.outcome }),
      }),
      { text: "t" },
    );
    expect(folding.absorb(folding.state, results).landed).toBe("committed");

    const plain = await fire(leaf<LeafState, { text: string }, Answer>(spec), { text: "t" });
    expect(plain.absorb(plain.state, results)).toEqual(plain.state);
  });

  test("the leaf is a step node, and the input projection is what the step saw", async () => {
    const prompts: string[] = [];
    const watching: ModelBinding = {
      id: "watching",
      generate: async <T,>(req: { prompt: string }): Promise<T> => {
        prompts.push(req.prompt);
        // Both halves: the worker's answer, then the validator's verdict.
        return (req.prompt === "QUIET" ? ANSWER : { verdict: "pass", violations: [] }) as T;
      },
    };
    const node = leaf<LeafState, { text: string }, Answer>({
      def: def(watching),
      journal: noReplayJournal(),
      input: (s) => ({ text: s.text.toUpperCase() }),
      absorb: (s) => s,
      next: "after",
    });

    expect(node.type).toBe("step");
    expect(node.type === "step" && node.next).toBe("after");
    await fire(node, { text: "quiet" });
    // The step's prompt is built from the PROJECTED input, so what the worker
    // was asked is what the projection produced.
    expect(prompts[0]).toBe("QUIET");
  });
});
