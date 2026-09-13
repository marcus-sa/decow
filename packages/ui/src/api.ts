/**
 * The client over `@des/server`'s own surface.
 *
 * The types are imported FROM the server rather than restated here, and the
 * import is type-only, so it is erased before the bundler ever sees it. One
 * definition of what a projection is, what a run record holds, and what an
 * event carries — held by the thing that produces them.
 */

import type {
  GraphProjection,
  ProjectedNode,
  RunRecord,
  RunStatus,
  RunSummary,
  ServerEvent,
} from "@des/server";

export type { GraphProjection, ProjectedNode, RunRecord, RunStatus, RunSummary, ServerEvent };

/** One registered graph, as `/api/workflows` lists it. */
export type ListedWorkflow = {
  id: string;
  title: string;
  graph: GraphProjection;
};

/** One row of a pipeline's run tree. */
export type PipelineRowView = {
  id: string;
  description?: string;
  dependencies: string[];
  workflowId?: string;
  runId?: string;
  status: string;
};

export type PipelineTree = {
  id: string;
  title: string;
  rows: PipelineRowView[];
};

const read = async <T>(path: string): Promise<T> => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

const send = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? {} : (JSON.parse(text) as T);
  if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status}`), { body: parsed });
  return parsed as T;
};

export const api = {
  workflows: () => read<ListedWorkflow[]>("/api/workflows"),
  pipelines: () => read<{ id: string; title: string }[]>("/api/pipelines"),
  workflow: (id: string) => read<ListedWorkflow>(`/api/workflows/${encodeURIComponent(id)}`),
  runs: () => read<RunSummary[]>("/api/runs"),
  run: (runId: string) => read<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`),
  startRun: (id: string, input: unknown) =>
    send<{ runId: string }>(`/api/workflows/${encodeURIComponent(id)}/runs`, input),
  resumeRun: (runId: string, answer: unknown) =>
    send<{ runId: string }>(`/api/runs/${encodeURIComponent(runId)}/resume`, answer),
  pipeline: (id: string) => read<PipelineTree>(`/api/pipelines/${encodeURIComponent(id)}`),
  runPipeline: (id: string) => send<{ id: string }>(`/api/pipelines/${encodeURIComponent(id)}/run`, {}),
  resumeRow: (id: string, rowId: string, answer: unknown) =>
    send<{ id: string }>(
      `/api/pipelines/${encodeURIComponent(id)}/rows/${encodeURIComponent(rowId)}/resume`,
      answer,
    ),
};

/** What a 400 from a resume carries: the closed enum it should have come from. */
export type RefusedAnswer = { error: string; field?: string; options?: string[] };

export const refusal = (error: unknown): RefusedAnswer | undefined => {
  const body = (error as { body?: RefusedAnswer } | undefined)?.body;
  return body?.error === undefined ? undefined : body;
};

/**
 * Subscribe to `/api/events`.
 *
 * `EventSource` rather than a streamed fetch: it reconnects on its own, and a
 * UI that loses the stream for a second while a DELIVER row is mid-cycle
 * should pick it back up rather than go quiet. What it misses in that second
 * is on the run's record, which every view re-reads when an event lands.
 */
export const subscribe = (onEvent: (event: ServerEvent) => void): (() => void) => {
  const source = new EventSource("/api/events");
  const listener = (message: MessageEvent<string>): void => {
    onEvent(JSON.parse(message.data) as ServerEvent);
  };
  for (const type of [
    "run-started",
    "node-entered",
    "node-left",
    "leaf-attempt",
    "suspended",
    "resumed",
    "terminal",
    "pipeline-row",
  ]) {
    source.addEventListener(type, listener as EventListener);
  }
  return () => source.close();
};
