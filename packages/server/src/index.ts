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
import type { GraphProjection } from "./projection.ts";
import type { AnyWorkflowRegistration, PipelineRegistration } from "./registration.ts";
import { openRegistry, setRegistry, type Registry } from "./registry.ts";
import { openRouter } from "./router.ts";
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
   * Anything not under `/api`. The UI is mounted here; without one the server
   * is the API and nothing else.
   */
  fallback?: (request: Request) => Response | undefined | Promise<Response | undefined>;
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
    ...(options.mintId === undefined ? {} : { mintId: options.mintId }),
  });
  setRegistry(registry);

  const router = openRouter({
    registry,
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
  });

  const server = Bun.serve({
    port: options.port ?? 3000,
    idleTimeout: 0,
    fetch: (request) => router.handle(request),
  });

  return {
    url: server.url.href.replace(/\/$/, ""),
    port: Number(server.url.port),
    stop: async () => {
      await server.stop(true);
    },
    registry,
    events: registry.events,
    runs: registry.runs,
    runner: registry.runner,
    projections: registry.projections,
  };
};

export {
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
  type EventBus,
  type ServerEvent,
} from "./events.ts";
export {
  drive,
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
  type RunRecord,
  type RunStatus,
  type RunStore,
  type RunSummary,
  type Suspension,
  type TraceEntry,
} from "./runs.ts";
