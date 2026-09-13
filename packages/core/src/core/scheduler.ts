/**
 * The scheduler. Steps in, the frontier runs, the statuses come back.
 *
 * DELIVER is sequential today because one big model holds one context and one
 * linear log. Sequencing is a property of the executor, not of the work: once
 * the roadmap is a DAG in steps, the frontier is every step whose dependencies
 * are all `accepted`, and the frontier runs concurrently.
 *
 * Generic on purpose. A step is `{ id, dependencies }` and nothing else; what a
 * step MEANS, where it is read from, and what its run does are the consumer's
 * (`examples/nwave/deliver/pipeline.ts`). This file owns the frontier, the
 * concurrency limit, the resource leases, and termination.
 *
 * STATE IS A PROJECTION. The scheduler persists nothing of its own: it asks
 * `statusOf` for every step's status, reports each finished run through
 * `record`, and re-reads. That is nwave-experimental's `delivery_state.py`
 * stance — the next step is DERIVED from persisted facts and never decided —
 * and the consequence is the useful part: a scheduler that died mid-feature
 * restarts by reading rather than by remembering, and a step in flight has
 * nothing persisted so it simply reads `pending` and is run again.
 *
 * A `rejected` or `suspended` step blocks only its dependents, and that falls
 * out of the frontier rule rather than being enforced: a dependent of a step
 * that is not `accepted` never becomes ready, and every step not downstream of
 * it keeps running. A person's queue is therefore a list of independent
 * blocked subtrees.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { RunOutcome } from "./workflow.ts";

/** A step the scheduler orders. Everything else about it is the consumer's. */
export type SchedulerStep = { id: string; dependencies: string[] };

/**
 * What a step's status can be, as the projection reports it.
 *
 * `pending` covers both "never run" and "running right now", deliberately:
 * nothing is persisted until a run finishes, so the two are indistinguishable
 * to a reader and the honest thing to do with an unfinished run is to run it.
 * The scheduler knows which of its own steps are in flight and does not start
 * them twice; a SECOND scheduler on the same steps would, which is why
 * `record` is the consumer's place to refuse that.
 */
