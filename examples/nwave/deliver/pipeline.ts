/**
 * The rows, and what a finished run of one is persisted as.
 *
 * This is the file that turns three examples into one pipeline — the roadmap
 * is rows, the step cycle is one fixed graph, and one row becomes one run of
 * it. What lives here is everything consumer-shaped: where the rows come from,
 * what one row's run is seeded with, what its outcome is persisted as, and how
 * a row's status is derived from what was persisted.
 *
 * NOTHING HERE SCHEDULES ANYTHING, and that is the shape of this cut. A
 * pipeline registration is data plus two hooks; the SERVER drives the frontier
 * through `@des/core`'s scheduler and starts each ready row as an ordinary run
 * of the registered `deliver` graph. So a row has a run id, a live trace,
 * events, and a suspension a person answers in the same dialog they answer any
 * other run in — none of which a composition that called `run()` itself could
 * offer.
 *
 * STATE IS A PROJECTION, and it still is where it matters. Each finished run
 * appends a `step_runs` row and a step's history is read back as those rows;
 * that is the durable record of what this roadmap has been through, and it is
 * what `runsOf` answers "did it ever fail" from.
 */

import type { ArtifactStore } from "@des/core/artifacts";
import { normalizeCommand, type Commands } from "@des/core/commands";
import type { RowStatus } from "@des/core/scheduler";
import type { RunOutcome } from "@des/core/workflow";
import type { Vcs } from "@des/core/vcs";
import { parseOracleLocator } from "@des/core/vcs/verify";
import { seed, type State } from "./graph.ts";
import type { StepUnderDelivery } from "./steps.ts";

/**
 * The test ids one oracle locator names, out of the symbol inventory.
 *
 * `test.route` reads these as the set membership that tells "my own oracle is
 * still red" from "I broke something else". They are resolved ONCE, where the
 * row becomes a run, rather than inside the graph: the oracle was authored and
 * measured in an earlier run, and a graph that re-resolved it would be reading
 * an inventory that has moved since.
 *
 * A bare path names every test in the file; a `path::selector` names the tests
 * whose name is that selector. A locator naming nothing resolves to nothing,
 * and the graph reads the absence honestly: with no ids of its own, every
 * failure is `broke-other`.
 */
export const oracleTests = (vcs: Vcs, oracle: string | undefined): string[] => {
  if (oracle === undefined) return [];
  const { path, selector } = parseOracleLocator(oracle);
  const file = vcs.registry.file(path);
  if (file === undefined) return [];
  return vcs.registry
    .symbolsOf(file.id)
    .filter((s) => s.kind === "test" && (selector === undefined || s.name === selector))
    .map((s) => s.id);
};

/* --------------------------------------------------------------- the rows */

/** The tables the roadmap workflow writes and this one reads. */
export const ROADMAP_TABLE = "roadmaps";
export const ROADMAP_STEPS_TABLE = "roadmap_steps";

/** Where a run's outcome is recorded. Append-only, one row per run. */
export const STEP_RUNS_TABLE = "step_runs";

/** One roadmap row, as much of it as the pipeline reads. */
export type RoadmapRow = {
  id: string;
  observation: string;
  dependencies: string[];
  authority: string;
  acceptance: { id: string; stimulus: string; expected: string }[];
  predictedTouches: string[];
  /** The one oracle DISTILL declared for this row, and measured red. */
  oracle?: string;
  supports: string[];
};

/** What a finished run is persisted as. */
export type StepRun = {
  stepId: string;
  runId: string;
  /** The outcome, in the scheduler's own vocabulary. */
  outcome: Exclude<RowStatus, "pending">;
  /** How many runs of this step came before it. The projection reads the last. */
  seq: number;
};

/**
 * The roadmap's rows, in the order the `roadmaps` row lists them.
 *
 * The join is through that row's `stepIds` rather than a scan of
 * `roadmap_steps`, because a store may hold more than one roadmap and a scan
 * would mix them.
 */
