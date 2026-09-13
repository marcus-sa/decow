/**
 * The registry: everything the server knows, in one value, plus the one slot
 * the request handlers read it from.
 *
 * A server function is a function. It is handed a validated argument and
 * nothing else — no server instance, no closure over the process that started
 * it — so the registrations, the runs, the runner and the event bus have to be
 * reachable from module scope. This is that scope: `serve` builds a registry
 * and sets it, and every server function reads it back.
 *
 * IT LIVES ON `globalThis`, deliberately. The UI is built by Vite into a
 * server bundle that the same process loads, and whether a bundler decides to
 * inline a module or import it is a bundler's business rather than a
 * correctness boundary. A well-known symbol is a slot two copies of this
 * module agree about; a module-level `let` is one two copies do not.
 *
 * Everything else here is in memory on purpose. The durable half of a run is
 * already durable somewhere better — the engine's snapshot, the journal, the
 * VCS event log, the consumer's own artifact rows — and losing this costs a
 * reader their scroll position rather than a fact.
 */

import type { ArtifactStore } from "@des/core/artifacts";
import { openWorkflowRuntime, type WorkflowRuntime } from "@des/core/compile";
import { inMemoryLeases, type ResourceLeases } from "@des/core/scheduler";
import { openEvents, type EventBus } from "./events.ts";
import { project, type GraphProjection } from "./projection.ts";
import type { AnyWorkflowRegistration, PipelineRegistration } from "./registration.ts";
import { openRunner, type Runner } from "./runner.ts";
import { openRuns, type RunStore } from "./runs.ts";

/** Which pipeline row a run belongs to, for a run that is one. */
export type RowOwner = { pipelineId: string; rowId: string };

export type Registry = {
  workflows: AnyWorkflowRegistration[];
  workflowById: Map<string, AnyWorkflowRegistration>;
  pipelines: PipelineRegistration[];
  pipelineById: Map<string, PipelineRegistration>;
  /** The authored projection per workflow id, built once at registration. */
  projections: Map<string, GraphProjection>;
  runs: RunStore;
  runner: Runner;
  events: EventBus;
  /** Where `upsert-artifact` rows are read back from, when a target has one. */
  artifacts?: ArtifactStore;

  /** Per pipeline, per row, the latest run the server started for it. */
  pipelineRuns: Map<string, Map<string, string>>;
  /** The row a run belongs to, for the runs that are rows. */
  rowOwners: Map<string, RowOwner>;
  /** Pipelines being driven right now, so a second request starts no second. */
  driving: Set<string>;
  /** Why a pipeline's last drive stopped early, when one did. */
  errors: Map<string, string>;
  /** Shared infrastructure two rows take turns on. One set per server. */
  leases: ResourceLeases;

  /** Hold a driving promise until it settles, so `idle` means something. */
  track(work: Promise<unknown>): void;
  /** Every run and every pipeline drive has settled. */
  idle(): Promise<void>;
};

export type RegistryOptions = {
  workflows: AnyWorkflowRegistration[];
  pipelines?: PipelineRegistration[];
  /** Where a registration's snapshots land when it names no runtime of its own. */
  runtimeUrl?: string;
  /** Where `upsert-artifact` rows are read back from. */
  artifacts?: ArtifactStore;
  /** The id a new run is given. Injected so a test can name its runs. */
  mintId?: () => string;
};

/** A default that is unique per run and needs no clock. */
const uuid = (): string => crypto.randomUUID();

export const openRegistry = (options: RegistryOptions): Registry => {
  const workflows = options.workflows;
  const pipelines = options.pipelines ?? [];
  const runtime: WorkflowRuntime = openWorkflowRuntime(options.runtimeUrl);
  const events = openEvents();
  const runs = openRuns();
  const runner = openRunner({
    workflows,
    runs,
    events,
    runtime,
    mintId: options.mintId ?? uuid,
  });

  // Built once, with an observer that reports nowhere: a projection is a
  // reading of the node map and must not be a run of anything.
  const projections = new Map<string, GraphProjection>(
    workflows.map((registration) => [
      registration.id,
      project(registration.graph({ journal: registration.journal, observe: () => {} })),
    ]),
  );

  const inFlight = new Set<Promise<unknown>>();

  return {
    workflows,
    workflowById: new Map(workflows.map((w) => [w.id, w] as const)),
    pipelines,
    pipelineById: new Map(pipelines.map((p) => [p.id, p] as const)),
    projections,
    runs,
    runner,
    events,
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),

    pipelineRuns: new Map(),
    rowOwners: new Map(),
    driving: new Set(),
    errors: new Map(),
    leases: inMemoryLeases(),

    track: (work) => {
      const tracked = work.then(
        () => {},
        () => {},
      );
      inFlight.add(tracked);
      void tracked.finally(() => inFlight.delete(tracked));
    },

    idle: async () => {
      // Two sources of work that start each other: a pipeline drive starts
      // runs, and a run settling lets a drive start the next row. So the wait
      // alternates until both are quiet at the same time.
      for (;;) {
        await runner.idle();
        if (inFlight.size === 0) return;
        await Promise.all([...inFlight]);
      }
    },
  };
};

/**
 * The one slot. A well-known symbol rather than a module-level binding, so two
 * copies of this module — the one the process imported and the one a bundler
 * may have inlined into the UI's server build — read the same registry.
 */
const SLOT = Symbol.for("@des/server.registry");

type Slotted = { [SLOT]?: Registry };

export const setRegistry = (registry: Registry): void => {
  (globalThis as Slotted)[SLOT] = registry;
};

/** Forget the registry. For a test that starts two servers in one process. */
export const clearRegistry = (): void => {
  delete (globalThis as Slotted)[SLOT];
};

/**
 * The registry, or a refusal by name.
 *
 * Reached only from a request handler, and a request handler only exists
 * because `serve` started one — so an absent registry is a wiring bug rather
 * than a state a person can be in.
 */
export const getRegistry = (): Registry => {
  const registry = (globalThis as Slotted)[SLOT];
  if (registry === undefined) {
    throw new Error(
      "no registry is set, so there is nothing to serve. `serve()` sets it; a server function " +
        "reached module scope without one having been started.",
    );
  }
  return registry;
};
