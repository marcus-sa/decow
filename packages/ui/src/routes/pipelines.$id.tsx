/**
 * A pipeline: the input it is driven over, the steps that input declares, what
 * each one's status projects, and the run each one is on.
 *
 * There is no second graph here. A pipeline is the one fixed graph
 * instantiated once per step, so the tree is a list and each step's link is a
 * run of that graph — an ordinary run, with a trace, drawn on the same page
 * every other run is.
 *
 * A PERSON SUPPLIES THE INPUT FIRST, and until they do there is nothing to
 * show: a composition whose steps are derived has no steps until it is told
 * what to derive them from. The form is the registration's own input schema,
 * rendered by the same component the workflow page renders a run's input with,
 * and a field whose options the registration declared is offered as a closed
 * list — so a pick cannot name something that does not exist.
 *
 * THIS PAGE KNOWS NO TABLE, no column and no field name. Which fields there
 * are is the schema's; which options a field has is the registration's; where
 * those options were read from is the consumer's and is never asked. Adding a
 * pipeline over something else changes nothing here.
 *
 * The supplied input is in the URL rather than in this component, which is
 * what makes the steps server-rendered, a reload land on the same tree, and
 * walking into a step's run and back keep the input the step belongs to. It
 * travels as ONE `?input=` parameter holding the whole object as JSON rather
 * than as one parameter per field, because the schema's values are typed — a
 * number, a boolean, a nested object — and a parameter per field would arrive
 * as a string this page would then have to decode back against the schema,
 * which is exactly the schema knowledge it is not supposed to have.
 */

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { subscribe } from "../events.ts";
import { SchemaForm, type JsonSchema } from "../form.tsx";
import { getPipeline, listPipelines, runPipeline } from "../server/functions.ts";

/**
 * The `?input=` parameter, read back.
 *
 * A refusal rather than a throw: a hand-edited URL is a thing a person can
 * act on, and losing the form to an error boundary would leave them nothing to
 * act with.
 */
const decode = (encoded: string): { values: Record<string, unknown> } | { refused: string } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return { refused: `the input in the URL is not JSON: ${encoded}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { refused: `the input in the URL is not an object: ${encoded}` };
  }
  return { values: parsed as Record<string, unknown> };
};

export const Route = createFileRoute("/pipelines/$id")({
  // Optional, and the absence is the state a person arrives in: the index
  // links here without one, and there is nothing to show until they supply it.
  validateSearch: (search: Record<string, unknown>): { input?: string } =>
    typeof search["input"] === "string" ? { input: search["input"] } : {},
  loaderDeps: ({ search }) => ({ input: search.input }),
  loader: async ({ params, deps }) => {
    const listed = (await listPipelines()).find((p) => p.id === params.id);
    if (listed === undefined) throw new Error(`no pipeline ${params.id} is registered`);

    const decoded = deps.input === undefined ? undefined : decode(deps.input);
    const values = decoded !== undefined && "values" in decoded ? decoded.values : undefined;
    if (values === undefined) {
      return {
        pipeline: listed,
        values,
        tree: undefined,
        refused: decoded !== undefined && "refused" in decoded ? decoded.refused : undefined,
      };
    }

    try {
      const tree = await getPipeline({ data: { id: params.id, input: values } });
      return { pipeline: listed, values, tree, refused: undefined };
    } catch (error) {
      // The registration's own schema refused it. That refusal belongs on the
      // page beside the form that produced it, naming the field it is about.
      return { pipeline: listed, values, tree: undefined, refused: String(error) };
    }
  },
  component: PipelinePage,
});

function PipelinePage(): React.ReactElement {
  const { pipeline, values, tree, refused } = Route.useLoaderData();
  const { input } = Route.useSearch();
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

      {/*
        Keyed on the encoded input, so the URL is what the fields say. A person
        who reloaded, or walked back out of a step's run, reads the value they
        supplied rather than the value the form would have started at.
      */}
      <SchemaForm
        key={input ?? ""}
        schema={(pipeline.input ?? {}) as JsonSchema}
        choices={pipeline.choices}
        {...(values === undefined ? {} : { values })}
        submitLabel="Show the steps"
        onSubmit={(supplied) => {
          setError(undefined);
          void navigate({ search: { input: JSON.stringify(supplied) } });
        }}
      />

      <button
        type="button"
        className="standalone"
        disabled={busy || values === undefined}
        data-testid="run-pipeline"
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void runPipeline({ data: { id: pipeline.id, input: values } })
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
        {tree === undefined ? <li className="empty">Supply an input.</li> : null}
      </ul>

      <p className="meta">
        A step runs when every step it depends on reads <code>accepted</code>. One that is parked
        or rejected blocks its own dependents and nothing else.
      </p>
    </div>
  );
}
