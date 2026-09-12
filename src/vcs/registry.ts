/**
 * The symbol identity registry (ai-vcs.md § 4.3, § 3.2, § 9.1).
 *
 * The registry assigns an opaque id to each symbol on first observation and
 * keeps it forever. The id travels through renames, moves and body edits
 * because a *declared* operation said so, and never because two symbols looked
 * alike. Deleted symbols are tombstoned rather than removed, so a historical
 * event referencing one stays interpretable. Files are tracked the same way.
 *
 * Identity inside a file is the identity key: kind, container path, name.
 * Never the content hash. That is the whole of § 9.1's rejection of
 * structural-similarity inference, and it is why a symbol that disappears
 * without a declaration is a desync rather than a guess.
 *
 * Desync is the conservative default the document chooses. A file whose bytes
 * on disk differ from the registry's last-known content was changed by a
 * channel that declared nothing, so the file is marked desynced, new leases on
 * its symbols are refused, and the divergence is held until an operator
 * imports it under the channel's name or rejects it and restores the
 * registry's view.
 *
 * Ids and time are injected. Nothing here reads a clock or an RNG; the
 * production implementations live in `./defaults.ts` and nowhere else.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import type { Database } from "bun:sqlite";
import type { EventLog } from "./log.ts";
import { identityKey, type ObservedSymbol, type SymbolKind } from "./structural/parser.ts";

/** Epoch milliseconds. Injected, so a lease TTL is testable without waiting. */
export type Clock = () => number;

/** Opaque id minting. `prefix` names the kind of thing, for legibility only. */
export type IdGen = (prefix: string) => string;

export type TrackedFile = {
  id: string;
  /** Root-relative, and a display attribute rather than identity (§ 3.2). */
  path: string;
  /** The registry's last-known content, which is what a reject restores. */
  content: string;
  desynced: boolean;
};

export type RegisteredSymbol = {
  id: string;
  fileId: string;
  kind: SymbolKind;
  name: string;
  container: readonly string[];
  start: number;
  end: number;
  nameStart: number;
  nameEnd: number;
  contentHash: string;
  version: number;
  tombstoned: boolean;
};

/** What an undeclared change did to a file, in the registry's own terms. */
export type Divergence = {
  fileId: string;
  path: string;
  /** Identity keys the registry holds and the file no longer does. */
  vanished: string[];
  /** Identity keys the file holds and the registry does not. */
  appeared: string[];
  /** Ids of registered symbols whose text changed. */
  changed: string[];
};

/** What `reconcile` did, so the caller can attribute it in the log. */
export type ReconcileReport = {
  created: RegisteredSymbol[];
  modified: RegisteredSymbol[];
  renamed: { symbol: RegisteredSymbol; from: string }[];
  tombstoned: RegisteredSymbol[];
};

export type Registry = {
  /**
   * First observation of a file. Every symbol in it is created at version 1,
   * and each creation is an event attributed to `INVENTORY_CHANNEL` rather
   * than to a task, because adopting code that already exists is not an agent
   * action (§ 9.1).
   */
  track(path: string, source: string, observed: readonly ObservedSymbol[]): { file: TrackedFile; report: ReconcileReport };
  file(path: string): TrackedFile | undefined;
  fileById(id: string): TrackedFile | undefined;
  files(): TrackedFile[];
  symbol(id: string): RegisteredSymbol | undefined;
  /** Live symbols of a file, in declaration order. */
  symbolsOf(fileId: string): RegisteredSymbol[];
  /** Every symbol of a file the registry has ever held, tombstones included. */
  allSymbolsOf(fileId: string): RegisteredSymbol[];
  find(fileId: string, key: string): RegisteredSymbol | undefined;
  /** The symbols held inside this one, at any depth. */
  descendantsOf(symbolId: string): RegisteredSymbol[];
  /** The symbols holding this one, outermost first. */
  ancestorsOf(symbolId: string): RegisteredSymbol[];

  /**
   * Re-key a file after a *declared* change. The caller has already proved,
   * through the structural stage, that the observed identity delta is the one
   * it declared, so this only has to apply it: move the ids the caller named,
   * tombstone whatever the observation no longer holds, refresh every range
   * and hash, and bump the version of everything that changed.
   */
  reconcile(spec: {
    fileId: string;
    source: string;
    observed: readonly ObservedSymbol[];
    /** Declared identity moves, by symbol id. */
    rekey?: Readonly<Record<string, { name: string; container: readonly string[] }>>;
  }): ReconcileReport;

  /**
   * Compare what is on disk against the registry's last-known content. Equal:
   * `undefined`. Different: the file is marked desynced, the divergent source
   * is held for a later import or reject, and the divergence is returned.
   */
  reinventory(path: string, source: string, observed: readonly ObservedSymbol[]): Divergence | undefined;
  desynced(fileId: string): boolean;
  /** The source a desync is holding, for the importer to reconcile against. */
  pending(fileId: string): string | undefined;
  /** Adopt the held source, attributed to `sourceChannel` and to no task. */
  importExternal(fileId: string, sourceChannel: string, observed: readonly ObservedSymbol[]): ReconcileReport;
  /** Discard the held source. Returns the content the caller must write back. */
  rejectExternal(fileId: string): string;
};

