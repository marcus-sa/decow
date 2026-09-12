/**
 * The workflow is a finite graph. Every path through it is enumerable before
 * it runs.
 *
 * 1. Only enums drive edges. `branch` reads a closed decision type; payload is
 *    never read by the graph.
 * 2. Every branch's edge table is exhaustive at compile time: a branch over a
 *    decision type D takes Record<D, NodeId>. Adding a decision value without
 *    an edge is a type error.
 * 3. Terminals are enumerated, not thrown. A workflow ends in `accepted` or
 *    `rejected`; a `suspend` node parks the run for a person and the graph
 *    branches on the typed decision they return.
 * 4. Effects are data. A step returns Effect[]; the compiled step executes them.
 *
 * This file is the contract. The graph is executed by compiling it to a Mastra
 * workflow (see ./compile.ts) and driving that through `createRun()`.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { z } from "zod";
import { compileWorkflow, readTrace, SuspensionPayload } from "./compile.ts";
import type { Effect, EffectResult } from "./effects.ts";

export type NodeId = string;

/**
 * A run's declared endings. `needs-human` is NOT here: parking for a person is
 * a suspension, not a terminal, so a person's answer can resume the same run.
 */
export type Terminal<S> =
  | { kind: "accepted"; state: S }
  | { kind: "rejected"; state: S; trail: unknown[] };

export const TERMINAL_KINDS = ["accepted", "rejected"] as const;

export type Node<S> =
  | {
      type: "step";
      run: (s: S) => Promise<{ state: S; effects: Effect[] }>;
      absorb: (s: S, results: EffectResult[]) => S;
      next: NodeId;
    }
  | { type: "fanout"; steps: NodeId[]; join: NodeId }
  | { type: "branch"; on: (s: S) => string; edges: Record<string, NodeId> }
  | {
      /**
       * Park the run for a person. `reason` is a closed enum per workflow and
       * `trail` is the evidence; together they are the typed suspend payload.
       * The person answers with a value of `resumeSchema`, `absorb` folds that
       * answer into state, and the graph branches on it at `next`.
       */
      type: "suspend";
      reason: (s: S) => string;
      trail: (s: S) => unknown[];
      resumeSchema: z.ZodType<unknown>;
      absorb: (s: S, answer: never) => S;
      next: NodeId;
    }
  | { type: "terminal"; done: (s: S) => Terminal<S> };

export type Workflow<S> = { start: NodeId; nodes: Record<NodeId, Node<S>> };

/**
 * The load-bearing constructor. `edges` is `Record<D, NodeId>` over the
 * decision union, so dropping a decision member is a compile error.
 */
export const branch = <S, D extends string>(on: (s: S) => D, edges: Record<D, NodeId>): Node<S> => ({
  type: "branch",
  on,
  edges,
});

/**
 * The suspend-node constructor, the same shape of guarantee one level over:
 * `resumeSchema` and `absorb` are tied to one answer type `R`, so the node
 * cannot be built with a schema that parses something `absorb` does not
 * accept. The erasure to `Node<S>` happens here and nowhere else.
 */
export const suspend = <S, R>(spec: {
  reason: (s: S) => string;
  trail: (s: S) => unknown[];
  resumeSchema: z.ZodType<R>;
  absorb: (s: S, answer: R) => S;
  next: NodeId;
}): Node<S> => ({
  type: "suspend",
  reason: spec.reason,
  trail: spec.trail,
  resumeSchema: spec.resumeSchema as z.ZodType<unknown>,
  absorb: spec.absorb as (s: S, answer: never) => S,
  next: spec.next,
});

/** Executes the effects a step returned and feeds typed results back. */
export type EffectExecutor = (effects: Effect[]) => Promise<EffectResult[]>;

/**
 * What a run produced. A run either reached a declared terminal or parked for
 * a person; `runId` addresses the parked run for `resume`.
 *
 * `trace` is the provenance record, accumulated in the compiled workflow's
 * state so it survives suspension. A model cannot claim to have reached a node
 * it did not reach.
 */
export type RunOutcome<S> =
  | { kind: "terminal"; terminal: Terminal<S>; trace: NodeId[]; runId: string }
  | { kind: "suspended"; reason: string; trail: unknown[]; trace: NodeId[]; runId: string };

const outcome = <S>(result: Record<string, unknown>, runId: string): RunOutcome<S> => {
  const trace = readTrace(result.state);
  switch (result.status) {
    case "success":
      return { kind: "terminal", terminal: result.result as Terminal<S>, trace, runId };
    case "suspended": {
      const payloads = Object.values((result.suspendPayload ?? {}) as Record<string, unknown>);
      const { reason, trail } = SuspensionPayload.parse(payloads[0]);
      return { kind: "suspended", reason, trail, trace, runId };
    }
    case "failed":
      throw result.error;
    default:
      throw new Error(`graph bug: run ${runId} ended in unexpected status ${String(result.status)}`);
  }
};

/**
 * Compile the graph to a Mastra workflow and run it from `start`.
 *
 * The only errors this throws are graph bugs: a malformed graph (rejected by
 * `graphDefects` before anything executes), an unhandled edge, or an error a
 * step let escape. Everything a step or an effect can decide is data.
 */
export async function run<S>(
  wf: Workflow<S>,
  state: S,
  execute: EffectExecutor,
): Promise<RunOutcome<S>> {
  const compiled = compileWorkflow(wf, execute);
  const handle = await compiled.createRun();
  const result = await handle.start({
    inputData: state,
    initialState: { trace: [] },
    outputOptions: { includeState: true },
  });
  return outcome<S>(result as unknown as Record<string, unknown>, handle.runId);
}

/**
 * Continue a parked run with a person's answer. The graph is recompiled — the
 * compilation is a pure function of the graph, so the step ids match the
 * snapshot Mastra persisted — and reattached to the same `runId`.
 */
export async function resume<S>(
  wf: Workflow<S>,
  runId: string,
  answer: unknown,
  execute: EffectExecutor,
): Promise<RunOutcome<S>> {
  const compiled = compileWorkflow(wf, execute);
  const handle = await compiled.createRun({ runId });
  const result = await handle.resume({
    resumeData: answer,
    outputOptions: { includeState: true },
  });
  return outcome<S>(result as unknown as Record<string, unknown>, runId);
}
