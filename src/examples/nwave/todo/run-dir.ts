/**
 * The run directory: where one attempt at delivering the todo target lives.
 *
 * `targets/todo/` is a template and is never mutated. Every run copies it to
 * `runs/<name>/todo/` and works there, so the repository stays clean, each run
 * is a fresh checkout, and two runs cannot see each other's writes. `runs/` is
 * gitignored.
 *
 * Five stores, one directory, all of them files rather than `:memory:`,
 * because the three commands are three PROCESSES:
 *
 *   todo/             the copied target, which the VCS writes into
 *   vcs.sqlite        the symbol registry, the lease table, the event log
 *   artifacts.sqlite  roadmap rows, roadmap_steps rows, step_runs rows
 *   journal.sqlite    what each step decided, keyed by content
 *   mastra.sqlite     the engine's snapshots, so a parked run survives exit
 *   report.jsonl      one line per leaf call
 *   run.json          the manifest: which roadmap, which parked run
 *
 * The design string handed to `decompose` and to every DELIVER leaf is
 * `design.md` PLUS the VCS symbol inventory. That addition is not decoration:
 * `predictedTouches` and `implement`'s `symbolId` are VCS symbol ids, which are
 * opaque and assigned at track time, so a model that has never seen the
 * inventory cannot name one and every write it proposes comes back
 * `rejected: contract` on an id that does not exist. The inventory is the
 * repository telling the author what its symbols are called.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openArtifacts, type ArtifactStore } from "../../../artifacts/store.ts";
import { openWorkflowRuntime, type WorkflowRuntime } from "../../../core/compile.ts";
import { sqliteJournal, type Journal } from "../../../core/journal.ts";
import { openVcs, type Vcs } from "../../../vcs/index.ts";

/** This file is `<repo>/src/examples/nwave/todo/run-dir.ts`. */
export const REPO = dirname(dirname(dirname(dirname(dirname(import.meta.path)))));

/** The template every run copies. Committed; never written to. */
export const TARGET = join(REPO, "targets", "todo");

/** Where run directories live. Gitignored. */
export const RUNS = join(REPO, "runs");

/** What the manifest records between commands. */
export type RunManifest = {
  name: string;
  /** The request the roadmap was authored for. Also the `roadmaps` row id. */
  request: string;
  /** The run id the roadmap workflow parked under, once it has parked. */
  roadmapRunId?: string;
  /** The reason it parked, which decides what a person may answer. */
  roadmapReason?: string;
};

export type RunDir = {
  name: string;
  /** `runs/<name>`. */
  path: string;
  /** `runs/<name>/todo`, the copied target. */
  project: string;
  vcs: Vcs;
  artifacts: ArtifactStore;
  journal: Journal & { close: () => void };
  runtime: WorkflowRuntime;
  /** `design.md` plus the VCS symbol inventory. */
  design: string;
  manifest: RunManifest;
  /** Rewrite `run.json`. The manifest object is updated in place too. */
  save(patch: Partial<RunManifest>): void;
  close(): void;
};

/** The directories every command tracks, in order, when they exist. */
export const TRACKED = ["src", "test"] as const;

const manifestPath = (path: string): string => join(path, "run.json");

export const readManifest = (path: string): RunManifest =>
  JSON.parse(readFileSync(manifestPath(path), "utf8")) as RunManifest;

/**
 * The symbol inventory, as the design source names it.
 *
 * Every live symbol the registry holds, with the opaque id a `replace-symbol`
 * names and the version it is currently at. Tests included: a roadmap
 * obligation's `oracleLocator` is `path::name` rather than an id, but a reader
 * deciding which obligation belongs to which step needs to see them.
 */
