# nWave as a consumer of the framework

The four directories here are one consumer's waves, plus the target they are
pointed at. The framework lives in `src/core`, `src/harness`, `src/bindings`,
`src/vcs`, and `src/artifacts`; this directory holds what a consumer owns: the
graphs, the requirement rows, the prompts, the model bindings, and the
fixtures. nWave is the consumer, and Overdrive is the first project it
delivers.

They connect through data, not through each other's code:

```
roadmap/   a request     ──►  roadmap rows in the artifact store   (roadmaps, roadmap_steps)
                                        │   observation, dependencies, authority,
                                        │   predictedTouches — and three EMPTY fields
                                        ▼
distill/   obligations/  ──►  the same rows, with `acceptance`, `oracle` and `supports` filled in
           oracle/       ──►  one executable oracle per value, written to disk and MEASURED RED,
                              recorded as an `oracle_runs` row
                                        │
                                        ▼
deliver/   the scheduler reads the rows, refuses any value whose oracle is not red, and runs the
           fixed step cycle once per ready row — with that row's oracle file PROTECTED, so RED to
           GREEN is bought by production. Each outcome is a step_runs row.
                                        │
todo/      the composition that points all of it at a real project — `targets/todo`, copied into a
           run directory — and five commands that drive it against real models, with a run report.
```

An agent never writes a workflow. It fills in leaves. The graphs below are
fixed; the roadmap is the only thing authored per feature, and it is rows.

## Reading the graphs

Every graph is built from the four constructors in `src/core/workflow.ts`.
Three kinds of node matter when reading one:

- **A leaf** is one model call through `runStep`: a worker, a validator,
  mechanical checks first, retries, escalation. Its `decision` is a closed enum
  and the only thing the graph reads.
- **A step** is code. It runs a pure function or emits effects and absorbs
  their typed results. `validate-shape`, `measure-disjointness`,
  `validate-manifest`, `write-oracle`, `measure`, `run-tests` and `persist` are
  steps.
- **A branch** is an exhaustive edge table over a closed enum. Every `*.route`
  and `*.verdict` node is one.

A `suspend` parks the run for a person and resumes on a closed decision enum. A
`loop` repeats a body up to a required bound. There are no back-edges anywhere.

In `bun test`, no leaf ever reaches a model: every answer is pre-seeded in the
journal, keyed by content exactly as production keys it. The mechanical half
runs for real, including the VCS, the artifact store, a real `tsc --noEmit` at
every write gate, and a real `bun test` at every measurement. That is what lets
the harness enumerate every path.

## `roadmap/` — the authoring workflow whose output is rows

Files: `schema.ts` (the roadmap rows), `shape.ts` (the pure shape validator),
`disjointness.ts` (the pure blast-radius pass), `steps.ts` (the two leaves and
their requirement rows), `fixture.ts` (a known-good roadmap and three
deliberately broken ones), `graph.ts`, `graph.test.ts`.

The schema mirrors nwave-experimental's `HandoverValue`:

```ts
RoadmapStep = {
  id, observation, dependencies: string[], authority, predictedTouches: string[],
  // DISTILL's to fill. ROADMAP leaves all three empty.
  acceptance: AcceptanceObligation[], oracle?: string, supports: string[],
}
AcceptanceObligation = { id, stimulus, expected }
Roadmap = { request, steps }
```

The graph is one bounded loop (`author`, max 2) around: `decompose`, a
frontier-class leaf that proposes the roadmap; `validate-shape`, pure, six
named defect kinds fed back to `decompose` on failure; `validate-slices`, one
small-model leaf returning a per-step verdict on whether each step is a
production-drivable vertical slice that invents no API, with verbatim anchors;
`measure-disjointness`, pure, mirroring `parallel_safety.py`; and
`human-review`, a suspend answered with `approve`, `revise`, or `abandon`. On
approve, `persist` writes one `roadmaps` row and one `roadmap_steps` row per
step.

**`no-acceptance` is not one of the shape defects, and its absence is the wave
boundary.** What a value must be observed to do is DISTILL's act. A shape check
demanding obligations at ROADMAP time would refuse every roadmap for not having
done a later wave's job. What ROADMAP *can* ask is whether the observation says
enough to be worked from at all, so `observation-too-short` sits there instead,
with nwave's own `MINIMUM_OBSERVATION_CHARACTERS` of 40 — measured rather than
chosen, from the shortest real accepted-turn diagnostic in the shipped runner.
The boundary is enforced twice: `acceptanceIsDistills` is a mechanical check on
`decompose`'s own output, so a proposal that filled the three fields in is
refused before a validator is spent.

169 paths, about 0.45 s. The known-good fixture is what the enumeration seeds
`decompose` with.

