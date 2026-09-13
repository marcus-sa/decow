/**
 * What the server knows about a run — as a PROJECTION of the three tables in
 * `./store.ts`, never as a second copy of them.
 *
 * The previous cut kept this in a `Map` and said so out loud: everything
 * durable about a run was already durable somewhere better, and losing the map
 * cost a reader their scroll position rather than a fact. Both halves of that
 * were wrong. The engine's snapshot knows where a run stopped and not which
 * graph it was of; the journal knows what a step decided and not which run
 * decided it; the VCS log knows what changed and not why. The one table that
 * joined them was the map, so a restarted server showed no prior run at all and
 * a delivered pipeline step read `pending` again.
 *
 * So the database is the source of truth and this is a read of it:
 *
 *   status, input, terminal, suspension   the `runs` row
 *   trace                                 the run's `node-entered` events, in
 *                                         `seq` order, with the iteration
 *                                         counter derived by counting
 *   attempts                              its `leaf_attempts` rows
 *
 * The trace is DERIVED rather than stored, and that is the point of an
 * append-only event log: a node the run entered is an event it published, so
 * keeping a second list of them would be a cache of the log that could disagree
 * with it.
 *
 * THE RUN ID IS THE SERVER'S, and the engine's is recorded beside it. `run`
 * mints its own id and only hands it back when it stops, so a POST that must
 * answer with an id before the run has done anything has nothing to answer
 * with. The server therefore names the run itself, reports that name
 * everywhere, and stores the engine's id when the outcome arrives — which is
 * exactly when it is first needed, because the only thing it is needed FOR is
 * resuming a run that parked, including from a different process.
 */

import type { StepAttempt } from "@des/core/step";
import type { NodeId } from "@des/core/workflow";
import type { Json } from "./json.ts";
import type { ResumeOptions } from "./projection.ts";
import type { RunDatabase } from "./store.ts";

