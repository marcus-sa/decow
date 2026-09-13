/**
 * A pipeline, driven. The rows are the consumer's; the scheduling is the
 * server's; every row's run is an ordinary run.
 *
 * This is the half that moved. A pipeline registration used to own `run` and
 * `resume` and call `@des/core`'s `run` itself, which meant a row's run had no
 * server run id, published no events, and parked where no dialog could reach
 * it — a run nobody could watch and a suspension nobody could answer. Now the
 * server schedules: `openScheduler` over the declared rows, `runOne` is
 * `runner.start(row.workflowId, row.input)`, and the scheduler awaits that
 * run's terminal or suspension exactly as it awaited a direct call.
 *
 * WHAT A ROW'S STATUS IS, AND WHERE IT COMES FROM. The scheduler needs a
 * status per row; the server has one, because it started the run and holds its
 * record. `pending` covers "never started" and "running right now", which is
 * the scheduler's own reading of `pending` and is what makes an interrupted
 * row simply run again. A consumer's `readiness` rides beside it as
 * `eligible`, because "may this row start at all" is a question a status
 * cannot answer.
 *
 * WHAT A CONSUMER STILL OWNS. `record`, which is where the durable row goes,
 * and `readiness`, which is where the precondition goes. Neither runs anything.
 */

import { openScheduler, type RowStatus, type SchedulerRow } from "@des/core/scheduler";
import type { RunOutcome } from "@des/core/workflow";
import type { PipelineRegistration, PipelineRow } from "./registration.ts";
import type { Registry } from "./registry.ts";

/** One row, with what the server knows about the run it last started for it. */
export type PipelineRowView = PipelineRow & {
  status: RowStatus;
  /** The run this row is on, once the server has started one. */
  runId?: string;
};

export type PipelineTree = {
  id: string;
  title: string;
  rows: PipelineRowView[];
  /** Is a drive in flight right now? */
  driving: boolean;
  /** Why the last drive stopped early, when one did. */
  error?: string;
};

/** The run this pipeline last started for this row, if it started one. */
export const runIdOf = (registry: Registry, pipelineId: string, rowId: string): string | undefined =>
  registry.pipelineRuns.get(pipelineId)?.get(rowId);

/**
 * A row's status, read off the run the server started for it.
 *
 * `failed` is a graph bug rather than a declared ending, and it reads
 * `rejected` here because that is what it means to the frontier: the row did
 * not succeed, so nothing downstream of it becomes ready.
 */
export const statusOf = (registry: Registry, pipelineId: string, rowId: string): RowStatus => {
  const runId = runIdOf(registry, pipelineId, rowId);
  const record = runId === undefined ? undefined : registry.runs.get(runId);
  switch (record?.status) {
    case "accepted":
      return "accepted";
    case "suspended":
      return "suspended";
    case "rejected":
    case "failed":
      return "rejected";
    default:
      return "pending";
  }
};

/** Remember which run a row is on, and say so. */
const attach = (registry: Registry, pipelineId: string, row: PipelineRow, runId: string): void => {
  const rows = registry.pipelineRuns.get(pipelineId) ?? new Map<string, string>();
  registry.pipelineRuns.set(pipelineId, rows);
  rows.set(row.id, runId);
  registry.rowOwners.set(runId, { pipelineId, rowId: row.id });
  registry.events.emit({
    type: "pipeline-row",
    pipelineId,
    rowId: row.id,
    status: "pending",
    runId,
  });
};

/** Say where a row ended up, once its run settled. */
const announce = (registry: Registry, pipelineId: string, rowId: string): void => {
  registry.events.emit({
    type: "pipeline-row",
    pipelineId,
    rowId,
    status: statusOf(registry, pipelineId, rowId),
    ...(runIdOf(registry, pipelineId, rowId) === undefined
      ? {}
      : { runId: runIdOf(registry, pipelineId, rowId) as string }),
  });
};

/** The rows, each with the status the server projects for it. */
export const tree = async (
  registry: Registry,
  pipeline: PipelineRegistration,
): Promise<PipelineTree> => {
  const rows = await pipeline.rows();
  const error = registry.errors.get(pipeline.id);
  return {
    id: pipeline.id,
    title: pipeline.title,
    rows: rows.map((row) => ({
      ...row,
      status: statusOf(registry, pipeline.id, row.id),
      ...(runIdOf(registry, pipeline.id, row.id) === undefined
        ? {}
        : { runId: runIdOf(registry, pipeline.id, row.id) as string }),
    })),
    driving: registry.driving.has(pipeline.id),
    ...(error === undefined ? {} : { error }),
  };
};

