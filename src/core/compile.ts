/**
 * Compiles a `Workflow<S>` node map to a Mastra workflow.
 *
 * The node map is a directed graph whose only cycles are declared `loop`
 * nodes; Mastra's builder is a linear chain of combinators. The bridge is the
 * continuation: a chain runs until it reaches a branch, and each edge of that
 * branch compiles to a NESTED workflow carrying the rest of that path.
 * `Workflow` implements `Step`, so a nested workflow is a legal branch target,
 * a legal `.dountil()` body, and a legal `.parallel()` member. A node
 * reachable from two branches is compiled once per path, under a path-unique
 * workflow id.
 *
 * Raw back edges stay refused: `graphDefects` names them and the compiler will
 * not build the graph. Repetition goes through `loop`, whose bound keeps the
 * path space finite.
 *
 * The mapping, one line each:
 *
 *   step      -> createStep; runs the node, executes its effects, absorbs
 *   fanout    -> a nested workflow: .parallel(sub-steps) then a .map() that
 *                merges each sub-step's CHANGED-KEY SLICE onto getInitData()
 *   branch    -> an entry step (trace + edge guard), .branch() with one
 *                predicate per edge key, then a .map() that unwraps the
 *                single executed target's output
 *   loop      -> .dountil(body, until || iterationCount >= max) then an exit
 *                step that hands { iterations, exhausted } to `absorb`
 *   suspend   -> createStep with suspendSchema/resumeSchema; suspend() on the
 *                first pass, absorb the person's answer on resume
 *   terminal  -> createStep returning the Terminal; `rejected` goes through
 *                bail() so nothing after it in its own chain can run
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { Mastra } from "@mastra/core/mastra";
import { InMemoryStore } from "@mastra/core/storage";
import { createStep, createWorkflow, type AnyWorkflow as MastraWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { graphDefects } from "../harness/enumerate-paths.ts";
import type { EffectExecutor, Node, NodeId, Terminal, Workflow } from "./workflow.ts";

/** The typed payload a suspension hands to a person. */
export const SuspensionPayload = z.object({
  reason: z.string(),
  trail: z.array(z.unknown()),
});
export type SuspensionPayload = z.infer<typeof SuspensionPayload>;

/**
 * The compiled workflow's Mastra state. It carries the provenance record and
 * the live loop counters, and nothing else: state survives suspend/resume,
 * which is exactly the lifetime both need. A run that parks inside a loop body
 * and is answered three days later resumes into the same iteration, with the
 * same count. The caller's `S` flows as step input/output, not as state.
 */
const RunState = z.object({
  trace: z.array(z.string()),
  /** Iterations of each live loop. The loop's own exit step resets its entry. */
  loops: z.record(z.string(), z.number()).optional(),
});
type RunState = z.infer<typeof RunState>;

/** Recover the trace from a Mastra run result's `state`. */
export const readTrace = (state: unknown): NodeId[] =>
  RunState.safeParse(state).data?.trace ?? [];

/**
 * `S` is caller-defined, so every schema the compiler hands Mastra is
 * permissive by construction. The framework's own guardrails are the step
 * output schemas inside `runStep`, not these.
 */
const opaque = <T>() => z.custom<T>(() => true);

/**
 * The keys `after` changed relative to `before`, as a shallow patch.
 *
 * A fanout sub-step receives the whole pre-fanout state and returns a whole
 * state, so returning it verbatim would let the last sub-step's unchanged
 * copies overwrite every earlier sub-step's work. Each sub-step emits only its
 * own patch instead, and the merge re-applies them onto the common ancestor in
 * declaration order. Two sub-steps writing one key is a graph-authoring
 * mistake; the later one wins, in declaration order, never completion order.
 */
export const changedKeys = <S>(before: S, after: S): Partial<S> => {
  if (before === after || typeof after !== "object" || after === null) return after as Partial<S>;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after as Record<string, unknown>)) {
    if (!Object.is((before as Record<string, unknown> | null)?.[key], value)) patch[key] = value;
  }
  return patch as Partial<S>;
};

