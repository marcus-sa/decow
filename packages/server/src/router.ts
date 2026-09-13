/**
 * The HTTP surface. JSON under `/api`, one SSE stream beside it.
 *
 * Every route is a projection of something that already exists: the authored
 * graph, a run's record, the artifact store's rows, a pipeline's own view of
 * its rows. The two that are not — starting a run and answering a suspension
 * — take a body the graph's own schema validates, and a body that does not
 * parse is refused here with the closed set it should have come from, rather
 * than three frames into a compiled step.
 */

import type { ArtifactStore } from "@des/core/artifacts";
import type { RowStatus } from "@des/core/scheduler";
import { z } from "zod";
import { eventStream, type EventBus } from "./events.ts";
import { project, type GraphProjection } from "./projection.ts";
import type { AnyWorkflowRegistration, PipelineRegistration, PipelineRow } from "./registration.ts";
import type { Runner } from "./runner.ts";
import type { RunStore } from "./runs.ts";

export type RouterOptions = {
  workflows: AnyWorkflowRegistration[];
  pipelines: PipelineRegistration[];
  runs: RunStore;
  runner: Runner;
  events: EventBus;
  /** Where `upsert-artifact` rows are read back from, when a target has one. */
  artifacts?: ArtifactStore;
  /** The authored projection per workflow id, built once at registration. */
  projections: Map<string, GraphProjection>;
  /** Anything not under `/api`. The UI, when one is mounted. */
  fallback?: (request: Request) => Response | undefined | Promise<Response | undefined>;
  /** How often a running pipeline's rows are re-read while it runs. */
  pipelinePollMs: number;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });

const notFound = (what: string): Response => json({ error: `no such ${what}` }, 404);

/** The path segments under `/api`, or `undefined` for anything else. */
const apiPath = (url: URL): string[] | undefined => {
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  return parts[0] === "api" ? parts.slice(1).map(decodeURIComponent) : undefined;
};

/** A pipeline's run tree: its rows, each with the status it projects. */
const runTree = async (
  pipeline: PipelineRegistration,
  error?: string,
): Promise<{
  id: string;
  title: string;
  rows: (PipelineRow & { status: RowStatus })[];
  error?: string;
}> => {
  const rows = await pipeline.rows();
  const statuses = await Promise.all(rows.map((row) => pipeline.status(row.id)));
  return {
    id: pipeline.id,
    title: pipeline.title,
    rows: rows.map((row, i) => ({ ...row, status: statuses[i] as RowStatus })),
    ...(error === undefined ? {} : { error }),
  };
};

