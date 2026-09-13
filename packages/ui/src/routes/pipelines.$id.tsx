/**
 * A pipeline: the roadmap it is driven over, the steps that roadmap declares,
 * what each one's status projects, and the run each one is on.
 *
 * There is no second graph here. A pipeline is the one fixed graph
 * instantiated once per step, so the tree is a list and each step's link is a
 * run of that graph — an ordinary run, with a trace, drawn on the same page
 * every other run is.
 *
 * A PERSON PICKS THE ROADMAP FIRST, and until they do there is nothing to
 * show: a composition over a roadmap has no steps until it is told which one.
 * The choices are the rows the artifact store holds, so a choice cannot name a
 * roadmap nobody authored, and the one that was made is in the URL rather than
 * in this component — which is what makes the steps server-rendered, a reload
 * land on the same tree, and walking into a step's run and back keep the
 * roadmap the step belongs to.
 */

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { subscribe } from "../events.ts";
import { getPipeline, listPipelines, readArtifacts, runPipeline } from "../server/functions.ts";

/**
 * The table a roadmap is a row in.
 *
 * Named here because this page offers a CHOICE between roadmaps, and the only
 * place the choices exist is the artifact store. It is the one thing this
 * application knows about what its target's pipelines are compositions over.
 */
const ROADMAPS = "roadmaps";

export const Route = createFileRoute("/pipelines/$id")({
  // Optional, and the absence is the state a person arrives in: the index
  // links here without one, and there is nothing to show until they pick.
  validateSearch: (search: Record<string, unknown>): { roadmap?: string } =>
    typeof search["roadmap"] === "string" ? { roadmap: search["roadmap"] } : {},
  loaderDeps: ({ search }) => ({ roadmap: search.roadmap }),
  loader: async ({ params, deps }) => {
    const listed = (await listPipelines()).find((p) => p.id === params.id);
    if (listed === undefined) throw new Error(`no pipeline ${params.id} is registered`);
    const read = await readArtifacts({ data: { table: ROADMAPS } });
    const roadmaps = "rows" in read ? read.rows.map((row) => row.id) : [];
    if (deps.roadmap === undefined) return { pipeline: listed, roadmaps };
    try {
      const tree = await getPipeline({
        data: { id: params.id, input: { roadmapId: deps.roadmap } },
      });
      return { pipeline: listed, roadmaps, tree };
    } catch (error) {
      // A refusal belongs on the page beside the picker that produced it: an
      // id the store does not hold is a thing a person can act on, and losing
      // the picker to an error boundary would leave them nothing to act with.
      return { pipeline: listed, roadmaps, refused: String(error) };
    }
  },
  component: PipelinePage,
});

function PipelinePage(): React.ReactElement {
  const { pipeline, roadmaps, tree, refused } = Route.useLoaderData();
  const { roadmap } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === "pipeline-step" && event.pipelineId === pipeline.id) void router.invalidate();
        if (event.type === "terminal" || event.type === "suspended") void router.invalidate();
      }),
    [pipeline.id, router],
  );

  return (
    <div className="page">
      <h1>{pipeline.id}</h1>
      <p className="lede">{pipeline.title}</p>

      <label className="field">
        <span>roadmap</span>
        <select
          data-testid="roadmap"
          value={roadmap ?? ""}
          onChange={(e) => {
            const picked = e.target.value;
            setError(undefined);
            void navigate({ search: { roadmap: picked === "" ? undefined : picked } });
          }}
        >
          <option value="">choose a roadmap</option>
          {roadmaps.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <span className="meta">
          {roadmaps.length === 0
            ? "No roadmap has been authored yet. Run the roadmap graph first."
            : "The steps below are this roadmap's, and so is the frontier the button drives."}
        </span>
      </label>

      <button
        type="button"
        disabled={busy || roadmap === undefined}
        data-testid="run-pipeline"
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void runPipeline({ data: { id: pipeline.id, input: { roadmapId: roadmap } } })
            .then(() => router.invalidate())
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        run the ready set
      </button>

      {error === undefined ? null : <p className="error">{error}</p>}
      {refused === undefined ? null : <p className="error">{refused}</p>}
      {tree?.error === undefined ? null : <p className="error">{tree.error}</p>}

      <h2>Steps</h2>
      <ul className="tree" data-testid="steps">
        {(tree?.steps ?? []).map((step) => (
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
        {tree === undefined ? <li className="empty">Pick a roadmap.</li> : null}
      </ul>

      <p className="meta">
        A step runs when every step it depends on reads <code>accepted</code>. One that is parked
        or rejected blocks its own dependents and nothing else.
      </p>
    </div>
  );
}