type FileRow = { id: string; path: string; content: string; desynced: number; pending: string | null };

type SymbolRow = {
  id: string;
  file_id: string;
  kind: string;
  name: string;
  container: string;
  start: number;
  end: number;
  name_start: number;
  name_end: number;
  content_hash: string;
  version: number;
  tombstoned: number;
};

const decodeFile = (row: FileRow): TrackedFile => ({
  id: row.id,
  path: row.path,
  content: row.content,
  desynced: row.desynced === 1,
});

const decodeSymbol = (row: SymbolRow): RegisteredSymbol => ({
  id: row.id,
  fileId: row.file_id,
  kind: row.kind as SymbolKind,
  name: row.name,
  container: JSON.parse(row.container) as string[],
  start: row.start,
  end: row.end,
  nameStart: row.name_start,
  nameEnd: row.name_end,
  contentHash: row.content_hash,
  version: row.version,
  tombstoned: row.tombstoned === 1,
});

const keyOf = (s: Pick<RegisteredSymbol, "kind" | "name" | "container">): string => identityKey(s);

/** The channel a first observation is attributed to. Not a task, by design. */
export const INVENTORY_CHANNEL = "inventory";

/** Is `inner` held by `outer`, at any depth, within one file? */
const isDescendant = (outer: RegisteredSymbol, inner: RegisteredSymbol): boolean => {
  const path = [...outer.container, outer.name];
  return (
    inner.id !== outer.id &&
    inner.container.length > outer.container.length &&
    path.every((segment, i) => inner.container[i] === segment)
  );
};

