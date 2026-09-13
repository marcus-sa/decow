/**
 * What a target registers with the server.
 *
 * A registration is the whole of what the server knows about a graph: how to
 * name it, what to ask a person for before starting it, how to turn that into
 * the graph's own seed state, what its effects mean in this repository, and
 * where its snapshots live. Everything else the server reports — the authored
 * projection, the trace, the suspension, the attempts — it derives.
 *
 * The graph is a FACTORY rather than a value, and that is the one place this
 * shape departs from the obvious one. A `Workflow<S>` has its journal and its
 * observer already closed over, so a server handed one cannot see what its
 * leaves decided, and "what did each attempt cost" is exactly what a person
 * watching a run wants. So the server supplies both and the registration
 * builds the graph over them, which is the same signature every graph builder
 * in this repository already has: `graph(journal, defs, observe)`.
 */

import type { Journal } from "@des/core/journal";
import type { RowStatus } from "@des/core/scheduler";
import type { StepObserver } from "@des/core/step";
import type { EffectExecutor, Workflow } from "@des/core/workflow";
import type { WorkflowRuntime } from "@des/core/compile";
import type { z } from "zod";

/** What the server hands a graph factory. */
export type GraphContext = {
  /** The registration's own journal, so a repeated decision is replayed. */
  journal: Journal;
  /**
   * Where every attempt of every leaf is reported. The registration's own
   * `observe` is called first and this one second, so a target that already
   * writes a run report keeps writing it.
   */
  observe: StepObserver;
};

export type WorkflowRegistration<S = unknown, I = unknown> = {
  /** Stable, unique across the registered set. The URL says this. */
  id: string;
  /** One line, for a person choosing between them. */
  title: string;
  /** What a person supplies to start one. The POST body is parsed by it. */
  input: z.ZodType<I>;
  /** The graph, built over the journal and the observer the server supplies. */
  graph: (ctx: GraphContext) => Workflow<S>;
  /** The graph's seed state, from the validated input. */
  seed: (input: I) => S;
  /**
   * What this graph's effects mean here, for one run.
   *
   * The validated input travels with the run id because an executor's two
   * ownership options are facts about what the run is ABOUT rather than about
   * the run: which oracle this row's crafter is walled off from, and which
   * failing tests it did not cause. An executor that could not see them could
   * not wall anything off.
   */
  executor: (ctx: { runId: string; input: I }) => EffectExecutor;
  /** One journal for every run of this graph. */
  journal: Journal;
  /** Where the snapshots live. The server's own runtime by default. */
  runtime?: WorkflowRuntime;
  /** The target's own attempt sink, called before the server's. */
  observe?: StepObserver;
};

/**
 * One row of a pipeline's run tree, as the consumer's own projection reports
 * it. `status` is read separately, through `status(rowId)`, because a row's
 * status is a projection of what was persisted and the rest of the row is a
 * declaration.
 */
export type PipelineRow = {
  id: string;
  /** What this row is for, in one line. */
  description?: string;
  /** Row ids that must be accepted before this one runs. */
  dependencies: string[];
  /** The registered workflow one row's run drills into. */
  workflowId?: string;
  /** The run this row last finished under, when the projection knows one. */
  runId?: string;
};

export type PipelineRegistration = {
  id: string;
  title: string;
  /** The rows, in declaration order. Re-read on every request. */
  rows: () => Promise<PipelineRow[]> | PipelineRow[];
  /** One row's status, as the consumer's own projection reports it. */
  status: (rowId: string) => Promise<RowStatus> | RowStatus;
  /** Run the ready set to quiescence. */
  run: () => Promise<void>;
  /** Continue a parked row, then re-evaluate the frontier. */
  resume: (rowId: string, answer: unknown) => Promise<void>;
};

/**
 * A registration with its type parameters erased, as the server holds it.
 *
 * Spelled out rather than written `WorkflowRegistration<unknown, unknown>`,
 * because `seed` takes its input and a function's parameter does not widen:
 * a `(input: RoadmapRequest) => State` is not a `(input: unknown) => unknown`,
 * and the erasure has to say so itself.
 */
export type AnyWorkflowRegistration = {
  id: string;
  title: string;
  input: z.ZodType<unknown>;
  graph: (ctx: GraphContext) => Workflow<unknown>;
  seed: (input: unknown) => unknown;
  executor: (ctx: { runId: string; input: unknown }) => EffectExecutor;
  journal: Journal;
  runtime?: WorkflowRuntime;
  observe?: StepObserver;
};

/**
 * Erase a registration's type parameters.
 *
 * `WorkflowRegistration<S, I>` is what a target writes, with both parameters
 * inferred from the object literal — so the seed still has to return the state
 * the graph reads, and the input schema still has to produce what the seed
 * takes. The server holds a heterogeneous set of them and drives every one
 * through the same four calls, so the erasure happens once, here, rather than
 * at each of those call sites.
 */
export const registration = <S, I>(reg: WorkflowRegistration<S, I>): AnyWorkflowRegistration =>
  reg as unknown as AnyWorkflowRegistration;
