/**
 * The event stream: one bus in the process, one SSE endpoint over it.
 *
 * Every event names the run it belongs to, because the UI draws one graph per
 * run and a browser holding two of them open subscribes once. The bus is
 * push-only and holds nothing: a subscriber that arrives mid-run reads the
 * run's record for where it is and takes the stream from there, which is the
 * same List-then-Watch shape the rest of this repository uses when a snapshot
 * and a stream have to agree.
 *
 * Nothing in a graph reads one of these. They are an observation sink, and
 * removing the endpoint changes no trajectory.
 */

import type { StepAttempt } from "@des/core/step";
import type { RowStatus } from "@des/core/scheduler";
import type { NodeId } from "@des/core/workflow";
import type { Suspension } from "./runs.ts";

export type ServerEvent =
  | { type: "run-started"; runId: string; workflowId: string }
  | { type: "node-entered"; runId: string; node: NodeId; iteration: number }
  | { type: "node-left"; runId: string; node: NodeId }
  | { type: "leaf-attempt"; runId: string; attempt: StepAttempt }
  | { type: "suspended"; runId: string; suspension: Suspension }
  | { type: "resumed"; runId: string; answer: unknown }
  | {
      type: "terminal";
      runId: string;
      /** `failed` is a graph bug rather than a declared ending; see `RunStatus`. */
      kind: "accepted" | "rejected" | "failed";
    }
  | { type: "pipeline-row"; pipelineId: string; rowId: string; status: RowStatus; runId?: string };

export type EventBus = {
  emit(event: ServerEvent): void;
  /** Subscribe until the returned function is called. */
  subscribe(listener: (event: ServerEvent) => void): () => void;
  /** How many subscribers are listening. For a test that wants to know. */
  readonly size: number;
};

export const openEvents = (): EventBus => {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    emit: (event) => {
      // A listener that throws is a broken subscriber, not a broken run: the
      // emit side is a graph in flight, and it must not learn about a browser
      // that went away mid-write.
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          listeners.delete(listener);
        }
      }
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
