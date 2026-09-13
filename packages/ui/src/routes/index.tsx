/**
 * What this target can run, and what it has run.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, subscribe, type ListedWorkflow, type RunSummary } from "../api.ts";

export const Route = createFileRoute("/")({ component: Index });

function Index(): React.ReactElement {
  const [workflows, setWorkflows] = useState<ListedWorkflow[]>([]);
  const [pipelines, setPipelines] = useState<{ id: string; title: string }[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const load = (): void => {
      void api.workflows().then(setWorkflows).catch((e: Error) => setError(e.message));
      void api.pipelines().then(setPipelines).catch(() => {});
      void api.runs().then(setRuns).catch(() => {});
    };
    load();
    return subscribe(load);
  }, []);

  return (
    <div className="page">
      {error === undefined ? null : <p className="error">{error}</p>}

      <section>
        <h1>Graphs</h1>
        <p className="lede">
          Each one is fixed and hand-written. A run fills in the leaves; nothing here generates a
          graph.
        </p>
        <ul className="cards">
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
          <ul className="cards">
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
        <ul className="rows">
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
