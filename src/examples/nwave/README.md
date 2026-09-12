# nWave as a consumer of the framework

The four directories here are one consumer's waves, plus the target they are
pointed at. The framework lives in `src/core`, `src/harness`, `src/bindings`, `src/vcs`, and `src/artifacts`; this directory holds what a consumer owns: the graphs, the requirement rows, the prompts, the model bindings, and the fixtures. nWave is the consumer, and Overdrive is the first project it delivers.

The three connect through data, not through each other's code:

```
distill/   one scenario  ──►  which test lanes it needs            (standalone; runs per DISTILL scenario)

roadmap/   a request     ──►  roadmap rows in the artifact store   (roadmaps, roadmap_steps)
                                        │
deliver/   the scheduler reads the rows, takes the frontier, and runs the fixed step cycle once per row,
           recording each outcome as a step_runs row. Status is derived from those rows, never held.
                                        │
todo/      the composition that points the two at a real project — `targets/todo`, copied into a run
           directory — and three commands that drive it against real models, with a run report.
```

An agent never writes a workflow. It fills in leaves. The graphs below are fixed; the roadmap is the only thing authored per feature, and it is rows.

## Reading the graphs

Every graph is built from the four constructors in `src/core/workflow.ts`. Three kinds of node matter when reading one:

- **A leaf** is one model call through `runStep`: a worker, a validator, mechanical checks first, retries, escalation. Its `decision` is a closed enum and the only thing the graph reads.
- **A step** is code. It runs a pure function or emits effects and absorbs their typed results. `validate-shape`, `measure-disjointness`, `oracle`, `activate-at`, `run-tests`, and `persist` are steps.
- **A branch** is an exhaustive edge table over a closed enum. Every `*.route` and `*.verdict` node is one.

A `suspend` parks the run for a person and resumes on a closed decision enum. A `loop` repeats a body up to a required bound. There are no back-edges anywhere.

In `bun test`, no leaf ever reaches a model: every answer is pre-seeded in the journal, keyed by content exactly as production keys it. The mechanical half runs for real, including the VCS, the artifact store, and a real `bun test` on a temp project in the pipeline test. That is what lets the harness enumerate every path.

## `distill/` — which test lanes does a scenario need

Files: `classify.ts` (the four classifier leaves, their requirement rows, and the `Lane` enum), `graph.ts`, `graph.test.ts`, `smoke.ts`.

Input is one scenario: id, text, and whether it crosses a component boundary. Four leaves fan out, each answering one question with `needed | not-needed | cannot-tell` plus a verbatim anchor into the scenario: E2E, expectation, benchmark, DST invariant. A pure `mergeVerdict` applies the cross-cutting rules from Overdrive's `testing.md`: a benchmark and an expectation are mutually exclusive, and a boundary-crossing scenario needs a composed-system lane. The branch over `MergeVerdict` routes `complete` to accept, the conflict to `demote-expectation`, and `incomplete-boundary` or an exhausted classifier to a person, who answers `proceed`, `override` (one classifier's lane), or `abandon`.

162 paths, about 0.7 s.

## `roadmap/` — the authoring workflow whose output is rows

Files: `schema.ts` (the roadmap rows), `shape.ts` (the pure shape validator), `disjointness.ts` (the pure blast-radius pass), `steps.ts` (the two leaves and their requirement rows), `fixture.ts` (a known-good roadmap and three deliberately broken ones), `graph.ts`, `graph.test.ts`.

The schema mirrors nwave-experimental's `HandoverValue`:

```ts
RoadmapStep = { id, observation, dependencies: string[], authority, acceptance: AcceptanceObligation[], predictedTouches: string[] }
AcceptanceObligation = { id, text, oracleLocator? }
Roadmap = { request, steps }
```

The graph is one bounded loop (`author`, max 2) around: `decompose`, a frontier-class leaf that proposes the roadmap; `validate-shape`, pure, six named defect kinds fed back to `decompose` on failure; `validate-slices`, one small-model leaf returning a per-step verdict on whether each step is a production-drivable vertical slice that invents no API, with verbatim anchors; `measure-disjointness`, pure, mirroring nwave-experimental's `parallel_safety.py`, which intersects `predictedTouches` for every pair with no dependency path and adds an edge in declaration order when they overlap, or reports the pair unresolvable if that edge would close a cycle; and `human-review`, a suspend carrying the roadmap, the added edges, and the defects, answered with `approve`, `revise`, or `abandon`. On approve, `persist` writes one `roadmaps` row and one `roadmap_steps` row per step through `upsert-artifact`. A conflict or rejection on persist parks for a person.

169 paths, about 1.6 s. The known-good fixture is what the enumeration seeds `decompose` with.

## `deliver/` — the fixed step cycle, and the scheduler that runs it per row

Files: `steps.ts` (the leaves, their enums and requirement rows, the `StepUnderDelivery` input), `oracle.ts` (locating and activating pre-authored acceptance tests), `graph.ts`, `pipeline.ts` (the composition over the artifact store, the VCS, and the scheduler), `smoke.ts`, and tests for each.

