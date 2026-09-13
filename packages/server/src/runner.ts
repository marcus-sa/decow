/**
 * Driving a registered graph, and reporting what it did while it did it.
 *
 * The engine is Mastra's and the runner is `@des/core`'s; this is neither. It
 * is the join: it starts a run through `run`, watches the nodes it enters,
 * collects what each leaf attempt decided, and settles the record when the run
 * stops — parked for a person, or on one of its two declared terminals.
 *
 * A run executes asynchronously and the caller gets an id back immediately,
 * because a DELIVER cycle is minutes of real work and nothing should wait on
 * it to learn the run's name. Everything that happens afterwards arrives on
 * the event bus, and the run's record is what a client that missed it reads.
 *
 * The id comes back BESIDE a promise of the outcome, and the pipeline
 * scheduler is what that is for: a row's run is an ordinary run, so the
 * scheduler starts one and awaits it exactly as it awaited a `run()` call,
 * while the person watching gets the id, the trace and the events for free.
 */

import {
  resume as resumeRun,
  run as startRun,
  type NodeId,
  type RunOutcome,
  type Workflow,
} from "@des/core/workflow";
import type { RunWatcher, WorkflowRuntime } from "@des/core/compile";
import type { StepAttempt } from "@des/core/step";
import type { EventBus } from "./events.ts";
import { parkedAt, resumeOptionsOf } from "./projection.ts";
import type { AnyWorkflowRegistration } from "./registration.ts";
import { traceEntries, type RunStore } from "./runs.ts";

export type RunnerOptions = {
  /** Every registered graph, so a run can be started by workflow id. */
  workflows: AnyWorkflowRegistration[];
  runs: RunStore;
  events: EventBus;
  /** Where a registration's snapshots land when it names no runtime. */
  runtime: WorkflowRuntime;
  /** The id a new run is given. Injected, so a test can name its runs. */
  mintId: () => string;
};

/** A run that has been started: its name now, its outcome later. */
export type StartedRun = {
  runId: string;
  /** Resolves when the run reaches a terminal or parks for a person. */
  settled: Promise<RunOutcome<unknown>>;
};

export type Runner = {
  /** Start a run of the named registration on `input`, already validated. */
  start(workflowId: string, input: unknown): StartedRun;
  /** The graph a run was built with, so a resume can parse the answer. */
  graphOf(runId: string): Workflow<unknown> | undefined;
  /**
   * Continue a parked run. The caller has already validated the answer.
   * `undefined` when there is no such run, or it never reached the engine.
   */
  resume(runId: string, answer: unknown): Promise<RunOutcome<unknown>> | undefined;
  /** Every run in flight has settled. For a test that wants to be sure. */
  idle(): Promise<void>;
};

