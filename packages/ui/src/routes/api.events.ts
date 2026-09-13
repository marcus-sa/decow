import { createFileRoute } from "@tanstack/react-router";
import { eventStream, getRegistry } from "@des/server";

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: ({ request }) => eventStream(getRegistry().events, request.signal),
    },
  },
});
