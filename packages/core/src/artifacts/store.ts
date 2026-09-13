/**
 * Artifact rows, in a real database.
 *
 * The design's "artifacts are typed rows, not documents" says what this has to
 * be: a version column on every row, an append-only event log for provenance,
 * and a schema a zod type can be derived from so the step output type and the
 * row type are one definition. The last of those belongs to the consumer — a
 * `RoadmapStep` is both — so what lives here is the first two plus the
 * optimistic concurrency the `upsert-artifact` effect already declares.
 *
 * ONE GENERIC TABLE, keyed by `(table, id)`, rather than one SQL table per
 * artifact table name. The name is DATA: it arrives on the effect at run time
 * (`{ type: "upsert-artifact", table, id, … }`), so a table per name would mean
 * running DDL built from a string the graph supplied, on every first write to a
 * name nobody had used yet. That is a migration per artifact kind and an
 * injection surface for nothing: the rows are opaque JSON bodies with a
 * version, and no query here reads inside one. A composite primary key gives
 * the same isolation between kinds with no DDL after `open`.
 *
 * Time travel is the event log rather than a history table. Every accepted
 * upsert appends `(table, id, version, body)`, so `at(table, id, version)` is a
 * point read and `read` is the latest. The log is append-only: nothing updates
 * or deletes a row of it, which is what makes it provenance rather than a
 * cache of the current state.
 *
 * This module knows nothing about effects, workflows, or the VCS. It is a
 * store: `src/core/effects.ts` and `src/vcs/executor.ts` both route
 * `upsert-artifact` to it, and it imports neither.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. The version column is the ordering, and the event
 * log's sequence number is the total order, so nothing here reads a clock.
 */

import { Database } from "bun:sqlite";

/** One row as it stands: the body it holds and the version it is at. */
export type ArtifactRow = { version: number; row: unknown };

/** One row of `list`, with the id it was stored under. */
export type ListedArtifact = { id: string; version: number; row: unknown };

/** One accepted upsert. Append-only, and the whole of the time-travel index. */
export type ArtifactEvent = {
  seq: number;
  table: string;
  id: string;
  /** The version this upsert produced. */
  version: number;
  row: unknown;
};

/**
 * The result of an upsert. Deliberately the shape of `EffectResult`'s two
 * relevant members, so the executors map one onto the other without
 * interpreting anything.
 */
export type UpsertResult =
  | { outcome: "committed"; version: number }
  | { outcome: "conflict"; currentVersion: number };

export type UpsertSpec = {
  table: string;
  id: string;
  /**
   * The version the caller believes the row is at. 0 for a row that does not
   * exist yet, which is what makes "create" and "update" one operation with
   * one concurrency rule.
   */
  expectedVersion: number;
  row: unknown;
};

export type ArtifactStore = {
  /**
   * Write a row if the caller's `expectedVersion` is the version it is
   * actually at. A mismatch is `conflict` carrying the current version, never
   * an exception: the effect executor turns it into a decision value and a
   * branch routes it.
   *
   * The row and its event land in one transaction. A reader that sees version
   * N therefore also sees the event that produced N, which is what lets `at`
   * be trusted as history rather than as a best effort.
   */
  upsert(spec: UpsertSpec): UpsertResult;
  /** The row as it stands, or `undefined` if nothing was ever written. */
  read(table: string, id: string): ArtifactRow | undefined;
  /** Every live row of one table, by id. */
  list(table: string): ListedArtifact[];
  /** The body this row held at that version, or `undefined`. */
  at(table: string, id: string, version: number): unknown | undefined;
  /** The append-only log, oldest first, optionally narrowed to one table. */
  events(table?: string): ArtifactEvent[];
  close(): void;
};

export type ArtifactStoreOptions = {
  /** One database per consumer. `":memory:"` in tests. */
  path?: string;
};

type Row = { version: number; body: string };
type Listed = { id: string; version: number; body: string };
type EventRow = { seq: number; tbl: string; id: string; version: number; body: string };

export const openArtifacts = (options: ArtifactStoreOptions = {}): ArtifactStore => {
  const db = new Database(options.path ?? ":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");

  // `tbl` rather than `table`, which is reserved. The column holds the
  // artifact table NAME; the SQL table is one for all of them.
  db.run(`CREATE TABLE IF NOT EXISTS artifacts (
    tbl     TEXT NOT NULL,
    id      TEXT NOT NULL,
    version INTEGER NOT NULL,
    body    TEXT NOT NULL,
    PRIMARY KEY (tbl, id)
  )`);

  // Append-only. `seq` is the total order, so "later" is a number rather than
  // a clock reading — the same choice the VCS event log makes.
  db.run(`CREATE TABLE IF NOT EXISTS artifact_events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl     TEXT NOT NULL,
    id      TEXT NOT NULL,
    version INTEGER NOT NULL,
    body    TEXT NOT NULL
  )`);

  const q = {
    read: db.query<Row, [string, string]>("SELECT version, body FROM artifacts WHERE tbl = ? AND id = ?"),
    list: db.query<Listed, [string]>(
      "SELECT id, version, body FROM artifacts WHERE tbl = ? ORDER BY id",
    ),
    write: db.query<unknown, [string, string, number, string]>(
      "INSERT OR REPLACE INTO artifacts (tbl, id, version, body) VALUES (?, ?, ?, ?)",
    ),
    event: db.query<unknown, [string, string, number, string]>(
      "INSERT INTO artifact_events (tbl, id, version, body) VALUES (?, ?, ?, ?)",
    ),
    at: db.query<{ body: string }, [string, string, number]>(
      "SELECT body FROM artifact_events WHERE tbl = ? AND id = ? AND version = ?",
    ),
    events: db.query<EventRow, []>("SELECT * FROM artifact_events ORDER BY seq"),
    eventsOf: db.query<EventRow, [string]>(
      "SELECT * FROM artifact_events WHERE tbl = ? ORDER BY seq",
    ),
  };

  /** The row and its event, in one transaction. Neither lands without the other. */
  const commit = db.transaction((table: string, id: string, version: number, body: string) => {
    q.write.run(table, id, version, body);
    q.event.run(table, id, version, body);
  });

  const decode = (event: EventRow): ArtifactEvent => ({
    seq: event.seq,
    table: event.tbl,
    id: event.id,
    version: event.version,
    row: JSON.parse(event.body) as unknown,
  });

  return {
    upsert({ table, id, expectedVersion, row }) {
      const current = q.read.get(table, id);
      const currentVersion = current?.version ?? 0;
      if (expectedVersion !== currentVersion) return { outcome: "conflict", currentVersion };
      const version = currentVersion + 1;
      commit(table, id, version, JSON.stringify(row));
      return { outcome: "committed", version };
    },

    read(table, id) {
      const found = q.read.get(table, id);
      return found === null ? undefined : { version: found.version, row: JSON.parse(found.body) as unknown };
    },

    list: (table) =>
      q.list.all(table).map((r) => ({ id: r.id, version: r.version, row: JSON.parse(r.body) as unknown })),

    at(table, id, version) {
      const found = q.at.get(table, id, version);
      return found === null ? undefined : (JSON.parse(found.body) as unknown);
    },

    events: (table) => (table === undefined ? q.events.all() : q.eventsOf.all(table)).map(decode),

    close: () => db.close(),
  };
};