The cycle, with its loops and bounds:

```
oracle (locate ATs) ─► activate-at (replace-symbol: strip the pending marker) ─► run-tests.red ─► red
  ├─ red-observed ─► cycle (max 1) {
  │     test-loop (max 2) { implement (replace-symbol) ─► select-tests ─► run-tests (effect) ─► test.route
  │                          ├─ still-red ─► diagnose ─► impl-wrong | at-wrong ─► fix-acceptance-test | design-missing | harness-failed
  │                          └─ green | broke-other | … }
  │     ─► refactor ─► gates-loop (max 2) { gates ─► clean | clippy-in-scope ─► fix-lint | mutation-below-gate ─► add-test | out-of-scope }
  │  } ─► cycle.verdict ─► commit ─► accepted
  ├─ already-green ─► human            (the acceptance test is vacuous)
  └─ harness-failed ─► human
```

What is a model call and what is not:

- **Model leaves:** `run-tests.red`, `implement`, `select-tests`, `diagnose`, `fix-acceptance-test`, `refactor`, `gates`, `fix-lint`, `add-test`, `surface-design-gap`, `commit`. In `smoke.ts` the three diagnosis-side leaves are Claude Code subagents through the `claudeCode` binding: acceptance designer, crafter, architect.
- **Steps, no model:** `oracle` resolves each obligation's `oracleLocator` (`path::name` or a bare `name`) against the VCS symbol inventory; `activate-at` emits one `replace-symbol` per located test that turns `test.skip(` into `test(` (also `it`, `todo`), an identity-preserving edit; `run-tests` emits the effect and a pure branch routes its typed outcome.
- **The test verdict is the effect's outcome.** `committed` is green. `rejected: tests` is `still-red` when every failing test is one of the step's own ATs and `broke-other` otherwise. `rejected: contract` means the selection dropped below the impact floor and parks for a person. `infra-failed` is `harness-failed`.
- **The LLM may add tests, never subtract.** `select-tests` returns `extra` ids; the VCS runs the impact floor plus `extra` and refuses any selection that omits a floor test.

450 paths, about 4.5 s. `MAX_CYCLES` is 1 because the two-cycle walk measured at over 7,000 paths and 544 s; the one observation that costs is rebuilt locally by the test that needs it. The bounds and every measurement behind them are in the comment above them in `graph.ts`.

### The pipeline

`openPipeline` reads a roadmap's rows from the artifact store, builds one `StepUnderDelivery` per row, and hands the rows to `src/core/scheduler.ts`. The frontier is every row whose dependencies are `accepted`. Each ready row gets its own DELIVER run, its own VCS session (the row id), and its own task id on every event. A row's status is the outcome of its latest `step_runs` row, `pending` if none; there is no `running` state because nothing is persisted until a run finishes. A suspended or rejected row blocks only its dependents.

The end-to-end test in `pipeline.test.ts` runs a two-step roadmap against a temp TypeScript project with real `test.skip` scaffolds, real VCS writes, and a real `bun test`, with every leaf answered from the journal. It takes under a second.

## `todo/` — the two waves pointed at a real project

Files: `request.ts` (the one request, and the `roadmaps` row id), `run-dir.ts` (the run directory and the design source), `models.ts` (which model runs which leaf), `evidence.ts` (the RED evidence, measured), `report.ts` (the run report), `render.ts`, the four command scripts `roadmap.ts` / `review.ts` / `deliver.ts` / `resume.ts`, the report command `summary.ts`, and `todo.test.ts`.

### The target

[`targets/todo/`](../../../targets/todo) is a tiny TypeScript project: a `TodoStore` with `add`, `complete`, `remove` and `list`. `add` and `list` are implemented; **`complete` and `remove` are stubs whose bodies throw**. `test/todo.test.ts` holds eight acceptance tests, four active and **four pending behind `test.skip(`** — the marker convention the oracle locates and `activate-at` strips. `design.md` is the authority: the whole public surface, the behaviour of each method, and the locator of every pending test.

The walking-skeleton shape is the point. The stub *symbols* exist with their declared signatures, so a `replace-symbol` effect has a target and the gap is a missing body rather than a missing surface — which is what the framework can actually write, since `Effect` has no way to create a file or a symbol.

**It is a template and is never mutated.** Every run copies it.

### The run directory

```
runs/<name>/
  todo/              the copied target, which the VCS writes into
  vcs.sqlite         symbol registry, lease table, event log
  artifacts.sqlite   roadmaps, roadmap_steps, step_runs
  journal.sqlite     what each step decided, keyed by content
  mastra.sqlite      engine snapshots, so a parked run survives exit
  report.jsonl       one line per leaf call
  run.json           the manifest: which roadmap, which parked run
```

Five stores, all files rather than `:memory:`, because the commands are separate PROCESSES. `runs/` is gitignored.

The **design source** every leaf reads is `design.md` plus the VCS symbol inventory, and the addition is load-bearing rather than decorative: `predictedTouches` and `implement`'s `symbolId` are opaque VCS ids assigned at track time, so a model that has never seen the inventory names one that does not exist and every write it proposes comes back `rejected: contract`.

