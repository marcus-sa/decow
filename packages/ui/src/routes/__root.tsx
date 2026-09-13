/**
 * The document, and the one thing every page shares: a link back to the list.
 *
 * Every route below this one is server-rendered, so this is a real document
 * rather than a shell: `<HeadContent />` is filled in on the server and
 * `<Scripts />` is what hydrates it afterwards.
 */

import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "deterministic workflows" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  component: RootComponent,
  notFoundComponent: () => <p className="error">No such page.</p>,
});

function RootComponent(): ReactNode {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header className="top">
          <Link to="/" className="brand">
            deterministic workflows
          </Link>
          <span className="hint">the graph owns control flow; a model fills in values</span>
        </header>
        <main>
          <Outlet />
        </main>
        <Scripts />
      </body>
    </html>
  );
}
