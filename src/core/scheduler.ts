/**
 * The scheduler. Rows in, the frontier runs, the statuses come back.
 *
 * DELIVER is sequential today because one big model holds one context and one
 * linear log. Sequencing is a property of the executor, not of the work: once
 * the roadmap is a DAG in rows, the frontier is every row whose dependencies
 * are all `accepted`, and the frontier runs concurrently.
 *
 * Generic on purpose. A row is `{ id, dependencies }` and nothing else; what a
 * row MEANS, where it is read from, and what its run does are the consumer's
 * (`src/examples/nwave/deliver/pipeline.ts`). This file owns the frontier, the
 * concurrency limit, the resource leases, and termination.
 *
 * STATE IS A PROJECTION. The scheduler persists nothing of its own: it asks
 * `statusOf` for every row's status, reports each finished run through
 * `record`, and re-reads. That is nwave-experimental's `delivery_state.py`
 * stance — the next step is DERIVED from persisted facts and never decided —
 * and the consequence is the useful part: a scheduler that died mid-feature
 * restarts by reading rather than by remembering, and a row in flight has
 * nothing persisted so it simply reads `pending` and is run again.
 *
 * A `rejected` or `suspended` row blocks only its dependents, and that falls
 * out of the frontier rule rather than being enforced: a dependent of a row
 * that is not `accepted` never becomes ready, and every row not downstream of
 * it keeps running. A person's queue is therefore a list of independent
 * blocked subtrees.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { RunOutcome } from "./workflow.ts";

/** A row the scheduler orders. Everything else about it is the consumer's. */
export type SchedulerRow = { id: string; dependencies: string[] };

/**
 * What a row's status can be, as the projection reports it.
 *
 * `pending` covers both "never run" and "running right now", deliberately:
 * nothing is persisted until a run finishes, so the two are indistinguishable
 * to a reader and the honest thing to do with an unfinished run is to run it.
 * The scheduler knows which of its own rows are in flight and does not start
 * them twice; a SECOND scheduler on the same rows would, which is why
 * `record` is the consumer's place to refuse that.
 */
export const ROW_STATUSES = ["pending", "accepted", "rejected", "suspended"] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

/**
 * Named resources a run needs exclusively — a VM, a kernel table, a port.
 *
 * `acquire` takes the whole set at once and resolves when every name is free,
 * so two rows that share one serialize on it and two rows that share none do
 * not. Taking the set atomically is what makes that deadlock-free: a caller
 * never holds one name while waiting for another.
 */
export type ResourceLeases = {
  /** Take every name, then release with the returned function. */
  acquire(names: readonly string[]): Promise<() => void>;
};

/**
 * The in-memory implementation. FIFO among waiters, so which of two blocked
 * rows goes first is a function of the order they asked rather than of timing.
 */
export const inMemoryLeases = (): ResourceLeases => {
  const held = new Set<string>();
  const waiting: { names: readonly string[]; grant: () => void }[] = [];

  const free = (names: readonly string[]): boolean => names.every((name) => !held.has(name));

  /** Grant the first waiter that can now be satisfied, if any. */
  const pump = (): void => {
    const next = waiting.findIndex((w) => free(w.names));
    if (next < 0) return;
    const [waiter] = waiting.splice(next, 1);
    if (waiter === undefined) return;
    for (const name of waiter.names) held.add(name);
    waiter.grant();
  };

  const release = (names: readonly string[]) => (): void => {
    for (const name of names) held.delete(name);
    pump();
  };

  return {
    acquire: (names) =>
      new Promise((resolve) => {
        if (names.length === 0) {
          resolve(() => {});
          return;
        }
        if (free(names)) {
          for (const name of names) held.add(name);
          resolve(release(names));
          return;
        }
        waiting.push({ names, grant: () => resolve(release(names)) });
      }),
  };
};

export type SchedulerSpec<S> = {
  rows: readonly SchedulerRow[];
  /** Run one row to a terminal or a suspension. */
  runOne: (row: SchedulerRow) => Promise<RunOutcome<S>>;
  /** Continue a parked row with a person's answer. */
  resumeOne: (row: SchedulerRow, runId: string, answer: unknown) => Promise<RunOutcome<S>>;
  /** The row's status, as the consumer's own projection reports it. */
  statusOf: (rowId: string) => Promise<RowStatus>;
  /** Record a finished run, so `statusOf` will report it. */
  record: (rowId: string, outcome: RunOutcome<S>) => Promise<void>;
  /** How many rows may be in flight at once. At least 1. */
  concurrency: number;
  /** Named resources the row's run needs exclusively. */
  resourcesFor?: (row: SchedulerRow) => string[];
  leases?: ResourceLeases;
};

