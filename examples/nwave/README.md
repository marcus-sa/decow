# nWave as a consumer of the framework

The three directories here are one consumer's waves. The target they are
pointed at, and the composition that drives it, live under `targets/todo/` and
`targets/todo/.des/`. The framework is `@des/core`, the server over it is
`@des/server`, and the UI over that is `@des/ui`; this directory holds what a
consumer owns: the graphs, the requirement rows, the prompts, the model
bindings, and the fixtures. nWave is the consumer, and Overdrive is the first
project it delivers.

They connect through data, not through each other's code:

```
roadmap/   a request     ──►  roadmap steps in the artifact store  (roadmaps, roadmap_steps)
                                        │   observation, dependencies, authority,
                                        │   predictedTouches — and three EMPTY fields
                                        ▼
distill/   obligations/  ──►  the same steps, with `acceptance`, `oracle` and `supports` filled in
           oracle/       ──►  one executable oracle per value, written to disk and MEASURED RED,
                              recorded as an `oracle_runs` row
                                        │
                                        ▼
deliver/   the scheduler reads the steps, refuses any value whose oracle is not red, and runs the
           fixed step cycle once per ready step — with that step's oracle file PROTECTED, so RED to
           GREEN is bought by production. Each outcome is a step_runs row.
                                        │
targets/todo/.des/  the composition that points all of it at a real project — `targets/todo`, copied
                    into a run directory — registered with one server, whose runs are rows.
```

An agent never writes a workflow. It fills in leaves. The graphs below are
fixed; the roadmap is the only thing authored per feature, and it is steps.

## Reading the graphs

Every graph is built from the four constructors in `@des/core/workflow`.
Three kinds of node matter when reading one:

- **A leaf** is one model call through `runStep`: a worker, a validator,
  mechanical checks first, retries, escalation. Its `decision` is a closed enum
  and the only thing the graph reads.
- **A step** is code. It runs a pure function or emits effects and absorbs
  their typed results. `validate-shape`, `measure-disjointness`,
  `validate-manifest`, `write-oracle`, `measure`, `run-tests`, `gates` and
  `persist` are steps.
- **A branch** is an exhaustive edge table over a closed enum. Every `*.route`
  and `*.verdict` node is one.

A `suspend` parks the run for a person and resumes on a closed decision enum. A
`loop` repeats a body up to a required bound. There are no back-edges anywhere.

In `bun test`, no leaf ever reaches a model: every WORKER answers from a
`scriptedBinding` script keyed by step id, and the leaf's own output schema,
mechanical checks and validator run for real around it. The rest runs for real
too, including the VCS, the artifact store, and every command the target
declared: a real `bunx tsc --noEmit` and a real `bunx biome check` at every
write gate, a real `bun test` at every measurement and at the quality gate's
own impact-scoped runs. That is what lets the harness enumerate every path.

Running the checks changed two of the four counts, and the change is the
finding. A leaf carries the same rules as mechanical checks that its gate
carries as a total function — deliberately, so a rule cannot hold at one and
not the other — so a proposal breaking one never REACHES the gate: the check
refuses it and the worker is re-driven. The paths that disappeared were ones
production could not take, and the ones that remain are reachable.

## `roadmap/` — the authoring workflow whose output is steps

Files: `schema.ts` (the roadmap steps), `shape.ts` (the pure shape validator),
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

176 paths, about 0.68 s. It was 169 when the two leaves answered from a seeded
journal, which skipped the six mechanical checks `decompose` carries and the
three `validate-slices` does. The walk gained a fifth proposal to keep the
gate's `invalid` edge reachable: `MALFORMED` breaks three rules the LEAF owns,
so it exhausts there, and `UNSHAPED` breaks only the dangling dependency and
the cycle, which are the gate's alone. The known-good fixture is what the
enumeration seeds
`decompose` with.

## `distill/` — what each value must be observed to do, and the oracle that observes it

DISTILL is **two disjoint steps**, and reading them as one is how the previous
cut of this repo got them wrong.

Files: `manifest.ts` (the pure rule set), `obligations/` (the first step),
`oracle/` (the second), `pipeline.ts` (the composition), `runs.ts` (the
`oracle_runs` projection both this wave and DELIVER read), `smoke.ts`.

### `obligations/` — the acceptance facts, which buy no model turn of their own

Mirrors nwave's `des distill` step. There is no dependency on `des` here; the
graph is this repository's, and the name of the step it models is the only
thing borrowed.

The shipped step is provider-free: a manifest in, a closed rule set applied,
the facts persisted. The only reason a model appears here is that something has to
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

