/**
 * One graph, drawn, with the one control that starts a run of it.
 *
 * The graph and the input schema arrive together from one server function,
 * because the schema is the REGISTRATION's rather than the graph's: a graph
 * says nothing about what a person supplies before it starts.
 */

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { SchemaForm, type JsonSchema } from "../form.tsx";
import { GraphView } from "../graph.tsx";
import { getWorkflow, startRun } from "../server/functions.ts";

export const Route = createFileRoute("/workflows/$id")({
  loader: async ({ params }) => await getWorkflow({ data: { id: params.id } }),
  component: WorkflowPage,
});

function WorkflowPage(): React.ReactElement {
  const workflow = Route.useLoaderData();
  const navigate = useNavigate();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | undefined>();

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
          schema={(workflow.input ?? {}) as JsonSchema}
          submitLabel="Start"
          busy={busy}
          {...(error === undefined ? {} : { error })}
          onSubmit={(input) => {
            setBusy(true);
            setError(undefined);
            void startRun({ data: { id: workflow.id, input } })
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
