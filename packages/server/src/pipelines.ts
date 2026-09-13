/**
 * A pipeline, driven. The steps are the consumer's; the scheduling is the
 * server's; every step's run is an ordinary run.
 *
 * This is the half that moved. A pipeline registration used to own `run` and
 * `resume` and call `@des/core`'s `run` itself, which meant a step's run had no
 * server run id, published no events, and parked where no dialog could reach
 * it — a run nobody could watch and a suspension nobody could answer. Now the
 * server schedules: `openScheduler` over the declared steps, `runOne` is
 * `runner.start(step.workflowId, step.input)`, and the scheduler awaits that
 * run's terminal or suspension exactly as it awaited a direct call.
 *
 * WHAT A STEP'S STATUS IS, AND WHERE IT COMES FROM. The scheduler needs a
 * status per step; the server has one, because it started the run and holds its
 * record. `pending` covers "never started" and "running right now", which is
 * the scheduler's own reading of `pending` and is what makes an interrupted
 * step simply run again. A consumer's `readiness` rides beside it as
 * `eligible`, because "may this step start at all" is a question a status
 * cannot answer.
 *
 * WHAT A CONSUMER STILL OWNS. `record`, which is where the durable row goes,
 * and `readiness`, which is where the precondition goes. Neither runs anything.
 */

import { openScheduler, type StepStatus, type SchedulerStep } from "@des/core/scheduler";
import type { RunOutcome } from "@des/core/workflow";
import type { PipelineRegistration, PipelineStep } from "./registration.ts";
import type { Registry, StepOwner } from "./registry.ts";

/** One step, with what the server knows about the run it last started for it. */
export type PipelineStepView = PipelineStep & {
  status: StepStatus;
  /** The run this step is on, once the server has started one. */
  runId?: string;
};

export type PipelineTree = {
  id: string;
  title: string;
  steps: PipelineStepView[];
  /** Is a drive in flight right now? */
  driving: boolean;
  /** Why the last drive stopped early, when one did. */
  error?: string;
};

/**
 * The run this pipeline last started for this step, if it started one.
 *
 * READ OFF THE EVENT LOG rather than off a map, which is what makes a step
 * survive a restart. A `pipeline-step` event names the pipeline, the step and
 * the run the server attached to it, and the log is append-only and ordered —
 * so the last one that named a run IS the run the step is on, in this process
 * or in the next one over the same directory.
 */
export const runIdOf = (registry: Registry, pipelineId: string, stepId: string): string | undefined => {
  for (const event of [...registry.runs.db.events.byKind("pipeline-step")].reverse()) {
    const payload = event.payload as { pipelineId?: unknown; stepId?: unknown; runId?: unknown };
    if (payload.pipelineId !== pipelineId || payload.stepId !== stepId) continue;
    if (typeof payload.runId === "string") return payload.runId;
  }
  return undefined;
};

/** The pipeline step a run belongs to, for a run that is one. */
export const ownerOf = (registry: Registry, runId: string): StepOwner | undefined => {
  for (const event of [...registry.runs.db.events.byKind("pipeline-step")].reverse()) {
    const payload = event.payload as { pipelineId?: unknown; stepId?: unknown; runId?: unknown };
    if (payload.runId !== runId) continue;
    if (typeof payload.pipelineId === "string" && typeof payload.stepId === "string") {
      return { pipelineId: payload.pipelineId, stepId: payload.stepId };
    }
  }
  return undefined;
};

/**
 * A step's status, read off the run the server started for it.
 *
 * `failed` is a graph bug rather than a declared ending, and it reads
 * `rejected` here because that is what it means to the frontier: the step did
 * not succeed, so nothing downstream of it becomes ready.
 */
