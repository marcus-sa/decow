/**
 * The UI, as a fetch handler `@des/server` mounts beside its own `/api`.
 *
 * ONE PROCESS. The app builds as a SPA — a prerendered shell plus a client
 * bundle — so serving it is serving files: the hashed assets by path, and the
 * shell for every route the client owns. There is no second server, no proxy,
 * and no origin to configure, which is what makes `/api` a relative URL in the
 * client and a relative URL the right thing for it to be.
 *
 * In development the loop is the other way round: `vite dev` serves the app
 * with hot reload and proxies `/api` back to this server, because a build per
 * keystroke is not a loop. That is a Vite config, not a thing this handler
 * does.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** This file is `<repo>/packages/ui/src/serve.ts`. */
const PACKAGE = dirname(dirname(import.meta.path));

/** Where `vite build` leaves the client: the shell and the hashed assets. */
export const CLIENT_DIR = join(PACKAGE, "dist", "client");

/** The prerendered document every route is served from. */
export const SHELL = join(CLIENT_DIR, "_shell.html");

export type UiOptions = {
  /** Where the built client lives. The package's own `dist/client` by default. */
  dir?: string;
};

/** Has the UI been built? A server can say so rather than 404 at a person. */
export const isBuilt = (options: UiOptions = {}): boolean =>
  existsSync(join(options.dir ?? CLIENT_DIR, "_shell.html"));

const NOT_BUILT =
  "The UI is not built. Run `bun run build` in packages/ui, or `bun run dev` there for the " +
  "hot-reload loop, which proxies /api back to this server.";

/**
 * A handler for everything that is not `/api`.
 *
 * A path that names a file under the client directory is that file; everything
 * else is the shell, because every other path is a route the client resolves
 * for itself. A path that escapes the directory is neither: it is refused.
 */
export const ui = (options: UiOptions = {}) => {
  const root = options.dir ?? CLIENT_DIR;

  return async (request: Request): Promise<Response | undefined> => {
    if (!isBuilt({ dir: root })) {
      return new Response(NOT_BUILT, { status: 503, headers: { "content-type": "text/plain" } });
    }

    const path = new URL(request.url).pathname;
    const wanted = resolve(root, `.${path}`);
    if (!wanted.startsWith(resolve(root))) return new Response("no", { status: 403 });

    const file = Bun.file(wanted);
    if (path !== "/" && (await file.exists())) {
      // Hashed assets are immutable by construction; the shell is not, and is
      // served below without a cache header.
      return new Response(file, {
        headers: path.startsWith("/assets/")
          ? { "cache-control": "public, max-age=31536000, immutable" }
          : {},
      });
    }

    return new Response(Bun.file(join(root, "_shell.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    });
  };
};
