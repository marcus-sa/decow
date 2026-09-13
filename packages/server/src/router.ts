/**
 * The HTTP surface. JSON under `/api`, one SSE stream beside it.
 *
 * Every route is a thin adapter over `./api.ts`: parse the path, call the
 * function, turn a refusal into a status code. Nothing decides anything here,
 * which is the point — what a browser reaches and what a unit test drives are
 * the same bodies.
 */

import { eventStream } from "./events.ts";
import {
  getPipeline,
  getRun,
  getWorkflow,
  listPipelines,
  listRuns,
  listWorkflows,
  readArtifacts,
  RefusedAnswer,
  resumeRow,
  resumeRun,
  runPipeline,
  startRun,
} from "./api.ts";
import type { Registry } from "./registry.ts";

export type RouterOptions = {
  registry: Registry;
  /** Anything not under `/api`. The UI, when one is mounted. */
  fallback?: (request: Request) => Response | undefined | Promise<Response | undefined>;
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

/**
 * A refusal, as a status code.
 *
 * `RefusedAnswer` is a 400 carrying the enum it should have come from; a "no
 * such thing" is a 404; everything else a named function threw is a 409,
 * because it is a state the caller asked about rather than a crash.
 */
const refused = (error: unknown): Response => {
  if (error instanceof RefusedAnswer) {
    return json(
      {
        error: error.message,
        ...(error.field === undefined ? {} : { field: error.field }),
        ...(error.options === undefined ? {} : { options: error.options }),
      },
      400,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: message }, /^no /.test(message) ? 404 : 409);
};

export const openRouter = (options: RouterOptions) => {
  const registry = options.registry;

  const attempt = async (work: () => unknown): Promise<Response> => {
    try {
      return json(await work());
    } catch (error) {
      return refused(error);
    }
  };

  const body = async (request: Request): Promise<unknown> =>
    await request.json().catch(() => undefined);

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = apiPath(url);
    if (path === undefined) {
      const answered = await options.fallback?.(request);
      return answered ?? notFound(`route ${url.pathname}`);
    }
    const [head, first, second, third, fourth] = path;

    if (head === "events" && first === undefined) return eventStream(registry.events, request.signal);

    if (head === "workflows") {
      if (first === undefined) return await attempt(() => listWorkflows(registry));
      if (second === "runs" && request.method === "POST") {
        return await attempt(async () => startRun(registry, first, await body(request)));
      }
      if (second === undefined) return await attempt(() => getWorkflow(registry, first));
    }

    if (head === "runs") {
      if (first === undefined) return await attempt(() => listRuns(registry));
      if (second === undefined) return await attempt(() => getRun(registry, first));
      if (second === "resume" && request.method === "POST") {
        return await attempt(async () => resumeRun(registry, first, await body(request)));
      }
    }

    if (head === "artifacts" && first !== undefined) {
      const version = url.searchParams.get("version");
      return await attempt(() =>
        readArtifacts(registry, {
          table: first,
          ...(second === undefined ? {} : { id: second }),
          ...(version === null ? {} : { version: Number(version) }),
        }),
      );
    }

    if (head === "pipelines") {
      // The list is names only. A tree is a projection per row, and running
      // every consumer's projection to render a menu would make the cheapest
      // page the most expensive one.
      if (first === undefined) return await attempt(() => listPipelines(registry));
      if (second === undefined) return await attempt(async () => await getPipeline(registry, first));
      if (second === "run" && request.method === "POST") {
        return await attempt(() => runPipeline(registry, first));
      }
      if (second === "rows" && third !== undefined && fourth === "resume" && request.method === "POST") {
        return await attempt(async () => resumeRow(registry, first, third, await body(request)));
      }
    }

    return notFound(`route ${url.pathname}`);
  };

  return { handle };
};
