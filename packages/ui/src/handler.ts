/**
 * The built application, as a fetch handler `@des/server` runs in its own
 * process.
 *
 * ONE PROCESS, and this is where that is true rather than merely claimed.
 * `vite build` leaves two things: `dist/server/server.js`, whose default
 * export is `{ fetch }` — TanStack Start's own request handler, which
 * dispatches server functions, then server routes, then SSR — and
 * `dist/client/assets/*`, the hashed bundles the rendered document asks for.
 * The handler below is the second in front of the first: a path under the
 * client directory is that file, everything else is the app's.
 *
 * The server entry is loaded by DYNAMIC import, and that is what keeps the
 * module graph acyclic while the package graph is not. `@des/ui` imports
 * `@des/server` for the registry its server functions read; `@des/server`
 * reaches `@des/ui` only here, at run time, for a built artifact — this module
 * imports nothing from `@des/server` at all.
 *
 * Nothing in the built bundle carries a copy of the registry: `@des/*` is
 * external to the server build (see `../vite.config.ts`), so it imports the
 * very modules this process already loaded.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** This file is `<repo>/packages/ui/src/handler.ts`. */
const PACKAGE = dirname(dirname(import.meta.path));

/** Where `vite build` leaves the hashed client bundles. */
export const CLIENT_DIR = join(PACKAGE, "dist", "client");

/** Where it leaves the request handler that renders and dispatches. */
export const SERVER_ENTRY = join(PACKAGE, "dist", "server", "server.js");

export type UiOptions = {
  /** Where the built client lives. The package's own `dist/client` by default. */
  clientDir?: string;
  /** Where the built server entry lives. The package's own by default. */
  serverEntry?: string;
};

/** Has the UI been built? A server can say so rather than 404 at a person. */
export const isBuilt = (options: UiOptions = {}): boolean =>
  existsSync(options.serverEntry ?? SERVER_ENTRY);

const NOT_BUILT =
  "The UI is not built. Run `bun run ui:build` from the repository root. There is no separate " +
  "dev server: the data comes from a registry only `serve()` supplies, and the build is ~1.5s.";

/** What the built server entry exports. */
type ServerEntry = { default: { fetch: (request: Request) => Promise<Response> } };

/**
 * The handler for everything: assets by path, and the app for the rest.
 *
 * A path that escapes the client directory is refused rather than served,
 * which is the one thing a static file server must not get wrong.
 */
export const uiHandler = async (
  options: UiOptions = {},
): Promise<(request: Request) => Promise<Response>> => {
  const clientDir = options.clientDir ?? CLIENT_DIR;
  const entry = options.serverEntry ?? SERVER_ENTRY;

  if (!isBuilt({ serverEntry: entry })) {
    return async () =>
      new Response(NOT_BUILT, { status: 503, headers: { "content-type": "text/plain" } });
  }

  const app = (await import(entry)) as ServerEntry;
  const root = resolve(clientDir);

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path !== "/") {
      const wanted = resolve(root, `.${path}`);
      if (!wanted.startsWith(root)) return new Response("no", { status: 403 });
      const file = Bun.file(wanted);
      if (await file.exists()) {
        // Hashed assets are immutable by construction.
        return new Response(file, {
          headers: path.startsWith("/assets/")
            ? { "cache-control": "public, max-age=31536000, immutable" }
            : {},
        });
      }
    }
    return await app.default.fetch(request);
  };
};