export const STEP_STATUSES = ["pending", "accepted", "rejected", "suspended"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/**
 * Named resources a run needs exclusively — a VM, a kernel table, a port.
 *
 * `acquire` takes the whole set at once and resolves when every name is free,
 * so two steps that share one serialize on it and two steps that share none do
 * not. Taking the set atomically is what makes that deadlock-free: a caller
 * never holds one name while waiting for another.
 */
export type ResourceLeases = {
  /** Take every name, then release with the returned function. */
  acquire(names: readonly string[]): Promise<() => void>;
};

/**
 * The in-memory implementation. FIFO among waiters, so which of two blocked
 * steps goes first is a function of the order they asked rather than of timing.
 */
export const inMemoryLeases = (): ResourceLeases => {
  const held = new Set<string>();
  const waiting: { names: readonly string[]; grant: () => void }[] = [];

  const free = (names: readonly string[]): boolean => names.every((name) => !held.has(name));

  /** Grant the first waiter that can now be satisfied, if any. */
  const pump = (): void => {
    const next = waiting.findIndex((w) => free(w.names));
    if (next < 0) return;
    const [waiter] = waiting.splice(next, 1);
    if (waiter === undefined) return;
    for (const name of waiter.names) held.add(name);
    waiter.grant();
  };

  const release = (names: readonly string[]) => (): void => {
    for (const name of names) held.delete(name);
    pump();
  };

  return {
    acquire: (names) =>
      new Promise((resolve) => {
        if (names.length === 0) {
          resolve(() => {});
          return;
        }
        if (free(names)) {
          for (const name of names) held.add(name);
          resolve(release(names));
          return;
        }
        waiting.push({ names, grant: () => resolve(release(names)) });
      }),
  };
};

export type SchedulerSpec<S> = {
  steps: readonly SchedulerStep[];
  /** Run one step to a terminal or a suspension. */
  runOne: (step: SchedulerStep) => Promise<RunOutcome<S>>;
  /** Continue a parked step with a person's answer. */
  resumeOne: (step: SchedulerStep, runId: string, answer: unknown) => Promise<RunOutcome<S>>;
  /** The step's status, as the consumer's own projection reports it. */
  statusOf: (stepId: string) => Promise<StepStatus>;
  /** Record a finished run, so `statusOf` will report it. */
  record: (stepId: string, outcome: RunOutcome<S>) => Promise<void>;
  /**
   * May this step run AT ALL, beyond its dependencies being accepted?
   *
   * The frontier rule answers "is everything this step waits on done". It does
   * not answer "is this step itself allowed to start", and a consumer with a
   * precondition of its own has nowhere else to put it: `statusOf` is about
   * what a step already IS, and a step that has not run is `pending` whether or
   * not it may.
   *
   * Read once per refresh, beside `statusOf`, so `ready` stays synchronous and
   * a consumer's answer is a projection like every other fact here. Absent:
   * every step is eligible, which is the behaviour before this existed.
   */
  eligible?: (stepId: string) => Promise<boolean>;
  /** How many steps may be in flight at once. At least 1. */
  concurrency: number;
  /** Named resources the step's run needs exclusively. */
  resourcesFor?: (step: SchedulerStep) => string[];
  leases?: ResourceLeases;
};

export type Scheduler = {
  /** Run until no step is ready and none is in flight. Returns every status. */
  run(): Promise<Map<string, StepStatus>>;
  /**
   * Continue a parked step and re-evaluate the frontier, so the steps that were
   * waiting on it run in the same call.
   */
  resume(stepId: string, answer: unknown): Promise<Map<string, StepStatus>>;
  /** The run id a parked step is waiting under, for a caller that wants it. */
  parked(): Map<string, string>;
};

export const openScheduler = <S>(spec: SchedulerSpec<S>): Scheduler => {
  if (!Number.isInteger(spec.concurrency) || spec.concurrency < 1) {
    throw new Error(`scheduler: concurrency must be a positive integer, not ${String(spec.concurrency)}`);
  }

  const byId = new Map(spec.steps.map((step) => [step.id, step] as const));
  /** The last known status per step. Re-read from the projection, never cached across a run. */
  const statuses = new Map<string, StepStatus>();
  /** Whether each step may run at all. Re-read beside its status. */
  const eligible = new Map<string, boolean>();
  /** The run id each parked step is waiting under. In memory: one scheduler, one process. */
  const waiting = new Map<string, string>();

  const refresh = async (): Promise<void> => {
    for (const step of spec.steps) {
      statuses.set(step.id, await spec.statusOf(step.id));
      eligible.set(step.id, spec.eligible === undefined ? true : await spec.eligible(step.id));
    }
  };

  /**
   * Steps that are eligible, whose every dependency is accepted, and which are
   * not already going.
   *
   * An INELIGIBLE step blocks its dependents exactly the way a rejected one
   * does, and for the same reason: nothing downstream of a step that may not
   * run becomes ready, and everything not downstream of it keeps running.
   */
  const ready = (running: ReadonlySet<string>): SchedulerStep[] =>
    spec.steps.filter(
      (step) =>
        statuses.get(step.id) === "pending" &&
        eligible.get(step.id) !== false &&
        !running.has(step.id) &&
        step.dependencies.every((id) => statuses.get(id) === "accepted"),
    );

  /** One step's run, under its resource leases if it declared any. */
  const drive = async (step: SchedulerStep): Promise<void> => {
    const names = spec.resourcesFor?.(step) ?? [];
    const release = spec.leases === undefined ? undefined : await spec.leases.acquire(names);
    try {
      const outcome = await spec.runOne(step);
      await spec.record(step.id, outcome);
      if (outcome.kind === "suspended") waiting.set(step.id, outcome.runId);
      else waiting.delete(step.id);
    } finally {
      release?.();
    }
  };

  /**
   * Run to quiescence.
   *
   * A `runOne` that THROWS is a graph bug and is not absorbed: everything a
   * graph decides is data, so a throw means the graph itself is malformed and
   * swallowing it would hide that behind a status. The in-flight promises all
   * carry handlers, so the throw propagates without leaving an unhandled
   * rejection behind it.
   */
  const loop = async (): Promise<Map<string, StepStatus>> => {
    await refresh();
    const running = new Map<string, Promise<{ id: string; error?: unknown }>>();

    for (;;) {
      while (running.size < spec.concurrency) {
        const next = ready(new Set(running.keys()))[0];
        if (next === undefined) break;
        running.set(
          next.id,
          drive(next).then(
            () => ({ id: next.id }),
            (error: unknown) => ({ id: next.id, error }),
          ),
        );
      }

      if (running.size === 0) return new Map(statuses);

      const done = await Promise.race([...running.values()]);
      running.delete(done.id);
      if (done.error !== undefined) throw done.error;
      // The projection is the source of truth, so it is re-read rather than
      // updated from the outcome the run returned.
      await refresh();
    }
  };

  return {
    run: loop,

    resume: async (stepId, answer) => {
      const step = byId.get(stepId);
      if (step === undefined) throw new Error(`scheduler: no step ${stepId}`);
      const runId = waiting.get(stepId);
      if (runId === undefined) {
        throw new Error(`scheduler: step ${stepId} is not parked, so there is no run to resume`);
      }
      const outcome = await spec.resumeOne(step, runId, answer);
      await spec.record(stepId, outcome);
      if (outcome.kind === "suspended") waiting.set(stepId, outcome.runId);
      else waiting.delete(stepId);
      // Re-evaluate the frontier: the steps that were waiting on this one run
      // in the same call, which is what makes a resume a continuation of the
      // feature rather than of one step.
      return await loop();
    },

    parked: () => new Map(waiting),
  };
};
