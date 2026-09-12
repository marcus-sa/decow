/**
 * The lease manager (ai-vcs.md § 5).
 *
 * An acquire names the complete set the caller will need — symbols, PATH
 * SCOPES, or both — plus a mode, a TTL, the intent payload, and optionally the
 * versions it expects to see. The manager evaluates the whole request
 * atomically and answers with one of five outcomes, every one of them data:
 *
 *   granted             the lease, its expiry, and the current version of every
 *                       granted symbol, so one round trip yields both the lock
 *                       and the versions the caller's next write needs (§ 5.1).
 *                       A path scope hands back no version: a file that does
 *                       not exist yet has none to be optimistic about
 *   stale               a symbol moved under the caller; here are the versions
 *   conflict            unavailable in this mode; here is who holds what
 *   contract-violation  the intent does not match the request (§ 4.5, § 5.1)
 *   desync              a requested symbol's file was changed by a channel that
 *                       declared nothing, and no new lease is granted on it
 *                       until that is acknowledged (§ 9.1)
 *
 * Deadlock is prevented by construction rather than detected (§ 5.3): a
 * session that already holds a live lease cannot acquire another, so there is
 * no hold-and-wait and therefore no cycle. Wait-die is the document's fallback
 * for callers that cannot predict their access set, and it is not built.
 *
 * Expiry is lazy. Nothing sweeps on a timer; an acquire retires the leases
 * whose deadline has passed before it evaluates anything, which is the only
 * moment at which an expired lease can affect an answer.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import type { Database } from "bun:sqlite";
import { Glob } from "bun";
import { DESCRIPTION_MAX, type EventLog, type Intent } from "./log.ts";
import type { Clock, IdGen, Registry, RegisteredSymbol } from "./registry.ts";

export const LEASE_MODES = ["read", "write", "exclusive"] as const;
export type LeaseMode = (typeof LEASE_MODES)[number];

/**
 * § 5.2, as a table. Rows are the mode a live lease holds, columns the mode
 * being requested, `true` meaning the request is blocked.
 *
 * It is deliberately asymmetric, because the document is: a read lease blocks
 * a later write, and a live write lease does not block a later read, because
 * "readers see the pre-write version until the write commits". The same table
 * is applied across the symbol hierarchy, so a write on a class is blocked by
 * a lease on any of its methods and vice versa (§ 5.2, intention locks).
 */
const BLOCKS: Record<LeaseMode, Record<LeaseMode, boolean>> = {
  read: { read: false, write: true, exclusive: true },
  write: { read: false, write: true, exclusive: true },
  exclusive: { read: true, write: true, exclusive: true },
};

/* ------------------------------------------------------------ path scopes */

/**
 * A lease may be taken on PATHS as well as on symbols, and the two are not the
 * same kind of claim. A symbol lease is an optimistic claim on something the
 * registry already holds; a path scope is a territorial one on a region of the
 * tree, which is the only thing a `write-file` can hold, because a file has no
 * version to be optimistic about before it exists.
 *
 * A scope is a repository-relative prefix (`test`, `test/acceptance`) or a
 * glob (`test/**`, `test/*.test.ts`). A prefix covers itself and everything
 * under it.
 */
export const scopeCovers = (scope: string, path: string): boolean => {
  if (scope.includes("*")) return new Glob(scope).match(path);
  const base = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return path === base || path.startsWith(`${base}/`);
};

/**
 * Do two scopes overlap? This is what decides whether two sessions' path
 * leases conflict.
 *
 * For prefixes it is exact: `test` overlaps `test/todo.test.ts` and neither
 * overlaps `src`. For globs it is an APPROXIMATION — one scope's glob is
 * matched against the other's literal text — because the general question
 * "can two patterns match the same string" is not one a matcher answers. The
 * approximation is right for every shape a caller here actually writes (a
 * prefix, or a glob against a concrete path) and it never reports an overlap
 * that is not one; what it can miss is two globs that overlap only on strings
 * neither spells. Stated rather than hidden: a caller that needs the stronger
 * guarantee names prefixes.
 */
export const scopesOverlap = (a: string, b: string): boolean =>
  a === b || scopeCovers(a, b) || scopeCovers(b, a);

/** Every scope in `scopes` that covers `path`. */
export const coveringScopes = (scopes: readonly string[], path: string): string[] =>
  scopes.filter((scope) => scopeCovers(scope, path));

/** The ways an intent payload can fail to match its request (§ 4.5). */
export const CONTRACT_VIOLATIONS = [
  "empty-request",
  "description-too-long",
  "intent-scope-mismatch",
  "tombstone-needs-exclusive",
  "hold-and-request",
  "unknown-symbol",
  "tombstoned-symbol",
] as const;
export type ContractViolation = (typeof CONTRACT_VIOLATIONS)[number];