export type Scheduler = {
  /** Run until no row is ready and none is in flight. Returns every status. */
  run(): Promise<Map<string, RowStatus>>;
  /**
   * Continue a parked row and re-evaluate the frontier, so the rows that were
   * waiting on it run in the same call.
   */
  resume(rowId: string, answer: unknown): Promise<Map<string, RowStatus>>;
  /** The run id a parked row is waiting under, for a caller that wants it. */
  parked(): Map<string, string>;
};

export const openScheduler = <S>(spec: SchedulerSpec<S>): Scheduler => {
  if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1) {
    throw new Error(`scheduler: concurrency must be a positive integer, not ${String(spec.concurrency)}`);
  }

  const byId = new Map(spec.rows.map((row) => [row.id, row] as const));
  /** The last known status per row. Re-read from the projection, never cached across a run. */
  const statuses = new Map<string, RowStatus>();
  /** The run id each parked row is waiting under. In memory: one scheduler, one process. */
  const waiting = new Map<string, string>();

  const refresh = async (): Promise<void> => {
    for (const row of spec.rows) statuses.set(row.id, await spec.statusOf(row.id));
  };

  /** Rows whose every dependency is accepted and which are not already going. */
  const ready = (running: ReadonlySet<string>): SchedulerRow[] =>
    spec.rows.filter(
      (row) =>
        statuses.get(row.id) === "pending" &&
        !running.has(row.id) &&
        row.dependencies.every((id) => statuses.get(id) === "accepted"),
    );

  /** One row's run, under its resource leases if it declared any. */
  const drive = async (row: SchedulerRow): Promise<void> => {
    const names = spec.resourcesFor?.(row) ?? [];
    const release = spec.leases === undefined ? undefined : await spec.leases.acquire(names);
    try {
      const outcome = await spec.runOne(row);
      await spec.record(row.id, outcome);
      if (outcome.kind === "suspended") waiting.set(row.id, outcome.runId);
      else waiting.delete(row.id);
    } finally {
      release?.();
    }
  };

  /**
   * Run to quiescence.
   *
   * A `runOne` that THROWS is a graph bug and is not absorbed: everything a
   * graph decides is data, so a throw means the graph itself is malformed and
   * swallowing it would hide that behind a status. The in-flight promises all
   * carry handlers, so the throw propagates without leaving an unhandled
   * rejection behind it.
   */
  const loop = async (): Promise<Map<string, RowStatus>> => {
    await refresh();
    const running = new Map<string, Promise<{ id: string; error?: unknown }>>();

    for (;;) {
      while (running.size < spec.concurrency) {
        const next = ready(new Set(running.keys()))[0];
        if (next === undefined) break;
        running.set(
          next.id,
          drive(next).then(
            () => ({ id: next.id }),
            (error: unknown) => ({ id: next.id, error }),
          ),
        );
      }

      if (running.size === 0) return new Map(statuses);

      const done = await Promise.race([...running.values()]);
      running.delete(done.id);
      if (done.error !== undefined) throw done.error;
      // The projection is the source of truth, so it is re-read rather than
      // updated from the outcome the run returned.
      await refresh();
    }
  };

  return {
    run: loop,

    resume: async (rowId, answer) => {
      const row = byId.get(rowId);
      if (row === undefined) throw new Error(`scheduler: no row ${rowId}`);
      const runId = waiting.get(rowId);
      if (runId === undefined) {
        throw new Error(`scheduler: row ${rowId} is not parked, so there is no run to resume`);
      }
      const outcome = await spec.resumeOne(row, runId, answer);
      await spec.record(rowId, outcome);
      if (outcome.kind === "suspended") waiting.set(rowId, outcome.runId);
      else waiting.delete(rowId);
      // Re-evaluate the frontier: the rows that were waiting on this one run
      // in the same call, which is what makes a resume a continuation of the
      // feature rather than of one row.
      return await loop();
    },

    parked: () => new Map(waiting),
  };
};
