/**
 * One graph, drawn, with the one control that starts a run of it.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api, type ListedWorkflow } from "../api.ts";
import { SchemaForm, type JsonSchema } from "../form.tsx";
import { GraphView } from "../graph.tsx";

export const Route = createFileRoute("/workflows/$id")({ component: WorkflowPage });

function WorkflowPage(): React.ReactElement {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<ListedWorkflow | undefined>();
  const [schema, setSchema] = useState<JsonSchema | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();

  useEffect(() => {
    void api
      .workflow(id)
      .then((found) => {
        setWorkflow(found);
        // The input schema is not on the projection — it is the registration's
        // — so it is fetched from the same place the run is started.
        setSchema(inputSchemaOf(found));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error !== undefined) return <p className="error">{error}</p>;
  if (workflow === undefined) return <p className="meta">…</p>;

  const node = workflow.graph.nodes.find((n) => n.id === selected);

  return (
    <div className="split">
      <div className="canvas">
        <GraphView projection={workflow.graph} onSelect={setSelected} />
      </div>

      <aside className="panel">
        <h1>{workflow.id}</h1>
        <p className="lede">{workflow.title}</p>

        <h2>Run it</h2>
        <SchemaForm
          schema={schema ?? {}}
          submitLabel="Start"
          busy={busy}
          {...(error === undefined ? {} : { error })}
          onSubmit={(input) => {
            setBusy(true);
            void api
              .startRun(workflow.id, input)
              .then(({ runId }) => navigate({ to: "/runs/$runId", params: { runId } }))
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        />

        <h2>Nodes</h2>
        <p className="meta">
          {workflow.graph.nodes.length} nodes, {workflow.graph.edges.length} edges.
          {workflow.graph.defects.length === 0
            ? " No defect: the compiler would build this."
            : ` ${workflow.graph.defects.length} defects.`}
        </p>
        {node === undefined ? (
          <p className="meta">Click a node.</p>
        ) : (
          <dl className="detail">
            <dt>id</dt>
            <dd>
              <code>{node.id}</code>
            </dd>
            <dt>kind</dt>
            <dd>{node.kind}</dd>
            {node.stepId === undefined ? null : (
              <>
                <dt>step</dt>
                <dd>
                  <code>{node.stepId}</code>
                </dd>
              </>
            )}
            {node.edges === undefined ? null : (
              <>
                <dt>edges</dt>
                <dd>
                  {Object.entries(node.edges).map(([key, to]) => (
                    <div key={key}>
                      <code>{key}</code> → <code>{to}</code>
                    </div>
                  ))}
                </dd>
              </>
            )}
            {node.max === undefined ? null : (
              <>
                <dt>bound</dt>
                <dd>
                  max {node.max}, body <code>{node.body}</code>
                </dd>
              </>
            )}
            {node.resume?.options === undefined ? null : (
              <>
                <dt>answers</dt>
                <dd>{node.resume.options.join(" · ")}</dd>
              </>
            )}
          </dl>
        )}
      </aside>
    </div>
  );
}

/**
 * The input schema, off the registration.
 *
 * `GET /api/workflows/:id` carries it beside the projection, because the
 * schema is the registration's rather than the graph's: a graph says nothing
 * about what a person supplies before it starts.
 */
const inputSchemaOf = (workflow: ListedWorkflow): JsonSchema =>
  (workflow as unknown as { input?: JsonSchema }).input ?? {};