export type Lease = {
  id: string;
  session: string;
  mode: LeaseMode;
  symbolIds: readonly string[];
  /** Repository-relative prefixes or globs this lease admits writes under. */
  paths: readonly string[];
  /** The TTL the lease was taken with. A heartbeat extends by this much. */
  ttlMs: number;
  expiresAt: number;
  intent: Intent;
  /** Versions held at acquisition, which is what § 5.1 hands back. */
  versions: Readonly<Record<string, number>>;
};

/**
 * Who is holding what, on a refused acquire. `symbolId` names the symbol when
 * the collision is on the symbol hierarchy and `path` names the scope when it
 * is on the tree; exactly one of them is set.
 */
export type Holder = {
  symbolId?: string;
  path?: string;
  leaseId: string;
  mode: LeaseMode;
  session: string;
};

export type AcquireRequest = {
  session: string;
  /** The complete set of symbols this lease will need. */
  symbolIds?: readonly string[];
  /**
   * The complete set of path scopes this lease will need. A `write` lease
   * whose scope covers a path admits a `write-file` at that path, whether or
   * not the file exists yet.
   */
  paths?: readonly string[];
  mode: LeaseMode;
  ttlMs: number;
  intent: Intent;
  /** Optional; a mismatch is `stale` rather than a granted lease (§ 3.3). */
  expectedVersions?: Readonly<Record<string, number>>;
};

export type AcquireResult =
  | { outcome: "granted"; leaseId: string; expiresAt: number; versions: Record<string, number> }
  | { outcome: "stale"; versions: Record<string, number> }
  | { outcome: "conflict"; held: Holder[] }
  | { outcome: "contract-violation"; violation: ContractViolation; detail: string }
  | { outcome: "desync"; fileIds: string[] };

export type ReleaseResult =
  | { outcome: "released"; seq: number; touched: string[] }
  /**
   * § 5.4: the lease changed something its intent did not declare. This is the
   * backstop under the per-call intent check, not a duplicate of it: a call
   * declares its own symbol and the write path enforces that, while the lease
   * declared a scope and only release can see whether the whole lease stayed
   * inside it.
   */
  | { outcome: "contract-violation"; declared: string[]; observed: string[]; outside: string[]; seq: number }
  | { outcome: "unknown-lease" };

export type LeaseManager = {
  acquire(request: AcquireRequest): AcquireResult;
  /** Extends the deadline. `undefined` when the lease is gone or expired. */
  heartbeat(leaseId: string): number | undefined;
  release(leaseId: string): ReleaseResult;
  /** The live lease, or `undefined` once it is released or expired. */
  lease(leaseId: string): Lease | undefined;
  /** Every live lease, for the conflict report and for tests. */
  live(): Lease[];
};

type LeaseRow = {
  id: string;
  session: string;
  mode: string;
  symbol_ids: string;
  paths: string;
  ttl_ms: number;
  expires_at: number;
  intent: string;
  versions: string;
  released: number;
};

const decodeLease = (row: LeaseRow): Lease => ({
  id: row.id,
  session: row.session,
  mode: row.mode as LeaseMode,
  symbolIds: JSON.parse(row.symbol_ids) as string[],
  paths: JSON.parse(row.paths) as string[],
  ttlMs: row.ttl_ms,
  expiresAt: row.expires_at,
  intent: JSON.parse(row.intent) as Intent,
  versions: JSON.parse(row.versions) as Record<string, number>,
});

/** Symbol ids the intent declares this call will mutate. */
const declaredMutations = (intent: Intent): string[] => [
  ...(intent.expectedOutcome.modified ?? []),
  ...(intent.expectedOutcome.tombstoned ?? []),
];

/** Events that count as "this lease touched that symbol" for release (§ 5.4). */
const TOUCHING = new Set(["symbol-created", "symbol-modified", "symbol-renamed", "symbol-deleted"]);