export const symbolInventory = (vcs: Vcs): string => {
  const rows: string[] = [];
  for (const file of vcs.registry.files()) {
    for (const symbol of vcs.registry.symbolsOf(file.id)) {
      if (symbol.tombstoned) continue;
      const where = [...symbol.container, symbol.name].join(".");
      rows.push(`| \`${symbol.id}\` | ${symbol.kind} | \`${where}\` | ${file.path} | ${symbol.version} |`);
    }
  }
  return [
    "## Symbol inventory",
    "",
    "The ids below are this repository's own. A step's `predictedTouches` and",
    "an `implement` call's `symbolId` MUST be an id from this table, verbatim.",
    "An id that is not in it names no symbol and the write is refused.",
    "",
    "| id | kind | symbol | file | version |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
};

/** `design.md` plus the inventory, which together are the design source. */
export const designSource = (project: string, vcs: Vcs): string =>
  `${readFileSync(join(project, "design.md"), "utf8")}\n\n${symbolInventory(vcs)}`;

/**
 * Copy the template into a fresh run directory.
 *
 * Refuses an existing directory by name rather than reusing it: a run is a
 * fresh checkout, and silently continuing on top of a half-finished one would
 * make "what did this run do" unanswerable.
 */
export const createRunDir = (name: string): string => {
  const path = join(RUNS, name);
  if (existsSync(path)) {
    throw new Error(`run "${name}" already exists at ${path}. Pick another name, or delete it.`);
  }
  mkdirSync(path, { recursive: true });
  cpSync(TARGET, join(path, "todo"), { recursive: true });
  // The copied project typechecks with `tsc` and runs with `bun test`, both of
  // which need `@types/bun`. One symlink beats one `bun install` per run.
  symlinkSync(join(REPO, "node_modules"), join(path, "todo", "node_modules"));
  return path;
};

export type OpenRunOptions = {
  /** Track the copied project's sources. Idempotent; safe on every open. */
  track?: boolean;
};

/**
 * Open every store of a run directory. Used by all four commands, so the
 * second and third see exactly what the first left behind.
 */
export const openRunDir = (name: string, options: OpenRunOptions = {}): RunDir => {
  const path = join(RUNS, name);
  if (!existsSync(path)) {
    throw new Error(`no run "${name}" at ${path}. Start one with: bun run todo:roadmap ${name}`);
  }
  const project = join(path, "todo");

  const vcs = openVcs({ root: project, dbPath: join(path, "vcs.sqlite") });
  if (options.track !== false) {
    // `track` returns the tracked file untouched when the path is already
    // known, so a re-open costs a lookup and changes nothing.
    //
    // `test/` is tracked only once it EXISTS. The target ships without one:
    // the oracle is authored by a `write-file` into `test/`, so the first
    // command to open this directory finds nothing there and the next one
    // finds the oracle the previous one wrote.
    for (const dir of TRACKED) {
      if (existsSync(join(project, dir))) vcs.trackTree(dir);
    }
  }

  const artifacts = openArtifacts({ path: join(path, "artifacts.sqlite") });
  const journal = sqliteJournal(join(path, "journal.sqlite"));
  const runtime = openWorkflowRuntime(`file:${join(path, "mastra.sqlite")}`);

  const manifest = existsSync(manifestPath(path))
    ? readManifest(path)
    : ({ name, request: "" } satisfies RunManifest);

  return {
    name,
    path,
    project,
    vcs,
    artifacts,
    journal,
    runtime,
    design: designSource(project, vcs),
    manifest,
    save(patch) {
      Object.assign(manifest, patch);
      writeFileSync(manifestPath(path), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    },
    close() {
      journal.close();
      artifacts.close();
      vcs.close();
    },
  };
};

/** What running the project's own suite printed, and how it exited. */
export type SuiteRun = { output: string; exitCode: number };

/**
 * The run's project, tested for real.
 *
 * This is the honest source of the `evidence` string every classifying leaf
 * quotes: the runner's own output, both channels, verbatim. There is nothing
 * to strip and nothing to reconstruct — the oracles are ACTIVE as `des oracle`
 * authored them, so what the suite prints against the stub bodies IS the red
 * the crafter is looking at.
 */
export const runSuite = (project: string): SuiteRun => {
  const run = Bun.spawnSync(["bun", "test"], { cwd: project });
  return {
    output: `${run.stdout.toString()}${run.stderr.toString()}`.trim(),
    exitCode: run.exitCode ?? 1,
  };
};

/** The credential every command needs, refused by name when it is absent. */
export const requireCredential = (command: string): void => {
  if (process.env.ANTHROPIC_API_KEY) return;
  console.error(
    `${command}: ANTHROPIC_API_KEY is not set. Refusing to run.\n` +
      "Every leaf in this command is a real model call; there is nothing to do without a key.",
  );
  process.exit(1);
};

/** The run name from `argv`, refused by name when it is absent. */
export const requireRunName = (command: string, argv: readonly string[]): string => {
  const name = argv[0];
  if (name === undefined || name.startsWith("-")) {
    console.error(`usage: bun run ${command} <run-name>`);
    process.exit(1);
  }
  return name;
};

/** Absolute path, for printing. */
export const shortPath = (path: string): string => resolve(path).replace(`${REPO}/`, "");