## `distill/` — what each value must be observed to do, and the oracle that observes it

DISTILL is **two disjoint steps**, and reading them as one is how the previous
cut of this repo got them wrong.

Files: `manifest.ts` (the pure rule set), `obligations/` (the first step),
`oracle/` (the second), `pipeline.ts` (the composition), `runs.ts` (the
`oracle_runs` projection both this wave and DELIVER read), `smoke.ts`.

### `obligations/` — `des distill`, which buys no model turn of its own

`des distill` is provider-free: a manifest in, a closed rule set applied, the
facts persisted. The only reason a model appears here is that something has to
*propose* the manifest — turning an observation into a stimulus and an expected
result is the one part that is not a lookup — so the leaf's decision space is a
**singleton**. Whether the proposal is admissible is `manifest.ts`'s, and that
is a total function.

Each rule is a named defect, because the defects are the feedback the next
proposal reads. Eleven of them: `no-values`, `unknown-observation`,
`duplicate-observation`, `uncovered-value`, `no-obligations`,
`duplicate-obligation-id`, `blank-field`, `oracle-not-a-locator`,
`support-not-a-whole-file`, `support-is-the-oracle`, `support-ignored`. Where a
typed schema makes one of nwave's fourteen *unrepresentable* rather than merely
invalid — `schema_version` is 1, the top level has exactly two keys,
`acceptance_supports` is an array — `manifest.ts` says so rather than counting
to fourteen. `uncovered-value` is ours and not nwave's: `des distill` merges a
partial manifest into a graph that may already carry facts, and this wave runs
once per roadmap with nothing to merge with.

`support-ignored` is the one rule that is a question about the *repository*
rather than about the manifest, so its predicate is injected — `git
check-ignore` in the composition, a literal in the walk — and the leaf's own
mechanical checks cannot carry it. That is stated where it lives and asserted
in the test.

**There is no human gate on the happy path**, unlike ROADMAP's. Every reason
this step can refuse is a named defect a proposal can be re-driven against, so
a review gate would be a person re-reading what a total function decided.

55 paths, about 0.13 s.

### `oracle/` — `des oracle --value N`, where software measures

Two things and one step. `author-oracle` runs on the acceptance designer's
binding and returns `authored | cannot-express`; then a `write-file` per
declared path lands the oracle and its supports under a path-scope lease; then
**software executes the oracle** and reads a verdict off it.

That last part is the whole arrangement. The two roles that hold an oracle —
its author, `Read, Edit`, and its reviewer, an enforced empty tool set —
*cannot run it*, so "this oracle fails on its assertion and not on its
scaffolding" is a property the runner owns and measures. The shipped code names
it `boundary:software-measures-model-decides`, and the pre-craft oracle
reviewer that used to sit between authoring and judging is retired: it was a
fourth model boundary, and the incident it existed for — a judge approving a
broken oracle in 27 seconds — is answered by a measurement that is free.

| verdict | route | why |
|---|---|---|
| `red` | leave the loop, `accepted` | the desired answer: it fails on its assertion before one production byte exists |
| `broken` | the one correction turn, with the runner's verbatim output as the finding | an import that does not resolve, a fixture that threw, a file that does not parse. The defect is the oracle's and no role downstream may repair it |
| `green` | a person, `vacuous-oracle` | a test that passes before any production code proves nothing |
| `indeterminate` | a person, `harness` | a non-zero exit whose own summary records neither a failure nor an error |

`cannot-express` is the designer's typed rejection — *the constructive chain
cannot be expressed through the declared public port without inventing a field,
an operation, a fixture fact or an expected result* — and it is charged to the
**design**, from a two-member `DEFECT_OWNERS` enum. A rejecting author owns no
byte: its finding travels, its edits do not, and a mechanical check enforces
that.

**The obligations reach the author, and in the shipped runner they do not.**
`_derive` builds its `AuthorityFacts` with `acceptance_obligations` at its
default and only the craft path populates it, so the acceptance author receives
the obligation *ids* and not the stimulus/expected pairs `des distill`
produced. Here they are an input.

421 paths, about 0.97 s. The third axis is the interesting one: the verdict is
an **effect outcome** rather than a leaf decision, so the walk gets all four
verdicts from the same `scriptedExecutor` seam it gets a write outcome from.

### The composition

`runObligations` runs the first graph once per roadmap. `openOracles` runs the
second once per value, in dependency order, through the same scheduler DELIVER
uses — each value under its own VCS session and task id — and records an
`oracle_runs` row per finished run. `verdict` on that row is the measured one
widened by exactly one word: `blocked` is a run that produced no measurement at
all, which keeps "measured green" and "never measured" two different facts.

There is **no protected scope here**, and that asymmetry is the point: this is
the one turn that owns the oracle. DELIVER's executor is the one that walls it.

