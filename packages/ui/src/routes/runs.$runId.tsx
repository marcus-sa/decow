/**
 * One run: the same graph, with what it has done to it so far.
 *
 * The drawing is the authored graph — the node ids are the ones in the source
 * — and the run is painted onto it: every node it entered, the one it is on,
 * and the iteration counter on any node it entered more than once. The trace
 * and the leaf attempts are beside it in words, because the picture says where
 * and the words say why.
 */

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { subscribe } from "../events.ts";
import { GraphView, type NodeState } from "../graph.tsx";
import { getRun, getWorkflow, resumeRun } from "../server/functions.ts";
import { SuspensionDialog } from "../suspension.tsx";

export const Route = createFileRoute("/runs/$runId")({
  loader: async ({ params }) => {
    const run = await getRun({ data: { runId: params.runId } });
    return { run, workflow: await getWorkflow({ data: { id: run.workflowId } }) };
  },
  component: RunPage,
});

function RunPage(): React.ReactElement {
  const { run, workflow } = Route.useLoaderData();
  const router = useRouter();
  const [answerError, setAnswerError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      // Every event about THIS run re-reads it. The record is the truth and
      // the event is the nudge: a client that missed one is still correct.
      subscribe((event) => {
        if ("runId" in event && event.runId === run.runId) void router.invalidate();
      }),
    [run.runId, router],
  );

  const states = useMemo((): Record<string, NodeState> => {
    const painted: Record<string, NodeState> = {};
    for (const entry of run.trace) painted[entry.node] = "visited";
    const last = run.trace.at(-1)?.node;
    if (last !== undefined && run.status !== "accepted" && run.status !== "rejected") {
      painted[last] = "current";
    }
    return painted;
  }, [run]);

  const iterations = useMemo((): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of run.trace) counts[entry.node] = entry.iteration;
    return counts;
  }, [run]);

  return (
    <div className="split">
      <div className="canvas">
        <GraphView projection={workflow.graph} states={states} iterations={iterations} />
      </div>

      <aside className="panel">
        <h1>
          <span className={`pill ${run.status}`} data-testid="run-status">
            {run.status}
          </span>{" "}
          <code>{run.runId}</code>
        </h1>
        <p className="lede">
          <Link to="/workflows/$id" params={{ id: run.workflowId }}>
            {run.workflowId}
          </Link>
          {run.engineRunId === undefined ? null : (
            <>
              {" · engine "}
              <code>{run.engineRunId.slice(0, 8)}</code>
            </>
          )}
        </p>

        {run.error === undefined ? null : (
          <>
            <h2>Graph bug</h2>
            <p className="error">{run.error}</p>
          </>
        )}

        <h2>Trace</h2>
        <div className="trace mono" data-testid="trace">
          {run.trace.map((entry, i) => (
            <span key={`${entry.node}-${i}`}>
              {entry.node}
              {entry.iteration > 1 ? ` ×${entry.iteration}` : ""}
            </span>
          ))}
          {run.trace.length === 0 ? <span className="meta">nothing yet</span> : null}
        </div>

        <h2>Leaf attempts</h2>
        <div className="attempts">
          {run.attempts.map((attempt, i) => (
            <div key={i} className={`attempt ${attempt.accepted ? "" : "refused"}`}>
              <div>
                <code>{attempt.stepId}</code> · attempt {attempt.attempt} ·{" "}
                {attempt.accepted ? "accepted" : "refused"}
              </div>
              <div className="meta">
                {attempt.model}
                {attempt.decision === undefined ? "" : ` → ${attempt.decision}`}
                {attempt.verdict === undefined ? "" : ` · validator ${attempt.verdict}`}
              </div>
              {attempt.mechanical.length === 0 ? null : (
                <div className="meta">
                  mechanical: {attempt.mechanical.map((v) => v.requirementId).join(", ")}
                </div>
              )}
              {attempt.violations.length === 0 ? null : (
                <div className="meta">
                  validator: {attempt.violations.map((v) => v.requirementId).join(", ")}
                </div>
              )}
              {attempt.error === undefined ? null : <div className="error">{attempt.error}</div>}
            </div>
          ))}
          {run.attempts.length === 0 ? (
            <p className="meta">
              No model was called: every leaf was a journal hit, or none has run yet.
            </p>
          ) : null}
        </div>

        {run.terminal === undefined ? null : (
          <>
            <h2>Terminal</h2>
            <p className="meta">{run.terminal.kind}</p>
            {run.terminal.trail === undefined ? null : (
              <pre>{JSON.stringify(run.terminal.trail, null, 2)}</pre>
            )}
          </>
        )}

        {run.status === "suspended" && dismissed ? (
          <button type="button" onClick={() => setDismissed(false)}>
            answer the suspension
          </button>
        ) : null}
      </aside>

      {run.status === "suspended" && !dismissed ? (
        <SuspensionDialog
          run={run}
          busy={busy}
          {...(answerError === undefined ? {} : { error: answerError })}
          onDismiss={() => setDismissed(true)}
          onAnswer={(answer) => {
            setBusy(true);
            setAnswerError(undefined);
            void resumeRun({ data: { runId: run.runId, answer } })
              .then(() => router.invalidate())
              .catch((e: Error) => setAnswerError(e.message))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