/**
 * Run the frontier to quiescence.
 *
 * The scheduler is built per drive rather than held, because the rows are
 * re-read per drive: a roadmap this same server authored may have grown since
 * the last one, and a scheduler over a stale row set would schedule a roadmap
 * nobody has.
 */
const driveOnce = async (registry: Registry, pipeline: PipelineRegistration): Promise<void> => {
  const rows = await pipeline.rows();
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const rowFor = (id: string): PipelineRow => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`pipeline ${pipeline.id}: no row ${id}`);
    return row;
  };

  const scheduler = openScheduler<unknown>({
    rows: rows.map((row): SchedulerRow => ({ id: row.id, dependencies: row.dependencies })),
    concurrency: Math.max(1, pipeline.concurrency ?? rows.length),
    leases: registry.leases,
    resourcesFor: (r: SchedulerRow) => pipeline.resourcesFor?.(rowFor(r.id)) ?? [],

    runOne: async (r) => {
      const row = rowFor(r.id);
      const started = registry.runner.start(row.workflowId, row.input);
      attach(registry, pipeline.id, row, started.runId);
      try {
        return await started.settled;
      } finally {
        announce(registry, pipeline.id, row.id);
      }
    },

    resumeOne: async (r, runId, answer) => {
      const settled = registry.runner.resume(runId, answer);
      if (settled === undefined) {
        throw new Error(`pipeline ${pipeline.id}: run ${runId} of row ${r.id} cannot be resumed`);
      }
      try {
        return await settled;
      } finally {
        announce(registry, pipeline.id, r.id);
      }
    },

    statusOf: async (id) => statusOf(registry, pipeline.id, id),

    ...(pipeline.readiness === undefined
      ? {}
      : { eligible: async (id: string) => await pipeline.readiness?.(id) === true }),

    record: async (id, outcome) => {
      await pipeline.record?.(id, outcome as RunOutcome<unknown>);
    },
  });

  await scheduler.run();
};

/**
 * Drive a pipeline, holding whatever refused it where a reader can find it.
 *
 * A consumer refuses by NAME — a `record` that will not write twice, a row set
 * that names a row nobody has — and a refusal nobody can read is a pipeline
 * that silently did nothing. It is held rather than thrown into the void
 * because the drive is asynchronous: whatever started it answered long ago.
 */
export const drive = async (registry: Registry, pipeline: PipelineRegistration): Promise<void> => {
  registry.driving.add(pipeline.id);
  registry.errors.delete(pipeline.id);
  try {
    await driveOnce(registry, pipeline);
  } catch (error) {
    registry.errors.set(pipeline.id, String(error));
  } finally {
    registry.driving.delete(pipeline.id);
  }
};

/** Start a drive, unless one is already going. */
export const start = (registry: Registry, pipeline: PipelineRegistration): { started: boolean } => {
  if (registry.driving.has(pipeline.id)) return { started: false };
  registry.track(drive(registry, pipeline));
  return { started: true };
};

/**
 * A run that belongs to a pipeline row has just been resumed: record it when
 * it settles, then re-evaluate the frontier.
 *
 * This is what makes answering a suspension a continuation of the PIPELINE
 * rather than of the row, and it fires whichever dialog the person used — the
 * row's, or the run page's, because both go through the same resume.
 */
export const continueAfterResume = (
  registry: Registry,
  owner: { pipelineId: string; rowId: string },
  settled: Promise<RunOutcome<unknown>>,
): void => {
  const pipeline = registry.pipelineById.get(owner.pipelineId);
  if (pipeline === undefined) return;
  registry.track(
    (async () => {
      try {
        const outcome = await settled;
        announce(registry, pipeline.id, owner.rowId);
        await pipeline.record?.(owner.rowId, outcome);
      } catch (error) {
        registry.errors.set(pipeline.id, String(error));
        return;
      }
      await drive(registry, pipeline);
    })(),
  );
};
