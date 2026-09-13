/**
 * A pipeline: the rows, what each one's status projects, and the run each one
 * is on.
 *
 * There is no second graph here. A pipeline is the one fixed graph
 * instantiated once per row, so the tree is a list and each row's link is a
 * run of that graph — an ordinary run, with a trace, drawn on the same page
 * every other run is.
 */

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { subscribe } from "../events.ts";
import { getPipeline, runPipeline } from "../server/functions.ts";

export const Route = createFileRoute("/pipelines/$id")({
  loader: async ({ params }) => await getPipeline({ data: { id: params.id } }),
  component: PipelinePage,
});

function PipelinePage(): React.ReactElement {
  const tree = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "pipeline-row" && event.pipelineId === tree.id) void router.invalidate();
        if (event.type === "terminal" || event.type === "suspended") void router.invalidate();
      }),
    [tree.id, router],
  );

  return (
    <div className="page">
      <h1>{tree.id}</h1>
      <p className="lede">{tree.title}</p>

      <button
        type="button"
        disabled={busy}
        data-testid="run-pipeline"
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void runPipeline({ data: { id: tree.id } })
            .then(() => router.invalidate())
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        run the ready set
      </button>

      {error === undefined ? null : <p className="error">{error}</p>}
      {tree.error === undefined ? null : <p className="error">{tree.error}</p>}

      <h2>Rows</h2>
      <ul className="tree" data-testid="rows">
        {tree.rows.map((row) => (
          <li key={row.id} className="row" data-row={row.id} data-status={row.status}>
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
