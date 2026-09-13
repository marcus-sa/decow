/**
 * Driving a registered graph, and reporting what it did while it did it.
 *
 * The engine is Mastra's and the runner is `@des/core`'s; this is neither. It
 * is the join: it starts a run through `run`, watches the nodes it enters,
 * collects what each leaf attempt decided, and settles the record when the run
 * stops — parked for a person, or on one of its two declared terminals.
 *
 * A run executes asynchronously and the caller gets an id back immediately,
 * because a DELIVER cycle is minutes of real work and an HTTP request is not
 * where a person waits for it. Everything that happens afterwards arrives on
 * the event bus, and the run's record is what a client that missed it reads.
 */

import { resume as resumeRun, run as startRun, type NodeId, type Workflow } from "@des/core/workflow";
import type { RunWatcher, WorkflowRuntime } from "@des/core/compile";
import type { StepAttempt } from "@des/core/step";
import type { EventBus } from "./events.ts";
import { parkedAt, resumeOptionsOf } from "./projection.ts";
import type { AnyWorkflowRegistration } from "./registration.ts";
import { traceEntries, type RunStore } from "./runs.ts";

export type RunnerOptions = {
  runs: RunStore;
  events: EventBus;
  /** Where a registration's snapshots land when it names no runtime. */
  runtime: WorkflowRuntime;
  /** The id a new run is given. Injected, so a test can name its runs. */
  mintId: () => string;
};

export type Runner = {
  /** Start a run of `registration` on `input`, and answer with its id. */
  start(registration: AnyWorkflowRegistration, input: unknown): string;
  /** The graph a run was built with, so a resume can parse the answer. */
  graphOf(runId: string): Workflow<unknown> | undefined;
  /** Continue a parked run. The caller has already validated the answer. */
  resume(registration: AnyWorkflowRegistration, runId: string, answer: unknown): void;
  /** Every run in flight has settled. For a test that wants to be sure. */
  idle(): Promise<void>;
};

export const openRunner = (options: RunnerOptions): Runner => {
  const { runs, events, runtime, mintId } = options;
  /** The graph each run was built with. A resume recompiles the same one. */
  const graphs = new Map<string, Workflow<unknown>>();
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
  const settle = (runId: string, graph: Workflow<unknown>, outcome: Awaited<ReturnType<typeof startRun>>): void => {
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

  /** Hold a driving promise until it settles, so `idle` means something. */
  const track = (work: Promise<void>): void => {
    const tracked = work.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
  };

  return {
    start: (registration, input) => {
      const runId = mintId();
      runs.start({ runId, workflowId: registration.id, input });
      events.emit({ type: "run-started", runId, workflowId: registration.id });

      const graph = registration.graph({
        journal: registration.journal,
        observe: observerFor(registration, runId),
      });
      graphs.set(runId, graph);

      track(
        (async () => {
          try {
            const outcome = await startRun<unknown>(
              graph,
              registration.seed(input),
              registration.executor({ runId }),
              registration.runtime ?? runtime,
              watcherFor(runId),
            );
            settle(runId, graph, outcome);
          } catch (error) {
            fail(runId, error);
          }
        })(),
      );

      return runId;
    },

    graphOf: (runId) => graphs.get(runId),

    resume: (registration, runId, answer) => {
      const record = runs.get(runId);
      const graph = graphs.get(runId);
      const engineRunId = record?.engineRunId;
      if (record === undefined || graph === undefined || engineRunId === undefined) return;

      runs.settle(runId, { status: "running" });
      events.emit({ type: "resumed", runId, answer });

      track(
        (async () => {
          try {
            const outcome = await resumeRun<unknown>(
              graph,
              engineRunId,
              answer,
              registration.executor({ runId }),
              registration.runtime ?? runtime,
              watcherFor(runId),
            );
            settle(runId, graph, outcome);
          } catch (error) {
            fail(runId, error);
          }
        })(),
      );
    },

    idle: async () => {
      // A settling run can start nothing, but a resumed one is tracked while
      // this is awaited, so the wait is a loop rather than one join.
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
};
