# `@des/ui`

The authored graph, drawn, with a live trace and a place to answer. A TanStack
Start application over `@des/server`'s registry; JointJS draws, dagre lays out.

```bash
bun run ui:build     # from the repository root: what `serve()` mounts
bun run e2e          # the browser tests, against a real seeded server
```

| Route | What it shows |
|---|---|
| `/` | Every registered graph, every pipeline, and every run. |
| `/workflows/:id` | The graph, drawn. A form from its input schema starts a run of it; clicking a node says what kind of thing it is. |
| `/runs/:runId` | The same graph with the run painted on: every node it entered, the one it is on, the iteration counter on anything it entered twice — and beside it the trace in words and every leaf attempt. |
| `/pipelines/:id` | The run tree: rows, the status each projects, and the run each one is on. |
| `/api/events` | The event stream. A server route rather than a page. |

## Server functions, not a client over an API

Every read and every write is a `createServerFn` in `src/server/functions.ts`,
called directly from a route's loader or from a button. There is no fetch to
`/api` in the client, no hand-written JSON route behind one, and no origin to
configure — the function runs in the process that holds the registrations. The
bodies are `@des/server`'s own `api.ts`, so what a browser reaches is what that
package's unit tests drive.

Routes have loaders, so the first paint is server-rendered from the registry.
Events arrive on `/api/events` — a server ROUTE, because a server function is
one request and one response — and every one of them invalidates the route
that cares, which re-runs its loader. The record is the truth and the event is
the nudge: a client that missed one is still correct.

**One process.** `serve()` mounts the built handler: `dist/client/assets` by
path, everything else to TanStack Start's own `{ fetch }`, which dispatches
server functions, then server routes, then SSR. `@des/*` is external to the
server build, so the bundle imports the very modules the process already
loaded rather than carrying copies.

`dist/` is not committed, and a server whose UI is not built answers 503 with
the command that builds it rather than 404ing at a person. There is no
separate dev server: the data comes from a registry only `serve()` supplies,
and the loop is `bun run ui:build` (about 1.5 s) then `bun run todo`.

## The drawing

Every id on the canvas is one the author wrote, because that is all the
projection carries. A branch's edges are labelled with the key they are taken
on. A loop's body is laid out as a dagre **cluster** and drawn as a dashed box
with the bound written on it — which is what makes a bounded loop legible as a
bound rather than as an arrow that goes backwards — and the loop node itself
sits outside that box, because it is the thing that decides whether there is
another iteration rather than part of one.

JointJS is imported inside the effect that draws. Every route is
server-rendered, and a drawing library that wants a document has nothing to do
on a server.

**A suspension reaches a person as a notification and a dialog, and the buttons
are the node's own closed enum**, read off its `resumeSchema` by the server. A
person cannot answer with something the node would refuse, because nothing
else is offered. The free-text half, where a node has one, sits under the
buttons and is read by the next attempt rather than branched on.

## A browser has rendered it

`e2e/` is six Playwright tests, in four files, against a real `serve()` on a
free port, over the four example graphs and the two pipelines, seeded so that
every leaf is a journal hit — the bindings throw by name if a key misses, so a
test that reached a model would fail rather than spend one.

| Test | What it drives |
|---|---|
| `01-index` | Four graphs and two pipelines, server-rendered. |
| `02-graph` | Every node under the id its author wrote; the `author` loop as a box labelled `max 2` with the loop node outside it and its body inside; `human` and `human-review` drawn as suspends, and the only two. |
| `03-suspension` | A roadmap run started from the form, parked at `human-review`, offering exactly `approve` / `revise` / `abandon`; approve carries the SAME run to `accepted`. Video recorded. |
| `04-pipeline` | Two pending rows, one button, both `accepted`, and each row's link opening its own run page with the step cycle's trace on it. |

Screenshots are committed under `e2e/screenshots/` at a fixed 1440×960
viewport, so what the tests saw is reviewable in the repository. They are
rewritten by every run and a run mints new ids, so `git status` is dirty after
`bun run e2e` — they are evidence rather than golden files, and a diff in one
is not a failure. Videos are not committed: `test-results/` is gitignored.

The files are `*.e2e.ts` rather than `*.spec.ts` because `bun test` claims
`*.spec.*`, and these are not bun tests.
