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
 * shape worth defending. It is an input schema, steps and two hooks; the
 * server schedules them, and each step's run is an ordinary run of a
 * registered workflow — with a server run id, a live trace, events, and a
 * suspension a person answers in the same dialog they answer a standalone run
 * in.
 *
 * A pipeline takes an INPUT for the same reason a workflow does: a composition
 * whose steps are derived from something is a composition over ONE of them, and
 * which one is a thing a person supplies rather than a thing the composition
 * was built holding. It is parsed by the registration's own schema before
 * anything is scheduled, so a value the steps could not be derived from never
 * becomes a drive.
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
   * the run: which oracle this step's writes are walled off from, and which
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
 * with, and nothing else. There is no second way to run a step: the pipeline's
 * step and the graph a person started by hand are the same registration,
 * seeded by the same `seed`, executed by the same `executor` — which is what
 * makes "starting one step by hand does not escape the precondition the
 * scheduler enforces" structural rather than duplicated.
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
 * One option a person may pick for one input field.
 *
 * `value` is what the field is set to, and it is what the registration's own
 * schema parses. `label` is what a person reads when the value alone is not
 * readable; absent, the value is shown.
 *
 * A choice is DATA. The UI renders a closed list because a field declares
 * choices, and it knows nothing about where they came from — a table, a
 * directory, a constant, or a service.
 */
export type Choice = { value: string; label?: string };

/**
 * A registered composition over the scheduler: an input, data, plus two hooks.
 *
 * It owns NO execution. The server reads the steps, drives the frontier through
 * `@des/core`'s own scheduler, and starts each ready step as a run of the
 * workflow the step names. What a consumer keeps is the two halves only it can
 * answer: whether a step may run at all, and what to persist when one finishes.
 *
 * Every hook is handed the validated input, because what a composition is a
 * composition OF is an argument rather than a constant. A pipeline whose steps
 * are derived names the data they are derived from with its input; a pipeline
 * whose steps are fixed declares `z.object({})` and ignores it.
 */
export type PipelineRegistration<I = unknown> = {
  id: string;
  title: string;
  /** What a person supplies to drive one. The input is parsed by it. */
  input: z.ZodType<I>;
  /**
   * The options one input field is picked from, keyed by the field's name.
   *
   * A field that declares choices is offered as a closed list; every other
   * field is rendered from the schema alone. This is where a consumer names
   * WHERE the options live, which is the one thing about them a reader of the
   * schema cannot work out: a field typed `string` says nothing about which
   * strings exist.
   *
   * Called at READ time rather than at registration, and that is the whole of
   * why it is a function. What a person may pick is a fact about the store
   * RIGHT NOW — a value some other graph wrote a second ago is one of the
   * options — and a list captured when the server booted would be the list
   * that existed before anything had run.
   */
  choices?: { [field: string]: () => Promise<Choice[]> | Choice[] };
  /** The steps, in declaration order. Re-read on every request and every run. */
  steps: (input: I) => Promise<PipelineStep[]> | PipelineStep[];
  /**
   * May this step run at all, beyond its dependencies being accepted?
   *
   * A consumer's might be "this step's oracle has been measured red". The
   * frontier rule cannot express it: a step that has not run is pending
   * whether or not it may. An ineligible step blocks its dependents exactly as
   * a rejected one does. Absent: every step is eligible.
   */
  readiness?: (stepId: string, input: I) => Promise<boolean> | boolean;
  /**
   * Each finished run, as it finishes. The consumer's only write: this is
   * where a `step_runs` or an `oracle_runs` row is appended, and the outcome
   * carries the terminal STATE, which is where a measured verdict lives.
   */
  record?: (stepId: string, outcome: RunOutcome<unknown>, input: I) => Promise<void> | void;
  /** How many steps may be in flight at once. Every step by default. */
  concurrency?: number;
  /** Shared infrastructure a step's run needs exclusively, by name. */
  resourcesFor?: (step: PipelineStep, input: I) => string[];
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

/**
 * A pipeline registration with its type parameter erased, as the server holds
 * it.
 *
 * Spelled out for the reason `AnyWorkflowRegistration` is: every hook CONSUMES
 * the input, and a function's parameter does not widen, so a
 * `PipelineRegistration<{ roadmapId: string }>` is not a
 * `PipelineRegistration<unknown>` and the erasure has to say so itself.
 */
export type AnyPipelineRegistration = {
  id: string;
  title: string;
  input: z.ZodType<unknown>;
  choices?: { [field: string]: () => Promise<Choice[]> | Choice[] };
  steps: (input: unknown) => Promise<PipelineStep[]> | PipelineStep[];
  readiness?: (stepId: string, input: unknown) => Promise<boolean> | boolean;
  record?: (stepId: string, outcome: RunOutcome<unknown>, input: unknown) => Promise<void> | void;
  concurrency?: number;
  resourcesFor?: (step: PipelineStep, input: unknown) => string[];
};

/**
 * Erase a pipeline registration's type parameter.
 *
 * `PipelineRegistration<I>` is what a target writes, with `I` inferred from
 * the input schema — so the steps a hook derives still have to come from the
 * value that schema produces. The server holds a heterogeneous set of them and
 * drives every one through the same hooks, so the erasure happens once, here.
 */
export const pipeline = <I>(reg: PipelineRegistration<I>): AnyPipelineRegistration =>
  reg as unknown as AnyPipelineRegistration;