28 paths, about 0.09 s. It was 55 when the leaf answered from a seeded
journal: nine of the proposals the walk draws from break one of the ten
manifest rules the leaf carries as a mechanical check, so they exhaust at the
LEAF rather than iterating the loop through the gate. `support-ignored` is the
one rule the leaf cannot carry — it is a question about the repository — and it
is therefore the only route to the gate's own `invalid` edge.

### `oracle/` — the oracle, authored and then measured by software

Mirrors nwave's `des oracle --value N` step. Same note as above: nothing here
depends on `des`, and the shipped step is what the graph is modelled on.

Two things and one step. `author-oracle` runs on the acceptance designer's
binding and returns `authored | cannot-express`; then a `write-file` per
declared path lands the oracle and its supports under a path-scope lease; then
**software executes the oracle** and reads a verdict off it.

What executes it is the consumer's declared `commands.oracle` — the framework
knows the job and the target names the runner — and the verdict is read off the
JUnit report that command was told to write. See
[Declared commands](../../README.md#declared-commands).

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
| `indeterminate` | a person, `harness` | a non-zero exit whose own report records neither a failure nor an error |

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

421 paths, about 1.3 s. The third axis is the interesting one: the verdict is
an **effect outcome** rather than a leaf decision, so the walk gets all four
verdicts from the same `scriptedExecutor` seam it gets a write outcome from.

### The composition

The first graph is registered as a WORKFLOW and runs once per roadmap; the
second is registered as a PIPELINE over the roadmap's steps, one run per value,
in dependency order — each value under its own VCS session and its own task id
— and `recordOracleRun` appends an `oracle_runs` row per finished run.
`verdict` on that row is the measured one widened by exactly one word:
`blocked` is a run that produced no measurement at all, which keeps "measured
green" and "never measured" two different facts. Neither of them schedules
anything: a pipeline registration is steps plus `record`, and the server drives
the frontier.

There is **no protected scope here**, and that asymmetry is the point: this is
the one turn that owns the oracle. DELIVER's executor is the one that walls it.

The test path scope comes off one declared line in `design.md` (`- Test path
scope: \`test/\``), read by `testPathScope` and refused by name when absent. Three
consumers read it: the author writes there, the executor walls the oracle
there, and the manifest validator refuses a support outside it.

## `deliver/` — the fixed step cycle, and the scheduler that runs it per step

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
  ─► refactor ─► gates-loop (max 2) { gates (run-command: commands.lint)
                                      ─► clean | lint-failed ─► fix-lint | infra-failed }
} ─► cycle.verdict ─► commit ─► accepted
```

**It starts at `implement`, and nothing precedes it.** There is no oracle node
and no RED node, because neither has anything left to do: the oracle was
authored and executed in its own run and this graph reads the recorded verdict.
"No edge bypasses RED" is therefore a **readiness precondition** — `eligible`
on the scheduler, `oracleIsRed` on the projection — which mirrors the shipped
runner's own rule that with no recorded oracle the next step for a value is
`des oracle`, never `des craft`.

Two things the pipeline builds per step, and both are about ownership:

- **`protected: [the step's oracle file]`.** `_crafter_owns` as an executor
  rule: every path the task declares is the crafter's except the oracle. The
  supports are *not* walled — a support is the oracle's dependency rather than
  the thing that measures the value.
- **`knownRed`: every other undelivered value's oracle.** Every one of them is
  red by construction, so refusing this step's correct write for one of them
  would make a module with two undelivered values undeliverable. An *accepted*
  sibling's oracle is deliberately not in it: that one is green, and breaking
  it is a real regression the gate exists to catch.

What is a model call and what is not:

- **Model leaves:** `implement`, `select-tests`, `diagnose`,
  `fix-acceptance-test`, `refactor`, `fix-lint`, `surface-design-gap`,
  `commit`. In `smoke.ts` the three diagnosis-side leaves are Claude Code
  subagents through the `claudeCode` binding.
- **Steps, no model:** `run-tests` and `gates` each emit an effect and a pure
  branch routes its typed outcome.
- **The gate verdict is the declared lint command's exit status.** `gates` used
  to be a leaf classifying lint output into four words; it emits a
  `run-command` built from `commands.lint` over the files the step writes, and
  `clean | lint-failed | infra-failed` is a pure function of the result. The
  gate's own output becomes the evidence `fix-lint` reads, so the fixing leaf
  answers the linter's words rather than a paraphrase. Two verdicts went with
  the model: `out-of-scope-structural` had no producer left, and
  `mutation-below-gate` has none until a consumer declares a mutation command,
  so the `add-test` leaf it reached is deleted. With `add-test` gone nothing
  inside the cycle can invalidate a green verdict, so the cycle runs exactly
  once and `cycle-exhausted` is gone with it.
- **The test verdict is the effect's outcome.** `committed` is green.
  `rejected: tests` is `still-red` when every failing test is one of the step's
  own oracle's and `broke-other` otherwise. `rejected: contract` means the
  selection dropped below the impact floor and parks for a person.
  `infra-failed` is `harness-failed`.
- **The LLM may add tests, never subtract.** `select-tests` returns `extra` ids;
  the VCS runs the impact floor plus `extra` and refuses any selection that
  omits a floor test.

347 paths, about 1.8 s. `MAX_CYCLES` is 1 because the two-cycle walk measured
at over 7,000 paths and 544 s when the cycle could still iterate; it cannot
now, so the bound is inert until a mutation command is declared.

## `targets/todo/.des/` — the waves pointed at a real project

Files: `run-dir.ts` (the run directory, the design source and the suite
runner), `models.ts` (which binding runs which leaf), `registrations.ts` (the
request, the four graphs and the two pipelines, as the server holds them),
`main.ts` (the server), and `todo.test.ts`.

**Nothing in it exists for a test.** `todoRegistrations(dir, { models })` takes
one thing, and `models` is a `ModelBinding` per leaf ROLE — `decompose`,
`authorOracle`, `implement`, `other`, `validator`. Production passes
`todoModels()`; `todo.test.ts` and the browser fixture pass scripted ones. There
used to be a second option, an `evidence` override, and it existed so a test
could compute the journal key `runStep` would compute against runner output
that carries its own timings. That was the composition shaped by its tests; it
is gone, and what the suite actually printed is what every DELIVER run quotes.

### The target

[`targets/todo/`](../../targets/todo) is a tiny TypeScript project: a
`TodoStore` with `add`, `complete`, `remove` and `list`. `add` and `list` are
implemented; **`complete` and `remove` are stubs whose bodies throw**.
`design.md` is the authority for what it is: the public surface, the behaviour
of each method, the driving port, and the test path scope. `commands.ts` is the
authority for how it is checked: the four commands that typecheck, lint, test
and measure it, declared as this consumer's own source and read by the
framework. `biome.json` and a `@biomejs/biome` dev dependency are what make the
lint command real.

**There is no test file.** The oracle is authored into `test/` by the oracle
graph and measured red before one production byte is written. A pre-written
test would make RED a thing the repository asserted rather than a thing the
runner measured.

The walking-skeleton shape is the point for the production half: the stub
*symbols* exist with their declared signatures, so a `replace-symbol` effect has
a target and the gap is a missing body rather than a missing surface.
`write-file` is what creates the oracle; `replace-symbol` is what fills the
body.

**It is a template and is never mutated.** Every run copies it.

### The run directory

```
runs/<name>/
  todo/              the copied target, which the VCS writes into, and whose
                     commands.ts says how it is checked
  vcs.sqlite         symbol registry, lease table, event log
  artifacts.sqlite   roadmaps, roadmap_steps, oracle_runs, step_runs
  journal.sqlite     what each step decided, keyed by content
  mastra.sqlite      engine snapshots, so a parked run survives exit
  runs.sqlite        the runs, their events, and every leaf attempt with what
                     it cost
```

Five stores, all files rather than `:memory:`, so a server restarted against
the same run directory continues rather than beginning again: it shows every
prior run, keeps a delivered step delivered, and answers a suspension its
predecessor produced. `runs/` is gitignored. `test/` is tracked only once it
exists, because the oracle is what creates it.

Every command the framework runs against the copy comes from that copy's own
`commands.ts`, loaded by `loadCommands` and refused BY NAME when absent. The
import in it is type-only, so it is erased before the file is loaded and a copy
sitting under `runs/` resolves with no path back to this repository.

The **design source** every leaf reads is `design.md` plus the VCS symbol
inventory, and the addition is load-bearing: `predictedTouches` and
`implement`'s `symbolId` are opaque VCS ids assigned at track time, so a model
that has never seen the inventory names one that does not exist and every write
it proposes comes back `rejected: contract`.

### The server

```bash
bun run ui:build                      # once, so there is an app to mount
bun run todo [run-name]               # http://localhost:3000, run directory `first`
```

`main.ts` opens the run directory, builds the registrations, and serves them.
There is no command per wave any more: six of them were six processes over one
run directory, each holding nothing, because a suspension had to survive the
exit of the process that produced it. A server stays up, so a suspension is
answered where it is read — in the UI, from the closed enum the node declares.

**Four graphs**, each startable on its own and each drawn as its author wrote
it:

- **`roadmap`** runs the authoring workflow to the `human-review` suspension.
  Nothing is persisted until a person answers, because `persist` sits after the
  review. `decompose` is Opus; `validate-slices` and its validator are Haiku;
  `validate-shape` and `measure-disjointness` have no model in them at all.
- **`obligations`** runs DISTILL's first half once over the roadmap. The leaf is
  Haiku and `validate-manifest` is a total function.
- **`oracle`** writes one value's oracle and lets software measure it.
  `author-oracle` is Sonnet, for the same reason `implement` is.
- **`deliver`** runs the step cycle over one step. `implement` is Sonnet; every
  other leaf is Haiku. It refuses a step with no red oracle **by name**.

**Two pipelines**, which are those same registrations under the server's
scheduler: `oracles` (one per value, in dependency order) and `delivery` (the
step cycle, once per red-oracled step, with each step's own oracle protected and
every sibling's excused as known-red). A pipeline step is `{ id, dependencies,
workflowId, input }` and nothing else — it names one of the four graphs above
and the input one run of it takes.

So a graph and a pipeline are two front doors onto ONE registration rather
than onto one graph twice: same seed, same executor, same journal, and a step's
run is an ordinary run with an id, a trace, events and a dialog. Neither door
escapes what the other enforces — the readiness precondition is the pipeline's
`readiness` AND the standalone seed's refusal.

**It starts without a key.** Everything is readable; a leaf refuses by name on
the attempt, the message lands in the run's trail, and the server stays up. No
escalation is wired, deliberately: `escalateTo` is unset, so the count of
exhausted leaves is the number of decisions the *small* models could not get
past their own validators.

### What every leaf call cost

One `leaf_attempts` row per model-call pair, in `runs.sqlite` — run, step,
attempt, model, decision, whether it was accepted, the validator's verdict and
violations, the mechanical-check failures, and the worker and validator token
counts. A journal HIT writes nothing, because no model was called; that is what
makes a count of rows a count of INFERENCE.

The gap between the calls a leaf made and the decisions it produced is the
number worth reading: it is what the validator and the mechanical checks cost,
in inference, to keep the graph honest. The UI shows it per run, and
`exportRun(runId)` emits the same facts as JSON lines. The counts are exact
whatever the concurrency, because `runStep` attributes each call to the attempt
that made it rather than draining a queue in call order.

## Running things

```
bun test ./examples/nwave       # all four waves, no network, no key
bun run e2e                     # a browser over a seeded server: the graphs, a suspension, a pipeline
bun run smoke:oracle            # one oracle, authored by a real subagent in the PROPOSAL shape
bun run smoke:deliver           # DELIVER against Haiku plus three Claude Code subagents
bun run todo                    # the four waves, served, against a copy of the todo target
```

The smoke scripts refuse to run without `ANTHROPIC_API_KEY`. The server does
not: it starts, everything is readable, and the refusal is at the leaf.

Every leaf in `bun test` and `bun run e2e` is stubbed with `scriptedBinding`,
which answers the WORKER and lets the leaf's own output schema, mechanical
checks and validator run for real. Nothing seeds a journal.

**Nothing in this directory has been run against a real model.** The server
exists, a browser has driven it, and a leaf refuses without a key.
`todo.test.ts` drives all three waves against a real checkout — through the
server, as `startRun` and `runPipeline` — through the target's own declared
commands
— a real `write-file`, a real measurement, a real `bunx tsc --noEmit`, a real
`bunx biome check` and a real impact-scoped `bun test` at every write gate, and
a real `bunx biome check` at the quality gate — in about 3.6 s with zero model
calls. What is untested is the inference itself: whether a
real model, given these prompts and schemas, gives useful answers at an
acceptable rate. Expect the prompts in `steps.ts` to need a round of tuning the
first time real output comes back, and expect the `leaf_attempts` rows to be
how you find out.

## Not built on the consumer side

- A declared MUTATION command. `commands.ts` has four keys. The quality gate
  runs lint and nothing else, so `mutation-below-gate` has no producer and the
  `add-test` leaf that answered it is gone. Adding the key is additive: a fifth
  `CommandArgs` member, a second effect from `gates`, and a fourth gate
  verdict — and the outer cycle gets its second pass back with it.
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
