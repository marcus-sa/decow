/**
 * The event stream: one bus in the process, one append-only table under it,
 * one SSE endpoint over it.
 *
 * Every event names the run it belongs to, because the UI draws one graph per
 * run and a browser holding two of them open subscribes once. Before a
 * subscriber sees one, the event is APPENDED FIRST, to `run_events`, and
 * published second. So the log is what a run's trace is read off, a
 * subscriber that arrives mid-run reads the run's record
 * for where it is and takes the stream from there, and a subscriber that
 * arrives after a RESTART reads a record that still exists.
 *
 * Append-then-publish is the ordering that matters. A subscriber woken by an
 * event re-reads the record, and a record that did not yet carry the fact the
 * event announced would send it back a version behind.
 *
 * Nothing in a graph reads one of these. They are an observation sink, and
 * removing the endpoint changes no trajectory.
 */

import type { StepAttempt, StepStarted } from "@des/core/step";
import type { StepStatus } from "@des/core/scheduler";
import type { NodeId } from "@des/core/workflow";
import { asJson, type Json } from "./json.ts";
import type { RunDatabase } from "./store.ts";
import type { Suspension } from "./runs.ts";

export type ServerEvent =
  | { type: "run-started"; runId: string; workflowId: string }
  | { type: "node-entered"; runId: string; node: NodeId; iteration: number }
  | { type: "node-left"; runId: string; node: NodeId }
  /**
   * A worker call is about to be made. Published BEFORE it, because that is
   * the only moment at which it is news: `leaf-attempt` cannot arrive until
   * the call comes back, and a frontier-class call is minutes of silence.
   */
  | { type: "leaf-started"; runId: string; started: StepStarted }
  | { type: "leaf-attempt"; runId: string; attempt: StepAttempt }
  | { type: "suspended"; runId: string; suspension: Suspension }
  | { type: "resumed"; runId: string; answer: unknown }
  | {
      type: "terminal";
      runId: string;
      /** `failed` is a graph bug rather than a declared ending; see `RunStatus`. */
      kind: "accepted" | "rejected" | "failed";
    }
  | {
      type: "pipeline-step";
      pipelineId: string;
      stepId: string;
      status: StepStatus;
      runId?: string;
      /**
       * True on the event that ATTACHED this run to this step, and on no
       * other. Said rather than inferred, because the two emitters differ in
       * what they carry and a reader that guessed from a payload's shape would
       * guess wrong the day a payload is legitimately empty.
       */
      attached?: true;
      /** The input the pipeline was driven with. On the attaching event. */
      input?: Json;
    };

/** The nine kinds, as one closed list. The table stores every one of them. */
export const EVENT_KINDS = [
  "run-started",
  "node-entered",
  "node-left",
  "leaf-started",
  "leaf-attempt",
  "suspended",
  "resumed",
  "terminal",
  "pipeline-step",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export type EventBus = {
  /** Append, then publish. Answers with the sequence the event landed at. */
  emit(event: ServerEvent): number;
  /** Subscribe until the returned function is called. */
  subscribe(listener: (event: ServerEvent) => void): () => void;
  /** How many subscribers are listening. For a test that wants to know. */
  readonly size: number;
};

export const openEvents = (db: RunDatabase): EventBus => {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    emit: (event) => {
      const seq = db.events.append({
        ...("runId" in event && event.runId !== undefined ? { runId: event.runId } : {}),
        kind: event.type,
        payload: asJson(event),
      });
      // A listener that throws is a broken subscriber, not a broken run: the
      // emit side is a graph in flight, and it must not learn about a browser
      // that went away mid-write. The append already happened, so a thrown
      // listener costs a reader a nudge and never a fact.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          listeners.delete(listener);
        }
      }
      return seq;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get size() {
      return listeners.size;
    },
  };
};

/** One event, in the `text/event-stream` wire format. */
export const encodeEvent = (event: ServerEvent): string =>
  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

/** An SSE response over the bus, closing when the client goes away. */
export const eventStream = (bus: EventBus, signal?: AbortSignal): Response => {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // A first byte, so a client knows the stream is open before anything
      // happens. Comment frames are ignored by every SSE reader.
      controller.enqueue(encoder.encode(": open\n\n"));
      unsubscribe = bus.subscribe((event) => {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      });
      signal?.addEventListener("abort", () => {
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client going away first.
        }
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
};
