/**
 * The composition root for the agent-native VCS (ai-vcs.md § 4.3: "a stateful
 * coordinator that owns three things: the symbol identity registry, the lease
 * table, and the entry point for the event log").
 *
 * One sqlite database per repository, one parser, one verifier, one clock, one
 * id generator. Everything below this file takes its dependencies as
 * arguments; this is the only place they are chosen, and the only place the
 * filesystem is touched outside the write path.
 *
 * The module is a library, not the Rust CLI the document plans. The caller is
 * the workflow runner rather than a free agent, so there is no MCP tool
 * surface and no reason for one: see `./executor.ts`.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { openImpactGraph, type ImpactGraph } from "./impact.ts";
import { openEventLog, type EventLog, type Intent } from "./log.ts";
import {
  openLeaseManager,
  type AcquireRequest,
  type AcquireResult,
  type LeaseManager,
  type ReleaseResult,
} from "./leases.ts";
import {
  openRegistry,
  type Clock,
  type Divergence,
  type IdGen,
  type ReconcileReport,
  type Registry,
  type TrackedFile,
} from "./registry.ts";
import { treeSitterTypeScript } from "./structural/typescript.ts";
import type { Parser } from "./structural/parser.ts";
import { openWritePath, type MeasureResult, type WritePath, type WriteResult } from "./writes.ts";
import { defaultVerifier, type Verifier } from "./verify.ts";
import type { Commands } from "../core/commands.ts";
import { randomIds, systemClock } from "./defaults.ts";

export type VcsOptions = {
  /** Absolute path of the repository this coordinator owns. */
  root: string;
  /** One database per repository. `":memory:"` in tests. */
  dbPath?: string;
  parser?: Parser;
  /**
   * How this repository is typechecked, linted, tested, and how one oracle is
   * executed (`src/core/commands.ts`). Required unless a `verifier` is
   * supplied outright, and refused BY NAME when neither is: a default set of
   * commands would work silently for every project that happens to be a bun
   * project and mis-run every project that is not, which is the whole reason
   * the declaration exists.
   */
  commands?: Commands;
  verifier?: Verifier;
  clock?: Clock;
  ids?: IdGen;
};

export type Vcs = {
  readonly root: string;
  readonly log: EventLog;
  readonly registry: Registry;
  readonly leases: LeaseManager;
  readonly impact: ImpactGraph;

  /**
   * First observation of a file, read from disk. Imports are resolved against
   * the files already tracked, so a file that imports one not yet tracked gets
   * no edge until `trackTree` or a later `track` of the importer.
   */
  track(path: string): TrackedFile;
  /**
   * Track every TypeScript file under a root-relative directory. Two passes,
   * because an import edge can only resolve to a file the registry already
   * holds: track them all, then read every one's imports.
   */
  trackTree(dir: string): TrackedFile[];
  /** Re-read a file from disk and compare it against the registry (§ 9.1). */
  reinventory(path: string): Divergence | undefined;
  /** Adopt a desynced file, attributed to the channel that changed it. */
  importExternal(fileId: string, sourceChannel: string): ReconcileReport;
  /** Refuse a desynced file and put the registry's content back on disk. */
  rejectExternal(fileId: string): void;

  acquire(request: AcquireRequest): AcquireResult;
  heartbeat(leaseId: string): number | undefined;
  release(leaseId: string): ReleaseResult;

  replaceSymbolBody: WritePath["replaceSymbolBody"];
  renameSymbol: WritePath["renameSymbol"];
  deleteSymbol: WritePath["deleteSymbol"];
  writeFile: WritePath["writeFile"];
  runTests: WritePath["runTests"];
  measureOracle: WritePath["measureOracle"];

  /**
   * Record one line of provenance under a task. This is where an
   * `append-trail` effect lands: the exhaustion trail of a step whose
   * validator was never satisfied is provenance, and the event log is the
   * provenance store.
   */
  appendTrail(line: string, intent: Intent): number;

  close(): void;
};

/** The declared commands, or a refusal that names what is missing. */
const requireCommands = (options: VcsOptions): Commands => {
  if (options.commands !== undefined) return options.commands;
  throw new Error(
    `openVcs(${options.root}): no \`commands\` were declared and no \`verifier\` was supplied. ` +
      "The four commands that typecheck, lint, test and measure a project are the consumer's " +
      "to declare (src/core/commands.ts); there is no default, because a default would run bun " +
      "against every project whether or not it is one.",
  );
};

export const openVcs = (options: VcsOptions): Vcs => {
  const parser = options.parser ?? treeSitterTypeScript();
  const verifier = options.verifier ?? defaultVerifier({ commands: requireCommands(options), root: options.root });
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIds;

  const db = new Database(options.dbPath ?? ":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  const log = openEventLog(db);
  const registry = openRegistry(db, log, ids);
  const impact = openImpactGraph(db, registry);
  const leases = openLeaseManager(db, log, registry, ids, clock);
  const writes = openWritePath({ root: options.root, registry, log, leases, impact, parser, verifier });

  const read = (path: string): string => readFileSync(join(options.root, path), "utf8");

  const trackOne = (path: string): TrackedFile => {
    const source = read(path);
    const { file } = registry.track(path, source, parser.symbols(source));
    return file;
  };

  const observeImports = (file: TrackedFile): void =>
    impact.observe(file.id, file.path, parser.imports(read(file.path)));

  return {
    root: options.root,
    log,
    registry,
    leases,
    impact,

    track(path) {
      const file = trackOne(path);
      observeImports(file);
      return file;
    },

    trackTree(dir) {
      const paths = [...new Glob("**/*.{ts,tsx}").scanSync({ cwd: join(options.root, dir) })]
        .map((found) => relative(options.root, join(options.root, dir, found)))
        .sort();
      const tracked = paths.map(trackOne);
      for (const file of tracked) observeImports(file);
      return tracked;
    },

    reinventory(path) {
      const source = read(path);
      return registry.reinventory(path, source, parser.symbols(source));
    },

    importExternal(fileId, sourceChannel) {
      const file = registry.fileById(fileId);
      if (file === undefined) throw new Error(`vcs: no tracked file ${fileId}`);
      const source = registry.pending(fileId) ?? read(file.path);
      const report = registry.importExternal(fileId, sourceChannel, parser.symbols(source));
      impact.observe(fileId, file.path, parser.imports(source));
      return report;
    },

    rejectExternal(fileId) {
      const file = registry.fileById(fileId);
      if (file === undefined) throw new Error(`vcs: no tracked file ${fileId}`);
      const restored = registry.rejectExternal(fileId);
      writeFileSync(join(options.root, file.path), restored, "utf8");
    },

    acquire: (request) => leases.acquire(request),
    heartbeat: (leaseId) => leases.heartbeat(leaseId),
    release: (leaseId) => leases.release(leaseId),

    replaceSymbolBody: writes.replaceSymbolBody,
    renameSymbol: writes.renameSymbol,
    deleteSymbol: writes.deleteSymbol,
    writeFile: writes.writeFile,
    runTests: writes.runTests,
    measureOracle: writes.measureOracle,

    appendTrail: (line, intent) =>
      log.append({
        kind: "trail",
        taskId: intent.taskId,
        ...(intent.parentTaskId === undefined ? {} : { parentTaskId: intent.parentTaskId }),
        description: intent.description,
        detail: line,
      }),

    close: () => db.close(),
  };
};

export type { MeasureResult, WriteResult };
