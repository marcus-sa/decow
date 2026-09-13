/**
 * Subscribe to `/api/events`.
 *
 * The one thing in this application that is not a server function, because a
 * server function is one request and one response and this is a stream. It is
 * a server ROUTE (`./routes/api.events.ts`) over the registry's own bus.
 *
 * `EventSource` rather than a streamed fetch: it reconnects on its own, and a
 * UI that loses the stream for a second while a DELIVER row is mid-cycle
 * should pick it back up rather than go quiet. What it misses in that second
 * is on the run's record, and every view re-reads that when an event lands —
 * the same List-then-Watch shape the rest of this repository uses when a
 * snapshot and a stream have to agree.
 */

import type { ServerEvent } from "@des/server";

export type { ServerEvent };

/** Every event type the bus publishes. `EventSource` dispatches by name. */
const TYPES = [
  "run-started",
  "node-entered",
  "node-left",
  "leaf-attempt",
  "suspended",
  "resumed",
  "terminal",
  "pipeline-row",
] as const;

export const subscribe = (onEvent: (event: ServerEvent) => void): (() => void) => {
  const source = new EventSource("/api/events");
  const listener = (message: MessageEvent<string>): void => {
    onEvent(JSON.parse(message.data) as ServerEvent);
  };
  for (const type of TYPES) source.addEventListener(type, listener as EventListener);
  return () => source.close();
};
