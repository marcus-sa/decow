/**
 * A pipeline: the steps, what each one's status projects, and the run each one
 * is on.
 *
 * There is no second graph here. A pipeline is the one fixed graph
 * instantiated once per step, so the tree is a list and each step's link is a
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
        if (event.type === "pipeline-step" && event.pipelineId === tree.id) void router.invalidate();
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

      <h2>Steps</h2>
      <ul className="tree" data-testid="steps">
        {tree.steps.map((step) => (
          <li key={step.id} className="row" data-step={step.id} data-status={step.status}>
            {step.runId === undefined ? (
              <span className="card">
                <span className={`pill ${step.status}`}>{step.status}</span> <code>{step.id}</code>
                <span className="meta">
                  {step.description ?? ""}
                  {step.dependencies.length === 0 ? "" : ` · after ${step.dependencies.join(", ")}`}
                </span>
              </span>
            ) : (
              <Link to="/runs/$runId" params={{ runId: step.runId }}>
                <span>
                  <span className={`pill ${step.status}`}>{step.status}</span> <code>{step.id}</code>
                </span>
                <span className="meta">
                  {step.description ?? ""}
                  {step.dependencies.length === 0 ? "" : ` · after ${step.dependencies.join(", ")}`}
                </span>
              </Link>
            )}
          </li>
        ))}
      </ul>

      <p className="meta">
        A step runs when every step it depends on reads <code>accepted</code>. One that is parked
        or rejected blocks its own dependents and nothing else.
      </p>
    </div>
  );
}