The test path scope comes off one declared line in `design.md` (`- Test path
scope: \`test/\``), read by `testPathScope` and refused by name when absent. Three
consumers read it: the author writes there, the executor walls the oracle
there, and the manifest validator refuses a support outside it.

## `deliver/` — the fixed step cycle, and the scheduler that runs it per row

Files: `steps.ts` (the leaves, their enums and requirement rows, the
`StepUnderDelivery` input), `graph.ts`, `pipeline.ts` (the composition over the
artifact store, the VCS, and the scheduler), `smoke.ts`, and tests for each.

The cycle, with its loops and bounds:

```
cycle (max 1) {
  test-loop (max 2) { implement (replace-symbol) ─► select-tests ─► run-tests (effect) ─► test.route
                       ├─ still-red ─► diagnose ─► impl-wrong | at-wrong ─► fix-acceptance-test
                       │                         | design-missing | harness-failed
                       └─ green | broke-other | … }
  ─► refactor ─► gates-loop (max 2) { gates ─► clean | clippy-in-scope ─► fix-lint
                                      | mutation-below-gate ─► add-test | out-of-scope }
} ─► cycle.verdict ─► commit ─► accepted
```

**It starts at `implement`, and nothing precedes it.** There is no oracle node
and no RED node, because neither has anything left to do: the oracle was
authored and executed in its own run and this graph reads the recorded verdict.
"No edge bypasses RED" is therefore a **readiness precondition** — `eligible`
on the scheduler, `oracleIsRed` on the projection — which mirrors the shipped
runner's own rule that with no recorded oracle the next step for a value is
`des oracle`, never `des craft`.

Two things the pipeline builds per row, and both are about ownership:

- **`protected: [the row's oracle file]`.** `_crafter_owns` as an executor
  rule: every path the task declares is the crafter's except the oracle. The
  supports are *not* walled — a support is the oracle's dependency rather than
  the thing that measures the value.
- **`knownRed`: every other undelivered value's oracle.** Every one of them is
  red by construction, so refusing this row's correct write for one of them
  would make a module with two undelivered values undeliverable. An *accepted*
  sibling's oracle is deliberately not in it: that one is green, and breaking
  it is a real regression the gate exists to catch.

What is a model call and what is not:

- **Model leaves:** `implement`, `select-tests`, `diagnose`,
  `fix-acceptance-test`, `refactor`, `gates`, `fix-lint`, `add-test`,
  `surface-design-gap`, `commit`. In `smoke.ts` the three diagnosis-side leaves
  are Claude Code subagents through the `claudeCode` binding.
- **Steps, no model:** `run-tests` emits the effect and a pure branch routes its
  typed outcome.
- **The test verdict is the effect's outcome.** `committed` is green.
  `rejected: tests` is `still-red` when every failing test is one of the row's
  own oracle's and `broke-other` otherwise. `rejected: contract` means the
  selection dropped below the impact floor and parks for a person.
  `infra-failed` is `harness-failed`.
- **The LLM may add tests, never subtract.** `select-tests` returns `extra` ids;
  the VCS runs the impact floor plus `extra` and refuses any selection that
  omits a floor test.

443 paths, about 1.5 s. `MAX_CYCLES` is 1 because the two-cycle walk measured at
over 7,000 paths and 544 s; the one observation that costs is rebuilt locally by
the test that needs it.

## `todo/` — the three waves pointed at a real project

Files: `request.ts`, `run-dir.ts` (the run directory, the design source and the
suite runner), `models.ts` (which model runs which leaf), `report.ts` (the run
report), `render.ts`, the command scripts `roadmap.ts` / `review.ts` /
`distill.ts` / `deliver.ts` / `resume.ts`, the report command `summary.ts`, and
`todo.test.ts`.

### The target

[`targets/todo/`](../../../targets/todo) is a tiny TypeScript project: a
`TodoStore` with `add`, `complete`, `remove` and `list`. `add` and `list` are
implemented; **`complete` and `remove` are stubs whose bodies throw**.
`design.md` is the authority: the public surface, the behaviour of each method,
the driving port, and the test path scope.

**There is no test file.** The oracle is authored by `des oracle` into `test/`
and measured red before one production byte is written. A pre-written test
would make RED a thing the repository asserted rather than a thing the runner
measured.

The walking-skeleton shape is the point for the production half: the stub
*symbols* exist with their declared signatures, so a `replace-symbol` effect has
a target and the gap is a missing body rather than a missing surface.
`write-file` is what creates the oracle; `replace-symbol` is what fills the
body.

**It is a template and is never mutated.** Every run copies it.

### The run directory