### The three commands

```
ANTHROPIC_API_KEY=... bun run todo:roadmap first          # author, park at human-review
ANTHROPIC_API_KEY=... bun run todo:review  first approve  # resume in a second process, persist the rows
ANTHROPIC_API_KEY=... bun run todo:deliver first          # the step cycle, once per row
                      bun run todo:report  first          # the table. No key: it reads a file
```

- **`todo:roadmap`** copies the target, tracks it, and runs the roadmap authoring workflow. `decompose` is `anthropic/claude-opus-5`; `validate-slices` and every validator are `anthropic/claude-haiku-4-5`; `validate-shape` and `measure-disjointness` are pure functions. It runs to the `human-review` suspension, prints the proposed roadmap, the shape defects and the disjointness result, prints the run id, and exits. Nothing is persisted to the artifact store, because `persist` sits after the review.
- **`todo:review <approve|revise|abandon> [notes]`** resumes that run **in a second process**. The run id is in `run.json`, the snapshot is in `mastra.sqlite`, and the graph is recompiled from source. `approve` leaves the loop and `persist` writes the rows; `revise` re-drives `decompose` with the notes, from inside the loop.
- **`todo:deliver`** reads the rows and runs the step cycle once per row at **concurrency 1**. `implement` is `anthropic/claude-sonnet-5`; every other leaf is Haiku. The oracle, the activation and the suite are not models. Every write is gated by a real `tsc --noEmit` and a real impact-scoped `bun test`, and the whole suite runs once at the end. A parked row prints a `todo:resume` line.
- **`todo:resume <row> <commit|abandon>`** answers a parked DELIVER row, also in a fresh process: `record` persisted the run id on the row's `step_runs` row, so the projection that answers "is this row parked" also answers "which run".

No escalation is wired, deliberately: `escalateTo` is unset, so the report's exhaustion count is the number of decisions the *small* models could not get past their own validators.

### The report

Every leaf call appends one line to `report.jsonl` — run, row, step, attempt, model, decision, whether it was accepted, the validator's verdict and violations, the mechanical-check failures, and the token counts. A journal HIT writes nothing, because no model was called. `bun run todo:report <name>` prints one row per leaf: calls, decisions, first-attempt rate, exhaustions, validator rejections, mechanical failures, tokens.

The gap between `calls` and `decided` is the number worth reading: it is what the validator and the mechanical checks cost, in inference, to keep the graph honest.

Three facts join into a line and they come from three places: the attempt from `runStep`'s observer seam, the row from the per-row observer the pipeline builds, and the tokens from `mastraAgent`'s `onUsage`. Token attribution is **order-based**, which is why the deliver command runs at concurrency 1; a line written at a higher concurrency carries `concurrent: true` and its token columns are not to be trusted.

### The RED evidence is measured, not supplied

`run-tests.red` is a leaf whose question is a judgement — "is this acceptance test vacuous?" — so it reads runner output. The target's pending tests are `test.skip`, so running the project as it stands reports them SKIPPED, and a classifier handed that would answer `already-green` and park. `evidence.ts` therefore copies the run's project to a scratch directory, strips every marker there, runs the suite, and hands over what it printed. That is the output the acceptance tests actually produce against the stub bodies, byte for byte.

## Running things

```
bun test src/examples/nwave         # all four, no network, no key
bun run smoke                        # DISTILL against a real Haiku through Mastra
bun run smoke:deliver                # DELIVER against Haiku plus three Claude Code subagents
```

Every script that calls a model refuses to run without `ANTHROPIC_API_KEY`.

**Nothing in this directory has been run against a real model yet, and the commands that would do it now exist.** Before this cut the gap was that there was nothing to run: three graphs, no target, no run directory, no way for a person to answer a suspension in a second process, and no way to record what a real run cost. All four are built and exercised without inference — `todo.test.ts` drives the whole pipeline against a real checkout, with a real `tsc` and a real `bun test` at every write gate, in about 2.7 s. What is still untested is the inference itself: whether a real model, given these prompts and schemas, gives useful answers at an acceptable rate. Expect the prompts in `steps.ts` and `classify.ts` to need a round of tuning the first time real output comes back, and expect the report to be how you find out.

## Not built on the consumer side

- An `author-at` leaf on the acceptance-designer binding for obligations whose test does not exist yet. It needs a `create-file` write the VCS does not have, so a missing test parks for a person today.
- Derived `step_edges` from measured touches. The scheduler runs the `dependencies` the roadmap persisted; the disjointness pass adds what the author missed but does not replace hand-authored edges.
- DISTILL fed from a real `test-scenarios` artifact rather than a hand-built scenario, and pointed at the todo target like the other two.
- RED reading an effect's result rather than a string. `evidence.ts` produces the string honestly — the target's own suite, markers stripped, in a scratch copy — but the built version makes the RED run an effect whose typed result the leaf reads, which is a graph change and is not made.
