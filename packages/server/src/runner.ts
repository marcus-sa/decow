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
 * scheduler is what that is for: a step's run is an ordinary run, so the
 * scheduler starts one and awaits it exactly as it awaited a `run()` call,
 * while the person watching gets the id, the trace and the events for free.
 *
 * NOTHING ABOUT A RUN IS HELD IN THIS MODULE. The graph a run was built with
 * is rebuilt from its registration, and the input it was started with is read
 * back off its row — so `resume` works in a process that never started the run.
 * That is the whole reason the run row carries its input and the engine's id:
 * with the snapshot on libSQL and the row in `runs.sqlite`, a suspension one
 * process produced is answerable by the next one over the same directory.
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
import { asJson } from "./json.ts";
import { parkedAt, resumeOptionsOf } from "./projection.ts";
import type { AnyWorkflowRegistration } from "./registration.ts";
import type { RunStore } from "./runs.ts";

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
  /**
   * The graph a run was built with, rebuilt from its registration so a resume
   * can parse the answer. `undefined` when there is no such run.
   */
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

  /**
   * The graph one run is of, built fresh over its registration.
   *
   * Fresh rather than held, and that is what makes a restart resumable: the
   * compilation is a pure function of the graph, so a graph rebuilt in a
   * different process compiles to the same step ids the persisted snapshot was
   * written under.
   */
  const buildGraph = (
    registration: AnyWorkflowRegistration,
    runId: string,
  ): Workflow<unknown> =>
    registration.graph({
      journal: registration.journal,
      observe: observerFor(registration, runId),
    });

  /** The registration a run is of, or `undefined` when neither is known. */
  const registrationOf = (runId: string): AnyWorkflowRegistration | undefined => {
    const record = runs.get(runId);
    return record === undefined ? undefined : byId.get(record.workflowId);
  };

  /**
   * Watch one run, appending a `node-entered` per node it enters.
   *
   * `reentering` is the suspend node a RESUME re-executes, and it is dropped
   * once. Resuming a parked run runs that step a second time — that is how the
   * answer is delivered — but it is the same visit, which is why the compiled
   * step appends to the engine's trace only on the pass that suspended. The
   * log says what the trace says, or one of them is lying.
   */
  const watcherFor =
    (runId: string, reentering?: NodeId): RunWatcher => {
    let reentered = false;
    return (event) => {
      if (event.kind === "node-entered" && !reentered && event.node === reentering) {
        reentered = true;
        return;
      }
      if (event.kind === "node-left") {
        events.emit({ type: "node-left", runId, node: event.node });
        return;
      }
      // The iteration counter is the count of this node's prior entries in
      // the log, which is what the trace projection counts too — one rule,
      // applied twice, so the event and the record cannot disagree.
      const before = runs.db.events
        .of(runId)
        .filter(
          (stored) =>
            stored.kind === "node-entered" &&
            (stored.payload as { node?: unknown }).node === event.node,
        ).length;
      events.emit({ type: "node-entered", runId, node: event.node, iteration: before + 1 });
    };
  };

  /**
   * Fold a finished run into its record and say so.
   *
   * The engine's own trace is not written back: the run's `node-entered`
   * events ARE the trace, and they were appended as they happened. Keeping the
   * log as the one that answers is what stops a second copy drifting from
   * it.
   */
  const settle = (runId: string, graph: Workflow<unknown>, outcome: RunOutcome<unknown>): void => {
    if (outcome.kind === "suspended") {
      const node: NodeId | undefined = parkedAt(graph, outcome.trace);
      const parked = node === undefined ? undefined : graph.nodes[node];
      const suspension = {
        ...(node === undefined ? {} : { node }),
        reason: outcome.reason,
        // The trail is on its way to a person, through a serializer.
        trail: outcome.trail.map(asJson),
        ...(parked?.type === "suspend" ? { resume: resumeOptionsOf(parked.resumeSchema) } : {}),
      };
      runs.settle(runId, {
        status: "suspended",
        suspension,
        engineRunId: outcome.runId,
        settled: true,
      });
      events.emit({ type: "suspended", runId, suspension });
      return;
    }
    const terminal = outcome.terminal;
    runs.settle(runId, {
      status: terminal.kind,
      terminal:
        terminal.kind === "rejected"
          ? { kind: "rejected", trail: terminal.trail.map(asJson) }
          : { kind: "accepted" },
      engineRunId: outcome.runId,
      settled: true,
    });
    events.emit({ type: "terminal", runId, kind: terminal.kind });
  };

  /**
   * A run that threw. Everything a graph DECIDES is data, so a throw is a
   * graph bug: it is recorded as one, under a status the declared endings do
   * not use, rather than flattened into `rejected`.
   */
  const fail = (runId: string, error: unknown): void => {
    runs.settle(runId, { status: "failed", error: String(error), settled: true });
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
      runs.start({ runId, workflowId: registration.id, input: asJson(input) });
      events.emit({ type: "run-started", runId, workflowId: registration.id });

      const graph = buildGraph(registration, runId);

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

    graphOf: (runId) => {
      const registration = registrationOf(runId);
      return registration === undefined ? undefined : buildGraph(registration, runId);
    },

    resume: (runId, answer) => {
      const record = runs.get(runId);
      const registration = registrationOf(runId);
      if (record === undefined || registration === undefined) return undefined;
      const engineRunId = record.engineRunId;
      if (engineRunId === undefined) return undefined;

      // The input is read back off the row and re-parsed by the registration's
      // own schema, so a resume in a fresh process builds the same executor
      // over the same facts the run was started with.
      const parsed = registration.input.safeParse(record.input);
      if (!parsed.success) return undefined;

      const graph = buildGraph(registration, runId);
      const parkedOn = record.suspension?.node;
      runs.settle(runId, { status: "running" });
      events.emit({ type: "resumed", runId, answer });

      return drive(runId, graph, () =>
        resumeRun<unknown>(
          graph,
          engineRunId,
          answer,
          registration.executor({ runId, input: parsed.data }),
          registration.runtime ?? runtime,
          watcherFor(runId, parkedOn),
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
