/**
 * The router factory TanStack Start calls on both sides of the wire.
 *
 * The route tree is generated from `src/routes` by the Vite plugin and is
 * committed, so a typecheck that has not run the build still sees every route.
 */

import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true, defaultPreload: "intent" });
}