export const openRegistry = (db: Database, log: EventLog, ids: IdGen): Registry => {
  db.run(`CREATE TABLE IF NOT EXISTS files (
    id        TEXT PRIMARY KEY,
    path      TEXT NOT NULL UNIQUE,
    content   TEXT NOT NULL,
    desynced  INTEGER NOT NULL DEFAULT 0,
    pending   TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS symbols (
    id            TEXT PRIMARY KEY,
    file_id       TEXT NOT NULL,
    kind          TEXT NOT NULL,
    name          TEXT NOT NULL,
    container     TEXT NOT NULL,
    start         INTEGER NOT NULL,
    end           INTEGER NOT NULL,
    name_start    INTEGER NOT NULL,
    name_end      INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    version       INTEGER NOT NULL,
    tombstoned    INTEGER NOT NULL DEFAULT 0,
    ord           INTEGER NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS symbols_file ON symbols (file_id, ord)");

  const q = {
    fileByPath: db.query<FileRow, [string]>("SELECT * FROM files WHERE path = ?"),
    fileById: db.query<FileRow, [string]>("SELECT * FROM files WHERE id = ?"),
    allFiles: db.query<FileRow, []>("SELECT * FROM files ORDER BY path"),
    insertFile: db.query<unknown, [string, string, string]>(
      "INSERT INTO files (id, path, content) VALUES (?, ?, ?)",
    ),
    setContent: db.query<unknown, [string, string]>(
      "UPDATE files SET content = ?, desynced = 0, pending = NULL WHERE id = ?",
    ),
    setDesync: db.query<unknown, [string, string]>("UPDATE files SET desynced = 1, pending = ? WHERE id = ?"),
    clearDesync: db.query<unknown, [string]>("UPDATE files SET desynced = 0, pending = NULL WHERE id = ?"),
    symbolById: db.query<SymbolRow, [string]>("SELECT * FROM symbols WHERE id = ?"),
    liveOf: db.query<SymbolRow, [string]>(
      "SELECT * FROM symbols WHERE file_id = ? AND tombstoned = 0 ORDER BY ord",
    ),
    allOf: db.query<SymbolRow, [string]>("SELECT * FROM symbols WHERE file_id = ? ORDER BY ord"),
    insertSymbol: db.query<unknown, (string | number)[]>(
      `INSERT INTO symbols
         (id, file_id, kind, name, container, start, end, name_start, name_end,
          content_hash, version, tombstoned, ord)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ),
    updateSymbol: db.query<unknown, (string | number)[]>(
      `UPDATE symbols SET name = ?, container = ?, start = ?, end = ?, name_start = ?,
         name_end = ?, content_hash = ?, version = ?, ord = ? WHERE id = ?`,
    ),
    tombstone: db.query<unknown, [number, string]>(
      "UPDATE symbols SET tombstoned = 1, version = ? WHERE id = ?",
    ),
  };

  const symbol = (id: string): RegisteredSymbol | undefined => {
    const row = q.symbolById.get(id);
    return row === null ? undefined : decodeSymbol(row);
  };
  const liveOf = (fileId: string) => q.liveOf.all(fileId).map(decodeSymbol);
  const fileById = (id: string): TrackedFile | undefined => {
    const row = q.fileById.get(id);
    return row === null ? undefined : decodeFile(row);
  };

  const reconcile: Registry["reconcile"] = (spec) => {
    const rekey = spec.rekey ?? {};
    const report: ReconcileReport = { created: [], modified: [], renamed: [], tombstoned: [] };

    // Registered symbols by the identity key they will be looked up under: the
    // declared new key for anything the caller re-keyed, the current key
    // otherwise. Re-keying here is what makes a rename identity-preserving.
    const registered = liveOf(spec.fileId);
    const byKey = new Map<string, RegisteredSymbol>();
    const renamedFrom = new Map<string, string>();
    for (const s of registered) {
      const moved = rekey[s.id];
      if (moved === undefined) {
        byKey.set(keyOf(s), s);
        continue;
      }
      renamedFrom.set(s.id, keyOf(s));
      byKey.set(keyOf({ kind: s.kind, name: moved.name, container: moved.container }), s);
    }

    const matched = new Set<string>();
    spec.observed.forEach((obs, ord) => {
      const key = identityKey(obs);
      const existing = byKey.get(key);
      if (existing === undefined) {
        const created: RegisteredSymbol = { ...obs, id: ids("sym"), fileId: spec.fileId, version: 1, tombstoned: false };
        q.insertSymbol.run(
          created.id,
          created.fileId,
          created.kind,
          created.name,
          JSON.stringify(created.container),
          created.start,
          created.end,
          created.nameStart,
          created.nameEnd,
          created.contentHash,
          1,
          ord,
        );
        report.created.push(created);
        return;
      }
      matched.add(existing.id);
      const from = renamedFrom.get(existing.id);
      const changed = existing.contentHash !== obs.contentHash;
      const version = from !== undefined || changed ? existing.version + 1 : existing.version;
      q.updateSymbol.run(
        obs.name,
        JSON.stringify(obs.container),
        obs.start,
        obs.end,
        obs.nameStart,
        obs.nameEnd,
        obs.contentHash,
        version,
        ord,
        existing.id,
      );
      const next: RegisteredSymbol = { ...existing, ...obs, container: [...obs.container], version };
      if (from !== undefined) report.renamed.push({ symbol: next, from });
      else if (changed) report.modified.push(next);
    });

    // A registered symbol the observation no longer holds. On a declared write
    // the structural stage already proved this set is the one the caller
    // declared, so tombstoning it is applying a declaration rather than
    // inferring one; on an external import there is no declaration and the
    // event carries the channel instead (§ 9.1).
    for (const s of registered) {
      if (matched.has(s.id)) continue;
      q.tombstone.run(s.version + 1, s.id);
      report.tombstoned.push({ ...s, version: s.version + 1, tombstoned: true });
    }

    q.setContent.run(spec.source, spec.fileId);
    return report;
  };

  return {
    track(path, source, observed) {
      const existing = q.fileByPath.get(path);
      if (existing !== null) {
        return { file: decodeFile(existing), report: { created: [], modified: [], renamed: [], tombstoned: [] } };
      }
      const id = ids("file");
      q.insertFile.run(id, path, source);
      log.append({ kind: "file-tracked", fileId: id, sourceChannel: INVENTORY_CHANNEL, detail: path });
      const report = reconcile({ fileId: id, source, observed });
      for (const s of report.created) {
        log.append({
          kind: "symbol-created",
          symbolId: s.id,
          fileId: id,
          sourceChannel: INVENTORY_CHANNEL,
          version: s.version,
          body: source.slice(s.start, s.end),
        });
      }
      const file = fileById(id);
      if (file === undefined) throw new Error(`registry: file ${id} vanished during track`);
      return { file, report };
    },
    file(path) {
      const row = q.fileByPath.get(path);
      return row === null ? undefined : decodeFile(row);
    },
    fileById,
    files: () => q.allFiles.all().map(decodeFile),
    symbol,
    symbolsOf: liveOf,
    allSymbolsOf: (fileId) => q.allOf.all(fileId).map(decodeSymbol),
    find: (fileId, key) => liveOf(fileId).find((s) => keyOf(s) === key),
    descendantsOf(symbolId) {
      const outer = symbol(symbolId);
      return outer === undefined ? [] : liveOf(outer.fileId).filter((s) => isDescendant(outer, s));
    },
    ancestorsOf(symbolId) {
      const inner = symbol(symbolId);
      if (inner === undefined) return [];
      return liveOf(inner.fileId).filter((s) => isDescendant(s, inner));
    },
    reconcile,
    reinventory(path, source, observed) {
      const row = q.fileByPath.get(path);
      if (row === null) return undefined;
      if (row.content === source) return undefined;

      const registered = liveOf(row.id);
      const seen = new Map(observed.map((o) => [identityKey(o), o]));
      const held = new Set(registered.map(keyOf));

      const divergence: Divergence = {
        fileId: row.id,
        path,
        vanished: registered.filter((s) => !seen.has(keyOf(s))).map(keyOf).sort(),
        appeared: [...seen.keys()].filter((k) => !held.has(k)).sort(),
        changed: registered
          .filter((s) => {
            const now = seen.get(keyOf(s));
            return now !== undefined && now.contentHash !== s.contentHash;
          })
          .map((s) => s.id)
          .sort(),
      };

      q.setDesync.run(source, row.id);
      log.append({
        kind: "desync-detected",
        fileId: row.id,
        detail: JSON.stringify({
          path,
          vanished: divergence.vanished,
          appeared: divergence.appeared,
          changed: divergence.changed,
        }),
      });
      return divergence;
    },
    desynced: (fileId) => q.fileById.get(fileId)?.desynced === 1,
    pending: (fileId) => q.fileById.get(fileId)?.pending ?? undefined,
    importExternal(fileId, sourceChannel, observed) {
      const row = q.fileById.get(fileId);
      if (row === null) throw new Error(`registry: no tracked file ${fileId}`);
      const source = row.pending ?? row.content;

      const report = reconcile({ fileId, source, observed });

      // Attribution is the channel and nothing else. No task id, no
      // description: § 9.1 requires that an external change never becomes
      // indistinguishable from an agent action in the log.
      const attribute = (kind: "symbol-created" | "symbol-modified" | "symbol-deleted", s: RegisteredSymbol) =>
        log.append({
          kind,
          symbolId: s.id,
          fileId,
          sourceChannel,
          version: s.version,
          ...(kind === "symbol-deleted" ? {} : { body: source.slice(s.start, s.end) }),
        });
      for (const s of report.created) attribute("symbol-created", s);
      for (const s of report.modified) attribute("symbol-modified", s);
      for (const s of report.tombstoned) attribute("symbol-deleted", s);
      log.append({ kind: "external-imported", fileId, sourceChannel, detail: row.path });
      return report;
    },
    rejectExternal(fileId) {
      const row = q.fileById.get(fileId);
      if (row === null) throw new Error(`registry: no tracked file ${fileId}`);
      q.clearDesync.run(fileId);
      log.append({ kind: "external-rejected", fileId, detail: row.path });
      return row.content;
    },
  };
};