export const statusOf = (registry: Registry, pipelineId: string, stepId: string): StepStatus => {
  const runId = runIdOf(registry, pipelineId, stepId);
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

/**
 * Say which run a step is on. The saying IS the remembering: the event is
 * appended before it is published, so the attachment is durable by the time
 * anybody hears about it.
 */
const attach = (registry: Registry, pipelineId: string, step: PipelineStep, runId: string): void => {
  registry.events.emit({
    type: "pipeline-step",
    pipelineId,
    stepId: step.id,
    status: "pending",
    runId,
  });
};

/** Say where a step ended up, once its run settled. */
const announce = (registry: Registry, pipelineId: string, stepId: string): void => {
  registry.events.emit({
    type: "pipeline-step",
    pipelineId,
    stepId,
    status: statusOf(registry, pipelineId, stepId),
    ...(runIdOf(registry, pipelineId, stepId) === undefined
      ? {}
      : { runId: runIdOf(registry, pipelineId, stepId) as string }),
  });
};

/** The steps, each with the status the server projects for it. */
export const tree = async (
  registry: Registry,
  pipeline: PipelineRegistration,
): Promise<PipelineTree> => {
  const steps = await pipeline.steps();
  const error = registry.errors.get(pipeline.id);
  return {
    id: pipeline.id,
    title: pipeline.title,
    steps: steps.map((step) => ({
      ...step,
      status: statusOf(registry, pipeline.id, step.id),
      ...(runIdOf(registry, pipeline.id, step.id) === undefined
        ? {}
        : { runId: runIdOf(registry, pipeline.id, step.id) as string }),
    })),
    driving: registry.driving.has(pipeline.id),
    ...(error === undefined ? {} : { error }),
  };
};

/**
 * Run the frontier to quiescence.
 *
 * The scheduler is built per drive rather than held, because the steps are
 * re-read per drive: a roadmap this same server authored may have grown since
 * the last one, and a scheduler over a stale step set would schedule a roadmap
 * nobody has.
 */
const driveOnce = async (registry: Registry, pipeline: PipelineRegistration): Promise<void> => {
  const steps = await pipeline.steps();
  const byId = new Map(steps.map((step) => [step.id, step] as const));
  const stepFor = (id: string): PipelineStep => {
    const step = byId.get(id);
    if (step === undefined) throw new Error(`pipeline ${pipeline.id}: no step ${id}`);
    return step;
  };

  const scheduler = openScheduler<unknown>({
    steps: steps.map((step): SchedulerStep => ({ id: step.id, dependencies: step.dependencies })),
    concurrency: Math.max(1, pipeline.concurrency ?? steps.length),
    leases: registry.leases,
    resourcesFor: (r: SchedulerStep) => pipeline.resourcesFor?.(stepFor(r.id)) ?? [],

    runOne: async (r) => {
      const step = stepFor(r.id);
      const started = registry.runner.start(step.workflowId, step.input);
      attach(registry, pipeline.id, step, started.runId);
      try {
        return await started.settled;
      } finally {
        announce(registry, pipeline.id, step.id);
      }
    },

    resumeOne: async (r, runId, answer) => {
      const settled = registry.runner.resume(runId, answer);
      if (settled === undefined) {
        throw new Error(`pipeline ${pipeline.id}: run ${runId} of step ${r.id} cannot be resumed`);
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
 * A consumer refuses by NAME — a `record` that will not write twice, a step set
 * that names a step nobody has — and a refusal nobody can read is a pipeline
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
 * A run that belongs to a pipeline step has just been resumed: record it when
 * it settles, then re-evaluate the frontier.
 *
 * This is what makes answering a suspension a continuation of the PIPELINE
 * rather than of the step, and it fires whichever dialog the person used — the
 * step's, or the run page's, because both go through the same resume.
 */
export const continueAfterResume = (
  registry: Registry,
  owner: { pipelineId: string; stepId: string },
  settled: Promise<RunOutcome<unknown>>,
): void => {
  const pipeline = registry.pipelineById.get(owner.pipelineId);
  if (pipeline === undefined) return;
  registry.track(
    (async () => {
      try {
        const outcome = await settled;
        announce(registry, pipeline.id, owner.stepId);
        await pipeline.record?.(owner.stepId, outcome);
      } catch (error) {
        registry.errors.set(pipeline.id, String(error));
        return;
      }
      await drive(registry, pipeline);
    })(),
  );
};
