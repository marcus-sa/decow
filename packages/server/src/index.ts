/**
 * `serve` — one process, every registered graph, one origin.
 *
 * A target's `.des/main.ts` is a list of registrations and a call to this. What
 * it gets back is the authored graph as data, a way to start a run, a live
 * event stream of where every run is, the artifact rows behind it, and the one
 * place a person answers a suspension.
 *
 * Mastra's runtime sits UNDER this rather than beside it. Runs, snapshots,
 * suspend and resume are the engine's and stay the engine's; what this adds is
 * the half the engine has no opinion about — which graph a person authored,
 * which of its nodes a run is on, what each leaf attempt decided and cost, and
 * which rows of a pipeline are still waiting on which.
 */

import type { ArtifactStore } from "@des/core/artifacts";
import type { EventBus } from "./events.ts";
import type { RunDatabase } from "./store.ts";
import type { GraphProjection } from "./projection.ts";
import type { AnyWorkflowRegistration, PipelineRegistration } from "./registration.ts";
import { clearRegistry, getRegistry, openRegistry, setRegistry, type Registry } from "./registry.ts";
import type { Runner } from "./runner.ts";
import type { RunStore } from "./runs.ts";

export type ServeOptions = {
  /**
   * Every graph this target can run, each erased through `registration()` so
   * one list can hold graphs over different states and different inputs.
   */
  workflows: AnyWorkflowRegistration[];
  /** Every registered composition over the scheduler. */
  pipelines?: PipelineRegistration[];
  /** 0 asks the OS for a free one, which is what a test wants. */
  port?: number;
  /**
   * Where a registration's snapshots land when it names no runtime of its
   * own. `:memory:` by default, which is right for a server whose targets
   * bring their own run directories and wrong for nothing else.
   */
  runtimeUrl?: string;
  /** Where `upsert-artifact` rows are read back from. */
  artifacts?: ArtifactStore;
  /**
   * Where runs, their events and their leaf attempts are kept.
   *
   * An in-memory database when absent. A target with a run directory opens one
   * on a file there and hands it in, which is what makes a restarted server
   * show every prior run and answer a suspension its predecessor produced.
   */
  store?: RunDatabase;
  /** The id a new run is given. Injected so a test can name its runs. */
  mintId?: () => string;
};

export type Server = {
  url: string;
  port: number;
  stop(): Promise<void>;
  /** Everything this server knows, for a caller in the same process. */
  registry: Registry;
  /** The bus every route publishes on. */
  events: EventBus;
  runs: RunStore;
  runner: Runner;
  /** The authored projection per workflow id. */
  projections: Map<string, GraphProjection>;
};

export const serve = async (options: ServeOptions): Promise<Server> => {
  const registry = openRegistry({
    workflows: options.workflows,
    ...(options.pipelines === undefined ? {} : { pipelines: options.pipelines }),
    ...(options.runtimeUrl === undefined ? {} : { runtimeUrl: options.runtimeUrl }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.mintId === undefined ? {} : { mintId: options.mintId }),
  });
  // Set BEFORE the handler is mounted: a server function reads the registry
  // from module scope, and the first request may arrive before this line
  // would otherwise have run.
  setRegistry(registry);

  // The one place this package reaches `@des/ui`, at run time, for a built
  // artifact. A static import would make the module graph a cycle; this does
  // not, because `@des/ui/handler` imports nothing from here.
  const { uiHandler } = await import("@des/ui/handler");
  const handle = await uiHandler();

  const server = Bun.serve({
    port: options.port ?? 3000,
    idleTimeout: 0,
    fetch: (request) => handle(request),
  });

  return {
    url: server.url.href.replace(/\/$/, ""),
    port: Number(server.url.port),
    stop: async () => {
      await server.stop(true);
      // Only if this server still owns the slot: a process that started a
      // second one has already handed it over.
      if (getRegistry() === registry) clearRegistry();
    },
    registry,
    events: registry.events,
    runs: registry.runs,
    runner: registry.runner,
    projections: registry.projections,
  };
};

export {
  exportRun,
  getPipeline,
  getRun,
  getWorkflow,
  listPipelines,
  listRuns,
  listWorkflows,
  readArtifacts,
  resumeRow,
  resumeRun,
  runPipeline,
  startRun,
  RefusedAnswer,
  type ArtifactRead,
  type DescribedWorkflow,
  type ListedPipeline,
} from "./api.ts";
export {
  openEvents,
  encodeEvent,
  eventStream,
  EVENT_KINDS,
  type EventBus,
  type EventKind,
  type ServerEvent,
} from "./events.ts";
export {
  drive,
  ownerOf,
  runIdOf,
  start as startPipeline,
  statusOf as rowStatusOf,
  tree as pipelineTree,
  type PipelineRowView,
  type PipelineTree,
} from "./pipelines.ts";
export {
  NODE_KINDS,
  parkedAt,
  project,
  resumeOptionsOf,
  type GraphProjection,
  type NodeKind,
  type ProjectedEdge,
  type ProjectedNode,
  type ResumeOptions,
} from "./projection.ts";
export {
  registration,
  type AnyWorkflowRegistration,
  type GraphContext,
  type PipelineRegistration,
  type PipelineRow,
  type WorkflowRegistration,
} from "./registration.ts";
export {
  clearRegistry,
  getRegistry,
  openRegistry,
  setRegistry,
  type Registry,
  type RegistryOptions,
  type RowOwner,
} from "./registry.ts";
export { openRunner, type Runner, type StartedRun } from "./runner.ts";
export {
  openRuns,
  traceEntries,
  RUN_STATUSES,
  type RunPatch,
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunSummary,
  type Suspension,
  type TraceEntry,
} from "./runs.ts";
export {
  openRunDatabase,
  type AttemptRows,
  type EventRows,
  type RunDatabase,
  type RunDatabaseOptions,
  type RunRows,
  type StoredEvent,
  type StoredRun,
} from "./store.ts";
