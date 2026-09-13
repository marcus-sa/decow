# `@des/server`

The registration types, the registry, the runner, the pipeline scheduler, and
`serve`.

```ts
import { serve, registration } from "@des/server";

const server = await serve({
  workflows: [registration({ id, title, input, graph, seed, executor, journal })],
  pipelines: [{ id, title, rows, readiness, record }],
  artifacts,
  port: 3000,
});
```

`serve` builds a REGISTRY — the registrations, the run store, the runner, the
event bus — sets it where a request handler can read it, and mounts
`@des/ui`'s built handler on one port. One process, one origin.

**Mastra's runtime sits under this rather than beside it.** Runs, snapshots,
suspend and resume stay the engine's. What this adds is the half the engine
has no opinion about: which graph a person authored, which of its nodes a run
is on, what each leaf attempt decided and cost, and which rows of a pipeline
are waiting on which.

**The projection is of the AUTHORED graph.** The compiler emits nested
workflows with per-path ids; none of them reaches a reader. Every id this
server reports is one the author wrote.

## What the UI can ask for

`src/api.ts` is the whole surface, as plain functions over the registry.
`@des/ui` wraps each one in `createServerFn`, which adds a validator, the RPC
boundary and a typed client stub and nothing else — so what a browser reaches
is what a unit test here drives.

| Function | What it answers |
|---|---|
| `listWorkflows` | Every registration: its title, its authored graph, and the JSON Schema of its input. |
| `getWorkflow` | One of them. |
| `startRun` | Start a run. The input is parsed by the registration's own schema; the run executes asynchronously and the id comes back at once. |
| `listRuns` | Every run, summarised. |
| `getRun` | Status, the trace with iteration counters, the suspension and its answer space, the terminal, and every leaf attempt. |
| `resumeRun` | Answer a suspension. An answer outside the node's closed enum is refused here, with the enum named. |
| `readArtifacts` | A table's rows, one of them, or the body one held at a past version. |
| `listPipelines` | The registered compositions, by name. |
| `getPipeline` | The run tree: every row, the status it projects, the run it is on, and why the last drive stopped early. |
| `runPipeline` | Drive the frontier to quiescence. |
| `resumeRow` | Answer a parked row — which is answering its run. |

The one thing that is not a function is the event stream. `/api/events` is a
server ROUTE in `@des/ui`, over `openEvents`'s bus, because a server function
is one request and one response: `run-started`, `node-entered`, `node-left`,
`leaf-attempt`, `suspended`, `resumed`, `terminal`, `pipeline-row`.

## A pipeline is data, and the server schedules it

```ts
type PipelineRegistration = {
  id: string;
  title: string;
  rows: () => PipelineRow[] | Promise<PipelineRow[]>;   // { id, dependencies, workflowId, input }
  readiness?: (rowId: string) => boolean | Promise<boolean>;
  record?: (rowId: string, outcome: RunOutcome<unknown>) => void | Promise<void>;
  concurrency?: number;
  resourcesFor?: (row: PipelineRow) => string[];
};
```

It runs nothing. The server reads the rows, drives the frontier through
`@des/core`'s own `openScheduler`, and starts each ready row through the same
`runner.start` a person's button starts a run with — so **a row's run is an
ordinary run**: a server run id, a live trace, events, and a suspension
answered in the same dialog. `readiness` is the precondition the frontier rule
cannot express (DELIVER's is "this value's oracle has been measured red");
`record` is the consumer's one write.

A row's STATUS is read off the run the server started for it. `pending` covers
"never started" and "running right now", which is the scheduler's own reading
of it and is what makes an interrupted row simply run again.

## Two ids per run, and why

**The run id is this server's, and the engine's is recorded beside it.** `run`
mints its own and hands it back when it stops, so a call that must answer with
an id before the run has done anything has nothing to answer with. A
consumer's `record` receives the framework's `RunOutcome`, whose `runId` is
the ENGINE's — the one the snapshot is under, and the one that outlives the
process — and the server's record carries it as `engineRunId`, so the two
names for one run join in one hop.

**A run's record is in memory.** Everything durable about a run is already
durable somewhere better: the snapshot a suspension resumes from, the journal,
the VCS event log, the consumer's own rows. This holds what a person watching
right now is looking at.

## `Json`, and why it is not `unknown`

Everything reported to a browser goes through a server function, and a return
type containing `unknown` is not serializable — TanStack Start says so at the
boundary, and the call site degrades to `unknown`. Every value this affected
was JSON in fact and typed `unknown` only because the framework had no reason
to care: a JSON Schema, a form's input, an artifact row body that is JSON text
in the store it came from, a trail on its way to a person. `src/json.ts` is
the type and the one named widening.
