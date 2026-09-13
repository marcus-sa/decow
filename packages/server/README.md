# `@des/server`

One HTTP surface over the graphs a target registered: the authored projection,
the runs, the suspensions, the artifact rows, and the pipelines.

```ts
import { serve, registration } from "@des/server";

const server = await serve({
  workflows: [registration({ id, title, input, graph, seed, executor, journal })],
  pipelines: [{ id, title, rows, status, run, resume }],
  artifacts,
  fallback: ui(),
});
```

**Mastra's runtime sits under this rather than beside it.** Runs, snapshots,
suspend and resume stay the engine's. What this adds is the half the engine has
no opinion about: which graph a person authored, which of its nodes a run is
on, what each leaf attempt decided and cost, and which rows of a pipeline are
waiting on which.

**The projection is of the AUTHORED graph.** The compiler emits nested
workflows with per-path ids; none of them reaches a reader. Every id this
server reports is one the author wrote.

| Route | What it answers |
|---|---|
| `GET /api/workflows` | Every registration: its title, its authored graph, and the JSON Schema of its input. |
| `GET /api/workflows/:id` | One of them. |
| `POST /api/workflows/:id/runs` | Start a run. The body is parsed by the registration's own schema; the run executes asynchronously and the id comes back at once. |
| `GET /api/runs` | Every run, summarised. |
| `GET /api/runs/:runId` | Status, the trace with iteration counters, the suspension and its answer space, the terminal, and every leaf attempt. |
| `POST /api/runs/:runId/resume` | Answer a suspension. An answer outside the node's closed enum is refused here, with the enum. |
| `GET /api/events` | SSE: `run-started`, `node-entered`, `node-left`, `leaf-attempt`, `suspended`, `resumed`, `terminal`, `pipeline-row`. |
| `GET /api/artifacts/:table` | Every live row of one table. |
| `GET /api/artifacts/:table/:id?version=` | One row now, or the body it held at a past version. |
| `GET /api/pipelines` | The registered compositions, by name. |
| `GET /api/pipelines/:id` | The run tree: every row, the status it projects, and why the last run stopped early when one did. |
| `POST /api/pipelines/:id/run` | Run the ready set to quiescence. |
| `POST /api/pipelines/:id/rows/:rowId/resume` | Answer a parked row, then re-evaluate the frontier. |

Anything not under `/api` goes to `fallback`, which is where the UI is mounted.

**The run id is this server's, and the engine's is recorded beside it.** `run`
mints its own and hands it back when it stops, so a POST that must answer with
an id before the run has done anything has nothing to answer with.

**A run's record is in memory.** Everything durable about a run is already
durable somewhere better — the snapshot a suspension resumes from, the journal,
the VCS event log, a pipeline's own projection. This holds what a person
watching right now is looking at.
