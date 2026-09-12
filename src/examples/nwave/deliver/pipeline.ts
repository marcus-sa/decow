/**
 * The composition: roadmap rows in, DELIVER runs out.
 *
 * This is the file that turns three examples into one pipeline. The roadmap is
 * rows; the step cycle is one fixed graph; the scheduler instantiates the graph
 * once per row and runs the ready set concurrently. Nothing about a feature
 * changes the graph.
 *
 * The generic half is `src/core/scheduler.ts`. What lives here is everything
 * consumer-shaped: where the rows come from, what a run outcome is persisted
 * as, how a row's status is derived from what was persisted, and how one row
 * becomes one DELIVER run.
 *
 * STATE IS A PROJECTION, which is the one design decision worth defending.
 * The scheduler persists nothing of its own: each finished run appends a
 * `step_runs` row, and a step's status is read back as the latest of those.
 * That mirrors nwave-experimental's `delivery_state.py` — "reading the owned
 * state as a projection", where the next step is DERIVED from persisted facts
 * and never decided, so a scheduler that died mid-feature restarts by reading
 * rather than by remembering. A row in flight has no `step_runs` row yet, so
 * it reads `pending` and is simply run again.
 */

import { openArtifacts, type ArtifactStore } from "../../../artifacts/store.ts";
import type { Journal } from "../../../core/journal.ts";
import { openScheduler, type ResourceLeases, type RowStatus, type SchedulerRow } from "../../../core/scheduler.ts";
import type { StepObserver } from "../../../core/step.ts";
import type { WorkflowRuntime } from "../../../core/compile.ts";
import { resume, run, type RunOutcome } from "../../../core/workflow.ts";
import { vcsExecutor } from "../../../vcs/executor.ts";
import type { Vcs } from "../../../vcs/index.ts";
import { identityKey } from "../../../vcs/structural/parser.ts";
import { deliverGraph, seed, type State } from "./graph.ts";
import type { DeliverDefs, StepUnderDelivery } from "./steps.ts";

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
  acceptance: { id: string; text: string; oracleLocator?: string }[];
  predictedTouches: string[];
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

/* ------------------------------------------------------------- the pipeline */

export type PipelineOptions = {
  /** Where the roadmap rows are read and the run rows are written. */
  artifacts: ArtifactStore;
  /** The repository the runs write code into. */
  vcs: Vcs;
  /** One journal for every run, so a repeated decision is replayed, not re-inferred. */
  journal: Journal;
  defs: DeliverDefs;
  /** The roadmap to deliver, by its own row id. */
  roadmapId: string;
  /** The design source every step is implemented against, verbatim. */
  design: string;
  /**
   * Verbatim runner output the RED leaf classifies. Supplied rather than
   * produced: `run-tests.red` is still a leaf, so the first run's output is
   * the one thing this pipeline hands it rather than derives.
   */
  evidence?: string;
  /** How many rows may run at once. */
  concurrency?: number;
  /** Shared test infrastructure a row needs, by name. */
  resourcesFor?: (row: RoadmapRow) => string[];
  leases?: ResourceLeases;
  /**
   * Where each leaf's attempts are reported, PER ROW. A factory rather than
   * one observer, because a record's most useful field is which roadmap step
   * it belongs to and the journal key does not carry it: the row id is inside
   * the hashed input, not in the key. Building the observer where the row is
   * known is cheaper than parsing it back out. Inert in the graph.
   */
  observe?: (rowId: string) => StepObserver;
  /**
   * Each finished run, as it finishes, before it is persisted. The `step_runs`
   * row records the outcome and the run id; the TRACE only exists on the
   * outcome, so a caller that wants to print where a row went needs it here.
   */
  onRun?: (rowId: string, outcome: RunOutcome<State>) => void;
  /**
   * Where each row's snapshot lives. The process-wide in-memory runtime by
   * default; a durable one when a suspended row has to outlive the command
   * that produced it.
   */
  runtime?: WorkflowRuntime;
};

/**
 * One roadmap row as the step cycle's input.
 *
 * `criteria` is the observation plus every obligation's text, because that is
 * what "the acceptance criteria, verbatim" means when the criteria are rows.
 */
