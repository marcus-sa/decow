/**
 * The event log (ai-vcs.md § 4.4).
 *
 * Append-only, totally ordered, durable. Each row records one observation
 * about the codebase, carries the intent metadata under which it happened, and
 * links to the lease it happened under. Nothing updates a row and nothing
 * deletes one; a symbol that goes away gets a `symbol-deleted` event and keeps
 * its id forever (§ 4.3).
 *
 * The total order is sqlite's own rowid, so "later" is a number rather than a
 * clock reading. That is what lets the whole module run with an injected clock
 * and still order events: ordering is the log's, not the wall's.
 *
 * A multi-symbol change is its child events followed by a `transaction` event
 * naming their sequence numbers. The parent is appended last, so a reader that
 * sees the transaction knows every child is already in the log. That is the
 * atomic-commit semantics § 4.4 asks for, on the log itself.
 *
 * Three queries carry the capabilities the document claims over a commit
 * graph: `history` is blame at symbol granularity, `at` is a time-travel read,
 * and `byTask` is provenance by task id.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import type { Database } from "bun:sqlite";
import type { FailureCategory, VerificationStatus } from "./verify.ts";

export const EVENT_KINDS = [
  "file-tracked",
  "symbol-created",
  "symbol-modified",
  "symbol-renamed",
  "symbol-deleted",
  "transaction",
  "write-failed",
  "lease-acquired",
  "lease-released",
  "lease-expired",
  "release-failed",
  "tests-run",
  "trail",
  "desync-detected",
  "external-imported",
  "external-rejected",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * The intent payload every mutating call carries (§ 4.5). It is a contract
 * validated at the boundary, not a comment: `expectedOutcome` is checked
 * against the symbols the call actually touched, and a divergence is a
 * contract violation before any work is committed.
 */
export type Intent = {
  taskId: string;
  parentTaskId?: string;
  /** Required, and bounded: see `DESCRIPTION_MAX`. */
  description: string;
  expectedOutcome: ExpectedOutcome;
};

/** What the caller says will be true afterwards, in symbol ids. */
export type ExpectedOutcome = {
  modified?: readonly string[];
  created?: readonly string[];
  tombstoned?: readonly string[];
};

/** § 4.5: "Required, but bounded in length". */
export const DESCRIPTION_MAX = 500;

export type Event = {
  /** The total order. Assigned by the log, never by a caller. */
  seq: number;
  kind: EventKind;
  symbolId?: string;
  fileId?: string;
  leaseId?: string;
  /** Intent metadata. Absent on an external import, deliberately (§ 9.1). */
  taskId?: string;
  parentTaskId?: string;
  description?: string;
  /** Set only on an external import: the channel the change arrived through. */
  sourceChannel?: string;
  /** The symbol's version after this event. */
  version?: number;
  /** § 6.3: every write has a verification status, queryable from here. */
  verification?: VerificationStatus;
  /** Which of § 5.4's three categories a failure falls into. */
  category?: FailureCategory;
  /** The symbol's full text as of this event, which is what `at` reads. */
  body?: string;
  /** The child sequence numbers, on a `transaction` event. */
  children?: readonly number[];
  detail?: string;
};

export type EventLog = {
  append(event: Omit<Event, "seq">): number;
  all(): Event[];
  /** Every event touching one symbol, oldest first. Blame at symbol grain. */
  history(symbolId: string): Event[];
  /**
   * The symbol's text as of `seq`. `undefined` when the symbol did not exist
   * then, or had already been tombstoned.
   */
  at(symbolId: string, seq: number): string | undefined;
  /** Every event for a task, across every symbol it touched. */
  byTask(taskId: string): Event[];
  /**
   * Every event that happened under one lease. § 4.4 links events to the lease
   * they occurred under, and release reads that link back to compare what the
   * lease declared against what it did (§ 5.4).
   */
  byLease(leaseId: string): Event[];
};