```
runs/<name>/
  todo/              the copied target, which the VCS writes into
  vcs.sqlite         symbol registry, lease table, event log
  artifacts.sqlite   roadmaps, roadmap_steps, oracle_runs, step_runs
  journal.sqlite     what each step decided, keyed by content
  mastra.sqlite      engine snapshots, so a parked run survives exit
  report.jsonl       one line per leaf call
  run.json           the manifest: which roadmap, which parked run
```

Five stores, all files rather than `:memory:`, because the commands are
separate PROCESSES. `runs/` is gitignored. `test/` is tracked only once it
exists, because the oracle is what creates it.

The **design source** every leaf reads is `design.md` plus the VCS symbol
inventory, and the addition is load-bearing: `predictedTouches` and
`implement`'s `symbolId` are opaque VCS ids assigned at track time, so a model
that has never seen the inventory names one that does not exist and every write
it proposes comes back `rejected: contract`.

### The commands

```
ANTHROPIC_API_KEY=... bun run todo:roadmap first          # author, park at human-review
ANTHROPIC_API_KEY=... bun run todo:review  first approve  # resume in a second process, persist the rows
ANTHROPIC_API_KEY=... bun run todo:distill first          # the facts, then one oracle per value, measured
ANTHROPIC_API_KEY=... bun run todo:deliver first          # the step cycle, once per red-oracled row
                      bun run todo:report  first          # the table. No key: it reads a file
```

and `todo:resume <name> <row> <commit|abandon>` for a DELIVER row that parked.

- **`todo:roadmap`** copies the target, tracks it, and runs the roadmap
  authoring workflow to the `human-review` suspension. Nothing is persisted,
  because `persist` sits after the review.
- **`todo:review <approve|revise|abandon> [notes]`** resumes that run **in a
  second process**, from `run.json` plus `mastra.sqlite`, with the graph
  recompiled from source.
- **`todo:distill`** runs the obligations graph once, prints every value's
  obligations, oracle and supports, then runs the oracle graph per value in
  dependency order and prints each **measured verdict**. `author-oracle` is
  Sonnet; the obligations leaf and every validator are Haiku;
  `validate-manifest` and the measurement are not models at all.
- **`todo:deliver`** reads the rows and runs the step cycle once per row at
  concurrency 1. A value with no red oracle is refused **by name** rather than
  skipped. `implement` is Sonnet; every other leaf is Haiku.
- **`todo:resume <row> <commit|abandon>`** answers a parked DELIVER row, also in
  a fresh process: `record` persisted the run id on the row's `step_runs` row.

No escalation is wired, deliberately: `escalateTo` is unset, so the report's
exhaustion count is the number of decisions the *small* models could not get
past their own validators.

### The report

Every leaf call appends one line to `report.jsonl` — run, row, step, attempt,
model, decision, whether it was accepted, the validator's verdict and
violations, the mechanical-check failures, and the token counts. A journal HIT
writes nothing, because no model was called. `bun run todo:report <name>` prints
one row per leaf.

The gap between `calls` and `decided` is the number worth reading: it is what
the validator and the mechanical checks cost, in inference, to keep the graph
honest.

## Running things

```
bun test src/examples/nwave         # all four waves, no network, no key
bun run smoke:oracle                 # one oracle, authored by a real subagent in the PROPOSAL shape
bun run smoke:deliver                # DELIVER against Haiku plus three Claude Code subagents
```

Every script that calls a model refuses to run without `ANTHROPIC_API_KEY`.

**Nothing in this directory has been run against a real model.** The commands
exist and every one of them refuses without a key. `todo.test.ts` drives all
three waves against a real checkout — a real `write-file`, a real measurement, a
real `tsc` and a real impact-scoped `bun test` at every write gate — in about
1.6 s with zero model calls. What is untested is the inference itself: whether a
real model, given these prompts and schemas, gives useful answers at an
acceptable rate. Expect the prompts in `steps.ts` to need a round of tuning the
first time real output comes back, and expect the report to be how you find out.

## Not built on the consumer side

- DISTILL's obligations leaf reads the roadmap and the design source. It does
  not read the code the design describes, so an obligation naming a behaviour
  the surface cannot express is caught by `author-oracle`'s `cannot-express`
  one step later rather than at the manifest.
- Derived `step_edges` from measured touches. The scheduler runs the
  `dependencies` the roadmap persisted; the disjointness pass adds what the
  author missed but does not replace hand-authored edges.
- A second oracle per value. The manifest admits exactly one, which is what
  makes "the oracle was red" unambiguous; a value whose obligations genuinely
  need two files has to become two values.
- A resume path for a parked ORACLE run. Its block node takes one answer —
  `abandon` — and the composition does not offer it, so a parked oracle run is
  read from the trail and the roadmap is changed instead.
