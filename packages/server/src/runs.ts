/**
 * What the server knows about a run, and where it keeps it.
 *
 * In memory, deliberately. Everything durable about a run is already durable
 * somewhere better: the engine persists the snapshot a suspension resumes
 * from, the journal records what each step decided, the VCS event log records
 * what changed, and a pipeline's own projection records which row is where.
 * This holds the one thing none of them does — what a person watching right
 * now is looking at — and losing it on restart costs a reader their scroll
 * position rather than a fact.
 *
 * THE RUN ID IS THE SERVER'S, and the engine's is recorded beside it. `run`
 * mints its own id and only hands it back when it stops, so a POST that must
 * answer with an id before the run has done anything has nothing to answer
 * with. The server therefore names the run itself, reports that name
 * everywhere, and stores the engine's id when the outcome arrives — which is
 * exactly when it is first needed, because the only thing it is needed FOR is
 * resuming a run that parked.
 */

import type { StepAttempt } from "@des/core/step";
import type { NodeId } from "@des/core/workflow";
import type { Json } from "./json.ts";
import type { ResumeOptions } from "./projection.ts";

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
  start(spec: { runId: string; workflowId: string; input: Json }): RunRecord;
  get(runId: string): RunRecord | undefined;
  list(): RunSummary[];
  /** Append a node the run just entered, with its iteration counter. */
  entered(runId: string, node: NodeId): TraceEntry | undefined;
  record(runId: string, attempt: StepAttempt): void;
  /** Replace the live trace with the engine's own, which is authoritative. */
  settle(runId: string, patch: Partial<RunRecord>): void;
};

const summarize = (run: RunRecord): RunSummary => {
  const { trace, attempts, input: _input, ...rest } = run;
  return { ...rest, visited: trace.length, attempts: attempts.length };
};

export const openRuns = (): RunStore => {
  const runs = new Map<string, RunRecord>();

  return {
    start: ({ runId, workflowId, input }) => {
      const record: RunRecord = {
        runId,
        workflowId,
        status: "running",
        input,
        trace: [],
        attempts: [],
      };
      runs.set(runId, record);
      return record;
    },

    get: (runId) => runs.get(runId),

    list: () => [...runs.values()].map(summarize),

    entered: (runId, node) => {
      const run = runs.get(runId);
      if (run === undefined) return undefined;
      const iteration = run.trace.filter((entry) => entry.node === node).length + 1;
      const entry: TraceEntry = { node, iteration };
      run.trace.push(entry);
      return entry;
    },

    record: (runId, attempt) => {
      runs.get(runId)?.attempts.push(attempt);
    },

    settle: (runId, patch) => {
      const run = runs.get(runId);
      if (run === undefined) return;
      Object.assign(run, patch);
    },
  };
};

/**
 * The engine's trace, with each entry's iteration counter.
 *
 * The live trace is accumulated from node events as they arrive; this is the
 * same thing read off the finished run, and it is the one that wins. They
 * agree in every case observed so far, and when they do not the engine's own
 * record of where it went is not something the server should be arguing with.
 */
export const traceEntries = (trace: readonly NodeId[]): TraceEntry[] => {
  const seen = new Map<NodeId, number>();
  return trace.map((node) => {
    const iteration = (seen.get(node) ?? 0) + 1;
    seen.set(node, iteration);
    return { node, iteration };
  });
};
