/**
 * What this target can run, and what it has run.
 *
 * The loader is three server functions, so the first paint is server-rendered
 * from the registry itself rather than from a fetch the client has not made
 * yet. Every event re-invalidates the route, which re-runs the loader.
 */

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { subscribe } from "../events.ts";
import { listPipelines, listRuns, listWorkflows } from "../server/functions.ts";

export const Route = createFileRoute("/")({
  loader: async () => ({
    workflows: await listWorkflows(),
    pipelines: await listPipelines(),
    runs: await listRuns(),
  }),
  component: Index,
});

function Index(): React.ReactElement {
  const { workflows, pipelines, runs } = Route.useLoaderData();
  const router = useRouter();

  useEffect(() => subscribe(() => void router.invalidate()), [router]);

  return (
    <div className="page">
      <section>
        <h1>Graphs</h1>
        <p className="lede">
          Each one is fixed and hand-written. A run fills in the leaves; nothing here generates a
          graph.
        </p>
        <ul className="cards" data-testid="workflows">
          {workflows.map((workflow) => (
            <li key={workflow.id} className="card">
              <Link to="/workflows/$id" params={{ id: workflow.id }}>
                <strong>{workflow.id}</strong>
                <span>{workflow.title}</span>
                <span className="meta">
                  {workflow.graph.nodes.length} nodes ·{" "}
                  {workflow.graph.nodes.filter((n) => n.kind === "leaf").length} leaves ·{" "}
                  {workflow.graph.nodes.filter((n) => n.kind === "loop").length} loops
                </span>
              </Link>
            </li>
          ))}
          {workflows.length === 0 ? <li className="empty">No graph is registered.</li> : null}
        </ul>
      </section>

      {pipelines.length === 0 ? null : (
        <section>
          <h1>Pipelines</h1>
          <p className="lede">
            One fixed graph, instantiated once per row, with the frontier running concurrently.
          </p>
          <ul className="cards" data-testid="pipelines">
            {pipelines.map((pipeline) => (
              <li key={pipeline.id} className="card">
                <Link to="/pipelines/$id" params={{ id: pipeline.id }}>
                  <strong>{pipeline.id}</strong>
                  <span>{pipeline.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h1>Runs</h1>
        <ul className="rows" data-testid="runs">
          {runs.map((run) => (
            <li key={run.runId} className="row">
              <Link to="/runs/$runId" params={{ runId: run.runId }}>
                <span className={`pill ${run.status}`}>{run.status}</span>
                <code>{run.runId}</code>
                <span className="meta">
                  {run.workflowId} · {run.visited} nodes · {run.attempts} attempts
                </span>
                {run.suspension === undefined ? null : (
                  <span className="meta parked">parked: {run.suspension.reason}</span>
                )}
              </Link>
            </li>
          ))}
          {runs.length === 0 ? <li className="empty">Nothing has run yet.</li> : null}
        </ul>
      </section>
    </div>
  );
}