type SetState = (s: RunState) => Promise<void> | void;

const appendTrace = async (
  state: RunState | undefined,
  setState: SetState,
  ...ids: NodeId[]
): Promise<void> => {
  await setState({ trace: [...(state?.trace ?? []), ...ids], loops: state?.loops ?? {} });
};

/** Snapshots live here, so a parked run can be resumed from a fresh compile. */
let runtime: Mastra | undefined;
export const workflowRuntime = (): Mastra => {
  runtime ??= new Mastra({ storage: new InMemoryStore({ id: "deterministic-workflows" }), logger: false });
  return runtime;
};

type StepNode<S> = Extract<Node<S>, { type: "step" }>;
type LoopNode<S> = Extract<Node<S>, { type: "loop" }>;

/**
 * Mastra's builder threads the flowing schema through its generics to check
 * that each step's input matches the previous step's output. Our schemas are
 * deliberately permissive — `S` is caller-defined — so that inference has
 * nothing to bite on and collapses into unresolvable conditional types. The
 * chain is therefore typed structurally here. The guarantee that a graph is
 * well-formed lives in the node map's own types and in `graphDefects`, not in
 * this builder's inference.
 */
type Chain = {
  then: (step: unknown) => Chain;
  parallel: (steps: unknown[]) => Chain;
  map: (fn: unknown) => Chain;
  branch: (entries: unknown[]) => Chain;
  dountil: (step: unknown, condition: unknown) => Chain;
  commit: () => MastraWorkflow;
};

const segment = <S>(id: string): Chain =>
  createWorkflow({
    id,
    inputSchema: opaque<S>(),
    outputSchema: opaque<unknown>(),
    stateSchema: RunState,
  }) as unknown as Chain;

/** A `step` node: run it, execute what it asked for, absorb the results. */
const stepFor = <S>(
  id: NodeId,
  node: StepNode<S>,
  execute: EffectExecutor,
  shape: { traced: boolean },
) =>
  createStep({
    id,
    inputSchema: opaque<S>(),
    outputSchema: opaque<S>(),
    stateSchema: RunState,
    execute: async ({ inputData, state, setState }) => {
      // Fanout sub-steps run concurrently, and concurrent setState calls clobber
      // one another, so they do not trace themselves: the fanout merge appends
      // every sub-step id at once, in declaration order.
      if (shape.traced) await appendTrace(state, setState, id);
      const out = await node.run(inputData);
      const absorbed = node.absorb(out.state, await execute(out.effects));
      return shape.traced ? absorbed : (changedKeys(inputData, absorbed) as S);
    },
  });

/**
 * A `fanout` node compiles to its own nested workflow so that `getInitData()`
 * inside it is the pre-fanout state — the common ancestor each sub-step's
 * patch is re-applied to.
 */
const fanoutFor = <S>(
  id: NodeId,
  steps: NodeId[],
  wf: Workflow<S>,
  execute: EffectExecutor,
): MastraWorkflow =>
  segment<S>(`fanout:${id}`)
    .parallel(
      steps.map((sub) => stepFor(sub, wf.nodes[sub] as StepNode<S>, execute, { traced: false })),
    )
    .map(
      async ({
        inputData,
        getInitData,
        state,
        setState,
      }: {
        inputData: Record<NodeId, Partial<S>>;
        getInitData: <T>() => T;
        state: RunState | undefined;
        setState: SetState;
      }) => {
        await appendTrace(state, setState, id, ...steps);
        return steps.reduce<S>((acc, sub) => ({ ...acc, ...inputData[sub] }), getInitData<S>());
      },
    )
    .commit();

