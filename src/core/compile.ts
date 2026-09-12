/**
 * Compiles a `Workflow<S>` node map to a Mastra workflow.
 *
 * The node map is an arbitrary directed acyclic graph; Mastra's builder is a
 * linear chain of combinators. The bridge is the continuation: a chain runs
 * until it reaches a branch, and each edge of that branch compiles to a NESTED
 * workflow carrying the rest of that path. `Workflow` implements `Step`, so a
 * nested workflow is a legal branch target. A node reachable from two branches
 * is therefore compiled once per path, under a per-path workflow id.
 *
 * Cycles are out of scope for this cut: `graphDefects` rejects a back edge and
 * the compiler refuses to build the graph, rather than mis-compiling it.
 *
 * The mapping, one line each:
 *
 *   step      -> createStep; runs the node, executes its effects, absorbs
 *   fanout    -> a nested workflow: .parallel(sub-steps) then a .map() that
 *                merges each sub-step's CHANGED-KEY SLICE onto getInitData()
 *   branch    -> an entry step (trace + edge guard), .branch() with one
 *                predicate per edge key, then a .map() that unwraps the
 *                single executed target's output
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
 * The compiled workflow's Mastra state. It carries the trace and nothing else:
 * state survives suspend/resume, which is exactly the lifetime the provenance
 * record needs. The caller's `S` flows as step input/output, not as state.
 */
const TraceState = z.object({ trace: z.array(z.string()) });

/** Recover the trace from a Mastra run result's `state`. */
export const readTrace = (state: unknown): NodeId[] =>
  TraceState.safeParse(state).data?.trace ?? [];

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

const appendTrace = async (
  state: { trace: string[] } | undefined,
  setState: (s: { trace: string[] }) => Promise<void> | void,
  ...ids: NodeId[]
): Promise<void> => {
  await setState({ trace: [...(state?.trace ?? []), ...ids] });
};

/** Snapshots live here, so a parked run can be resumed from a fresh compile. */
let runtime: Mastra | undefined;
export const workflowRuntime = (): Mastra => {
  runtime ??= new Mastra({ storage: new InMemoryStore({ id: "deterministic-workflows" }), logger: false });
  return runtime;
};

type StepNode<S> = Extract<Node<S>, { type: "step" }>;

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
  commit: () => MastraWorkflow;
};

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
    stateSchema: TraceState,
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
  (
    createWorkflow({
      id: `fanout:${id}`,
      inputSchema: opaque<S>(),
      outputSchema: opaque<S>(),
      stateSchema: TraceState,
    }) as unknown as Chain
  )
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
        state: { trace: string[] } | undefined;
        setState: (s: { trace: string[] }) => Promise<void>;
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
    stateSchema: TraceState,
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
    stateSchema: TraceState,
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
    stateSchema: TraceState,
    execute: async ({ inputData, state, setState }) => {
      const key = node.on(inputData);
      if (!node.edges[key]) throw new Error(`graph bug: ${id} has no edge for ${key}`);
      await appendTrace(state, setState, id);
      return inputData;
    },
  });

/**
 * Compile one segment: the chain from `start` up to and including the first
 * branch or terminal it reaches. `segmentId` makes the nested workflow ids
 * unique per path, so two edges of one branch pointing at the same node
 * compile to two distinct workflows rather than colliding.
 */
const compileSegment = <S>(
  wf: Workflow<S>,
  start: NodeId,
  segmentId: string,
  execute: EffectExecutor,
): MastraWorkflow => {
  let builder = createWorkflow({
    id: segmentId,
    inputSchema: opaque<S>(),
    outputSchema: opaque<Terminal<S>>(),
    stateSchema: TraceState,
  }) as unknown as Chain;

  let cursor = start;
  for (;;) {
    const id = cursor;
    const node = wf.nodes[id] as Node<S>;
    switch (node.type) {
      case "step":
        builder = builder.then(stepFor(id, node, execute, { traced: true }));
        cursor = node.next;
        break;
      case "fanout":
        builder = builder.then(fanoutFor(id, node.steps, wf, execute));
        cursor = node.join;
        break;
      case "suspend":
        builder = builder.then(suspendFor(id, node));
        cursor = node.next;
        break;
      case "branch": {
        const keys = Object.keys(node.edges);
        builder = builder
          .then(branchEntryFor(id, node))
          .branch(
            keys.map((key) => [
              async ({ inputData }: { inputData: S }) => node.on(inputData) === key,
              compileSegment(wf, node.edges[key] as NodeId, `${id}=${key}`, execute),
            ]),
          )
          // Exactly one target ran; its output is keyed by that target's id.
          .map(async ({ inputData }: { inputData: Record<string, unknown> }) =>
            Object.values(inputData).find((v) => v !== undefined),
          );
        return builder.commit();
      }
      case "terminal":
        builder = builder.then(terminalFor(id, node));
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
