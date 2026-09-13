/**
 * Where a person answers.
 *
 * A suspension is not an error and not a log line: it is the graph asking for
 * one value from a closed set, and it stops until it gets one. So it arrives
 * as a notification — the browser's, when the reader has allowed them, and an
 * in-app dialog either way — and the buttons on that dialog ARE the enum, read
 * off the node's own `resumeSchema` by the server. A person cannot answer with
 * something the node would refuse, because nothing else is offered.
 *
 * The free-text half, when a node has one, sits under the buttons: a `notes`
 * field is read by whatever runs next and never branched on.
 */

import { useEffect, useState } from "react";
import type { RunRecord } from "@des/server";

export type SuspensionDialogProps = {
  run: RunRecord;
  /** What the server said about the last answer, when it refused one. */
  error?: string;
  busy?: boolean;
  onAnswer: (answer: Record<string, unknown>) => void;
  onDismiss: () => void;
};

/** Ask once, and never again in this session. */
const notify = (title: string, body: string): void => {
  if (typeof Notification === "undefined") return;
  const show = (): void => {
    if (Notification.permission === "granted") new Notification(title, { body });
  };
  if (Notification.permission === "default") void Notification.requestPermission().then(show);
  else show();
};

export const SuspensionDialog = (props: SuspensionDialogProps): React.ReactElement | null => {
  const suspension = props.run.suspension;
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (suspension === undefined) return;
    notify(`${props.run.workflowId} needs a person`, suspension.reason);
  }, [suspension, props.run.workflowId]);

  if (suspension === undefined) return null;
  const field = suspension.resume?.field ?? "decision";
  const options = suspension.resume?.options ?? [];
  const takesNotes =
    (suspension.resume?.schema as { properties?: Record<string, unknown> } | undefined)?.properties?.[
      "notes"
    ] !== undefined;

  return (
    <div className="backdrop" role="dialog" aria-modal="true" data-testid="suspension">
      <div className="dialog">
        <h2 data-testid="suspension-reason">{suspension.reason}</h2>
        <p className="meta">
          <code>{props.run.runId}</code> parked at <code>{suspension.node ?? "?"}</code>. The run
          continues from here when you answer; it is not a new run.
        </p>

        <pre>{JSON.stringify(suspension.trail, null, 2)}</pre>

        {takesNotes ? (
          <label className="field">
            <span>notes — read by the next attempt, never branched on</span>
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        ) : null}

        {props.error === undefined ? null : <p className="error">{props.error}</p>}

        <div className="answers" data-testid="answers">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              // The one marker that says "this button posts an answer": the
              // dismiss beside them does not, and a test asserting the closed
              // enum is offered has to be able to tell them apart.
              data-answer={option}
              disabled={props.busy === true}
              onClick={() =>
                props.onAnswer({
                  [field]: option,
                  ...(takesNotes && notes.length > 0 ? { notes } : {}),
                })
              }
            >
              {option}
            </button>
          ))}
          <button type="button" className="ghost" onClick={props.onDismiss}>
            later
          </button>
        </div>

        {options.length === 0 ? (
          <p className="meta">
            This node's answer is not a closed enum, so there is nothing to offer. Call{" "}
            <code>resumeRun</code> with the shape its <code>resumeSchema</code> parses.
          </p>
        ) : null}
      </div>
    </div>
  );
};
