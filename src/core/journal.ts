/**
 * Keyed by (step id, step version, input hash). A hit returns the stored
 * StepResult and the model is never called. This is what makes a workflow
 * replayable: rerun it against the same journal and the trajectory is
 * identical, byte for byte, with zero inference.
 *
 * The journal answers "what did each step decide". It is not the provenance
 * log for code changes; that lives in the VCS event log, linked one way.
 */

import { Database } from "bun:sqlite";

export interface Journal {
  get<O>(key: string): Promise<O | undefined>;
  put<O>(key: string, value: O): Promise<void>;
}

/** Journal keys are `<step id>@<version>:<input hash>`. */
export const stepIdFromKey = (key: string): string => key.split("@")[0] ?? key;

export const memoryJournal = (seed: Record<string, unknown> = {}): Journal => {
  const rows = new Map<string, unknown>(Object.entries(seed));
  return {
    async get<O>(key: string) {
      return rows.get(key) as O | undefined;
    },
    async put<O>(key: string, value: O) {
      rows.set(key, value);
    },
  };
};

/**
 * Persistent journal on bun:sqlite. One row per (step, version, input hash);
 * the value is the JSON-encoded StepResult. Writes are `INSERT OR REPLACE` so
 * a re-put of the same key is idempotent.
 *
 * `path` may be ":memory:" for a transient database with the same code path.
 */
export const sqliteJournal = (path: string): Journal & { close: () => void } => {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE IF NOT EXISTS journal (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const select = db.query<{ value: string }, [string]>("SELECT value FROM journal WHERE key = ?");
  const insert = db.query<unknown, [string, string]>(
    "INSERT OR REPLACE INTO journal (key, value) VALUES (?, ?)",
  );

  return {
    async get<O>(key: string) {
      const row = select.get(key);
      return row === null ? undefined : (JSON.parse(row.value) as O);
    },
    async put<O>(key: string, value: O) {
      insert.run(key, JSON.stringify(value));
    },
    close: () => db.close(),
  };
};