export const openLeaseManager = (
  db: Database,
  log: EventLog,
  registry: Registry,
  ids: IdGen,
  clock: Clock,
): LeaseManager => {
  db.run(`CREATE TABLE IF NOT EXISTS leases (
    id          TEXT PRIMARY KEY,
    session     TEXT NOT NULL,
    mode        TEXT NOT NULL,
    symbol_ids  TEXT NOT NULL,
    paths       TEXT NOT NULL,
    ttl_ms      INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    intent      TEXT NOT NULL,
    versions    TEXT NOT NULL,
    released    INTEGER NOT NULL DEFAULT 0
  )`);

  const q = {
    byId: db.query<LeaseRow, [string]>("SELECT * FROM leases WHERE id = ? AND released = 0"),
    live: db.query<LeaseRow, []>("SELECT * FROM leases WHERE released = 0 ORDER BY id"),
    insert: db.query<unknown, (string | number)[]>(
      `INSERT INTO leases (id, session, mode, symbol_ids, paths, ttl_ms, expires_at, intent, versions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    extend: db.query<unknown, [number, string]>("UPDATE leases SET expires_at = ? WHERE id = ?"),
    close: db.query<unknown, [string]>("UPDATE leases SET released = 1 WHERE id = ?"),
  };

  /**
   * Retire every lease whose deadline has passed, then answer with what is
   * still live. This is the only place expiry is evaluated (§ 5.3 note above).
   */
  const liveNow = (): Lease[] => {
    const now = clock();
    const leases: Lease[] = [];
    for (const row of q.live.all()) {
      const lease = decodeLease(row);
      if (lease.expiresAt <= now) {
        q.close.run(lease.id);
        log.append({
          kind: "lease-expired",
          leaseId: lease.id,
          taskId: lease.intent.taskId,
          ...(lease.intent.parentTaskId === undefined ? {} : { parentTaskId: lease.intent.parentTaskId }),
          detail: `held ${lease.symbolIds.length} symbol(s) in ${lease.mode} mode for session ${lease.session}`,
        });
        continue;
      }
      leases.push(lease);
    }
    return leases;
  };

  /** The symbol plus everything above and below it in the symbol tree. */
  const closure = (symbolId: string): string[] => {
    const related = [...registry.ancestorsOf(symbolId), ...registry.descendantsOf(symbolId)];
    return [symbolId, ...related.map((s: RegisteredSymbol) => s.id)];
  };

  return {
    acquire(request) {
      const reject = (violation: ContractViolation, detail: string): AcquireResult => ({
        outcome: "contract-violation",
        violation,
        detail,
      });

      const symbolIds = request.symbolIds ?? [];
      const paths = request.paths ?? [];

      // Guardrail order: the caller's own errors first, because they are the
      // cheapest to answer and § 5.1 rejects them "before any work begins".
      if (symbolIds.length === 0 && paths.length === 0) {
        return reject(
          "empty-request",
          "an acquire names the complete set it will need: symbols, path scopes, or both",
        );
      }
      if (request.intent.description.length > DESCRIPTION_MAX) {
        return reject(
          "description-too-long",
          `description is ${request.intent.description.length} characters; the bound is ${DESCRIPTION_MAX}`,
        );
      }

      const requested = new Set(symbolIds);
      const outside = declaredMutations(request.intent).filter((id) => !requested.has(id));
      if (outside.length > 0) {
        return reject(
          "intent-scope-mismatch",
          `the intent declares ${outside.join(", ")}, which the request does not name`,
        );
      }
      // § 4.5's `created` names PATHS, because a file that does not exist yet
      // has no symbol id to name. Every one of them has to be inside a scope
      // this lease is asking for, on the same rule as the symbols above.
      const uncovered = (request.intent.expectedOutcome.created ?? []).filter(
        (path) => coveringScopes(paths, path).length === 0,
      );
      if (uncovered.length > 0) {
        return reject(
          "intent-scope-mismatch",
          `the intent declares creating ${uncovered.join(", ")}, which no requested path scope covers`,
        );
      }
      if ((request.intent.expectedOutcome.tombstoned ?? []).length > 0 && request.mode !== "exclusive") {
        return reject(
          "tombstone-needs-exclusive",
          "a declared tombstone is a structural operation and needs an exclusive lease",
        );
      }

      const symbols: RegisteredSymbol[] = [];
      for (const id of symbolIds) {
        const symbol = registry.symbol(id);
        if (symbol === undefined) return reject("unknown-symbol", id);
        if (symbol.tombstoned) return reject("tombstoned-symbol", id);
        symbols.push(symbol);
      }

      const live = liveNow();
      if (live.some((l) => l.session === request.session)) {
        return reject(
          "hold-and-request",
          `session ${request.session} already holds a lease; release it before acquiring again (§ 5.3)`,
        );
      }

      const desynced = [...new Set(symbols.map((s) => s.fileId))].filter((f) => registry.desynced(f));
      if (desynced.length > 0) return { outcome: "desync", fileIds: desynced };

      const versions = Object.fromEntries(symbols.map((s) => [s.id, s.version]));
      if (request.expectedVersions !== undefined) {
        const expected = request.expectedVersions;
        const moved = Object.keys(expected).filter((id) => versions[id] !== expected[id]);
        if (moved.length > 0) return { outcome: "stale", versions };
      }

      // Hierarchical conflict detection: a request on a method is evaluated
      // against leases on the method, on its class, and on anything the method
      // itself holds.
      const held: Holder[] = [];
      for (const id of symbolIds) {
        const related = new Set(closure(id));
        for (const lease of live) {
          for (const heldId of lease.symbolIds) {
            if (!related.has(heldId)) continue;
            if (!BLOCKS[lease.mode][request.mode]) continue;
            held.push({ symbolId: heldId, leaseId: lease.id, mode: lease.mode, session: lease.session });
          }
        }
      }
      // The same mode matrix over the tree rather than over the hierarchy. Two
      // sessions whose scopes overlap are asking for the same region, and the
      // question of who may have it is the one the matrix already answers.
      for (const scope of paths) {
        for (const lease of live) {
          for (const heldScope of lease.paths) {
            if (!scopesOverlap(scope, heldScope)) continue;
            if (!BLOCKS[lease.mode][request.mode]) continue;
            held.push({ path: heldScope, leaseId: lease.id, mode: lease.mode, session: lease.session });
          }
        }
      }
      // All or nothing (§ 5.3): one blocked symbol or scope denies the whole
      // request.
      if (held.length > 0) return { outcome: "conflict", held };

      const leaseId = ids("lease");
      const expiresAt = clock() + request.ttlMs;
      q.insert.run(
        leaseId,
        request.session,
        request.mode,
        JSON.stringify(symbolIds),
        JSON.stringify(paths),
        request.ttlMs,
        expiresAt,
        JSON.stringify(request.intent),
        JSON.stringify(versions),
      );
      log.append({
        kind: "lease-acquired",
        leaseId,
        taskId: request.intent.taskId,
        ...(request.intent.parentTaskId === undefined ? {} : { parentTaskId: request.intent.parentTaskId }),
        description: request.intent.description,
        detail: JSON.stringify({ mode: request.mode, symbolIds, paths, session: request.session }),
      });
      return { outcome: "granted", leaseId, expiresAt, versions };
    },

    /**
     * § 4.3: "Heartbeats from agent sessions extend leases; missed heartbeats
     * expire them." The extension is another full TTL from now, so a session
     * that keeps beating keeps its lease and one that stops loses it at the
     * next acquire that looks.
     */
    heartbeat(leaseId) {
      const lease = liveNow().find((l) => l.id === leaseId);
      if (lease === undefined) return undefined;
      const expiresAt = clock() + lease.ttlMs;
      q.extend.run(expiresAt, leaseId);
      return expiresAt;
    },

    release(leaseId) {
      const row = q.byId.get(leaseId);
      if (row === null) return { outcome: "unknown-lease" };
      const lease = decodeLease(row);
      q.close.run(leaseId);

      // § 5.4: compare the declared intent against the observed effect. The
      // observation is the log's own record of what happened under this lease,
      // not a second bookkeeping structure that could drift from it.
      //
      // The test is containment, not equality, and in one direction only. A
      // lease that declared two symbols and changed none of them refused its
      // writes, which is a refusal rather than a divergence. A lease that
      // changed something it did not declare is the divergence § 5.4 names.
      // Editing a method necessarily rewrites the text of the class holding
      // it, so the declared scope is closed over the symbol hierarchy, which
      // is the same closure the lease locked in the first place.
      const observed = [
        ...new Set(
          log
            .byLease(leaseId)
            .filter((e) => TOUCHING.has(e.kind) && e.symbolId !== undefined)
            .map((e) => e.symbolId as string),
        ),
      ].sort();
      const declared = [...new Set(declaredMutations(lease.intent))].sort();
      const permitted = new Set(declared.flatMap(closure));
      // A whole-file write creates symbols the intent could not have named by
      // id, because they did not exist when it was written. What it DID name
      // is the path, so a symbol whose file the lease's scope covers is inside
      // the declaration in the only way a file-grained claim can be.
      const inScope = (symbolId: string): boolean => {
        const symbol = registry.symbol(symbolId);
        const file = symbol === undefined ? undefined : registry.fileById(symbol.fileId);
        return file !== undefined && coveringScopes(lease.paths, file.path).length > 0;
      };
      const outside = observed.filter((id) => !permitted.has(id) && !inScope(id));

      if (outside.length > 0) {
        const seq = log.append({
          kind: "release-failed",
          leaseId,
          taskId: lease.intent.taskId,
          ...(lease.intent.parentTaskId === undefined ? {} : { parentTaskId: lease.intent.parentTaskId }),
          category: "contract",
          detail: JSON.stringify({ declared, observed, outside }),
        });
        return { outcome: "contract-violation", declared, observed, outside, seq };
      }

      const seq = log.append({
        kind: "lease-released",
        leaseId,
        taskId: lease.intent.taskId,
        ...(lease.intent.parentTaskId === undefined ? {} : { parentTaskId: lease.intent.parentTaskId }),
        detail: JSON.stringify({ touched: observed }),
      });
      return { outcome: "released", seq, touched: observed };
    },

    lease: (leaseId) => liveNow().find((l) => l.id === leaseId),
    live: liveNow,
  };
};