export const openRouter = (options: RouterOptions) => {
  const byId = new Map(options.workflows.map((w) => [w.id, w] as const));
  const pipelineById = new Map(options.pipelines.map((p) => [p.id, p] as const));
  /** The statuses each pipeline's rows last reported, so a poll can diff. */
  const lastSeen = new Map<string, Map<string, RowStatus>>();
  /** Pipelines currently running, so a second POST does not start a second. */
  const running = new Set<string>();
  /**
   * Why a pipeline's last run stopped early, when one did.
   *
   * A pipeline refuses by NAME — DELIVER's refuses a row whose oracle has not
   * been measured red — and a refusal nobody can read is a pipeline that
   * silently did nothing. It is held rather than thrown into the void because
   * the run is asynchronous: the POST that started it has long since answered.
   */
  const lastError = new Map<string, string>();

  const projectionOf = (id: string): GraphProjection => {
    const cached = options.projections.get(id);
    if (cached !== undefined) return cached;
    const registration = byId.get(id);
    const built = project(
      registration === undefined ? { start: "", nodes: {} } : registration.graph({
        journal: registration.journal,
        observe: () => {},
      }),
    );
    options.projections.set(id, built);
    return built;
  };

  /**
   * Re-read a pipeline's rows and report every status that moved.
   *
   * A pipeline's state is a PROJECTION — the scheduler persists nothing of its
   * own and derives each row's status by reading what finished — so watching
   * one means re-reading it. There is no hook to subscribe to and inventing
   * one would ask every consumer to report what its own projection already
   * says.
   */
  const sweep = async (pipeline: PipelineRegistration): Promise<void> => {
    const seen = lastSeen.get(pipeline.id) ?? new Map<string, RowStatus>();
    lastSeen.set(pipeline.id, seen);
    const tree = await runTree(pipeline);
    for (const row of tree.rows) {
      if (seen.get(row.id) === row.status) continue;
      seen.set(row.id, row.status);
      options.events.emit({
        type: "pipeline-row",
        pipelineId: pipeline.id,
        rowId: row.id,
        status: row.status,
        ...(row.runId === undefined ? {} : { runId: row.runId }),
      });
    }
  };

  /** Drive a pipeline to quiescence, sweeping its rows while it goes. */
  const drive = async (pipeline: PipelineRegistration, work: () => Promise<void>): Promise<void> => {
    running.add(pipeline.id);
    lastError.delete(pipeline.id);
    let ticking = true;
    const poll = (async () => {
      while (ticking) {
        await sweep(pipeline);
        await Bun.sleep(options.pipelinePollMs);
      }
    })();
    try {
      await work();
    } catch (error) {
      // A consumer's own refusal, held where a reader can find it. Rethrowing
      // it here would be an unhandled rejection in a run nobody is awaiting.
      lastError.set(pipeline.id, String(error));
    } finally {
      ticking = false;
      await poll;
      await sweep(pipeline);
      running.delete(pipeline.id);
    }
  };

  const startPipeline = (pipeline: PipelineRegistration, work: () => Promise<void>): Response => {
    if (running.has(pipeline.id)) {
      return json({ error: `pipeline ${pipeline.id} is already running` }, 409);
    }
    void drive(pipeline, work);
    return json({ id: pipeline.id, status: "running" });
  };

  /* ------------------------------------------------------------- the routes */

  /**
   * One registration, as a client reads it: what it is called, the authored
   * graph, and the shape of the input a person supplies to start one.
   *
   * The input schema is the REGISTRATION's rather than the graph's — a graph
   * says nothing about what precedes it — so it travels beside the projection
   * rather than inside it, and it travels as JSON Schema because a browser
   * cannot hold a zod type.
   */
  const described = (registration: AnyWorkflowRegistration) => ({
    id: registration.id,
    title: registration.title,
    graph: projectionOf(registration.id),
    input: z.toJSONSchema(registration.input, { target: "draft-07", unrepresentable: "any" }),
  });

  const workflows = (): Response => json(options.workflows.map(described));

  const startRun = async (id: string, request: Request): Promise<Response> => {
    const registration = byId.get(id);
    if (registration === undefined) return notFound(`workflow ${id}`);
    const body = await request.json().catch(() => undefined);
    const parsed = registration.input.safeParse(body);
    if (!parsed.success) {
      return json({ error: `the input for ${id} does not parse`, issues: parsed.error.issues }, 400);
    }
    return json({ runId: options.runner.start(registration, parsed.data) });
  };

  const resumeRun = async (runId: string, request: Request): Promise<Response> => {
    const record = options.runs.get(runId);
    if (record === undefined) return notFound(`run ${runId}`);
    if (record.status !== "suspended") {
      return json({ error: `run ${runId} is ${record.status}, so there is nothing to answer` }, 409);
    }
    const graph = options.runner.graphOf(runId);
    const node = record.suspension?.node;
    const parked = graph === undefined || node === undefined ? undefined : graph.nodes[node];
    if (parked?.type !== "suspend") {
      return json({ error: `run ${runId} is parked on a node this server cannot name` }, 409);
    }

    const body = await request.json().catch(() => undefined);
    const parsed = parked.resumeSchema.safeParse(body);
    if (!parsed.success) {
      const resume = record.suspension?.resume;
      return json(
        {
          error:
            resume?.options === undefined
              ? `the answer for ${runId} does not parse`
              : `the answer for ${runId} must be one of ${resume.options.join(", ")}`,
          ...(resume?.field === undefined ? {} : { field: resume.field }),
          ...(resume?.options === undefined ? {} : { options: resume.options }),
          issues: parsed.error.issues,
        },
        400,
      );
    }

    const registration = byId.get(record.workflowId);
    if (registration === undefined) return notFound(`workflow ${record.workflowId}`);
    options.runner.resume(registration, runId, parsed.data);
    return json({ runId, status: "running" });
  };

  const artifacts = (table: string, id?: string, version?: string): Response => {
    const store = options.artifacts;
    if (store === undefined) {
      return json({ error: "this server registered no artifact store, so there are no rows to read" }, 404);
    }
    if (id === undefined) return json({ table, rows: store.list(table) });
    if (version !== undefined) {
      const at = store.at(table, id, Number(version));
      return at === undefined ? notFound(`${table}/${id} at version ${version}`) : json({ table, id, version: Number(version), row: at });
    }
    const row = store.read(table, id);
    return row === undefined ? notFound(`${table}/${id}`) : json({ table, id, ...row });
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = apiPath(url);
    if (path === undefined) {
      const answered = await options.fallback?.(request);
      return answered ?? notFound(`route ${url.pathname}`);
    }
    const [head, first, second, third, fourth] = path;

    if (head === "events" && first === undefined) return eventStream(options.events, request.signal);

    if (head === "workflows") {
      if (first === undefined) return workflows();
      if (second === "runs" && request.method === "POST") return await startRun(first, request);
      if (second === undefined) {
        const registration = byId.get(first);
        return registration === undefined ? notFound(`workflow ${first}`) : json(described(registration));
      }
    }

    if (head === "runs") {
      if (first === undefined) return json(options.runs.list());
      if (second === undefined) {
        const record = options.runs.get(first);
        return record === undefined ? notFound(`run ${first}`) : json(record);
      }
      if (second === "resume" && request.method === "POST") return await resumeRun(first, request);
    }

    if (head === "artifacts" && first !== undefined) {
      return artifacts(first, second, url.searchParams.get("version") ?? undefined);
    }

    if (head === "pipelines") {
      // The list is names only. A tree is a projection per row, and running
      // every consumer's projection to render a menu would make the cheapest
      // page the most expensive one.
      if (first === undefined) {
        return json(options.pipelines.map((p) => ({ id: p.id, title: p.title })));
      }
      const pipeline = pipelineById.get(first);
      if (pipeline === undefined) return notFound(`pipeline ${first}`);
      if (second === undefined) return json(await runTree(pipeline, lastError.get(first)));
      if (second === "run" && request.method === "POST") {
        return startPipeline(pipeline, () => pipeline.run());
      }
      if (second === "rows" && third !== undefined && fourth === "resume" && request.method === "POST") {
        const answer = await request.json().catch(() => undefined);
        return startPipeline(pipeline, () => pipeline.resume(third, answer));
      }
    }

    return notFound(`route ${url.pathname}`);
  };

  return { handle, runTree };
};
