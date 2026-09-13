/**
 * The run directory: where one attempt at delivering the todo target lives.
 *
 * `targets/todo/` is a template and is never mutated. Every run copies it to
 * `runs/<name>/todo/` and works there, so the repository stays clean, each run
 * is a fresh checkout, and two runs cannot see each other's writes. `runs/` is
 * gitignored.
 *
 * Five stores, one directory, all of them files rather than `:memory:`, so a
 * server restarted against the same name continues where it left off rather
 * than beginning again:
 *
 *   todo/             the copied target, which the VCS writes into and which
 *                     every declared command runs against. The declaration
 *                     itself is `.des/commands.ts`, which the copy does not
 *                     carry: it is DES configuration rather than project
 *                     source
 *   vcs.sqlite        the symbol registry, the lease table, the event log
 *   artifacts.sqlite  roadmap rows, roadmap_steps rows, step_runs rows
 *   journal.sqlite    what each step decided, keyed by content
 *   mastra.sqlite     the engine's snapshots, so a parked run survives exit
 *   runs.sqlite       the runs, their events, and what every leaf call
 *                     decided and cost
 *
 * The design string handed to `decompose` and to every DELIVER leaf is
 * `design.md` PLUS the VCS symbol inventory. That addition is not decoration:
 * `predictedTouches` and `implement`'s `symbolId` are VCS symbol ids, which are
 * opaque and assigned at track time, so a model that has never seen the
 * inventory cannot name one and every write it proposes comes back
 * `rejected: contract` on an id that does not exist. The inventory is the
 * repository telling the author what its symbols are called.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openArtifacts, type ArtifactStore } from "@des/core/artifacts";
import { openRunDatabase, type RunDatabase } from "@des/server";
import type { Commands } from "@des/core/commands";
import { openWorkflowRuntime, type WorkflowRuntime } from "@des/core/compile";
import { sqliteJournal, type Journal } from "@des/core/journal";
import { openVcs, type Vcs } from "@des/core/vcs";

/** This composition's own directory: `<repo>/targets/todo/.des`. */
export const DES = dirname(import.meta.path);

/** The repository root, three directories above the composition. */
export const REPO = dirname(dirname(dirname(DES)));

/** The template every run copies. Committed; never written to. */
export const TARGET = join(REPO, "targets", "todo");

/** Where run directories live. Gitignored. */
export const RUNS = join(REPO, "runs");

export type RunDir = {
  name: string;
  /** `runs/<name>`. */
  path: string;
  /** `runs/<name>/todo`, the copied target. */
  project: string;
  /** The target's own declaration of how it is built and tested. */
  commands: Commands;
  vcs: Vcs;
  artifacts: ArtifactStore;
  journal: Journal & { close: () => void };
  runtime: WorkflowRuntime;
  /** Runs, their events, and every leaf attempt with what it cost. */
  runs: RunDatabase;
  /** `design.md` plus the VCS symbol inventory. */
  design: string;
  close(): void;
};

/** The directories every command tracks, in order, when they exist. */
export const TRACKED = ["src", "test"] as const;

/** The file a composition declares its four commands in. */
export const COMMANDS_FILE = "commands.ts";

/**
 * The four commands, loaded from the composition's own directory.
 *
 * `commands.ts` is DES CONFIGURATION rather than project source: nothing in
 * the todo application reads it, only the framework does. So it lives beside
 * this file in `.des/`, which is the one directory a run's copy leaves behind
 * — the copy carries no declaration, and the commands it declares are RUN
 * with `cwd` set to the copy.
 *
 * Refused BY NAME when it is absent, the same way the test path scope is:
 * every process this framework runs against a project comes from here, so a
 * default would run bun and biome against a project that is neither and call
 * the result a verdict.
 *
 * `from` names another directory, for a caller whose project is not this one:
 * `examples/nwave/distill/smoke.ts` writes a temp project and its declaration
 * together and loads that one.
 */
export const loadCommands = async (from: string = DES): Promise<Commands> => {
  const path = join(from, COMMANDS_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `no ${COMMANDS_FILE} at ${path}. A composition declares how its target is typechecked, ` +
        "linted, tested and measured; there is no default, because a default would run one " +
        "project's toolchain against every other project.",
    );
  }
  const loaded = (await import(path)) as { commands?: Commands };
  if (loaded.commands === undefined) {
    throw new Error(`${path} exports no \`commands\`. It must export one, named \`commands\`.`);
  }
  return loaded.commands;
};

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
  cpSync(TARGET, join(path, "todo"), { recursive: true, filter: (source) => basename(source) !== ".des" });
  // The copied project typechecks with `tsc` and runs with `bun test`, both of
  // which need `@types/bun`. One symlink beats one `bun install` per run.
  symlinkSync(join(REPO, "node_modules"), join(path, "todo", "node_modules"));
  return path;
};

/**
 * Open every store of a run directory.
 *
 * A server opens one of these at boot and holds it for its lifetime. A second
 * open of the same name — a restart — sees exactly what the first left behind,
 * because every store in it is a file.
 */
export const openRunDir = async (name: string): Promise<RunDir> => {
  const path = join(RUNS, name);
  if (!existsSync(path)) {
    throw new Error(`no run "${name}" at ${path}. Start one with: bun run todo:roadmap ${name}`);
  }
  const project = join(path, "todo");

  // From `.des/`, never from the copy: the declaration is this composition's,
  // and the copy is only where the commands it declares are run.
  const commands = await loadCommands();
  const vcs = openVcs({ root: project, dbPath: join(path, "vcs.sqlite"), commands });
  // `track` returns the tracked file untouched when the path is already known,
  // so a re-open costs a lookup and changes nothing.
  //
  // `test/` is tracked only once it EXISTS. The target ships without one: the
  // oracle is authored by a `write-file` into `test/`, so the first open of
  // this directory finds nothing there and the next one finds the oracle the
  // previous one wrote.
  for (const dir of TRACKED) {
    if (existsSync(join(project, dir))) vcs.trackTree(dir);
  }

  const artifacts = openArtifacts({ path: join(path, "artifacts.sqlite") });
  const journal = sqliteJournal(join(path, "journal.sqlite"));
  const runtime = openWorkflowRuntime(`file:${join(path, "mastra.sqlite")}`);
  // A SIBLING of the artifact store rather than a table inside it: the server
  // owns this schema and `@des/core` owns that one, and a file whose
  // migrations are two packages' business belongs to neither.
  const runs = openRunDatabase({ path: join(path, "runs.sqlite") });

  return {
    name,
    path,
    project,
    commands,
    vcs,
    artifacts,
    journal,
    runtime,
    runs,
    design: designSource(project, vcs),
    close() {
      runs.close();
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
 * to strip and nothing to reconstruct — the oracles are ACTIVE as the oracle
 * graph authored them, so what the suite prints against the stub bodies IS the
 * red the crafter is looking at.
 */
export const runSuite = (project: string): SuiteRun => {
  const run = Bun.spawnSync(["bun", "test"], { cwd: project });
  return {
    output: `${run.stdout.toString()}${run.stderr.toString()}`.trim(),
    exitCode: run.exitCode ?? 1,
  };
};

/** Absolute path, for printing. */
export const shortPath = (path: string): string => resolve(path).replace(`${REPO}/`, "");
