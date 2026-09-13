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
 *
 * A PIPELINE registration owns no execution at all, and that is the second
 * shape worth defending. It is steps plus two hooks; the server schedules them,
 * and each step's run is an ordinary run of a registered workflow — with a
 * server run id, a live trace, events, and a suspension a person answers in
 * the same dialog they answer a standalone run in.
 */

import type { Journal } from "@des/core/journal";
import type { StepObserver } from "@des/core/step";
import type { EffectExecutor, RunOutcome, Workflow } from "@des/core/workflow";
import type { WorkflowRuntime } from "@des/core/compile";
import type { z } from "zod";
import type { Json } from "./json.ts";

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
  /** What a person supplies to start one. The input is parsed by it. */
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
   * the run: which oracle this step's crafter is walled off from, and which
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
 * One step of a pipeline, as the consumer declares it.
 *
 * A step names a registered WORKFLOW and the input one run of it is started
 * with, and nothing else. There is no second way to run a step: `deliver` the
 * pipeline step and `deliver` the graph a person started by hand are the same
 * registration, seeded by the same `seed`, executed by the same `executor` —
 * which is what makes "starting one step by hand does not escape the
 * precondition the scheduler enforces" structural rather than duplicated.
 */
export type PipelineStep = {
  id: string;
  /** What this step is for, in one line. */
  description?: string;
  /** Step ids that must be accepted before this one runs. */
  dependencies: string[];
  /** The registered workflow one step's run is a run OF. */
  workflowId: string;
  /** The input that run is started with, as that workflow's schema parses it. */
  input: Json;
};

/**
 * A registered composition over the scheduler: data, plus two hooks.
 *
 * It owns NO execution. The server reads the steps, drives the frontier through
 * `@des/core`'s own scheduler, and starts each ready step as a run of the
 * workflow the step names. What a consumer keeps is the two halves only it can
 * answer: whether a step may run at all, and what to persist when one finishes.
 */
export type PipelineRegistration = {
  id: string;
  title: string;
  /** The steps, in declaration order. Re-read on every request and every run. */
  steps: () => Promise<PipelineStep[]> | PipelineStep[];
  /**
   * May this step run at all, beyond its dependencies being accepted?
   *
   * DELIVER's is "this value's oracle has been measured red". The frontier
   * rule cannot express it: a step that has not run is pending whether or not
   * it may. An ineligible step blocks its dependents exactly as a rejected one
   * does. Absent: every step is eligible.
   */
  readiness?: (stepId: string) => Promise<boolean> | boolean;
  /**
   * Each finished run, as it finishes. The consumer's only write: this is
   * where a `step_runs` or an `oracle_runs` row is appended, and the outcome
   * carries the terminal STATE, which is where a measured verdict lives.
   */
  record?: (stepId: string, outcome: RunOutcome<unknown>) => Promise<void> | void;
  /** How many steps may be in flight at once. Every step by default. */
  concurrency?: number;
  /** Shared infrastructure a step's run needs exclusively, by name. */
  resourcesFor?: (step: PipelineStep) => string[];
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
