/**
 * Runs, the events they published, and what every leaf attempt decided — in a
 * database, which is the source of truth the rest of this package projects.
 *
 * Runs, traces, attempts and events in maps would cost more than a reader's
 * scroll position, twice over: a restarted server would show no prior run at
 * all, and a pipeline step whose run had settled would read `pending` again,
 * so a second drive would deliver it a second time. The facts are on disk in
 * four other stores, and this is the one thing that joins them.
 *
 * A SIBLING FILE, not the artifact store's. `runs.sqlite` sits beside
 * `artifacts.sqlite` in the same run directory, and the reason is ownership
 * rather than taste: the artifact store is `@des/core`'s and holds the
 * CONSUMER's rows, whose table names arrive on an effect at run time; these
 * three tables are the SERVER's own and their schema is written here. Putting
 * them inside a store this package does not define would make one file's
 * migrations two packages' business, and `serve()` is handed an
 * `ArtifactStore` by consumers that need not have a run directory at all.
 * Nothing has to be atomic across the two, because no artifact write is part of
 * a run write.
 *
 * THREE TABLES, and what each one is for:
 *
 *   runs           ONE row per run, UPDATED as its status changes. It is the
 *                  current state and only that; its history is recoverable
 *                  from `run_events` between `started_seq` and `settled_seq`.
 *   run_events     APPEND-ONLY. Every event the bus published, in one total
 *                  order, which is also the trace: a run's `node-entered`
 *                  events in `seq` order ARE the nodes it entered, in order.
 *   leaf_attempts  APPEND-ONLY. One row per model call pair, as `runStep`
 *                  reported it, with what each call cost on the row that
 *                  spent it.
 *
 * No nondeterminism lives in this file. No `Date.now`, no `Math.random`, no
 * `randomUUID`. `seq` is the total order, so "later" is a number rather than a
 * clock reading — the same choice the VCS event log and the artifact store
 * both make.
 */

import { Database } from "bun:sqlite";
import type { StepAttempt } from "@des/core/step";
import type { Json } from "./json.ts";

/** One appended event, as it is stored. */
export type StoredEvent = {
  seq: number;
  /** Absent for a `pipeline-step` event about a step with no run yet. */
  runId?: string;
  kind: string;
  payload: Json;
};

/** One run row, as the store holds it. Every JSON column is already parsed. */
export type StoredRun = {
  runId: string;
  workflowId: string;
  engineRunId?: string;
  input: Json;
  status: string;
  terminal?: Json;
  suspension?: Json;
  error?: string;
  /** The `run_events` seq this run was started at. */
  startedSeq: number;
  /** The `run_events` seq it settled at, once it has. */
  settledSeq?: number;
};

/** What `runs` accepts on an update. Absent means "leave it alone". */
export type RunPatch = {
  status?: string;
  engineRunId?: string;
  terminal?: Json;
  suspension?: Json;
  error?: string;
  settledSeq?: number;
};

export type RunRows = {
  /** Insert a run at `running`, at the current event sequence. */
  insert(run: { runId: string; workflowId: string; input: Json; startedSeq: number }): void;
  update(runId: string, patch: RunPatch): void;
  get(runId: string): StoredRun | undefined;
  /** Every run, oldest first. */
  all(): StoredRun[];
};

export type EventRows = {
  /** Append one event and answer with the sequence it landed at. */
  append(event: { runId?: string; kind: string; payload: Json }): number;
  /** The sequence the next append will exceed. 0 on an empty log. */
  head(): number;
  /** Every event for one run, oldest first. */
  of(runId: string): StoredEvent[];
  /** Every event of one kind, oldest first. For the pipeline projection. */
  byKind(kind: string): StoredEvent[];
};

export type AttemptRows = {
  append(runId: string, attempt: StepAttempt): void;
  /** Every attempt of one run, in the order they were made. */
  of(runId: string): StepAttempt[];
  /** How many attempts one run has made, without materialising them. */
  countOf(runId: string): number;
};

export type RunDatabase = {
  runs: RunRows;
  events: EventRows;
  attempts: AttemptRows;
  close(): void;
};

export type RunDatabaseOptions = {
  /** One file per run directory. `":memory:"` for a server that keeps nothing. */
  path?: string;
};

