/**
 * One run: the same graph, with what it has done to it so far.
 *
 * The drawing is the authored graph — the node ids are the ones in the source
 * — and the run is painted onto it: every node it entered, the one it is on,
 * and the iteration counter on any node it entered more than once. The trace
 * and the leaf attempts are beside it in words, because the picture says where
 * and the words say why.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, refusal, subscribe, type ListedWorkflow, type RunRecord } from "../api.ts";
import { GraphView, type NodeState } from "../graph.tsx";
import { SuspensionDialog } from "../suspension.tsx";

export const Route = createFileRoute("/runs/$runId")({ component: RunPage });

function RunPage(): React.ReactElement {
  const { runId } = Route.useParams();
  const [run, setRun] = useState<RunRecord | undefined>();
  const [workflow, setWorkflow] = useState<ListedWorkflow | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [answerError, setAnswerError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const reload = useCallback((): void => {
    void api
      .run(runId)
      .then(setRun)
      .catch((e: Error) => setError(e.message));
  }, [runId]);

  useEffect(() => {
    reload();
    // Every event about THIS run re-reads it. The record is the truth and the
    // event is the nudge: a client that missed one is still correct.
    return subscribe((event) => {
      if ("runId" in event && event.runId === runId) reload();
    });
  }, [runId, reload]);

  useEffect(() => {
    if (run === undefined || workflow !== undefined) return;
    void api.workflow(run.workflowId).then(setWorkflow).catch(() => {});
  }, [run, workflow]);

  const states = useMemo((): Record<string, NodeState> => {
    const painted: Record<string, NodeState> = {};
    for (const entry of run?.trace ?? []) painted[entry.node] = "visited";
    const last = run?.trace.at(-1)?.node;
    if (last !== undefined && run?.status !== "accepted" && run?.status !== "rejected") {
      painted[last] = "current";
    }
    return painted;
  }, [run]);

  const iterations = useMemo((): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of run?.trace ?? []) counts[entry.node] = entry.iteration;
    return counts;
  }, [run]);

  if (error !== undefined) return <p className="error">{error}</p>;
  if (run === undefined) return <p className="meta">…</p>;

  return (
    <div className="split">
      <div className="canvas">
        {workflow === undefined ? (
          <p className="meta">…</p>
        ) : (
          <GraphView projection={workflow.graph} states={states} iterations={iterations} />
        )}
      </div>

      <aside className="panel">
        <h1>
          <span className={`pill ${run.status}`}>{run.status}</span> <code>{run.runId}</code>
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
        <div className="trace mono">
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
            void api
              .resumeRun(run.runId, answer)
              .then(() => reload())
              .catch((e: unknown) => {
                const refused = refusal(e);
                setAnswerError(refused?.error ?? String(e));
              })
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