export const readRoadmap = (artifacts: ArtifactStore, roadmapId: string): RoadmapRow[] => {
  const roadmap = artifacts.read(ROADMAP_TABLE, roadmapId);
  if (roadmap === undefined) throw new Error(`pipeline: no roadmap ${roadmapId} in the artifact store`);
  const stepIds = (roadmap.row as { stepIds?: unknown }).stepIds;
  if (!Array.isArray(stepIds)) throw new Error(`pipeline: roadmap ${roadmapId} lists no step ids`);

  return stepIds.map((id) => {
    const row = artifacts.read(ROADMAP_STEPS_TABLE, String(id));
    if (row === undefined) throw new Error(`pipeline: roadmap ${roadmapId} names a missing step ${String(id)}`);
    return row.row as RoadmapRow;
  });
};

/** Every recorded run of one step, oldest first. */
export const runsOf = (artifacts: ArtifactStore, stepId: string): StepRun[] =>
  artifacts
    .list(STEP_RUNS_TABLE)
    .map((r) => r.row as StepRun)
    .filter((r) => r.stepId === stepId)
    .sort((a, b) => a.seq - b.seq);

/**
 * A step's status, derived from the latest run recorded for it. No row means
 * `pending`, which is also what a run in flight reads: nothing is persisted
 * until it finishes, so a scheduler that died mid-run simply runs it again.
 */
export const statusOf = (artifacts: ArtifactStore, stepId: string): RowStatus =>
  runsOf(artifacts, stepId).at(-1)?.outcome ?? "pending";

/**
 * One roadmap row as the step cycle's input.
 *
 * `criteria` is the observation plus every obligation rendered as the pair it
 * is, `stimulus -> expected`, because that is what "the acceptance criteria,
 * verbatim" means when the criteria are rows.
 */
export const stepUnderDelivery = (row: RoadmapRow, design: string): StepUnderDelivery => ({
  id: row.id,
  criteria: [row.observation, ...row.acceptance.map((a) => `${a.stimulus} -> ${a.expected}`)].join("\n"),
  design,
  authority: row.authority,
  acceptance: row.acceptance,
  predictedTouches: row.predictedTouches,
  ...(row.oracle === undefined ? {} : { oracle: row.oracle }),
});

/**
 * The first of the row's predicted touches that names a live symbol, as the
 * version the first `replace-symbol` claims, and the impact floor for it.
 *
 * A row that predicted nothing the registry knows gets version 0 and an empty
 * floor, which the graph handles: the write comes back `conflict` carrying the
 * real version and the retry rebases onto it. This is the cheap read that
 * saves an iteration, not a correctness requirement.
 */
const predicted = (vcs: Vcs, row: RoadmapRow): { symbolVersion: number; impacted: string[] } => {
  for (const touch of row.predictedTouches) {
    const symbol = vcs.registry.symbol(touch);
    if (symbol === undefined || symbol.tombstoned) continue;
    return {
      symbolVersion: symbol.version,
      impacted: vcs.impact.impactedTests([symbol.id]).map((t) => t.id),
    };
  }
  return { symbolVersion: 0, impacted: [] };
};

/**
 * The files this row writes, resolved through the registry.
 *
 * A predicted touch is a SYMBOL id, which is opaque, and the quality gate
 * needs paths. The registry is the only thing that can map one to the other,
 * so the mapping happens here, once, where the row becomes a run — the same
 * boundary the acceptance-test ids and the impact floor already sit on.
 *
 * A touch that names no live symbol contributes nothing, which is honest: the
 * row predicted something the repository does not hold, and inventing a path
 * for it would lint a file nobody named.
 */
export const writtenPaths = (vcs: Vcs, row: RoadmapRow): string[] => {
  const paths = new Set<string>();
  for (const touch of row.predictedTouches) {
    const symbol = vcs.registry.symbol(touch);
    if (symbol === undefined || symbol.tombstoned) continue;
    const file = vcs.registry.fileById(symbol.fileId);
    if (file !== undefined) paths.add(file.path);
  }
  return [...paths].sort();
};

/**
 * One roadmap row as the step cycle's whole seed state.
 *
 * Four facts the graph reads but cannot derive, resolved once where the row
 * becomes a run: the version the first write claims, the impact floor under
 * its test selection, the files its quality gate lints, and the test ids its
 * own oracle names. Every one of them is a question for the registry, and a
 * graph that asked it would be reading an inventory that has moved since the
 * oracle was measured.
 *
 * Exported because the scheduler is not the only thing that starts one of
 * these runs: a person starting a single row from the server starts the same
 * graph, and two ways of seeding it would be two definitions of what a row IS.
 */