export const RUN_STATUSES = ["running", "suspended", "accepted", "rejected", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** One node visit, with which visit of that node it was. */
export type TraceEntry = { node: NodeId; iteration: number };

/** Where a parked run is and what it will accept. */
export type Suspension = {
  /** The suspend node it is sitting on, when the trace names one. */
  node?: NodeId;
  reason: string;
  trail: Json[];
  /** The closed enum a person answers from, off that node's own schema. */
  resume?: ResumeOptions;
};

export type RunRecord = {
  /** The server's own id, which is what every route and every event carries. */
  runId: string;
  workflowId: string;
  status: RunStatus;
  /** The validated input the run was started with. */
  input: Json;
  /** The nodes entered so far, in order, with their iteration counters. */
  trace: TraceEntry[];
  /** Every attempt of every leaf, as `runStep` reported it. */
  attempts: StepAttempt[];
  suspension?: Suspension;
  terminal?: { kind: "accepted" | "rejected"; trail?: Json[] };
  /** The message of the graph bug that ended the run, when one did. */
  error?: string;
  /** The engine's own run id, once the run has produced one. */
  engineRunId?: string;
};

/** A run as `listRuns` reports it: everything but the bulky fields. */
export type RunSummary = Omit<RunRecord, "trace" | "attempts" | "input"> & {
  /** How many nodes it has entered. */
  visited: number;
  /** How many leaf attempts it has made. */
  attempts: number;
};

export type RunStore = {
  start(spec: { runId: string; workflowId: string; input: Json }): void;
  get(runId: string): RunRecord | undefined;
  list(): RunSummary[];
  record(runId: string, attempt: StepAttempt): void;
  /** Update the run row. Everything absent is left alone. */
  settle(runId: string, patch: RunPatch): void;
  /** The database this is a projection of, for the pipeline's own reads. */
  readonly db: RunDatabase;
};

/** What a caller may change about a run. A subset of the record, by design. */
export type RunPatch = {
  status?: RunStatus;
  suspension?: Suspension;
  terminal?: { kind: "accepted" | "rejected"; trail?: Json[] };
  error?: string;
  engineRunId?: string;
  /** True when this patch is the run coming to rest. */
  settled?: boolean;
};

/** The node a `node-entered` event names. */
const enteredNode = (payload: Json): NodeId | undefined => {
  const node = (payload as { node?: unknown }).node;
  return typeof node === "string" ? node : undefined;
};

/**
 * The trace, read off the run's own `node-entered` events.
 *
 * The iteration counter is derived by counting rather than stored, because it
 * is a function of the events before it and a stored copy could disagree with
 * them. Exported because `traceEntries` over the ENGINE's trace is the same
 * arithmetic, and one definition is what keeps them from drifting.
 */
export const traceEntries = (trace: readonly NodeId[]): TraceEntry[] => {
  const seen = new Map<NodeId, number>();
  return trace.map((node) => {
    const iteration = (seen.get(node) ?? 0) + 1;
    seen.set(node, iteration);
    return { node, iteration };
  });
};

const STATUSES = new Set<string>(RUN_STATUSES);
const statusOf = (raw: string): RunStatus => (STATUSES.has(raw) ? (raw as RunStatus) : "failed");

export const openRuns = (db: RunDatabase): RunStore => {
  const traceOf = (runId: string): TraceEntry[] =>
    traceEntries(
      db.events
        .of(runId)
        .filter((event) => event.kind === "node-entered")
        .map((event) => enteredNode(event.payload))
        .filter((node): node is NodeId => node !== undefined),
    );

  return {
    db,

    start: ({ runId, workflowId, input }) => {
      db.runs.insert({ runId, workflowId, input, startedSeq: db.events.head() });
    },

    get: (runId) => {
      const stored = db.runs.get(runId);
      if (stored === undefined) return undefined;
      return {
        runId: stored.runId,
        workflowId: stored.workflowId,
        status: statusOf(stored.status),
        input: stored.input,
        trace: traceOf(runId),
        attempts: db.attempts.of(runId),
        ...(stored.suspension === undefined
          ? {}
          : { suspension: stored.suspension as unknown as Suspension }),
        ...(stored.terminal === undefined
          ? {}
          : { terminal: stored.terminal as unknown as RunRecord["terminal"] }),
        ...(stored.error === undefined ? {} : { error: stored.error }),
        ...(stored.engineRunId === undefined ? {} : { engineRunId: stored.engineRunId }),
      };
    },

    list: () =>
      db.runs.all().map((stored): RunSummary => {
        // A summary counts rather than materialises: a list of a hundred runs
        // must not read a hundred traces and a hundred attempt sets.
        const visited = db.events
          .of(stored.runId)
          .filter((event) => event.kind === "node-entered").length;
        return {
          runId: stored.runId,
          workflowId: stored.workflowId,
          status: statusOf(stored.status),
          ...(stored.suspension === undefined
            ? {}
            : { suspension: stored.suspension as unknown as Suspension }),
          ...(stored.terminal === undefined
            ? {}
            : { terminal: stored.terminal as unknown as RunRecord["terminal"] }),
          ...(stored.error === undefined ? {} : { error: stored.error }),
          ...(stored.engineRunId === undefined ? {} : { engineRunId: stored.engineRunId }),
          visited,
          attempts: db.attempts.countOf(stored.runId),
        };
      }),

    record: (runId, attempt) => {
      db.attempts.append(runId, attempt);
    },

    settle: (runId, patch) => {
      db.runs.update(runId, {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.engineRunId === undefined ? {} : { engineRunId: patch.engineRunId }),
        ...(patch.terminal === undefined ? {} : { terminal: patch.terminal as unknown as Json }),
        ...(patch.suspension === undefined
          ? {}
          : { suspension: patch.suspension as unknown as Json }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
        ...(patch.settled === true ? { settledSeq: db.events.head() } : {}),
      });
    },
  };
};