type RunRow = {
  run_id: string;
  workflow_id: string;
  engine_run_id: string | null;
  input: string;
  status: string;
  terminal: string | null;
  suspension: string | null;
  error: string | null;
  started_seq: number;
  settled_seq: number | null;
};

type EventRow = { seq: number; run_id: string | null; kind: string; payload: string };

type AttemptRow = {
  run_id: string;
  step_id: string;
  version: number;
  journal_key: string;
  attempt: number;
  model_id: string;
  decision: string | null;
  accepted: number;
  verdict: string | null;
  violations: string;
  mechanical: string;
  error: string | null;
  worker_tokens: string | null;
  validator_tokens: string | null;
};

const json = (value: string | null): Json | undefined =>
  value === null ? undefined : (JSON.parse(value) as Json);

export const openRunDatabase = (options: RunDatabaseOptions = {}): RunDatabase => {
  const db = new Database(options.path ?? ":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");

  // One row per run, and the only table here that is updated in place. What it
  // held before is not lost: every transition also appended an event.
  db.run(`CREATE TABLE IF NOT EXISTS runs (
    run_id        TEXT PRIMARY KEY,
    workflow_id   TEXT NOT NULL,
    engine_run_id TEXT,
    input         TEXT NOT NULL,
    status        TEXT NOT NULL,
    terminal      TEXT,
    suspension    TEXT,
    error         TEXT,
    started_seq   INTEGER NOT NULL,
    settled_seq   INTEGER
  )`);

  // Append-only. `run_id` is nullable because one of the eight kinds —
  // `pipeline-step` — is about a step that may not have a run yet.
  db.run(`CREATE TABLE IF NOT EXISTS run_events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT,
    kind    TEXT NOT NULL,
    payload TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS run_events_by_run ON run_events (run_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS run_events_by_kind ON run_events (kind, seq)");

  // Append-only. `seq` orders attempts within a run, and the token columns
  // are what one call of one step of THIS run cost — exact, because `runStep`
  // attributes them to the attempt that made the call rather than draining a
  // queue in call order.
  db.run(`CREATE TABLE IF NOT EXISTS leaf_attempts (
    seq              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id           TEXT NOT NULL,
    step_id          TEXT NOT NULL,
    version          INTEGER NOT NULL,
    journal_key      TEXT NOT NULL,
    attempt          INTEGER NOT NULL,
    model_id         TEXT NOT NULL,
    decision         TEXT,
    accepted         INTEGER NOT NULL,
    verdict          TEXT,
    violations       TEXT NOT NULL,
    mechanical       TEXT NOT NULL,
    error            TEXT,
    worker_tokens    TEXT,
    validator_tokens TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS leaf_attempts_by_run ON leaf_attempts (run_id, seq)");

  const q = {
    insertRun: db.query<unknown, [string, string, string, number]>(
      "INSERT INTO runs (run_id, workflow_id, input, status, started_seq) VALUES (?, ?, ?, 'running', ?)",
    ),
    getRun: db.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?"),
    allRuns: db.query<RunRow, []>("SELECT * FROM runs ORDER BY started_seq"),

    appendEvent: db.query<unknown, [string | null, string, string]>(
      "INSERT INTO run_events (run_id, kind, payload) VALUES (?, ?, ?)",
    ),
    head: db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM run_events"),
    eventsOf: db.query<EventRow, [string]>(
      "SELECT * FROM run_events WHERE run_id = ? ORDER BY seq",
    ),
    eventsByKind: db.query<EventRow, [string]>(
      "SELECT * FROM run_events WHERE kind = ? ORDER BY seq",
    ),

    appendAttempt: db.query<
      unknown,
      [
        string,
        string,
        number,
        string,
        number,
        string,
        string | null,
        number,
        string | null,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
    >(
      `INSERT INTO leaf_attempts
         (run_id, step_id, version, journal_key, attempt, model_id, decision, accepted,
          verdict, violations, mechanical, error, worker_tokens, validator_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    attemptsOf: db.query<AttemptRow, [string]>(
      "SELECT * FROM leaf_attempts WHERE run_id = ? ORDER BY seq",
    ),
    countAttempts: db.query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM leaf_attempts WHERE run_id = ?",
    ),
  };

  const decodeRun = (row: RunRow): StoredRun => ({
    runId: row.run_id,
    workflowId: row.workflow_id,
    ...(row.engine_run_id === null ? {} : { engineRunId: row.engine_run_id }),
    input: JSON.parse(row.input) as Json,
    status: row.status,
    ...(row.terminal === null ? {} : { terminal: json(row.terminal) as Json }),
    ...(row.suspension === null ? {} : { suspension: json(row.suspension) as Json }),
    ...(row.error === null ? {} : { error: row.error }),
    startedSeq: row.started_seq,
    ...(row.settled_seq === null ? {} : { settledSeq: row.settled_seq }),
  });

  const decodeEvent = (row: EventRow): StoredEvent => ({
    seq: row.seq,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    kind: row.kind,
    payload: JSON.parse(row.payload) as Json,
  });

  const decodeAttempt = (row: AttemptRow): StepAttempt => ({
    stepId: row.step_id,
    version: row.version,
    key: row.journal_key,
    attempt: row.attempt,
    model: row.model_id,
    ...(row.decision === null ? {} : { decision: row.decision }),
    mechanical: JSON.parse(row.mechanical) as StepAttempt["mechanical"],
    ...(row.verdict === null ? {} : { verdict: row.verdict as "pass" | "fail" }),
    violations: JSON.parse(row.violations) as StepAttempt["violations"],
    ...(row.error === null ? {} : { error: row.error }),
    accepted: row.accepted === 1,
    ...(row.worker_tokens === null
      ? {}
      : { workerTokens: JSON.parse(row.worker_tokens) as StepAttempt["workerTokens"] }),
    ...(row.validator_tokens === null
      ? {}
      : { validatorTokens: JSON.parse(row.validator_tokens) as StepAttempt["validatorTokens"] }),
  });

  /**
   * One UPDATE per patch, built from the keys the caller supplied.
   *
   * Spelled out rather than generated from `Object.keys`, so the column names
   * in this file are a closed set a reader can check against the schema above.
   */
  const update = (runId: string, patch: RunPatch): void => {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.engineRunId !== undefined) set("engine_run_id", patch.engineRunId);
    if (patch.terminal !== undefined) set("terminal", JSON.stringify(patch.terminal));
    if (patch.suspension !== undefined) set("suspension", JSON.stringify(patch.suspension));
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.settledSeq !== undefined) set("settled_seq", patch.settledSeq);
    if (sets.length === 0) return;
    db.query(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = ?`).run(...values, runId);
  };

  return {
    runs: {
      insert: ({ runId, workflowId, input, startedSeq }) => {
        q.insertRun.run(runId, workflowId, JSON.stringify(input), startedSeq);
      },
      update,
      get: (runId) => {
        const row = q.getRun.get(runId);
        return row === null ? undefined : decodeRun(row);
      },
      all: () => q.allRuns.all().map(decodeRun),
    },

    events: {
      append: ({ runId, kind, payload }) => {
        q.appendEvent.run(runId ?? null, kind, JSON.stringify(payload));
        return Number(db.query<{ seq: number }, []>("SELECT last_insert_rowid() AS seq").get()?.seq ?? 0);
      },
      head: () => q.head.get()?.seq ?? 0,
      of: (runId) => q.eventsOf.all(runId).map(decodeEvent),
      byKind: (kind) => q.eventsByKind.all(kind).map(decodeEvent),
    },

    attempts: {
      append: (runId, attempt) => {
        q.appendAttempt.run(
          runId,
          attempt.stepId,
          attempt.version,
          attempt.key,
          attempt.attempt,
          attempt.model,
          attempt.decision ?? null,
          attempt.accepted ? 1 : 0,
          attempt.verdict ?? null,
          JSON.stringify(attempt.violations),
          JSON.stringify(attempt.mechanical),
          attempt.error ?? null,
          attempt.workerTokens === undefined ? null : JSON.stringify(attempt.workerTokens),
          attempt.validatorTokens === undefined ? null : JSON.stringify(attempt.validatorTokens),
        );
      },
      of: (runId) => q.attemptsOf.all(runId).map(decodeAttempt),
      countOf: (runId) => q.countAttempts.get(runId)?.n ?? 0,
    },

    close: () => db.close(),
  };
};
