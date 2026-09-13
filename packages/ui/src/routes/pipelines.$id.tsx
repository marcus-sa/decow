/**
 * A pipeline: the rows, what each one's status projects, and the run each one
 * drilled into.
 *
 * There is no second graph here. A pipeline is the one fixed graph
 * instantiated once per row, so the tree is a list and each row's link is a
 * run of that graph.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { api, subscribe, type PipelineTree } from "../api.ts";

export const Route = createFileRoute("/pipelines/$id")({ component: PipelinePage });

function PipelinePage(): React.ReactElement {
  const { id } = Route.useParams();
  const [tree, setTree] = useState<PipelineTree | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const reload = useCallback((): void => {
    void api
      .pipeline(id)
      .then(setTree)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    reload();
    return subscribe((event) => {
      if (event.type === "pipeline-row" && event.pipelineId === id) reload();
      if (event.type === "terminal" || event.type === "suspended") reload();
    });
  }, [id, reload]);

  if (error !== undefined) return <p className="error">{error}</p>;
  if (tree === undefined) return <p className="meta">…</p>;

  return (
    <div className="page">
      <h1>{tree.id}</h1>
      <p className="lede">{tree.title}</p>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api
            .runPipeline(id)
            .then(() => reload())
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        run the ready set
      </button>

      <h2>Rows</h2>
      <ul className="tree">
        {tree.rows.map((row) => (
          <li key={row.id} className="row">
            {row.runId === undefined ? (
              <span className="card">
                <span className={`pill ${row.status}`}>{row.status}</span> <code>{row.id}</code>
                <span className="meta">
                  {row.description ?? ""}
                  {row.dependencies.length === 0 ? "" : ` · after ${row.dependencies.join(", ")}`}
                </span>
              </span>
            ) : (
              <Link to="/runs/$runId" params={{ runId: row.runId }}>
                <span>
                  <span className={`pill ${row.status}`}>{row.status}</span> <code>{row.id}</code>
                </span>
                <span className="meta">
                  {row.description ?? ""}
                  {row.dependencies.length === 0 ? "" : ` · after ${row.dependencies.join(", ")}`}
                </span>
              </Link>
            )}
          </li>
        ))}
      </ul>

      <p className="meta">
        A row runs when every row it depends on reads <code>accepted</code>. One that is parked or
        rejected blocks its own dependents and nothing else.
      </p>
    </div>
  );
}