type Row = {
  seq: number;
  kind: string;
  symbol_id: string | null;
  file_id: string | null;
  lease_id: string | null;
  task_id: string | null;
  parent_task_id: string | null;
  description: string | null;
  source_channel: string | null;
  version: number | null;
  verification: string | null;
  category: string | null;
  body: string | null;
  children: string | null;
  detail: string | null;
};

const decode = (row: Row): Event => ({
  seq: row.seq,
  kind: row.kind as EventKind,
  ...(row.symbol_id === null ? {} : { symbolId: row.symbol_id }),
  ...(row.file_id === null ? {} : { fileId: row.file_id }),
  ...(row.lease_id === null ? {} : { leaseId: row.lease_id }),
  ...(row.task_id === null ? {} : { taskId: row.task_id }),
  ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
  ...(row.description === null ? {} : { description: row.description }),
  ...(row.source_channel === null ? {} : { sourceChannel: row.source_channel }),
  ...(row.version === null ? {} : { version: row.version }),
  ...(row.verification === null ? {} : { verification: row.verification as VerificationStatus }),
  ...(row.category === null ? {} : { category: row.category as FailureCategory }),
  ...(row.body === null ? {} : { body: row.body }),
  ...(row.children === null ? {} : { children: JSON.parse(row.children) as number[] }),
  ...(row.detail === null ? {} : { detail: row.detail }),
});

/** Events after which the symbol's text is `body`, and the one after which it is gone. */
const BODY_BEARING = new Set<EventKind>(["symbol-created", "symbol-modified", "symbol-renamed"]);

export const openEventLog = (db: Database): EventLog => {
  db.run(`CREATE TABLE IF NOT EXISTS events (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL,
    symbol_id       TEXT,
    file_id         TEXT,
    lease_id        TEXT,
    task_id         TEXT,
    parent_task_id  TEXT,
    description     TEXT,
    source_channel  TEXT,
    version         INTEGER,
    verification    TEXT,
    category        TEXT,
    body            TEXT,
    children        TEXT,
    detail          TEXT
  )`);
  db.run("CREATE INDEX IF NOT EXISTS events_symbol ON events (symbol_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq)");
  db.run("CREATE INDEX IF NOT EXISTS events_lease ON events (lease_id, seq)");

  const insert = db.query<{ seq: number }, (string | number | null)[]>(
    `INSERT INTO events
       (kind, symbol_id, file_id, lease_id, task_id, parent_task_id, description,
        source_channel, version, verification, category, body, children, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING seq`,
  );
  const selectAll = db.query<Row, []>("SELECT * FROM events ORDER BY seq");
  const selectSymbol = db.query<Row, [string]>("SELECT * FROM events WHERE symbol_id = ? ORDER BY seq");
  const selectTask = db.query<Row, [string]>("SELECT * FROM events WHERE task_id = ? ORDER BY seq");
  const selectLease = db.query<Row, [string]>("SELECT * FROM events WHERE lease_id = ? ORDER BY seq");

  return {
    append(event) {
      const row = insert.get(
        event.kind,
        event.symbolId ?? null,
        event.fileId ?? null,
        event.leaseId ?? null,
        event.taskId ?? null,
        event.parentTaskId ?? null,
        event.description ?? null,
        event.sourceChannel ?? null,
        event.version ?? null,
        event.verification ?? null,
        event.category ?? null,
        event.body ?? null,
        event.children === undefined ? null : JSON.stringify(event.children),
        event.detail ?? null,
      );
      if (row === null) throw new Error("event log: INSERT … RETURNING produced no row");
      return row.seq;
    },
    all: () => selectAll.all().map(decode),
    history: (symbolId) => selectSymbol.all(symbolId).map(decode),
    at(symbolId, seq) {
      let body: string | undefined;
      for (const event of selectSymbol.all(symbolId).map(decode)) {
        if (event.seq > seq) break;
        if (event.kind === "symbol-deleted") body = undefined;
        else if (BODY_BEARING.has(event.kind) && event.body !== undefined) body = event.body;
      }
      return body;
    },
    byTask: (taskId) => selectTask.all(taskId).map(decode),
    byLease: (leaseId) => selectLease.all(leaseId).map(decode),
  };
};