export const stepUnderDelivery = (row: RoadmapRow, design: string): StepUnderDelivery => ({
  id: row.id,
  criteria: [row.observation, ...row.acceptance.map((a) => a.text)].join("\n"),
  design,
  authority: row.authority,
  acceptance: row.acceptance,
  predictedTouches: row.predictedTouches,
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
 * The scheduler, composed over one roadmap.
 *
 * Every row runs as its own VCS SESSION, named by the row id, so two rows in
 * flight hold two leases rather than colliding on the one a session may hold;
 * and under its own TASK id, also the row id, so the event log's answer to
 * "what changed" joins the journal's answer to "what did this step decide" on
 * one key.
 *
 * The row id is also in every leaf's journal input, because `StepUnderDelivery`
 * carries it and the input is what the journal key hashes. Two rows therefore
 * cannot share a key, which is what stops one row's decision replaying as
 * another's.
 */
export const openPipeline = (options: PipelineOptions) => {
  const { artifacts, vcs, journal, defs, design } = options;
  const rows = readRoadmap(artifacts, options.roadmapId);
  const byId = new Map(rows.map((row) => [row.id, row] as const));

  const rowFor = (id: string): RoadmapRow => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`pipeline: no row ${id}`);
    return row;
  };

  const executorFor = (row: RoadmapRow) =>
    vcsExecutor({
      vcs,
      session: row.id,
      intent: { taskId: row.id, parentTaskId: options.roadmapId, description: row.observation },
      artifacts,
    });

  const stateFor = (row: RoadmapRow): State => {
    const { symbolVersion, impacted } = predicted(vcs, row);
    return {
      ...seed(stepUnderDelivery(row, design), options.evidence ?? "", impacted),
      symbolVersion,
    };
  };

  const scheduler = openScheduler<State>({
    rows: rows.map((row): SchedulerRow => ({ id: row.id, dependencies: row.dependencies })),
    concurrency: options.concurrency ?? rows.length,
    ...(options.resourcesFor === undefined
      ? {}
      : { resourcesFor: (r: SchedulerRow) => (options.resourcesFor as (row: RoadmapRow) => string[])(rowFor(r.id)) }),
    ...(options.leases === undefined ? {} : { leases: options.leases }),

    runOne: async (r) => {
      const row = rowFor(r.id);
      return await run<State>(
        deliverGraph(journal, defs, options.observe?.(row.id)),
        stateFor(row),
        executorFor(row),
        options.runtime,
      );
    },

    resumeOne: async (r, runId, answer) => {
      const row = rowFor(r.id);
      return await resume<State>(
        deliverGraph(journal, defs, options.observe?.(row.id)),
        runId,
        answer,
        executorFor(row),
        options.runtime,
      );
    },

    statusOf: async (id) => statusOf(artifacts, id),

    record: async (id, outcome) => {
      options.onRun?.(id, outcome);
      const seq = runsOf(artifacts, id).length;
      const row: StepRun = {
        stepId: id,
        runId: outcome.runId,
        outcome: outcomeStatus(outcome),
        seq,
      };
      // One row per run, never an update: the projection reads the latest and
      // the history is what "did it ever fail" is answered from.
      const written = artifacts.upsert({
        table: STEP_RUNS_TABLE,
        id: `${id}#${seq}`,
        expectedVersion: 0,
        row,
      });
      if (written.outcome !== "committed") {
        throw new Error(
          `pipeline: run ${seq} of ${id} is already recorded — two schedulers are driving one roadmap`,
        );
      }
    },
  });

  /**
   * Continue a row this or ANY EARLIER process parked, then re-evaluate the
   * frontier so the rows waiting on it run in the same call.
   *
   * `Scheduler.resume` reads the parked run id out of its own memory, which is
   * the right answer inside one process and no answer at all across two. The
   * pipeline has a better source: `record` persisted the run id on the
   * `step_runs` row, so the projection that answers "what is this row's
   * status" also answers "which run is it parked under". That is the same
   * state-is-a-projection stance one field over, and it is what lets a person
   * answer a suspension with a command rather than with a handle.
   */
  const resumeParked = async (rowId: string, answer: unknown) => {
    const row = rowFor(rowId);
    const last = runsOf(artifacts, rowId).at(-1);
    if (last === undefined || last.outcome !== "suspended") {
      throw new Error(`pipeline: row ${rowId} is not parked, so there is no run to resume`);
    }
    const outcome = await resume<State>(
      deliverGraph(journal, defs, options.observe?.(rowId)),
      last.runId,
      answer,
      executorFor(row),
      options.runtime,
    );
    options.onRun?.(rowId, outcome);
    const seq = runsOf(artifacts, rowId).length;
    artifacts.upsert({
      table: STEP_RUNS_TABLE,
      id: `${rowId}#${seq}`,
      expectedVersion: 0,
      row: { stepId: rowId, runId: outcome.runId, outcome: outcomeStatus(outcome), seq } satisfies StepRun,
    });
    return { outcome, statuses: await scheduler.run() };
  };

  return { scheduler, rows, resumeParked };
};

/** A run outcome, in the scheduler's vocabulary. */
export const outcomeStatus = <S>(outcome: RunOutcome<S>): Exclude<RowStatus, "pending"> =>
  outcome.kind === "suspended" ? "suspended" : outcome.terminal.kind;

/** Re-exported so a caller composing this has one module to read. */
export { openArtifacts, identityKey };
