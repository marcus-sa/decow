/**
 * `serve` — one process, every registered graph, one HTTP surface.
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

import { openWorkflowRuntime, type WorkflowRuntime } from "@des/core/compile";
import type { ArtifactStore } from "@des/core/artifacts";
import { openEvents, type EventBus, type ServerEvent } from "./events.ts";
import { project, type GraphProjection } from "./projection.ts";
import type { AnyWorkflowRegistration, PipelineRegistration } from "./registration.ts";
import { openRunner, type Runner } from "./runner.ts";
import { openRouter } from "./router.ts";
import { openRuns, type RunStore } from "./runs.ts";

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
  fallback?: (request: Request) => Response | Promise<Response> | undefined | Promise<undefined>;
  /** The id a new run is given. Injected so a test can name its runs. */
  mintId?: () => string;
  /** How often a running pipeline's rows are re-read. */
  pipelinePollMs?: number;
};

export type Server = {
  url: string;
  port: number;
  stop(): Promise<void>;
  /** The bus every route publishes on, for a caller in the same process. */
  events: EventBus;
  runs: RunStore;
  runner: Runner;
  /** The authored projection per workflow id. */
  projections: Map<string, GraphProjection>;
};

/** A default that is unique per run and needs no clock. */
const uuid = (): string => crypto.randomUUID();

export const serve = async (options: ServeOptions): Promise<Server> => {
  const workflows = options.workflows;
  const pipelines = options.pipelines ?? [];
  const runtime: WorkflowRuntime = openWorkflowRuntime(options.runtimeUrl);
  const events = openEvents();
  const runs = openRuns();
  const runner = openRunner({ runs, events, runtime, mintId: options.mintId ?? uuid });

  // Built once, with an observer that reports nowhere: a projection is a
  // reading of the node map and must not be a run of anything.
  const projections = new Map<string, GraphProjection>(
    workflows.map((registration) => [
      registration.id,
      project(registration.graph({ journal: registration.journal, observe: () => {} })),
    ]),
  );

  const router = openRouter({
    workflows,
    pipelines,
    runs,
    runner,
    events,
    projections,
    pipelinePollMs: options.pipelinePollMs ?? 250,
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
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
    events,
    runs,
    runner,
    projections,
  };
};

export {
  openEvents,
  encodeEvent,
  eventStream,
  type EventBus,
  type ServerEvent,
} from "./events.ts";
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
export { openRunner, type Runner } from "./runner.ts";
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