/** A `suspend` node: park on the first pass, absorb the answer on resume. */
const suspendFor = <S>(id: NodeId, node: Extract<Node<S>, { type: "suspend" }>) =>
  createStep({
    id,
    inputSchema: opaque<S>(),
    outputSchema: opaque<S>(),
    stateSchema: RunState,
    suspendSchema: SuspensionPayload,
    resumeSchema: node.resumeSchema,
    execute: async ({ inputData, resumeData, suspend, state, setState }) => {
      if (resumeData === undefined) {
        await appendTrace(state, setState, id);
        return await suspend({ reason: node.reason(inputData), trail: node.trail(inputData) });
      }
      return node.absorb(inputData, node.resumeSchema.parse(resumeData) as never);
    },
  });

/** A `terminal` node. `rejected` bails so nothing downstream of it can run. */
const terminalFor = <S>(id: NodeId, node: Extract<Node<S>, { type: "terminal" }>) =>
  createStep({
    id,
    inputSchema: opaque<S>(),
    outputSchema: opaque<Terminal<S>>(),
    stateSchema: RunState,
    execute: async ({ inputData, state, setState, bail }) => {
      await appendTrace(state, setState, id);
      const terminal = node.done(inputData);
      return terminal.kind === "rejected" ? bail(terminal) : terminal;
    },
  });

/**
 * The entry step of a branch: record the visit and prove the edge exists
 * before any predicate runs, so an unhandled decision names itself.
 */
const branchEntryFor = <S>(id: NodeId, node: Extract<Node<S>, { type: "branch" }>) =>
  createStep({
    id,
    inputSchema: opaque<S>(),
    outputSchema: opaque<S>(),
    stateSchema: RunState,
    execute: async ({ inputData, state, setState }) => {
      const key = node.on(inputData);
      if (!node.edges[key]) throw new Error(`graph bug: ${id} has no edge for ${key}`);
      await appendTrace(state, setState, id);
      return inputData;
    },
  });

/**
 * The head of a loop body: count this iteration and mark it in the trace, so a
 * loop's id appears once per pass and `visitCount(trace, loopId)` is the number
 * of iterations run.
 */
const loopIterationFor = (id: NodeId) =>
  createStep({
    id: `${id}#iteration`,
    inputSchema: opaque<unknown>(),
    outputSchema: opaque<unknown>(),
    stateSchema: RunState,
    execute: async ({ inputData, state, setState }) => {
      const loops = state?.loops ?? {};
      await setState({
        trace: [...(state?.trace ?? []), id],
        loops: { ...loops, [id]: (loops[id] ?? 0) + 1 },
      });
      return inputData;
    },
  });

/**
 * The step after the loop: hand the exit facts to `absorb`.
 *
 * `exhausted` needs no counter. The loop leaves for exactly two reasons —
 * `until` held, or the bound was reached with `until` still false — so
 * `!until(final)` is the second one, exactly. The counter is read for
 * `iterations` and then reset, so a loop nested inside another loop counts
 * from zero on every re-entry rather than accumulating across the outer pass.
 */
const loopExitFor = <S>(id: NodeId, node: LoopNode<S>) =>
  createStep({
    id: `${id}#exit`,
    inputSchema: opaque<S>(),
    outputSchema: opaque<S>(),
    stateSchema: RunState,
    execute: async ({ inputData, state, setState }) => {
      const loops = state?.loops ?? {};
      const iterations = loops[id] ?? 0;
      await setState({ trace: state?.trace ?? [], loops: { ...loops, [id]: 0 } });
      return node.absorb(inputData, { iterations, exhausted: !node.until(inputData) });
    },
  });

/**
 * A body path that reaches the loop's own id with nothing in between — a
 * branch edge that means "iterate now". Mastra needs a step there; this one
 * passes the state through untouched and does not trace.
 */
const continueFor = (segmentId: string) =>
  createStep({
    id: `${segmentId}#continue`,
    inputSchema: opaque<unknown>(),
    outputSchema: opaque<unknown>(),
    stateSchema: RunState,
    execute: async ({ inputData }) => inputData,
  });

