/**
 * The UI is a TanStack Start application, server-rendered, and `@des/server`
 * runs its built handler in the same process.
 *
 * TWO THINGS ARE EXTERNAL AND THAT IS THE LOAD-BEARING PART. `@des/server` and
 * `@des/core` are linked workspace packages, so Vite's default is to BUNDLE
 * them into the server build — which would give the built handler its own copy
 * of the registry, its own `bun:sqlite` import, and its own everything. They
 * are marked external instead, so the built file `import`s them at run time and
 * resolves to exactly the modules the process that mounted it already loaded.
 * (The registry is on a well-known symbol as well, so even a bundler that
 * inlined a copy would read the same slot; two defences, because the failure
 * mode is silent.)
 *
 * There is no SPA mode and no `/api` proxy any more. Every read and every write
 * the UI does is a server function — a typed call that runs in this process —
 * and the one exception is `/api/events`, which is a server ROUTE because a
 * server function is request/response and an event stream is not.
 */

import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Resolved at run time out of the process that mounts the handler, never bundled. */
const EXTERNAL = [/^@des\//];

export default defineConfig({
  plugins: [
    // Must come before the React plugin: it owns the route generation and the
    // entry points the React plugin then transforms.
    tanstackStart(),
    viteReact(),
  ],
  environments: {
    ssr: {
      build: {
        rollupOptions: { external: EXTERNAL },
        rolldownOptions: { external: EXTERNAL },
      },
    },
  },
});