export const openRunner = (options: RunnerOptions): Runner => {
  const { runs, events, runtime, mintId } = options;
  const byId = new Map(options.workflows.map((w) => [w.id, w] as const));
  /** The graph each run was built with. A resume recompiles the same one. */
  const graphs = new Map<string, Workflow<unknown>>();
  /** The registration and input each run was started with. */
  const started = new Map<string, { registration: AnyWorkflowRegistration; input: unknown }>();
  /** Everything in flight, so a caller can wait for quiet. */
  const inFlight = new Set<Promise<void>>();

  /** The leaf observer for one run: the target's sink first, then ours. */
  const observerFor =
    (registration: AnyWorkflowRegistration, runId: string) =>
    (attempt: StepAttempt): void => {
      registration.observe?.(attempt);
      runs.record(runId, attempt);
      events.emit({ type: "leaf-attempt", runId, attempt });
    };

  const watcherFor =
    (runId: string): RunWatcher =>
    (event) => {
      if (event.kind === "node-left") {
        events.emit({ type: "node-left", runId, node: event.node });
        return;
      }
      const entry = runs.entered(runId, event.node);
      if (entry !== undefined) {
        events.emit({ type: "node-entered", runId, node: entry.node, iteration: entry.iteration });
      }
    };

  /**
   * Fold a finished run into its record and say so.
   *
   * The trace is replaced with the engine's own rather than kept as the one
   * the watcher accumulated: the engine wrote it into the snapshot a resume
   * reads, so it is the record that survives, and two traces that disagree
   * should disagree in favour of the durable one.
   */
  const settle = (runId: string, graph: Workflow<unknown>, outcome: RunOutcome<unknown>): void => {
    const trace = traceEntries(outcome.trace);
    if (outcome.kind === "suspended") {
      const node: NodeId | undefined = parkedAt(graph, outcome.trace);
      const parked = node === undefined ? undefined : graph.nodes[node];
      const suspension = {
        ...(node === undefined ? {} : { node }),
        reason: outcome.reason,
        trail: outcome.trail,
        ...(parked?.type === "suspend" ? { resume: resumeOptionsOf(parked.resumeSchema) } : {}),
      };
      runs.settle(runId, {
        status: "suspended",
        trace,
        suspension,
        engineRunId: outcome.runId,
      });
      events.emit({ type: "suspended", runId, suspension });
      return;
    }
    const terminal = outcome.terminal;
    runs.settle(runId, {
      status: terminal.kind,
      trace,
      terminal:
        terminal.kind === "rejected"
          ? { kind: "rejected", trail: terminal.trail }
          : { kind: "accepted" },
      engineRunId: outcome.runId,
    });
    events.emit({ type: "terminal", runId, kind: terminal.kind });
  };

  /**
   * A run that threw. Everything a graph DECIDES is data, so a throw is a
   * graph bug: it is recorded as one, under a status the declared endings do
   * not use, rather than flattened into `rejected`.
   */
  const fail = (runId: string, error: unknown): void => {
    runs.settle(runId, { status: "failed", error: String(error) });
    events.emit({ type: "terminal", runId, kind: "failed" });
  };

  /**
   * Drive one run to its outcome, recording it either way.
   *
   * The returned promise is what a caller awaits — the pipeline scheduler
   * does — and it rejects on a graph bug, because a scheduler must not treat
   * a malformed graph as a status. Nothing is left unhandled: `track` attaches
   * a handler for the callers that only want `idle`.
   */
  const drive = (
    runId: string,
    graph: Workflow<unknown>,
    work: () => Promise<RunOutcome<unknown>>,
  ): Promise<RunOutcome<unknown>> => {
    const driving = (async () => {
      try {
        const outcome = await work();
        settle(runId, graph, outcome);
        return outcome;
      } catch (error) {
        fail(runId, error);
        throw error;
      }
    })();
    // Attaching a handler here is what keeps a rejection from being
    // "unhandled" for a caller that only ever wanted the run to happen.
    const tracked = driving.then(
      () => {},
      () => {},
    );
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
    return driving;
  };

  return {
    start: (workflowId, input) => {
      const registration = byId.get(workflowId);
      if (registration === undefined) {
        throw new Error(`no workflow ${workflowId} is registered, so nothing can be run`);
      }
      const runId = mintId();
      runs.start({ runId, workflowId: registration.id, input });
      events.emit({ type: "run-started", runId, workflowId: registration.id });

      const graph = registration.graph({
        journal: registration.journal,
        observe: observerFor(registration, runId),
      });
      graphs.set(runId, graph);
      started.set(runId, { registration, input });

      const settled = drive(runId, graph, () =>
        startRun<unknown>(
          graph,
          registration.seed(input),
          registration.executor({ runId, input }),
          registration.runtime ?? runtime,
          watcherFor(runId),
        ),
      );

      return { runId, settled };
    },

    graphOf: (runId) => graphs.get(runId),

    resume: (runId, answer) => {
      const record = runs.get(runId);
      const graph = graphs.get(runId);
      const opened = started.get(runId);
      const engineRunId = record?.engineRunId;
      if (record === undefined || graph === undefined || opened === undefined) return undefined;
      if (engineRunId === undefined) return undefined;

      runs.settle(runId, { status: "running" });
      events.emit({ type: "resumed", runId, answer });

      return drive(runId, graph, () =>
        resumeRun<unknown>(
          graph,
          engineRunId,
          answer,
          opened.registration.executor({ runId, input: opened.input }),
          opened.registration.runtime ?? runtime,
          watcherFor(runId),
        ),
      );
    },

    idle: async () => {
      // A settling run can start nothing, but a resumed one is tracked while
      // this is awaited, so the wait is a loop rather than one join.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
};
