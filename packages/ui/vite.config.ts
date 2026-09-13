/**
 * The UI builds as a SPA, deliberately.
 *
 * Every byte this app reads comes from `@des/server`'s own `/api`, and the
 * server is the one process that holds the runs, the graphs and the event
 * stream. A server-rendered route would have to reach that API from inside a
 * second server, at a URL it would have to be told, on a request whose only
 * purpose is to render what the client is about to fetch anyway. So the app is
 * a prerendered shell plus a client, and `@des/server` serves the shell from
 * disk beside the API it is a client of. One process, one origin, no proxy.
 */

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // Must come before the React plugin: it owns the route generation and the
    // entry points the React plugin then transforms.
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
  server: {
    // The development loop is the other way round from production: Vite serves
    // the app and hands `/api` back to the server the app is a client of. A
    // build per keystroke is not a loop.
    proxy: {
      "/api": {
        target: process.env.DES_SERVER ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