/**
 * One iteration of a loop: the counter, then the body sub-graph compiled with
 * the loop's own id as its stop edge.
 */
const loopBodyFor = <S>(
  id: NodeId,
  node: LoopNode<S>,
  wf: Workflow<S>,
  execute: EffectExecutor,
  segmentId: string,
): MastraWorkflow =>
  segment<S>(`${segmentId}>loop:${id}`)
    .then(loopIterationFor(id))
    .then(compileSegment(wf, node.body, `${segmentId}>loop:${id}:body`, execute, id))
    .commit();

/**
 * Compile one segment: the chain from `start` up to and including the first
 * branch or terminal it reaches, or up to `stopAt` when compiling a loop body.
 *
 * `segmentId` is the path taken to get here, so every nested workflow id is
 * unique. Two edges of one branch pointing at the same node compile to two
 * distinct workflows, and a node reachable by two different paths does too.
 */
const compileSegment = <S>(
  wf: Workflow<S>,
  start: NodeId,
  segmentId: string,
  execute: EffectExecutor,
  /** The loop id whose continue edge ends this segment, when inside a body. */
  stopAt?: NodeId,
): MastraWorkflow => {
  let builder = segment<S>(segmentId);
  let emitted = 0;
  const push = (step: unknown): void => {
    builder = builder.then(step);
    emitted += 1;
  };

  let cursor = start;
  for (;;) {
    if (cursor === stopAt) {
      // The loop's iteration boundary. An empty segment still needs a step.
      if (emitted === 0) push(continueFor(segmentId));
      return builder.commit();
    }
    const id = cursor;
    const node = wf.nodes[id] as Node<S>;
    switch (node.type) {
      case "step":
        push(stepFor(id, node, execute, { traced: true }));
        cursor = node.next;
        break;
      case "fanout":
        push(fanoutFor(id, node.steps, wf, execute));
        cursor = node.join;
        break;
      case "suspend":
        push(suspendFor(id, node));
        cursor = node.next;
        break;
      case "loop":
        builder = builder.dountil(
          loopBodyFor(id, node, wf, execute, segmentId),
          async ({ inputData, iterationCount }: { inputData: S; iterationCount: number }) =>
            node.until(inputData) || iterationCount >= node.max,
        );
        push(loopExitFor(id, node));
        cursor = node.next;
        break;
      case "branch": {
        const keys = Object.keys(node.edges);
        builder = builder
          .then(branchEntryFor(id, node))
          .branch(
            keys.map((key) => [
              async ({ inputData }: { inputData: S }) => node.on(inputData) === key,
              compileSegment(
                wf,
                node.edges[key] as NodeId,
                `${segmentId}>${id}=${key}`,
                execute,
                stopAt,
              ),
            ]),
          )
          // Exactly one target ran; its output is keyed by that target's id.
          .map(async ({ inputData }: { inputData: Record<string, unknown> }) =>
            Object.values(inputData).find((v) => v !== undefined),
          );
        return builder.commit();
      }
      case "terminal":
        push(terminalFor(id, node));
        return builder.commit();
    }
  }
};

/**
 * Compile a graph and register it on the shared runtime so its snapshots are
 * addressable by `runId`. The compilation is a pure function of the graph: the
 * same graph always yields the same workflow id and the same step ids, which
 * is what lets `resume` rebuild it and reattach to a persisted run.
 */
export const compileWorkflow = <S>(wf: Workflow<S>, execute: EffectExecutor): MastraWorkflow => {
  const defects = graphDefects(wf);
  if (defects.length > 0) {
    throw new Error(`graph bug: cannot compile this workflow:\n  ${defects.join("\n  ")}`);
  }
  const compiled = compileSegment(wf, wf.start, `wf:${wf.start}`, execute);
  compiled.__registerMastra(workflowRuntime());
  return compiled;
};
