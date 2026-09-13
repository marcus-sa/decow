# `@des/ui`

The authored graph, drawn, with a live trace and a place to answer. TanStack
Start over `@des/server`'s API; JointJS draws, dagre lays out.

```bash
bun run ui:build     # from the repository root: what `serve({ fallback: ui() })` serves
bun run ui:dev       # vite, with /api proxied back to a running server
```

| Route | What it shows |
|---|---|
| `/` | Every registered graph, every pipeline, and every run. |
| `/workflows/:id` | The graph, drawn. A form from its input schema starts a run of it; clicking a node says what kind of thing it is. |
| `/runs/:runId` | The same graph with the run painted on: every node it entered, the one it is on, the iteration counter on anything it entered twice — and beside it the trace in words and every leaf attempt. |
| `/pipelines/:id` | The run tree: rows, the status each projects, and what refused the last run. |

**What it draws is the authored graph.** Every id on the canvas is one the
author wrote, because that is all the projection carries. A branch's edges are
labelled with the key they are taken on. A loop's body is laid out as a dagre
cluster and drawn as a dashed box with the bound written on it — which is what
makes a bounded loop legible as a bound rather than as an arrow that goes
backwards — and the loop node itself sits outside that box, because it is the
thing that decides whether there is another iteration rather than part of one.

**A suspension reaches a person as a notification and a dialog, and the buttons
are the node's own closed enum**, read off its `resumeSchema` by the server. A
person cannot answer with something the node would refuse, because nothing else
is offered. The free-text half, where a node has one, sits under the buttons
and is read by the next attempt rather than branched on.

**One process.** The app builds as a SPA — a prerendered shell plus a client —
so `@des/server` serves it from disk beside the API it is a client of. No
proxy, no second origin, and `/api` is a relative URL because it is genuinely
the same one. Development is the other way round: `vite dev` serves the app and
proxies `/api` back.

`dist/` is not committed. A server whose UI is not built answers 503 with the
command that builds it rather than 404ing at a person.

**No browser has rendered this.** There is no browser automation here and
nothing pretends otherwise: what is tested is the layout (that a loop's body
lands inside its own box) and the mount (that the shell and its assets are
served from the same origin as `/api`).