export const deliverSeed = (spec: {
  vcs: Vcs;
  row: RoadmapRow;
  design: string;
  /** Verbatim runner output the classifying leaves quote. */
  evidence: string;
}): State => {
  const { symbolVersion, impacted } = predicted(spec.vcs, spec.row);
  return {
    ...seed(
      stepUnderDelivery(spec.row, spec.design),
      spec.evidence,
      impacted,
      writtenPaths(spec.vcs, spec.row),
    ),
    symbolVersion,
    acceptanceTests: oracleTests(spec.vcs, spec.row.oracle),
  };
};


/**
 * The exported comment on `deliverSeed` above is the join point: a person
 * starting one row by hand and the scheduler starting the same row both reach
 * the registered `deliver` graph through the same seed, so the readiness
 * precondition cannot be escaped by picking a different door.
 */

/* ------------------------------------------------- what a finished run leaves */

/** A run outcome, in the scheduler's vocabulary. */
export const outcomeStatus = <S>(outcome: RunOutcome<S>): Exclude<RowStatus, "pending"> =>
  outcome.kind === "suspended" ? "suspended" : outcome.terminal.kind;

/**
 * Append one `step_runs` row for a finished run.
 *
 * This is the whole of what a DELIVER pipeline registration's `record` does,
 * and it is one row per run rather than an update: the history is what "did it
 * ever fail" is answered from, and `runsOf` reads it in order.
 *
 * A duplicate is refused BY NAME rather than overwritten, because two rows at
 * the same sequence means two things are driving one roadmap and the honest
 * answer is to say so.
 */
export const recordStepRun = <S>(
  artifacts: ArtifactStore,
  stepId: string,
  outcome: RunOutcome<S>,
): StepRun => {
  const seq = runsOf(artifacts, stepId).length;
  const row: StepRun = { stepId, runId: outcome.runId, outcome: outcomeStatus(outcome), seq };
  const written = artifacts.upsert({
    table: STEP_RUNS_TABLE,
    id: `${stepId}#${seq}`,
    expectedVersion: 0,
    row,
  });
  if (written.outcome !== "committed") {
    throw new Error(
      `pipeline: run ${seq} of ${stepId} is already recorded — two things are driving one roadmap`,
    );
  }
  return row;
};

/**
 * Every resource this row's own declared commands name.
 *
 * `run-command.resources` is where a consumer says "this needs the shared
 * database", and the scheduler is where two rows that both need it are made to
 * take turns. The join is here: the row's arguments go into the declarations,
 * and the union of what they declare comes back out as the lease names the
 * server takes before the run.
 *
 * The JUnit path is a placeholder, deliberately. A declaration whose
 * `resources` depended on where a report was written would be declaring
 * something other than shared infrastructure.
 */
export const declaredResources = (vcs: Vcs, commands: Commands, row: RoadmapRow): string[] => {
  const { path, selector } = parseOracleLocator(row.oracle ?? "");
  const args = { file: path, ...(selector === undefined ? {} : { selector }), junit: "" };
  const declared = [
    commands.typecheck({}),
    commands.lint({ paths: writtenPaths(vcs, row) }),
    commands.tests(args),
    commands.oracle(args),
  ];
  return [...new Set(declared.flatMap((c) => normalizeCommand(c).resources ?? []))].sort();
};

/**
 * The tests every OTHER undelivered value's oracle names.
 *
 * Every one of them is red by construction: a value is only ready to be
 * delivered once its oracle has been measured red, so a value that has not
 * been delivered has a live failing test in every module it shares with its
 * siblings. Refusing this row's correct write for one of them would make a
 * module with two undelivered values undeliverable, and it would be answering
 * the wrong question: the gate asks whether the change broke something ELSE.
 *
 * An ACCEPTED sibling's oracle is not in here, deliberately. That one is
 * green, and breaking it is a real regression the gate exists to catch.
 */
export const knownRedTests = (
  artifacts: ArtifactStore,
  vcs: Vcs,
  rows: RoadmapRow[],
  rowId: string,
): string[] =>
  rows
    .filter((other) => other.id !== rowId && statusOf(artifacts, other.id) !== "accepted")
    .flatMap((other) => oracleTests(vcs, other.oracle));
