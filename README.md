# deterministic-workflows

## What it is

A TypeScript framework for building software out of many small language-model calls placed inside workflow graphs that own the control flow.

A graph is nodes and closed-enum edges. A model fills in values at the leaves and never picks a transition: a leaf returns one decision from a fixed set, and which edge that decision takes was written by the graph's author in advance. Every leaf's output is then checked against requirements — mechanically where the rule is a predicate, and by a second small model whose only job is to refute the first where it is not. Three properties follow. The whole path space of a graph is [enumerable before it runs](#four-constructors-over-six-node-types), because every repetition is a [`loop` node with a required bound](#loops-are-nodes-with-a-bound-not-back-edges) rather than a back edge. A run is [durable](#durable-snapshots) and [replayable](#two-journals). And where a run parks, it is [answerable by a person](#suspend-and-resume-needs-human-is-a-suspension-not-a-terminal) from the closed enum the parked node itself declares.

Three things ship beside the graph contract.

- **An [agent-native version control layer](#vcs-module).** A write takes a lease over the symbols and path scopes it touches, passes a verification gate that runs the consumer's own [declared](#declared-commands) typecheck, lint and tests before the bytes are kept — rolling the file back byte for byte if a stage refuses — and lands in an append-only event log under the task that caused it. Test selection is a [union](#the-run-tests-union): the VCS owns the impact floor, so a leaf may add a test and can never subtract one.
- **A [server and a UI](#the-server-and-the-ui).** One process registers every graph, [draws it](#the-drawing) under the ids its author wrote, shows where each run is and [what every leaf call decided and cost](#what-every-leaf-call-cost), and is the one place a person answers a suspension. [Runs, their events and every leaf attempt are persisted](#runs-survive-a-restart), so a restarted server shows what the last one did and can answer the suspension it left.
- **A [worked consumer](#the-four-worked-examples).** nWave's waves — ROADMAP, [DISTILL](#distill-is-two-graphs) and [DELIVER](#deliver-why-it-starts-at-implement-and-why-347) — as four graphs and two pipelines, pointed at [`targets/todo/`](#the-todo-target): a small TypeScript project with two stubbed methods and **no test file at all**.

## Why it exists

A frontier model handed a directory of prose rules re-reads them on every run. It decides which apply, branches invisibly, executes, and grades itself. Three things are wrong with that, and none is fixable by writing better prose: the decision space is closed while the model's output is open, the cross-cutting rule is applied by the same model that made the leaf decision it would have caught, and nobody can enumerate the paths the model might take. That is non-deterministic in shape, and untestable.

Invert it. Use a capable model **once**, per rule change, to author the workflow and the requirements it is checked against. From then on the graph owns control flow, small models own one decision each, and everything that can be decided mechanically is. **The model fills in values. It never picks a transition.** The argument in full is [`DETERMINISTIC-WORKFLOWS.md`](./DETERMINISTIC-WORKFLOWS.md); this repository is a prototype of it, and [a table](#map-to-the-design-document) maps each part back.

## What it can be used for

- **Authoring a roadmap from a request.** A person types what they want. [The roadmap graph](#roadmap-the-roadmap-is-data-and-this-is-the-graph-that-writes-it) decomposes it into ordered, production-drivable steps, checks their shape, measures the dependency edges the author missed from the symbols each step touches, parks for review, and persists the roadmap a person approves so it [outlives the process](#the-artifact-store).
- **Turning each roadmap step into acceptance obligations and an executable oracle that software measures red.** [DISTILL](#distill-is-two-graphs) states what each value must be observed to do, then [authors the test that observes it](#the-oracle-graph-the-model-decides-and-software-measures) through the real write path and has software run it. **The oracle is authored by one wave, executed by software, and walled off from the next wave.** RED is not a node a model can claim; it is a recorded verdict the next wave refuses to run without.
- **Running the delivery cycle per step, concurrently.** [The scheduler](#the-scheduler-and-the-pipeline) instantiates [one fixed graph](#deliver-why-it-starts-at-implement-and-why-347) per roadmap step and runs the whole ready set at once, refusing any step whose oracle has not been measured red. The model that implements is [walled off from the acceptance test](#the-crafter-is-walled-off-from-the-oracle) that judges it — the oracle's path is refused before a lease is even asked for — so a green suite means the code satisfied the test rather than that the test was edited.
- **Classifying anything into a closed set, with a validator behind it.** The smallest unit here is one step: a closed output enum, requirements quoting the rule verbatim, a mechanical check where the rule is a predicate, and a second model refuting the first where it is not. [The obligations graph](#the-obligations-graph-one-leaf-in-front-of-a-total-function) is that shape at its thinnest — one leaf in front of a total function — and it is the shape any rules-driven triage takes.
- **Any multi-step agent process where the path space must be finite and the writes must be gated.** The graph contract, the [VCS module](#vcs-module), the [declared commands](#declared-commands) and the [server](#the-server-and-the-ui) know nothing about nWave. A consumer supplies its own graphs, its own requirements, its own four commands and its own [model bindings](#bindings); an agent that edits a checkout plugs into the same leaf slot as a single model call.

## What it is not yet

**No real-model run has been performed.** What the test suite supports is that every graph is correct for every answer a model could give: **176 paths through the roadmap workflow, 28 through DISTILL's obligations graph, 421 through its oracle graph, and 347 through the DELIVER step cycle**, each walked through the real Mastra engine with every leaf stubbed at its binding — so the output schema, the mechanical checks and the validator all run, and the answers are enumerated rather than sampled. The whole suite is 541 tests in **about 14.5 s**, with no key and no model; six Playwright tests drive a real server in a real browser in **about 5.5 s**, also with no model. What the suite does **not** support is the claim the design most needs: that real models, at these sizes, give useful answers at an acceptable rate and cost. Being right about every answer says nothing about whether the answers would be good. See [The real run](#the-real-run) for what a run with a key would settle, and [Not built yet](#not-built-yet) for what is missing.

## Start here

- [`DETERMINISTIC-WORKFLOWS.md`](./DETERMINISTIC-WORKFLOWS.md) — the design this implements, and [the map](#map-to-the-design-document) from it to the source.
- [Terms](#terms) — two things here are called a step, and they are not the same thing. Read this before anything else.
- [Install, test, run](#install-test-run), then `bun run todo` — [the todo target](#the-todo-target) served on `http://localhost:3000`, where every graph is drawn and a suspension is answered. It starts without a key.
- [A browser has rendered it](#a-browser-has-rendered-it) — the screenshots are in the repository.

## Terms

Two things here are called a step, and they are not the same thing.

- **A step of the roadmap** is one unit of work a request decomposes into: `{ id, dependencies }` plus the obligations and the oracle DISTILL attaches to it. A pipeline is a set of them with dependencies, and DELIVER runs its cycle once per step.
- **A step node of a graph** is a `type: "step"` node inside a `Workflow<S>` — the thing `runStep` runs and a `StepResult` comes back from. The DELIVER step cycle is one fixed graph of those nodes, instantiated once per roadmap step.
- **A row is a database row**, and nothing else: an artifact row, or a `runs` / `run_events` / `leaf_attempts` row. Nothing a person authors or approves is called one.

## Install, test, run

```bash
bun install
bunx playwright install chromium   # once, for the browser tests

bun run test      # 541 tests, no key, no model, no network beyond loopback, ~14.5 s
bun run typecheck # tsc --noEmit, over every package at once
bun run check     # both
bun run ui:build  # the application the server mounts
bun run e2e       # six Playwright tests against a real seeded server, ~5.5 s
bun run todo      # the todo target, served: http://localhost:3000
```

Three packages in one bun workspace, and a consumer's own directories beside them:

```
packages/core/     @des/core    the framework: the contract, the compiler, the VCS, the harness
packages/server/   @des/server  the registrations, the registry, the runner, the scheduler, `serve`
packages/ui/       @des/ui      the application: server functions, the drawing, the place to answer
examples/nwave/    one consumer's four waves
targets/todo/      one project to deliver to, plus the composition under `.des/`
```

`targets/todo` is deliberately NOT a workspace member: it is a template a run COPIES, and a workspace member is a thing bun links. Its `.des/` composition resolves `@des/*` by walking up to the root `node_modules`, which is also what a copy under `runs/` does.

The test script names its roots — `packages`, `examples`, `targets/todo/.des` — rather than scanning the tree: a target's own project files and the run copies under `runs/` are not this repository's suite. The browser tests are `*.e2e.ts` and belong to the other runner; `bun test` claims `*.spec.*`, so one suffix keeps them apart.

Nothing in the test suite talks to a model. One file opens a socket — [`mastra.endpoint.test.ts`](./packages/core/src/bindings/mastra.endpoint.test.ts) serves an OpenAI-compatible endpoint on a loopback port and counts every `fetch`, so a call to anywhere else fails the test rather than passing quietly. The two smoke scripts do talk to a model, and the todo server refuses at the leaf rather than at the door:

```bash
# One oracle, authored by a real Claude Code subagent in the PROPOSAL shape,
# written through the real VCS, and measured by a real `bun test`.
ANTHROPIC_API_KEY=... bun run smoke:oracle

# DELIVER, where three leaves are Claude Code subagents rather than one model
# call each. They run against DW_WORKSPACE, defaulting to the cwd.
ANTHROPIC_API_KEY=... DW_WORKSPACE=/path/to/repo bun run smoke:deliver
```

`smoke:oracle` is the one to read first: it builds a temp project with a stubbed method, dispatches the acceptance designer in a scratch copy, turns what it changed into `write-file` effects, commits them through the write path, and prints the verdict software read off the result. `smoke:deliver` pushes one roadmap step through the step cycle — see [Bindings](#bindings).

The todo target is the end-to-end path, against a real project rather than a literal, and it is one process:

```bash
bun run ui:build                                   # once, so there is an app to mount
ANTHROPIC_API_KEY=... bun run todo                 # http://localhost:3000, run directory `first`
```

It starts **without a key**: the graphs, the projections, the artifact store and the event stream are all readable, and what needs a key is a leaf — which refuses there, by name, on the attempt, with the server still up. See [The todo target](#the-todo-target) and [The server and the UI](#the-server-and-the-ui).

## Map to the design document

| Path | Implements |
|---|---|
| `packages/core/src/core/requirement.ts` | § Primitives → Requirement. The rule itself: verbatim text, FK to its source, closed decision space, optional mechanical check. |
| `packages/core/src/core/step.ts` | § Step: a worker paired with a validator, always. `stepOutput`, `StepDef`, `Attempt`, `StepResult`, `journalKey`, `runStep` and its six guardrails. |
| `packages/core/src/core/workflow.ts` | § Workflow graph and runner. The contract: `NodeId`, `Terminal`, `Node`, `Workflow`, `branch`, `suspend`, `run`, `resume`. |
| `packages/core/src/core/compile.ts` | § Workflow graph and runner. The compiler from the node map to a Mastra workflow. |
| `packages/core/src/core/effects.ts` | § Effects with typed results. The `Effect` / `EffectResult` unions plus an in-memory executor with optimistic concurrency. |
| `packages/core/src/core/commands.ts` | § Effects with typed results → `run-command`. The consumer's `Commands` contract, and the one process runner behind every command the framework runs. |
| `packages/core/src/core/journal.ts` | § Journal. The interface, an in-memory implementation, and a persistent one on `bun:sqlite`. |
| `packages/core/src/core/scheduler.ts` | § DELIVER runs in parallel. The frontier, the concurrency limit, resource leases, and termination. Generic in steps; the composition is the consumer's. |
| `packages/core/src/artifacts/` | § Artifacts are typed rows, not documents. The store: one version column, one append-only event log, one time-travel read. |
| `packages/core/src/bindings/` | § Framework versus consumer → "model bindings: which small models, which validator family". `mastra.ts` is one model call; `claude-code.ts` is a Claude Code subagent. |
| `packages/core/src/checks/` | § Framework versus consumer → "a library of mechanical checks": `verbatim.ts`, `enum-member.ts`, `id-in-set.ts`. |
| `packages/core/src/harness/` | § Framework versus consumer → "test harness": `scripted-binding.ts` (the one way a test stubs a leaf), `no-replay.ts`, `enumerate-paths.ts` (the graph inspector, the reachable-path walker, and the effect-outcome axis), `matchers.ts`. |
| `examples/nwave/distill/` | § DISTILL is two graphs. `manifest.ts` is `des distill`'s closed rule set as a pure function; `obligations/` is the graph around it; `oracle/` mirrors `des oracle --value N`, and is where the acceptance designer authors and software measures. Bootstrap steps 2 and 3. |
| `examples/nwave/deliver/` | § DELIVER is two graphs → The step cycle as a graph. Bootstrap step 6 — the fixed step cycle, as three nested bounded loops, starting at `implement` because RED is an `oracle_runs` row it reads. `pipeline.ts` is bootstrap step 7's second half: one roadmap step as one run's seed, and what a finished run is persisted as. The scheduling is the server's. |
| `examples/nwave/roadmap/` | § DELIVER is two graphs → the roadmap half, and § Framework versus consumer → the authoring workflow. Bootstrap step 7's first half — the roadmap as steps, with two pure decision functions and no generator. |
| `targets/todo/.des/` | The composition that points all four graphs and the two pipelines at a real project: `registrations.ts` declares them and `main.ts` serves them. Its one injection point is `models`. Not a wave: the consumer's own composition. |
| `targets/todo/` | The delivery target. A template project with two stubbed methods and no test file, copied into a run directory and never mutated in place. The oracle is authored into it, not shipped with it. |
| `packages/core/src/vcs/` | § The agent-native VCS is the effect executor and mechanical verifier, and the whole of [`ai-vcs.md`](./ai-vcs.md) phases 2 to 4. See [`packages/core/src/vcs/README.md`](./packages/core/src/vcs/README.md). |
| `packages/server/` | § The server and the UI are the entrypoint. `registration.ts` is what a target declares; `projection.ts` reads the AUTHORED graph off the node map; `runner.ts` drives one and watches it; `pipelines.ts` schedules the steps a pipeline declares; `store.ts` is the three tables runs, events and attempts are rows in; `api.ts` is the surface, and `registry.ts` is where a request handler finds it. |
| `packages/ui/` | § The server and the UI are the entrypoint → the application. `server/functions.ts` wraps every call as a server function; `routes/` are the pages and the one event route; `layout.ts` is dagre — including where every edge label goes — `graph.tsx` is JointJS, `suspension.tsx` is the dialog whose buttons are a node's closed enum; `e2e/` is a browser driving all of it. |

The model bindings live under `packages/core/src/bindings/` and nothing in `core/` imports them: the design's framework/consumer table puts "which small models, which validator family" on the consumer side, and the smoke scripts are where a consumer picks.

## Substrate: Mastra Workflows, all the way down

**Decision: the graph runner is Mastra. `run` compiles the node map to a Mastra workflow and drives it through `createRun()`.**

Four properties of Mastra's builder are what make a node map compilable onto it, and each answers an objection the shape invites.

1. **`.branch()` is a predicate list, and an edge table compiles to one.** `branch<S, D>(on, edges: Record<D, NodeId>)` emits one `[state => on(state) === k, target]` entry per key of the edge table. Exhaustiveness stays in the wrapper's type, and by construction exactly one predicate is true: the compiler emits the predicate list from a table it has already proved total.
2. **The graph is not a chain, and does not have to be.** Mastra's builder is a chain, but `Workflow` implements `Step`, so a branch target can be a nested workflow. The compiler exploits that: a chain runs until it reaches a branch, and each edge compiles to a nested workflow carrying the rest of that path. Arbitrary re-convergence works — a node reachable from two edges is compiled once per path. Repetition works too, through `.dountil()` over the same nested-workflow trick: a `loop` node compiles to a nested workflow for its body and a condition carrying the bound. Arbitrary back edges are refused, by `graphDefects`, by name.
3. **The trace is not lossy.** It would be if the trace were Mastra's `steps` record. It is not: the compiler accumulates `NodeId[]` in Mastra's *workflow state*, which is exactly the right lifetime, because state survives suspend/resume. The trace of a run that parked for a person and was answered three days later spans both halves.
4. **Terminals are one schema, not three differently-shaped variants.** They are a discriminated union over `kind`, which one schema holds. Mastra's requirement that branch targets share a schema is satisfied by a permissive schema plus the union's own tag.

And Mastra buys three things a hand-written runner cannot, without writing a durable-execution engine:

- **Crash-resume from snapshots.** A suspended run is persisted and reattachable by `runId`, from a freshly compiled workflow, in a different process.
- **Suspend and resume.** Which is what makes `needs-human` a live node rather than a dead end — see below.
- **Serializable graph definitions.** Mastra's dynamic workflows are JSON definitions over registered agents, tools, and nested workflows. That is the design's "graph topology as data" fork, already built. Emitting one from a `Workflow<S>` is the authoring workflow's natural output format.

### The compile mapping

Every node type maps to one Mastra construct. The compiled workflow's *input and output* is the caller's state `S`; the compiled workflow's *state* is the trace and nothing else.

| Node | Compiles to | Notes |
|---|---|---|
| `step` | `createStep` | `execute` runs the node, hands its `Effect[]` to the injected executor, applies `absorb`, returns the new state. |
| `fanout` | a nested workflow: `.parallel(sub-steps)` then `.map(merge)` | Each sub-step returns **only the keys it changed**; the merge re-applies those slices onto `getInitData()` — the pre-fanout state — in declaration order. |
| `branch` | an entry step, then `.branch([[pred_k, tail_k], …])`, then `.map(unwrap)` | One predicate per edge key: `state => on(state) === k`. Each tail is a nested workflow compiled from that edge's target. The entry step records the visit and throws if `on` returns a key with no edge. The unwrap takes the single executed target's output. |
| `loop` | `.dountil(body, cond)`, then an exit step | `body` is a nested workflow: a counter step, then the body sub-graph compiled with the loop's own id as its stop edge. `cond` is `async ({ inputData, iterationCount }) => until(inputData) \|\| iterationCount >= max`. The exit step reads the count, resets it, and hands `absorb` a `{ iterations, exhausted }`. |
| `suspend` | `createStep` with `suspendSchema` + `resumeSchema` | First pass calls `suspend({ reason, trail })`. On resume, the answer is parsed and folded into state by `absorb`, and the graph branches on it at `next`. |
| `terminal` | `createStep` returning the `Terminal<S>` | `accepted` completes normally; `rejected` goes through `bail()`, so nothing after it in its own chain can run. |

Three consequences worth stating out loud.

- **The fanout-merge defect is structurally impossible.** A whole-state merge — `outs.reduce((acc, s) => ({ ...acc, ...s }), state)` — lets the last sub-step's unchanged copies overwrite every earlier one's work, because each computed a whole state from the same ancestor. Under `.parallel()`, Mastra keys each sub-step's output by its own step id and the merge re-applies slices onto a base nobody else wrote. There is no ordering in which a sub-step's own write can be lost.
- **Fanout sub-steps do not write the trace.** Mastra's `setState` is last-writer-wins, and four concurrent sub-steps each appending to the trace lose three of four appends. (Measured, not assumed.) The fanout merge appends every sub-step id at once, after they have all completed, in declaration order.
- **Schemas are permissive by construction.** `S` is caller-defined, so every schema the compiler hands Mastra is `z.custom<S>(() => true)`. The framework's real output guardrail is the step output schema inside `runStep`, which is unaffected. Mastra's builder generics have nothing to infer from, so the builder chain is typed structurally inside the compiler; graph well-formedness is proved by the node map's own types and by `graphDefects`, not by the builder.

### Four constructors over six node types

A node type is what the compiler switches on. A constructor is what a graph author writes, and there are four, each one tying together two things that must not drift apart.

| Constructor | Node it builds | What it ties together |
|---|---|---|
| `branch<S, D>(on, edges)` | `branch` | a decision union and its edge table: dropping a member of `D` is a compile error |
| `suspend<S, R>(spec)` | `suspend` | a `resumeSchema` and the `absorb` that consumes it, so a node cannot parse an answer its `absorb` will not accept |
| `loop<S>(spec)` | `loop` | a body and the bound that ends it: `max` is a required field at every call site |
| `leaf<S, I, O>(spec)` | `step` | a `StepDef` and the state it reads and writes — and the exhaustion trail, which it emits whether the author asked for it or not |

`leaf` is the one that is not about types. Every graph that calls a model does the same four things around `runStep`: project the step's input out of state, run it, fold the decision or the exhaustion back in, and record the trail when the validator was never satisfied. The fourth one is the one that gets forgotten, so the constructor owns it: a `validator-exhausted` result always emits `{ type: "append-trail", line: JSON.stringify({ leaf, trail }) }`, in addition to whatever the author's own `effects` hook returned.

```ts
leaf<State, Scenario, Classification>({
  id: kind,                  // names the leaf in the trail; defaults to def.id
  def,                       // the StepDef
  journal,                   // a field, not a closure variable: see below
  input: (s) => s.scenario,
  absorb: (s, r) => …,       // the StepResult
  effects: (s, r) => […],    // optional
  absorbEffects: (s, rs) => …, // optional; the EffectResult[], which arrive later
  next: "merge",
});
```

The journal is a spec field rather than something the constructor closes over, because the other three dependencies are already fields and a leaf reading module-level state would let two graphs in one process disagree about which journal they meant. `leaf` builds a `step` node: the compiler has no reason to tell a leaf from any other step — it runs, it asks for effects, it absorbs their results — so a sixth node type would buy nothing and cost an arm in every switch.

### Loops are nodes with a bound, not back edges

A back edge in the node map is still refused. Not because Mastra cannot do it, but because an unbounded cycle makes the path space infinite and the enumeration test is the whole point. Repetition is a sixth node type instead:

```ts
| { type: "loop"; body: NodeId; until: (s: S) => boolean; max: number;
    absorb: (s: S, exit: LoopExit) => S; next: NodeId }

export type LoopExit = { iterations: number; exhausted: boolean };

export const loop = <S>(spec: { body; until; max; absorb; next }): Node<S> => …;
```

Run the sub-graph at `body`, then evaluate `until`. True: leave for `next`. False below `max`: run the body again. False at `max`: leave for `next` anyway. `until` is a decision function, pure and covered by the no-nondeterminism scanner exactly like a `branch`'s `on`.

**How "max reached" reaches the graph.** Through `absorb`, and only through it. The loop hands it a `LoopExit` on the way out, the graph folds those two facts wherever it wants them in `S`, and a branch on `next` routes them. Nothing else about the loop is observable to the graph. In the DELIVER example that is one line:

```ts
const absorbLoop = (id: LoopId) => (s: State, exit: LoopExit): State => ({
  ...s,
  iterations: { ...s.iterations, [id]: exit.iterations },
  loopExhausted: exit.exhausted ? (s.loopExhausted ?? id) : s.loopExhausted,
});
```

`exhausted` needs no counter to compute: a loop leaves for exactly two reasons, so it is `!until(final)`, exactly. `iterations` does need one, and it lives in the engine's own state beside the trace, which is the right lifetime: a run can park inside a loop body and be answered three days later, into the same iteration, with the same count. The loop's exit step resets its own counter, so a loop nested inside another counts from zero on each re-entry rather than accumulating.

**Where a body ends.** By convention, declared rather than inferred: **a body node whose edge names the loop's own id is the iteration boundary, and that is the only edge allowed out of the body.** The alternative was a reserved `NodeId` like `"$loop-end"`, which is ambiguous the moment loops nest. Naming the loop is not.

`graphDefects` verifies five things about every loop, and `compileWorkflow` refuses to build past any of them:

| Defect | Message |
|---|---|
| `max` is not a positive integer | `loop bound must be a positive integer: spin has max 0 — an unbounded loop has an infinite path space and cannot be enumerated` |
| no path from the body back to the loop | `loop body never returns to the loop: spin -> body has no path back to spin` |
| a body node points at something that cannot come back | `loop body escapes: gate.verdict -> human leaves the body of cycle — the only edge out of a loop body is cycle itself` |
| something outside points into the body | `loop body entered from outside: gate -> body is inside the body of spin` |
| the loop's `next` is inside its own body | `loop exit re-enters its own body: spin -> body` |

"The body" is computed structurally: the nodes reachable from `body` that can reach the loop again. That definition is what makes the escape check mean something, and it makes a terminal inside a loop body fall out as an escape rather than needing its own rule. Nested loops are just body nodes of the enclosing one, and a `suspend` inside a body is a body node too.

### Suspend and resume: `needs-human` is a suspension, not a terminal

`Terminal<S>` is `accepted | rejected`. Parking for a person is a *suspension*: the run stops with a typed payload, and the same run continues when a person answers.

```ts
const outcome = await run(wf, state, execute);
// { kind: "suspended", reason, trail, trace, runId }
//   | { kind: "terminal", terminal: Terminal<S>, trace, runId }

if (outcome.kind === "suspended") {
  const resumed = await resume(wf, outcome.runId, { decision: "override", override: { kind: "e2e", lane: "needed" } }, execute);
  // { kind: "terminal", terminal: { kind: "accepted", state }, trace, runId }
}
```

- `reason` is a closed enum per workflow; `trail` is the evidence behind it. Together they are the `suspendSchema` payload Mastra persists.
- The answer is validated by the node's `resumeSchema` before `absorb` sees it, and the graph branches on it like any other decision. A model still never picks a transition — and neither does a free-text human reply.
- `resume` recompiles the graph. The compilation is a pure function of the graph, so the step ids match the persisted snapshot and the run reattaches by `runId`. That is the same path a different process would take — and with a durable runtime it literally is one: `run(wf, state, execute, runtime?)` and `resume(wf, runId, answer, execute, runtime?)` take the runtime whose snapshots they use, so a run parked by one command is answered by another. See [Durable snapshots](#durable-snapshots).

In the ROADMAP example the person answers `approve | revise | abandon` at a review that sits INSIDE the author loop, so `revise` re-drives the decomposition with their notes. Everywhere else — the block node in ROADMAP, both of DISTILL's, and DELIVER's — the answer set is smaller, and in three of them it is one word. That is a position rather than an omission: a block reaching those nodes needs work outside a closed enum, and offering a second answer would mean inventing a route the design does not have.

### Two journals

Mastra has a journal and so do we. They are complements, not duplicates, and neither can do the other's job.

| | Our `Journal` | Mastra's snapshot |
|---|---|---|
| Key | `step id @ version : sha256(input)` | `runId` |
| Scope | every run, forever | one run |
| Answers | "what did this step decide, for this input, under this prompt version?" | "where was this run when it stopped?" |
| Enables | replay with zero inference | crash-resume, suspend/resume, `restart()` |
| Consulted | first thing inside `runStep` | by the engine, on `resume` / `restart` |
| Survives a prompt change? | no — `version` is in the key, so the step re-infers | yes — it is about position, not content |

Re-running a workflow against a warm journal is byte-identical and spends nothing. Resuming a *parked* run continues where it stopped without re-running the steps before it. A run that is both replayed and resumed uses both.

### Dependencies

`@mastra/core`, `zod`, and `@anthropic-ai/claude-agent-sdk`.

- **`zod`** is Mastra's only peer dependency and the schema language for step outputs, requirement decision spaces, and resume payloads.
- **`@anthropic-ai/claude-agent-sdk`** is what `packages/core/src/bindings/claude-code.ts` dispatches a subagent through. It is a runtime dependency because the binding ships in `@des/core`, but it is imported lazily — `bun test` never loads it, and nothing outside that one file references it.
- **`tree-sitter`** and **`tree-sitter-typescript`** are the structural layer of the VCS module. The native Node bindings, not `web-tree-sitter` plus wasm grammars, which do not load under bun; see [`packages/core/src/vcs/README.md`](./packages/core/src/vcs/README.md#the-parser-native-tree-sitter-not-wasm). Prebuilt binaries ship for every supported platform, so nothing compiles at install time, and the whole surface sits behind a three-method `Parser` interface.
- **`@mastra/core`** supplies the workflow engine, the `Agent` the smoke scripts and the todo target's leaves run on, and `InMemoryStore` from `@mastra/core/storage`, which is where a snapshot goes by default.
- **`@mastra/libsql`** is where a snapshot goes when a run directory is given. See [Durable snapshots](#durable-snapshots) for the measurement behind using two adapters rather than one.

Mastra's model router takes a `provider/model` string (`anthropic/claude-haiku-4-5`), resolves `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment itself, and needs no provider package — so `ai`, `@ai-sdk/anthropic`, and `@ai-sdk/openai` are not here. The `@ai-sdk/provider*` packages still under `node_modules` are Mastra's own transitive dependencies, not ours.

## Bindings

`StepDef.worker.model`, `validator.model` and `escalateTo` are all `ModelBinding` — `{ id, generate({ system, prompt, schema }) }`. One method. That seam is the whole provider story, and it is also where an *agent* plugs in: from the step's side there is no difference between a single model call and a subagent that spent forty turns reading a checkout, as long as what comes back satisfies the schema.

| Binding | Behind it | `id` |
|---|---|---|
| `mastraAgent({ model, id?, agent? })` | a Mastra Agent, structured output, temperature 0. `model` is a router id or an OpenAI-compatible endpoint | the router id, e.g. `anthropic/claude-haiku-4-5`, or `providerId/modelId` |
| `claudeCode({ agent, cwd, model?, maxTurns?, … })` | a Claude Code subagent, through the Claude Agent SDK's `query()` | `claude-code:<agent>`, so `Attempt.model` in a trail names the agent |
| `scriptedBinding(script)` | a script keyed by step id, per attempt. The ONE way a test stubs a leaf | `scripted` |

A call carries `step` — the step id, its version, which half of the pair, and
the attempt — because a binding shared across steps could not otherwise say
which one it was answering for, and because what a call cost has to land on the
step that spent it. It also carries an `onUsage` sink supplied by `runStep`,
closed over the attempt being made, which is what makes token attribution exact
rather than order-based.

### An OpenAI-compatible endpoint

`mastraAgent`'s `model` is `string | OpenAICompatibleConfig` — Mastra's own type, imported rather than restated, and one of the shapes its `MastraModelConfig` already admits. A **string** is the model-router id, `provider/model`, and the router resolves that provider's key from the environment itself. An **object** — `{ providerId, modelId, url?, apiKey?, headers? }`, or `{ id, url?, … }` — is an endpoint the caller names: a gateway, a proxy, or a model served on their own machine. It reaches `Agent` unchanged, so a field the binding does not know about survives it. The binding's `id`, which is what `Attempt.model` and `leaf_attempts.model_id` carry, is the string, or `providerId/modelId`, or the config's own `id`; `options.id` still overrides it. `targets/todo` exposes the whole thing as four environment variables — see [The todo target](#the-todo-target).

**The credential is refused at the leaf, and what a call needs is read off the config.** An endpoint carrying its own `apiKey`, or naming its own `url`, needs nothing from the environment and is never refused; a bare router string needs the variables Mastra's own provider registry declares for that provider — which is why the refusal names `ANTHROPIC_API_KEY` rather than a `<PROVIDER>_API_KEY` this repository guessed at. A provider the registry does not know is not refused either, because there is no variable to name and the router is the honest place for "no such provider" to be said.

**A provider Mastra has never heard of is fine.** The router resolves a gateway for every id, and `models.dev` is the unconditional last resort, so `providerId: "acme-local"` parses as a provider rather than raising `MODEL_ROUTER_NO_GATEWAY_FOUND`. A config carrying a `url` then short-circuits that gateway twice: auth is the config's own `apiKey` rather than an environment variable, and the model is `createOpenAICompatible({ name: providerId, baseURL: url, headers })` rather than anything the gateway builds. So the endpoint is reached as named, with no gateway consulted, no provider package installed, and nothing in the binding to make it happen.

**What your endpoint has to accept**, observed rather than inferred — [`mastra.endpoint.test.ts`](./packages/core/src/bindings/mastra.endpoint.test.ts) drives a real `Agent` against a real HTTP server on a loopback port and asserts each of these:

| On the wire | What arrives |
|---|---|
| request | `POST <url>/chat/completions` — the path is appended to the `url` as given |
| auth | `Authorization: Bearer <apiKey>`, and no such header at all when no key is given |
| headers | the config's own `headers`, merged in |
| `model` | the `modelId`, not `providerId/modelId` — the provider was the routing decision |
| `temperature` | `0`, from the binding |
| `messages` | the step's `system` as the system turn, its `prompt` as the user turn |
| `response_format` | `{ type: "json_schema", json_schema: { name: "response", strict: true, schema } }`, where `schema` is the step's zod schema as draft-07 JSON Schema |

**Structured output is that `response_format` field**, not a tool call and not a prompt-engineered instruction — so an endpoint that ignores `response_format` will answer with something the step's schema rejects. Two caveats follow, and both are the reason a local model is worth trying rather than a reason not to. **Structured output depends on the endpoint honouring the schema.** Every leaf asks for one object against a zod schema and the step re-parses the answer with that schema, so an endpoint that returns prose, or an object of a different shape, fails the parse — and that failure is visible: `runStep` records it in the trail and the leaf exhausts, so the run parks as `validator-exhausted` with the parse error in it rather than proceeding on a wrong answer. **Token usage may be absent**, because not every OpenAI-compatible server reports it; the attempt then records no counts at all rather than zeros, since "nobody said" and "it cost nothing" are different claims.

### Opaque and proposal

Two shapes, and the binding's `proposal` option selects between them.

**Opaque.** The agent edits the workspace itself, through its own tools, and the binding returns only what the schema asks for. The writes have already happened by the time `generate` resolves; the framework never sees them, so it cannot lease them, verify them, or roll them back. `claudeCode` without a `proposal` option is this shape. The consequence is not stylistic: under it a `conflict` is *unrepresentable*, because the write never crossed the effect boundary where a version check could have happened.

**Proposal.** The agent still edits, because a tool set is what makes it an agent rather than a chat — but it edits a **scratch copy** of the source tree, and afterwards the copy is diffed. Every changed file under the allowed paths becomes a `write-file` effect, or a `replace-symbol` when the caller supplies a `symbolFor` port that can name the symbol it belongs to; a symbol id is the VCS's to assign, and this binding must not import the VCS to guess one. The runner commits them through the agent-native VCS, under a lease, with the gate at the write boundary and the task id recorded as the intent.

Three properties of the proposal shape are worth stating, because each is a decision rather than a mechanism:

- **A byte outside the allowed paths refuses the WHOLE turn**, before any effect is emitted. Not "most of what it did": a turn that wrote where it may not proposes nothing, and the refusal is what the next attempt is told.
- **A deletion is refused rather than dropped.** `Effect` has no way to remove a file, so a turn that deleted one proposed something the framework cannot commit, and saying so beats committing the rest.
- **The effects land on `payload.proposal`.** `stepOutput` fixes the output shape at `{ decision, payload }`, which makes that the one unambiguous place for them; the agent never produces the field and the binding always overwrites it. A step that wants a proposal declares it optional, which is also what keeps the JSON Schema handed to the SDK satisfiable.

`bun run smoke:oracle` runs it against a real acceptance designer.

### Executors

A `ModelBinding` is where a model plugs in. An `EffectExecutor` is where the *world* plugs in: `(effects) => Promise<EffectResult[]>`, injected into `run` and `resume`.

| Executor | Behind it | `replace-symbol` / `run-tests` | `upsert-artifact` |
|---|---|---|---|
| `memoryEffects({ store? })` | an [artifact store](#the-artifact-store), and an array for the trail | `infra-failed`, because there is nothing behind it and that is the honest answer | the store |
| `vcsExecutor({ vcs, session, intent, artifacts?, protected?, knownRed? })` | the [VCS module](#vcs-module): one lease per batch, the verification gate, the event log | executed for real, and the outcome is what the branch routes. `run-tests` runs the union and enforces the floor — see [The `run-tests` union](#the-run-tests-union). `write-file` creates. `measure-oracle` executes one test and reads a verdict | the store, or `infra-failed` without one |

`vcsExecutor` takes ONE write lease covering every `replace-symbol` target AND every `write-file` path in the batch, applies the writes, releases, and maps each outcome onto an `EffectResult`. The session and the task intent are fixed per executor instance, so the `EffectExecutor` signature does not change: one executor per task is the answer, rather than threading provenance through the runner.

Two options are about ownership rather than plumbing. **`protected`** refuses any write landing under a declared scope before a lease is asked for, which is how the crafter is walled off from the oracle. **`knownRed`** names tests the caller knows were already failing for a reason this task did not cause, which the gate excludes — without it a module with two undelivered values is undeliverable, because every undelivered value has a live red oracle in it.

### What `claudeCode` does with the SDK

- **Structured output is native.** `options.outputFormat = { type: "json_schema", schema }` makes the SDK validate the agent's final answer and re-prompt on mismatch; the validated object arrives on the result message as `structured_output`. No prompt-engineered JSON extraction was needed.
- **The zod schema is still the guarantee.** `z.toJSONSchema(schema, { target: "draft-07" })` is a projection, not a translation: a refinement zod can express and draft-07 cannot is widened rather than carried across. So the SDK's validation is necessary and not sufficient, and the binding re-parses the returned object with the step's own zod schema. That re-parse is what the binding's small retry bound (default 2) exists for, alongside the two failures the SDK documents: `error_max_structured_output_retries`, and a `success` result carrying no `structured_output` at all. After the bound it throws, and `runStep` turns the throw into a trail entry — the path that is asserted end-to-end in `packages/core/src/bindings/claude-code.test.ts`.
- **The subagent is selected by name.** `options.agent` names the agent for the main thread, and the agent must exist in the settings the run loads, which is what `settingSources` controls — `"project"` loads `.claude/agents` from `cwd`. The default is `["user", "project"]`.
- **The step's `system` leads the turn.** The subagent's own prompt *is* its system prompt, so passing `systemPrompt` would replace it. The step's `system` is prepended to the user turn instead, and a retry appends what the previous attempt got wrong, which is the same feedback shape `runStep` uses one level up.

### The injected `query`

`claudeCode` takes the SDK's `query` as an option, defaulting to the real one. The default is a lazy `await import`, so the SDK's 1.5 MB module is not loaded unless a call is actually made — and `bun test` never makes one: every test in `claude-code.test.ts` supplies a fake that yields scripted messages. A binding that could only be tested by spawning an agent would not be a seam.

## VCS module

[`packages/core/src/vcs/`](./packages/core/src/vcs/README.md) implements [`ai-vcs.md`](./ai-vcs.md) as a library on `bun:sqlite`: a tree-sitter symbol inventory, an identity registry with opaque ids that survive declared renames, an append-only event log, a lease manager with atomic multi-acquire over **symbols and path scopes**, a verification pipeline that runs inside the write path and rolls the file back byte for byte when a stage refuses, and an oracle measurement that is not a gate at all — it executes one test and reads `green | red | broken | indeterminate` off it, because the two roles that hold an oracle cannot run it.

**The four stages are structural, typecheck, lint and tests**, and every one after the first is a [declared command](#declared-commands) composed into a `run-command` effect and handed to an injected executor. Nothing under `packages/core/src/vcs/` spawns anything, and the tests stage and the measurement read their verdict off a [JUnit report](#the-junit-rule) rather than off a runner's stdout.

**The dependency runs one way.** `core` imports nothing from `vcs`. What `vcs` imports back is the `Effect` / `EffectResult` types and `packages/core/src/core/commands.ts`, and nothing else from the framework. The framework is the control plane; the VCS is the data plane for code.

The design document's own test for whether the seam works is one path: "the runner executes an `Effect[]` through the VCS with lease, verify, and log, and gets back a typed result a branch can route on." That path is `packages/core/src/vcs/executor.test.ts`, driven through the real Mastra runner on a temp TypeScript project: a `leaf` emits a `replace-symbol`, the branch after it routes `committed`, and a second run with a stale `expectedVersion` routes `conflict` to a rebase node instead.

**174 tests, 2.3 s.** Full detail, the storage schema, the write path step by step, the deviations and what is still missing: [`packages/core/src/vcs/README.md`](./packages/core/src/vcs/README.md).

## The artifact store

[`packages/core/src/artifacts/`](./packages/core/src/artifacts/store.ts) is the other half of the design's state layer: `bun:sqlite`, a version column on every row, an append-only `artifact_events` log of every accepted upsert, and `at(table, id, version)` reading history back out of that log. Both executors route `upsert-artifact` to it, so a roadmap outlives the process that authored it.

**One generic table, keyed by `(table, id)`**, not one SQL table per artifact table name. The name is *data*: it arrives on the effect at run time, so a table per name means running DDL built from a string the graph supplied, on every first write to a name nobody had used yet. That is a migration per artifact kind and an injection surface bought for nothing, because the bodies are opaque JSON with a version and no query here reads inside one. A composite primary key gives the same isolation with no DDL after `open`.

Time travel is the event log rather than a history table, so `read` is the latest and `at` is a point read, and neither can disagree with the other: the row and its event land in one transaction.

Both executors route to it, with the same optimistic version check `replace-symbol` gets one column over:

| Executor | `upsert-artifact` |
|---|---|
| `memoryEffects({ store? })` | the injected store, or an in-memory one it opens itself |
| `vcsExecutor({ artifacts? })` | the injected store, or still `infra-failed` — an executor with nowhere to write must not report that it wrote |

`memoryEffects().artifacts` is a live read-only **view** over the store's event log rather than a second `Map`. A getter would have handed out the state at destructuring time, and `const { artifacts } = memoryEffects()` is how every caller reads it.

## Declared commands

How a project is typechecked, linted, tested and how one oracle is executed is the consumer's to declare. [`packages/core/src/core/commands.ts`](./packages/core/src/core/commands.ts) is where it says so — four functions, from typed arguments to a command:

```ts
export type CommandArgs = {
  typecheck: Record<string, never>;
  lint:   { paths: readonly string[] };
  tests:  { file: string; selector?: string; junit: string };
  oracle: { file: string; selector?: string; junit: string };
};
export type Command =
  | readonly string[]
  | { argv: readonly string[]; env?: Record<string, string>; timeoutMs?: number;
      resources?: readonly string[] };
export type Commands = { [K in keyof CommandArgs]: (args: CommandArgs[K]) => Command };
```

The framework knows the four **jobs**; the consumer knows the four **commands**. `targets/todo/.des/commands.ts` is one, in the consumer's own DES configuration, and the run directory loads it from beside the composition. It is refused **by name** when absent, the same way the test path scope is: a default would run one project's toolchain against every other project and call the result a verdict.

A bare `string[]` normalises to `{ argv }` at the framework's default timeout. The object form exists for the three things an argv cannot say: an environment overlay (never a replacement, because `bunx biome check` needs a `PATH`), a budget, and a named shared resource.

All four are compositions of **one effect**:

```ts
| { type: "run-command"; argv: readonly string[]; cwd?: string;
    env?: Record<string, string>; timeoutMs: number; resources?: readonly string[] }
```

and the mapping is deliberately coarse, because a branch should read a verdict and not a transcript:

| | `EffectResult` |
|---|---|
| could not be spawned | `infra-failed`, carrying nothing: nothing was observed |
| killed at its timeout | `infra-failed`, carrying what it printed: it **ran** |
| exit 0 | `committed` |
| any other exit | `rejected { by: "command" }` |

The output rides on the result as `command` — `{ exitCode, stdout, stderr, durationMs, timedOut }`, each channel capped at **64 000 bytes** with a trailing `…` when it was truncated. It is payload: a person reads it, a correction turn reads it, the event log carries an excerpt of it. The exit and the outcome are the only things a branch reads. A **stage** that interprets a non-zero exit reports its own name instead, so `tsc` saying no is `rejected { by: "typecheck" }` and the linter saying no is `rejected { by: "lint" }`; `command` is what an uninterpreted exit looks like.

`resources` is how shared test infrastructure gets serialised. A step's own declared commands name what they need exclusively, the pipeline's default `resourcesFor` is the union of those names, and the scheduler takes the whole set as a lease before the step runs. Two steps that name `shared-db` take turns; two that name nothing run together. Both halves are asserted against the same two independent steps.

Both effect executors run it, because a command needs no VCS behind it and an executor that refused one would be pretending it could not do a thing it can. The VCS executor adds two things: the repository root as the base for a relative `cwd`, and a `trail` event carrying the argv and the exit, because every effect it performs is on the event log.

### The JUnit rule

The declared command is told **where to write a JUnit report**, and [`packages/core/src/vcs/junit.ts`](./packages/core/src/vcs/junit.ts) is the one place in the repository that reads one. Reading the interchange format rather than a runner's own summary lines is what keeps the verdict from being a function of one runner's human output, which would leave a consumer with any other runner unmeasurable.

The flags in `targets/todo/.des/commands.ts` were **measured against bun 1.3.12**, not assumed: `bun test <file> -t <name> --reporter=junit --reporter-outfile=<path>` writes a `<testsuites>` document with `tests`, `failures` and `skipped` counts and one `<testcase>` per test. It does **not** create the report's parent directory, so the stage mints a temp one. A run whose file does not parse, or whose import does not resolve, writes **no document at all**.

That last fact is why the reader keeps two absences apart, and it is what lets the four-word verdict rule stay exactly as it was:

| What the runner left behind | Counts | Verdict |
|---|---|---|
| no file | `undefined` | `broken` on the `no-summary` axis: it ran nothing |
| a file no reader can count | zeros | a non-zero exit over zeros is `indeterminate`: nothing was established |
| a report | its own | the rule as before: `green` / `red` / `broken` / `indeterminate` |

A selector naming no test is `indeterminate`. bun's JUnit report says two tests existed and both were skipped, and it exits non-zero anyway: a non-zero exit that establishes nothing is exactly what that word names.

`errored` is failures-versus-errors, which is what tells `broken` from `red`. bun does not distinguish them and emits `<failure>` for both, so for a bun project `errored` is always zero and `broken` arrives by the absent-report route. A runner that does distinguish them (`<error>`, or an `errors` attribute) is read correctly, which is the point of reading the interchange format rather than one runner's prose.

## The four worked examples

They live under `examples/nwave/`, together, because they are waves of one consumer's process rather than unrelated demonstrations — and they compose: ROADMAP writes the steps, DISTILL fills in their acceptance facts and writes the oracle that measures each value, and DELIVER runs once per step whose oracle came back red.

| | ROADMAP | DISTILL / obligations | DISTILL / oracle | DELIVER |
|---|---|---|---|---|
| Shape | one bounded loop, two leaves, three non-model steps, eight branches, two suspend nodes | one bounded loop, ONE leaf, two non-model steps, four branches | one bounded loop, one leaf, two non-model steps, four branches | three nested bounded loops, eight leaves, two non-model steps, eleven branches |
| Cycles | `author`, bounded at 2 | `obligations`, at 2 | `author`, at 2 | `cycle` ⊃ `test-loop`, `gates-loop` |
| Decision space | a sequence, and a choice of *data*: two branches read pure functions of the roadmap | a choice of *manifest*: the branch after the leaf reads a pure function of it | a decision, a write outcome, and an *effect verdict* the runner produced | a sequence, and every effect it asks for has its own outcome space |
| Enumerated by | `enumeratePaths` over `scriptedBinding`, resuming every suspension it reaches | the same, resuming | the same + `scriptedExecutor`, resuming | the same + `scriptedExecutor` |
| Paths | **176** | **28** | **421** | **347** |
| Wall clock | ~0.68 s | ~0.09 s | ~1.3 s | ~1.8 s |

Two of them are worth a second look for opposite reasons. The obligations graph is the smallest thing in the repo that still earns a graph: one leaf, a total function, and no person on the happy path. The oracle graph is the only one whose decisive input is neither a model's answer nor a person's — it is a verdict software measured, and the walk gets it through the same `scriptedExecutor` seam it gets a write outcome from.

**Every path in those counts is one production can take**, and the mechanical checks are why. `scriptedBinding` answers the worker, so everything between the seam and the decision runs — including the leaf's own checks. A leaf carries the same rules as mechanical checks that its gate carries as a total function — deliberately, "so a rule cannot hold at one and not the other" — so a proposal breaking one never REACHES the gate: the check refuses it and the worker is re-driven with the defect named. That is also why the roadmap walk draws from a fifth proposal carrying ONLY the two defects the leaf cannot see, which is what keeps `shape.route`'s `invalid` edge reachable at all.

### The `run-tests` union

The size of a test run is not one owner's to decide in *both* directions: the workflow knows things the static import graph does not, and the import graph knows the one thing the workflow must not be allowed to forget.

So the effect carries `impacted` and `extra?: string[]`, and the two halves have separate owners.

| | Owner | How |
|---|---|---|
| The **floor** | the VCS | `writes.runTests` recomputes `impactedTests(wrote)` from the symbols the batch actually wrote, rather than reading it off the effect |
| The **selection** above it | the workflow | a leaf returns test ids in `extra`, and `impactedTests(impacted) ∪ testsById(extra)` is what runs |

A selection that misses a test the floor holds comes back:

```ts
{ effect, outcome: "rejected", by: "contract" }
```

with the omitted ids named in the rejection detail and in the `tests-run` event's `detail` as `{ omitted, selected, wrote, status: "omitted-impacted-tests" }`, at `verification: "failed"` and `category: "contract"`. It is refused before anything runs, because a narrower run is not a cheaper run. The union is what is checked rather than the declaration, so an effect whose `impacted` names the wrong symbols but whose `extra` covers the floor is fine.

`memoryEffects` answers `infra-failed`, deliberately: enforcing a floor needs an impact graph, that executor has none, and an executor that cannot tell an omission from a selection must not pretend to.

`ImpactGraph.testsById` is what makes `extra` runnable at all. A test is a symbol of kind `test`, so its id is already stable. An id naming no live test is **dropped rather than refused** — `extra` may only add, so an id that names nothing adds nothing and cannot shrink a run, and the event records what actually ran so the drop is visible in provenance.

In DELIVER the selection is a leaf, `select-tests`, between `implement` and `run-tests`. Its decision space is `no-extra | extra` and the ids are payload: a set of test ids is not a closed enum, so it cannot drive an edge, and keeping it out of the decision is also what stops the path space scaling with the size of the suite. There is no `fewer`, and that is the rule rather than an omission. `no-extra` does not carry the ids even when the payload holds some — the mechanical check `deliver.selection-matches-its-decision` refuses that contradiction at the model boundary, and reading the decision in the `carry` hook makes it structural for a journal replay that never ran the check.

## DISTILL is two graphs

**`des distill` is provider-free.** Its input is a JSON manifest — per value an observation that must already exist in the handover by exact match, a non-empty list of `{ id, stimulus, expected }` obligations, exactly one oracle locator, and a whole-file support list — and it validates a closed rule set, renders a brief, and persists the facts. It buys no model turn and writes no test. There is no lane in it, no `.feature` file, no `steps/**` tree, no seven-category taxonomy, no fifteen-item checklist, and no pending marker anywhere. Completeness is a **total relation** in both directions — every obligation to at least one falsifiable observation and back — which is the rule a checklist exists to replace rather than to implement.

**The oracle graph is the half that writes the test.** Its one leaf holds no tools: it is bound to the structured-output binding, its prompt carries the observation, the obligations, the oracle locator, the supports and the design, and it returns the file bodies as payload. A `write-file` per declared path lands them under a path-scope lease covering the target's declared test paths — `_designer_owns` as a lease rather than as a tool grant — and then software runs the result. It mirrors nwave's `des oracle --value N`.

### The obligations graph: one leaf in front of a total function

```
obligations = loop(body: propose-obligations, until: valid or blocked, max: 2)
|
+- propose-obligations -> propose.route  -+- proposed  -> validate-manifest
|                                         +- exhausted -> obligations (blocked)
+- validate-manifest --> manifest.route  -+- valid     -> obligations (leave)
                                          +- invalid   -> obligations (iterate)

obligations.verdict -+- valid   -> persist -> accepted
                     +- blocked -> human   -> rejected
```

The leaf's decision space is a **singleton**. It proposes; whether the proposal is admissible is `manifest.ts`'s, and that is a total function of the manifest, the roadmap, and one injected repository fact. Giving the leaf a second decision would be asking a model to grade its own manifest, which is the arrangement the validator replaces.

Eleven named defects, because the defects are the feedback the next proposal reads and "invalid" tells a model nothing it can act on. Where a typed schema makes one of nwave's fourteen rules *unrepresentable* rather than merely invalid — `schema_version` is 1, the top level has exactly two keys, `acceptance_supports` is an array — `manifest.ts` says so rather than counting to fourteen. One is ours and not nwave's: `uncovered-value`, because `des distill` merges a partial manifest into a graph that may already carry facts and this wave runs once per roadmap with nothing to merge with.

`support-ignored` is the one rule that is a question about the *repository* — a support the repository ignores is a generated artifact rather than evidence reproducible from the commit — so its predicate is injected (`git check-ignore` in the composition, a literal in the walk) and the leaf's own mechanical checks cannot carry it. The test asserts both halves: with the predicate the manifest is refused, without it the same manifest is admissible, because an unanswered ignore question is not a defect.

**There is no human gate on the happy path**, unlike ROADMAP's. That is the one shape decision here worth defending. A decomposition is the highest-judgement act in the pipeline and its output is a diff somebody reads; this is not that. Every reason this step can refuse is a named defect a proposal can be re-driven against, so a review gate would be a person re-reading what a total function already decided.

### The oracle graph: the model decides, and software measures

```
author = loop(body: author-oracle, until: red or blocked, max: 2)
|
+- author-oracle --> author.route --+- authored       -> write-oracle
|                                   +- cannot-express -> author (blocked: design)
+- write-oracle ---> write.verdict -+- committed      -> measure
|                                   +- conflict       -> author (iterate)
|                                   +- defective      -> author (iterate, with the gate's detail)
|                                   +- refused        -> author (blocked: out of scope)
+- measure -------> measure.verdict +- red            -> author (leave)
                                    +- broken         -> author (iterate, with the output)
                                    +- green          -> author (blocked: vacuous)
                                    +- indeterminate  -> author (blocked: harness)
```

`measure` is **not a leaf**, and that is the load-bearing shape rather than an optimisation. The author of an oracle must not be the thing that decides it is red, and here it cannot be: `author-oracle` holds no tools and returns file bodies, and what executes them is the consumer's declared `commands.oracle`, read back through the JUnit reader. So "this oracle fails on its assertion and not on its scaffolding" is a property the runner owns and measures — nwave names the same rule `boundary:software-measures-model-decides` — and observing an execution is a fixed floor rather than a rigor knob.

There is **no pre-craft oracle reviewer**, for the same reason. A judge between "measured" and "judged" is a fourth model boundary, and the incident that would justify one — a judge approving a broken oracle in 27 seconds — is answered by a measurement that is software and free. The oracle's independent judgement is the whole-diff review at the end, which sees the oracle and the implementation together.

| verdict | route | why |
|---|---|---|
| `red` | leave, `accepted`, and an `oracle_runs` row | the desired answer |
| `broken` | the one correction turn, with the runner's verbatim output | the defect is the oracle's, and no role downstream may repair it |
| `green` | a person, `vacuous-oracle` | a test that passes before any production code proves nothing |
| `indeterminate` | a person, `harness` | a non-zero exit whose own summary records no failure and no error |

`green` is where this diverges from nwave deliberately. The shipped runner computes the same verdict and does not *arm* it, because four of its own designed behaviours legitimately reach a green oracle before a craft turn — a resumed run, a value a sibling delivered, a no-delta request, a silent craft turn. A graph that runs one value once with nothing behind it reaches none of them, so parking is the honest answer here.

`cannot-express` is the designer's typed rejection: *the constructive chain cannot be expressed through the declared public port without inventing a field, an operation, a fixture fact or an expected result.* It is charged to the **design**, from a two-member owner enum, and a rejecting author owns no byte — its finding travels, its edits do not, and a mechanical check enforces that.

### One defect from the shipped runner, closed rather than copied

`des distill`'s obligations never reach the oracle author. `_derive` builds its `AuthorityFacts` with `acceptance_obligations` at its default and only the craft path populates it, so the acceptance author receives the obligation *ids* the design declared and not the stimulus/expected pairs `des distill` produced — and is asked to write an oracle for obligations it cannot read. Here they are an input to the author leaf.

### The crafter is walled off from the oracle

`_crafter_owns`, as an executor rule. Every path a task declares is the crafter's **except the oracle**, because RED to GREEN must be bought by production and never by editing the test that measures it. The DELIVER pipeline builds each step's executor with `protected: [the step's oracle file]`, so a `replace-symbol` or a `write-file` landing there is `rejected { by: "contract" }` before a lease is asked for, with the refusal on the event log.

Expressing it in the executor rather than in a graph is what makes it hold for every write the graph could emit — including one a model proposed and the graph merely passed along. The supports are *not* walled: a support is the oracle's dependency rather than the thing that measures the value, which is the same line the shipped runner's own ownership check draws.

### `run-tests` is effect-driven

Whether a leaf's classification or the effect's outcome decides "did the suite pass" is the one thing the design leaves open. **It is the effect's outcome.** A suite's result is what running it produces, and a model asked the same question is a second source of truth for a fact the runner already answered.

So `run-tests` is a plain `step` that emits `{ type: "run-tests", impacted, extra }` and stores the `EffectResult`, and `test.route` is a pure function of that result and this step's own acceptance-test ids:

| Effect result | Verdict | Route |
|---|---|---|
| `committed` | `green` | leave the test loop |
| `rejected: tests`, failing ids all this step's own ATs | `still-red` | `diagnose` |
| `rejected: tests`, any failing id outside them | `broke-other` | iterate |
| `rejected: tests`, no failing id named | `broke-other` | iterate |
| `rejected: contract` | `selection-refused` | block → `test-selection-refused` |
| `infra-failed` | `harness-failed` | block |
| `conflict` | `harness-failed` | block |
| the suite did not run this iteration | `not-run` | iterate |

Three of those arms are positions rather than mechanics. A failure that names **no** failing test is `broke-other` deliberately: "the suite failed and nobody can say which test" is not the claim "this step's own acceptance test is still failing", and treating it as the second would spend the diagnosis leaf on evidence that does not exist. A **conflict** is `harness-failed` because running a suite claims no version, so there is no optimistic check for it to lose and one arriving means the executor is wrong rather than the change being bad. And `selection-refused` is a block rather than a retry because the floor is the VCS's: nothing inside the cycle could repair a selection that reached below it.

That split needed the ids to reach the branch, so `EffectResult`'s `rejected` gained `detail?: { failed?: string[] }`, `StageOutcome`'s failed variant gained `failed?`, and the tests stage populates it from the JUnit report's own failing cases. A stage that cannot name which test failed leaves it absent, and the graph reads the absence honestly rather than guessing.

### `gates` is effect-driven too

Whether the quality gate found anything is what **running** it answers, and a model asked the same question is a second source of truth for a fact the command already produced. So `gates` is a `step` that emits a `run-command` built from the consumer's declared `commands.lint` over the files the step writes, and `gate.route` is a pure function of the typed result:

| Effect result | Verdict | Route |
|---|---|---|
| `committed` (exit 0) | `clean` | leave the gates loop |
| `rejected` (any other exit) | `lint-failed` | `fix-lint`, then round again |
| `infra-failed` | `infra-failed` | block → `harness-failed` |

`fix-lint` stays a leaf, because writing the fix is judgement, and the gate's own output becomes the `evidence` it reads so it answers the linter's words rather than a paraphrase. A **clean** run does not overwrite the evidence: it has nothing to say, no leaf downstream reads it, and re-keying every later leaf's journal entry against "no fixes applied" would buy nothing.

There are three verdicts and no more, because three are what a lint run can produce. In particular there is no **`mutation-below-gate`**: a mutation kill rate is a verdict no declared command produces yet, so nothing would reach an **`add-test`** leaf and `graphDefects` refuses an unreachable node by name. That leaf is the only thing inside the cycle that could invalidate a green verdict, so the **cycle runs exactly once and cannot run out**, and there is no `cycle-exhausted` reason because nothing produces one. The loop node stays: the day a consumer declares a mutation command, the second pass comes back with it.

### DELIVER, why it starts at `implement`, and why 347

The DELIVER step cycle is the design's fixed graph: implement until green, refactor, gate, commit. Every leaf is a `runStep` with an injected model binding. One of them classifies and carries the enum the design names:

- `diagnose` → `impl-wrong | at-wrong | design-missing | harness-failed`

`select-tests` carries a second, `no-extra | extra`, which is the union rule above. The other six (`implement`, `fix-acceptance-test`, `surface-design-gap`, `refactor`, `fix-lint`, `commit`) are generative. "Make this AT pass with the minimal change" is code generation, not a closed-enum decision, so their decision space is a singleton and the routable outcome downstream is something else: for `implement`, the **effect result**. It returns a `replace-symbol` effect and the branch after it routes `committed | conflict | rejected | infra-failed`, plus `exhausted` for "the validator was never satisfied".

**The cycle starts at `implement`, and nothing precedes it.** There is no oracle node and no RED node, because neither has anything left to do: the oracle was authored and executed in [its own graph](#the-oracle-graph-the-model-decides-and-software-measures), and this one reads the recorded verdict. So "no edge bypasses RED" is a **readiness precondition** rather than a topology claim — a step whose oracle has no `red` in `oracle_runs` never becomes ready — which mirrors the shipped runner's own rule that with no recorded oracle the next step for a value is `des oracle`, never `des craft`.

That is a stronger guarantee than an edge, not a weaker one. An edge could be reached with a fabricated observation; a step that is not ready has no run at all. Both front doors refuse such a step **by name** rather than skipping it: the scheduler through `eligible`, and a run started by hand in its seed.

Three nodes are **not** leaves: [`run-tests`](#run-tests-is-effect-driven) and [`gates`](#gates-is-effect-driven-too) read an effect's result, and `test-loop.head` is a pure branch. A node whose answer a cheaper thing already produces does not get a model, and "cheaper" now includes "a command's exit status" and "a measurement another wave already took".

Nothing in the DELIVER *walk* runs a test or writes a symbol: the leaves answer from a `scriptedBinding` script and `scriptedExecutor` answers the effects, because the walk is a control-flow test and giving it a filesystem would make it something else. `memoryEffects()` returns `infra-failed` for `replace-symbol` and that outcome is **routed, not hidden** — a test drives it through the real graph and asserts the run parks. The same graph against a real checkout is [the pipeline](#the-scheduler-and-the-pipeline), which does run `bun test` and does write symbols.

**347 paths** is every leaf decision, every effect outcome, and every loop count up to its bound, with unreachable combinations never run. Coverage is asserted, not assumed: the walk visits every node the graph declares except `human.route` (reachable only by answering a suspension, which the resume tests cover), produces all seven declared `HUMAN_REASONS`, and produces both terminal kinds.

**Why `MAX_CYCLES` is 1 while the other two bounds are 2.** `select-tests` sits inside `test-loop`, which sits inside `cycle`, so its multiplier compounds once per (cycle × test) iteration, and the branch after it converging two edges on `run-tests` makes the compiler build the rest of the loop body twice per compile on top of that. Three bounds at 2 puts the walk past 7000 paths. The bound that gives way is the one the innermost multiplier is inside, because the other two do not pay: cutting `MAX_GATE_ATTEMPTS` does not reach far enough, since the gates loop is not one of the two loops `select-tests` is inside, and `MAX_TEST_ATTEMPTS` is the most expensive in signal — five tests depend on the test loop running twice: the implement retry, the conflict rebase, the rejected-write retry, `broke-other`, and the whole `at-wrong` re-run-without-re-implementing claim.

The cycle's bound costs nothing while it stands, because nothing inside the cycle can invalidate a green verdict and it therefore cannot iterate at any bound. The number matters again the day a consumer declares a mutation command.

### The diagnosis branch

A `still-red` suite is classified before it is retried, and each cause routes to the agent that owns it. Looping straight back to `implement` would assume the answer to a question nobody asked.

| `diagnose` | Route | Why |
|---|---|---|
| `impl-wrong` | iterate: `implement` again | the plain implement loop |
| `at-wrong` | `fix-acceptance-test`, then re-run the suite without re-implementing | the test asserts the criterion wrongly; rewriting the code would be answering the wrong question |
| `design-missing` | leave the cycle → `surface-design-gap` → `human`, reason `design-gap` | the design is a contract, and a gap in it is not something a model may close by inventing the surface a test happens to need |
| `harness-failed` | block, reason `harness-failed` | the same distinction one leaf up: a runner that produced no verdict is not a failing test |

`design-missing` is the interesting one, because it has to *leave* a loop. The body-boundary rule says a body node's only edge out is the loop's own id, so there is no edge from `diagnose.route` to `human`. Instead the diagnosis lands in state, `blockedReason` reads it, `testDone` and `cycleDone` go true because of it, the run unwinds through both loops, and `cycle.verdict` — the one branch after the outermost loop — routes it to the architect's leaf and then to a person. That is the same move rule 3 makes for a failing step, two levels up.

`at-wrong` is the other shape worth naming. "Back to `run-tests`" cannot be an edge, because `fix-acceptance-test → run-tests` closes a cycle inside the body that is not the loop's boundary, and `graphDefects` refuses it by name. So the correction routes to the loop boundary and the body gains a head branch: `test-loop.head` starts the next iteration at `run-tests` when an acceptance test has just been corrected, and at `implement` otherwise. The suite runs twice and the implementation is written once, which is exactly the difference between `at-wrong` and `impl-wrong`, and it is asserted as such.

The walker itself is `enumeratePaths(runOnce)`: run with every choice at its first option, re-run forcing the last choice point to its next option, repeat until none is left. It requires the decision order to be a function of the decisions already made, so it covers sequential graphs and refuses a `fanout` by name rather than miscounting. DISTILL keeps its `cartesian` product.

**Two things are choices, not one.** What a leaf decided is the first axis and what came back from the effects a step asked for is the second, and a walk that enumerated only the first covered half of DELIVER's edge tables. `scriptedExecutor(choose, space)` is the second: an `EffectOutcomeSpace` names, per effect type, the outcomes to try, and the executor forks the path once per effect per outcome. The space is small and explicit on purpose, because it is a multiplier at every node that emits the effect, so it holds the outcomes the graph *routes differently* rather than every outcome the type system admits. DELIVER's declares four for `replace-symbol`, five for `run-tests`, and one for `append-trail` — the last forking nothing, and declared anyway because the `leaf` constructor emits it whenever a validator was never satisfied.

An effect type the space does **not** declare is refused rather than answered `committed`. A silent commit would make the coverage claim a fiction for the edges the other outcomes route to, and nothing would say so, so a graph that grows an effect grows its space in the same commit or its own walk fails by name. It is one outcome per effect rather than per batch, which is why the roadmap's `persist` keeps its own executor: forking per effect there would enumerate combinations a batch-atomic write could never produce.

The oracle adds a third thing the DELIVER walk has to vary, and it is neither a decision nor an effect: `oracle.route` reads the *inventory*. That is the same shape the roadmap walk already has, where two branches read pure functions of the roadmap, so the walk chooses between an inventory that locates and one that does not, exactly as the roadmap walk chooses between proposals.

**One `human` node, outside all three loops.** A loop body leaves only through the loop's own id, so an outcome that needs a person does not jump out of the cycle. It sets a block in state, every enclosing `until` goes true, the run unwinds, and `cycle.verdict` routes it. Reaching a bound arrives the same way with its own reason (`test-loop-exhausted`, `gates-loop-exhausted`), so a person is told which budget was spent and how many times it ran. The cycle has no such reason, because nothing inside it can ask for a second pass: every way its body can end either leaves cleanly or sets a block. Because DELIVER's person sits outside the loops, the "a suspension inside a loop body resumes into the same iteration" guarantee is tested in `packages/core/src/core/workflow.test.ts` against a hand-built graph, where the assertion can be exact: the trace reads `spin, ask, apply, spin, ask` rather than `spin, ask, spin, ask`.

### ROADMAP: the roadmap is data, and this is the graph that writes it

The third example is the authoring workflow, and the thing it is there to say is that **a roadmap is steps**. An agent does not generate a workflow per feature. It generates steps, and a scheduler instantiates the one fixed step cycle per step. Nothing about a feature changes the graph.

So this graph is fixed and hand-written like the other two, and what it produces is `roadmaps` and `roadmap_steps` artifact rows through the effect executor.

#### The steps

Modelled on nWave's own `handover.json`, with our naming. A `StoredHandover` there is a request plus an ordered tuple of `HandoverValue`s; these are the same facts, as zod schemas, in `examples/nwave/roadmap/schema.ts`:

```ts
RoadmapStep = {
  id: string;                          // stable, unique within the roadmap
  observation: string;                 // what will be observably true when it is done
  dependencies: string[];              // step ids that must be accepted first
  authority: string;                   // a locator into the design source it implements
  predictedTouches: string[];          // symbol ids or paths it expects to write

  // DISTILL's to fill. ROADMAP leaves all three empty.
  acceptance: AcceptanceObligation[];
  oracle?: string;                     // `path::selector`, exactly one per value
  supports: string[];                  // whole-file test substrate the oracle needs
}
AcceptanceObligation = { id: string; stimulus: string; expected: string }
Roadmap = { request: string; steps: RoadmapStep[] }
```

`predictedTouches` is the one field beyond the handover's own, and it is there because the disjointness check needs an axis to measure. `steps` is deliberately allowed to be empty by the schema: that is what `decompose` returns when it answers `cannot-decompose`, and an empty roadmap is refused by `validate-shape` as a *named defect* rather than by the parser, so the refusal reaches the graph as data.

**The last three fields are the wave boundary.** What a value must be observed to do is [DISTILL's act](#distill-is-two-graphs), not the decomposer's, and `acceptanceIsDistills` is a mechanical check on `decompose`'s own output that refuses a proposal which filled them in.

Declaration order is significant. It is the total order the disjointness resolution uses to decide which way a new dependency edge points, and nWave's handover relies on the same order for the same reason.

#### Two of the nodes are pure functions, not models

That is the point of the example. A graph's branches do not have to read a model's answer; they have to read a closed enum, and a pure function over the data produces one just as well.

**`validate-shape`** returns the six named defects nWave's own `read_handover` refuses a persisted handover for:

| Defect | What it names |
|---|---|
| `no-steps` | the roadmap has no steps at all |
| `duplicate-id` | two steps claim one identity |
| `dangling-dependency` | a dependency names no step in the roadmap |
| `cycle` | the dependency graph is not a DAG, named by the path that closes it |
| `observation-too-short` | a step says too little to be worked from, with its length |
| `empty-authority` | a step implements no named design source |

They are **named rather than boolean** because they are the feedback `decompose` reads on the next iteration: "invalid" tells a model nothing it can act on. And `decompose`'s own requirements consume the same predicates through `firstDefectOfKind`, so the step's mechanical guardrail (which runs before a validator model is spent) and the graph's gate (which runs on whatever got past it) cannot drift apart.

**`no-acceptance` is not one of them**, and its absence is the wave boundary. A shape check demanding obligations at ROADMAP time would refuse every roadmap for not having done a later wave's job. What ROADMAP can ask is whether the observation says enough to decide anything about, so `observation-too-short` sits there instead, with nwave's own `MINIMUM_OBSERVATION_CHARACTERS` of 40 — measured rather than chosen, from the shortest real accepted-turn diagnostic in the shipped runner.

**`measure-disjointness`** mirrors `parallel_safety.py`. A pair the roadmap declares independent whose `predictedTouches` overlap is DRIFT, and the overlapping entries are the finding. The resolution on top of that is deterministic: order the pair by declaration order, lower ordinal first, and record the edge. If adding one would close a cycle, the verdict is `drift-unresolvable` and the pair is named.

The measurement is taken **once**, against the roadmap as the author declared it, and only then are the edges applied. That ordering is load-bearing twice over:

- It is the only way `drift-unresolvable` is reachable. A lower-to-higher edge for a pair with no path either way cannot close a cycle on its own, because a cycle through the new edge needs a path back, which is exactly what "independent" rules out. So a cycle can only come from an *earlier* repair having ordered things since. Re-measuring after each edge made the verdict dead code.
- It keeps the findings honest. Re-measuring would let the tool's own edge silence the next disagreement the author made, which is the adjudication `parallel_safety.py` refuses to do.

The resolved roadmap is what gets persisted, not the proposal. The added edges are what the author's own declaration implied once the overlap was measured, so `persist` writes them, the terminal state carries them, and a test asserts the `roadmap_steps` row for the affected step. In production `predictedTouches` would come from the VCS symbol inventory rather than a model's guess, and whatever this misses the DELIVER lease catches at write time as a `conflict`. This is the cheap check before anything is dispatched, not the guarantee.

#### The fanout-sizing decision: one leaf, not eight

`validate-slices` judges every step of the roadmap. The design allows either a fanout of one leaf per step or a single leaf returning per-step decisions. **It is a single leaf**, and the reason is not taste:

- A fanout's shape is fixed at compile time and a roadmap's step count is not, so a fanout would need sizing to a declared maximum (say 8). That puts 4^8 = 65 536 combinations at one point in the walk.
- Worse, the walker that fits this graph is `enumeratePaths`, because a bounded loop makes the path space *sequences* rather than tuples — and `enumeratePaths` **refuses a fanout by name** rather than miscounting it. A fanout would have made the graph unenumerable by the only walker that fits it.

One leaf keeps the per-step verdicts (each with a verbatim anchor into *that* step's own observation, checked by the framework's `verbatim`), keeps the aggregate as the one closed enum the graph reads, and costs one choice point. `slicesVerdict` maps the leaf's step-level word onto the graph's roadmap-level one: `is-slice → all-ok`, `not-slice → some-not-slice`, `cannot-tell → cannot-tell`, absent → `exhausted`.

#### One loop, two people, and what `revise` costs

Everything that repeats goes through the one `author` loop, bounded at 2, and the body-boundary rule shapes the rest. The design's sketch draws `human-review --approve--> persist` and `slices-verdict --cannot-tell--> human`; neither can be an edge, because a body leaves only through the loop's own id. So each records its fact, `until` goes true, the run unwinds, and `author.verdict` — the one branch after the loop — routes it.

`human-review` is **inside** the loop and `human` is **outside** it, and that is exactly what `revise` costs. A person answering from inside an iteration re-drives the decomposition with their notes; a person handed a block is outside every loop, so nothing they could answer would re-drive anything. Which is why `human` has **one** answer:

```ts
export const HUMAN_DECISIONS = ["abandon"] as const;
```

That is a position rather than an omission. Every route into `human` is a block no closed enum could clear: a shape nobody can fix from there needs a re-decomposition (which is `revise`, inside the loop), an unorderable overlap needs the author to change the roadmap, a persist conflict needs the world re-read. Offering a second answer would mean inventing a route the design does not name — a forced persist, or a jump back into a loop the run has already left. Rule 3's point is that a person is an input the graph reads, not that every parking has two exits.

#### The walk resumes, and it chooses data

176 paths, ~0.7 s, and two things make it unlike DELIVER's.

**It resumes.** DELIVER's person sits outside all three loops, so its walk stops at the suspension and leaves `human.route` to the resume tests. Here the review is in the middle, and `persist`, `accept`, `review.route` and `human.route` are only reachable through an answer. So the walk answers: while a run is parked it chooses from that node's own closed enum and resumes. The walker allows it because the choice point's id is `resume:${reason}`, and the reason is a function of the choices already made, which is the walker's one requirement. The coverage assertion is therefore stronger than DELIVER's: **every node the graph declares is visited, with nothing excused.**

**It chooses data, not just decisions.** Two branches read pure functions of the roadmap, so to reach `shape.route`'s `invalid` edge or `disjointness.route`'s `consistent` and `drift-unresolvable` edges the walk has to vary the *roadmap*. The choice point at `decompose` is therefore a choice of **proposal**, drawn from the hand-written roadmaps in `examples/nwave/roadmap/fixture.ts`: `KNOWN_GOOD` (three steps, one declared dependency, one deliberate overlap → `edges-added`), `DISJOINT` (→ `consistent`), `UNRESOLVABLE` (→ `drift-unresolvable`), `MALFORMED` (every shape defect at once, three of which the LEAF's own checks catch — so it exhausts there and never reaches the gate), `UNSHAPED` (only the dangling dependency and the cycle, which are the gate's alone → `invalid`), plus `cannot-decompose` and a worker that never answers. Enumerating a graph whose decisions are functions of its data means enumerating enough data to reach every edge.

`KNOWN_GOOD` is also the known-good artifact in the framework/consumer sense: the harness proves a roadmap is well-formed, and a hand-written one is the only thing that says a well-formed one is *right*. `KNOWN_GOOD_RESOLVED` beside it is the expected output steps, which is what makes "the resolution is not advice" a testable claim rather than a comment.

## The scheduler and the pipeline

The roadmap is steps. The step cycle is one fixed graph. The scheduler instantiates the graph once per step and runs the ready set concurrently. Two waves use it now: DISTILL runs one oracle turn per value in dependency order, and DELIVER runs the step cycle per step.

**[`packages/core/src/core/scheduler.ts`](./packages/core/src/core/scheduler.ts) is generic.** A step is `{ id, dependencies }` and nothing else; what a step means, where it is read from, and what its run does are the consumer's.

```ts
openScheduler<S>({
  steps,                   // { id, dependencies }[]
  runOne,                  // (step) => Promise<RunOutcome<S>>
  resumeOne,               // (step, runId, answer) => Promise<RunOutcome<S>>
  statusOf,                // (stepId) => Promise<StepStatus>     the projection
  record,                  // (stepId, outcome) => Promise<void>  the only write
  eligible?,               // (stepId) => Promise<boolean>        may it run at all?
  concurrency,             // a positive integer
  resourcesFor?,           // (step) => string[]
  leases?,                 // ResourceLeases; inMemoryLeases() is supplied
});
// => { run(), resume(stepId, answer), parked() }
```

**State is a projection**, which is the one design decision worth defending. The scheduler persists nothing of its own: it asks `statusOf` for every step, reports each finished run through `record`, and re-reads. That is the stance nwave's `delivery_state.py` takes — the next step is *derived* from persisted facts and never decided — and it buys the property that matters: a scheduler that died mid-feature restarts by reading rather than by remembering. A step in flight has nothing persisted yet, so it reads `pending` and is simply run again.

- **The frontier** is every step whose every dependency reads `accepted`. A `rejected` or `suspended` step therefore blocks only its dependents, and that *falls out of* the rule rather than being enforced: nothing downstream of it becomes ready and everything else keeps running. A person's queue is a list of independent blocked subtrees.
- **`eligible` is the precondition the frontier rule cannot express.** "Is everything this step waits on done" and "may this step start at all" are different questions, and `statusOf` cannot carry the second: a step that has not run is `pending` whether or not it may. It is read once per refresh, beside `statusOf`, so `ready` stays synchronous and a consumer's answer is a projection like every other fact here. An ineligible step blocks its dependents exactly the way a rejected one does. DELIVER's is `oracleIsRed`.
- **Resuming** a parked step continues it through the framework's own `resume` and then re-evaluates the frontier in the same call, so answering one step continues the feature rather than the step.
- **Resource leases** serialize shared test infrastructure and nothing else. A step declares the names it needs, the scheduler takes the whole set atomically before the run and releases it after (`finally`, so a throwing run does not deadlock the next one), and two steps sharing one name serialize on that name while two steps sharing none run together. Taking the set at once is what makes it deadlock-free: a run never holds one name while waiting for another. `inMemoryLeases` grants waiters FIFO, so which of two blocked steps goes first is a function of the order they asked rather than of timing.
- **A `runOne` that throws is a graph bug and is not absorbed.** Everything a graph decides is data, so a throw means the graph itself is malformed, and swallowing it into a status would hide that.

**[`examples/nwave/deliver/pipeline.ts`](./examples/nwave/deliver/pipeline.ts) is the step half, and the SERVER is the scheduling half.** The consumer's file reads the `roadmaps` row for its `stepIds` and joins through to `roadmap_steps` (a scan would mix two roadmaps in one store), turns one step into the seed of one DELIVER run, and appends a `step_runs` row `{ stepId, runId, outcome, seq }` for each finished run. It calls `openScheduler` nowhere: a pipeline registration is an input schema plus steps plus `readiness` plus `record`, and `@des/server` drives the frontier — starting each ready step through the same `runner.start` a person's button starts a run with, so **a step's run is an ordinary run** with an id, a trace, events and a dialog. One DELIVER run per step, with:

- the step's obligations, `predictedTouches` and `authority` in the `StepUnderDelivery` the graph reads;
- **the run's id as the VCS session**, so two runs hold two leases rather than colliding on the one lease a session may hold;
- **the step id as the task id**, so the event log's answer to "what changed" joins the journal's answer to "what did this step decide" on one key;
- and therefore the step id in **every leaf's journal input**, because `StepUnderDelivery` carries it and the journal key is a hash of the input. Two steps cannot share a key, so one step's decision cannot replay as another's. That is asserted directly rather than assumed.

Two things the DELIVER registration builds per step are about OWNERSHIP rather than plumbing, and both are executor options rather than graph edges:

- **`protected: [the step's oracle file]`** — `_crafter_owns`. Every path the task declares is the crafter's except the oracle.
- **`knownRed`: every other undelivered value's oracle.** Every one of them is red by construction, because a value is only ready once its own oracle has been measured red. Without this a module with two undelivered values is undeliverable: the gate refuses step A's correct write because step B's oracle — which A did not break and cannot fix — is failing. An *accepted* sibling's oracle is deliberately not in the set: that one is green, and breaking it is a real regression the gate exists to catch.

That second one is measured rather than predicted: without it the todo target's own delivery refuses `complete`'s write for `remove`'s red oracle, which is the same shape the batch filter is widened for one case over.

**The end-to-end test drives all of that through the server**, and it is one of the two tests in the repo allowed to shell out. A two-step roadmap (B depends on A) is persisted *through the roadmap workflow's own `persist`* into the artifact store; a temp TypeScript project holds two oracles and two production symbols; the leaves are scripted at the binding so nothing reaches a model; and the tests stage is the real one, over the declared test command. `runPipeline` is pressed once: A runs, B runs after A is `accepted`, both steps carry a run id the run store answers for, both `step_runs` rows read `accepted`, the event log shows the write under each step's own task id and each run's own session, and `bun test` over the project at the end reports 2 pass. A companion test drives an implementation that does *not* satisfy its oracle and watches the real gate refuse it, roll the file back byte for byte, park the step's run with the enum a person answers from, and leave B unready.

One honest finding from building that: with the impact floor covering the step's own acceptance test, a wrong implementation is caught at the **write** gate as `rejected: tests` and retried, so `still-red` is reached only when the suite fails for something the write's impacted set does not cover. That is the under-approximation `impact.ts` already documents (a fixture file, an environment variable, a subprocess), not a new gap.

**10 tests, ~1.6 s** for the whole file, including the real `bun test` spawns behind every write gate. A `bun test` of one file with one test costs about 30 ms, which is what makes a real gate affordable in a test suite at all.

## Durable snapshots

`resume` rebuilds the graph rather than holding a live handle — the compilation is a pure function of the graph, so the step ids match the snapshot the engine persisted and the run reattaches by `runId`. The only thing standing between "a parked run is resumable from a fresh compile" and "a parked run is resumable from a fresh **process**" was where that snapshot lived.

```ts
export const openWorkflowRuntime = (url = ":memory:"): WorkflowRuntime => …
run(wf, state, execute, runtime?)
resume(wf, runId, answer, execute, runtime?)
```

`:memory:` is the default and is what the whole suite runs on. A `file:` URL opens libSQL, which is what lets a parked run outlive the process that parked it: the todo target's runtime is a file in its run directory, so a server restarted against the same run directory can still answer a suspension its predecessor produced. `packages/core/src/core/durable-snapshots.test.ts` proves it the only way that means anything — two runtime instances over one file, the first dropped before the second is built — and pairs it with the negative, a second runtime on a *different* file that cannot see the parked run.

**Two adapters rather than one, and the split is measured.** Running the whole suite on `LibSQLStore({ url: ":memory:" })` also works, and takes **20.6 s** against **4.6 s** on `InMemoryStore`: the 972 enumerated paths write a snapshot per step, and a SQL round trip per write is 4.5× the cost of a map write. The durable path needs a database; the in-memory one needs a map.

## The server and the UI

**The entrypoint is a server, and the server IS the application.** A target
declares what it can run and calls `serve`; `targets/todo/.des/main.ts` is that
file, and it is a list of registrations and one call.

```ts
import { serve } from "@des/server";
await serve({ workflows: [...], pipelines: [...], artifacts, port: 3000 });
```

Five things are decided by that, and each is a position rather than a convenience.

**Every call the UI makes is a server function.** `@des/ui` is a TanStack Start
application, and each of the eleven things it can ask for is a `createServerFn`
whose body is `@des/server`'s own — called directly from a route's loader or a
button, typed end to end. There is no fetch to `/api` in the client, no
hand-written JSON route behind one, and no origin to configure: the function
runs in the process that holds the registrations. Routes have loaders, so the
first paint is rendered there, from the registry, before any client bundle
exists.

The one exception is `/api/events`, which is a server ROUTE, because a server
function is one request and one response and an event stream is neither.

**The UI draws the AUTHORED graph, never the compiled one.** The compiler emits
nested workflows with per-path ids — `wf:cycle>test.verdict=green.implement` —
and a node reachable from two branch edges is compiled twice under two names,
neither of which its author wrote. Drawing that would draw the compile. So
`project()` reads the node map through the harness's own `inspectGraph` and
`loopBody` — the same walk `compileWorkflow` admits a graph with — and reports
the ids in the source. A branch arrives with its whole edge table; a loop with
its bound and the nodes inside its body; a suspend node with the closed enum a
person will choose from, read off its own `resumeSchema`.

**Mastra's runtime sits under the server rather than beside it.** Runs,
snapshots, suspend and resume stay the engine's; `run` and `resume` are still
`@des/core`'s. What the server adds is the half neither has an opinion about:
which graph a person authored, which of its nodes a run is on, what each leaf
attempt decided and cost, and which steps of a pipeline are waiting on which.
Live node events come from the engine's own stream, projected back onto
authored ids by the compiler that minted the compiled ones.

**Runs, attempts and events are persisted in three tables**, and the registry
is a projection of them — see [Runs survive a restart](#runs-survive-a-restart).

**A pipeline is a registered composition that runs nothing.** It is an input
schema, steps — each naming a registered workflow and the input one run of it
takes — plus `readiness` and `record`. The server drives the frontier through
`@des/core`'s scheduler and starts each ready step through the same
`runner.start` a person's button uses, so **a step's run is an ordinary run**: a
server run id, a live trace, events, and a suspension answered in the same
dialog. Its status is read off that run.

**A pipeline takes an input for the same reason a workflow does.** A
composition over a roadmap is a composition over ONE roadmap, and which one is a
thing a person supplies rather than a thing the registration was built holding.
It is parsed by the registration's own schema before anything is scheduled, and
every hook is handed the parsed value — so the steps are derived from it, and a
value the steps could not come from never becomes a drive. The input rides on
the event that ATTACHED a step's run, which is what lets a suspension answered
minutes later, in another process, continue the frontier its own drive
computed.

**A suspension is answered in the UI.** A parked run raises a notification and
a dialog whose buttons are the node's own closed enum. A person cannot answer
with something the node would refuse, because nothing else is offered; an
answer that somehow is refused comes back naming the enum, and the run stays
parked. Answering a pipeline step is answering its run, from either page, and
the frontier is re-evaluated when it settles.

### The registration

```ts
type WorkflowRegistration<S, I> = {
  id: string;
  title: string;
  input: z.ZodType<I>;                          // what a person supplies, and the parser for it
  graph: (ctx: GraphContext) => Workflow<S>;    // built over the journal and the observer
  seed: (input: I) => S;
  executor: (ctx: { runId: string; input: I }) => EffectExecutor;
  journal: Journal;
  runtime?: WorkflowRuntime;
  observe?: StepObserver;                       // the target's own sink, called before the server's
};

type PipelineRegistration<I> = {
  id: string;
  title: string;
  input: z.ZodType<I>;                                   // what a person supplies to drive one
  steps: (input: I) => PipelineStep[] | Promise<PipelineStep[]>; // { id, dependencies, workflowId, input }
  readiness?: (stepId: string, input: I) => boolean | Promise<boolean>;
  record?: (stepId: string, outcome: RunOutcome<unknown>, input: I) => void | Promise<void>;
  concurrency?: number;
  resourcesFor?: (step: PipelineStep, input: I) => string[];
};
```

Both are written with their type parameters inferred from the object literal
and erased at the door — `registration()` and `pipeline()` — because the server
holds a heterogeneous set of each and drives every one through the same calls.
A hook CONSUMES its input and a function's parameter does not widen, so the
erasure has to be spelled out rather than written `<unknown>`.

Three of those shapes are worth defending. **The graph is a factory** because a
`Workflow<S>` has its journal and its observer already closed over, and "what
did each attempt cost" is exactly what a person watching wants — so the server
supplies both, which is the signature every graph builder in this repository
already has. **The executor sees the run's input** because its two ownership
options are facts about what the run is ABOUT: which oracle this step's crafter
is walled off from, and which failing tests it did not cause. **A pipeline step
names a workflow and an input** rather than carrying a way to run itself,
which is what makes "starting one step by hand does not escape the precondition
the scheduler enforces" structural: there is one registration and both doors
reach it.

### The surface

| Server function | What it answers |
|---|---|
| `listWorkflows` · `getWorkflow` | Every registration: its title, its authored graph, and the JSON Schema of its input. |
| `startRun` | Start a run. The run executes asynchronously and the id comes back at once. |
| `listRuns` · `getRun` | Status, the trace with iteration counters, the suspension and its answer space, the terminal, and every leaf attempt. |
| `resumeRun` | Answer a suspension. Outside the enum is a refusal naming it. |
| `readArtifacts` | A table's rows, now or at a past version. |
| `listPipelines` · `getPipeline` | The compositions, and one's run tree — for the input naming what it is a composition of — with the run each step is on. |
| `runPipeline` · `resumeStep` | Drive the frontier for one input; answer a parked step. |
| `exportRun` | One run as JSON lines: the run, then its attempts, then its events. |
| `GET /api/events` | The one route rather than a function: `run-started`, `node-entered`, `node-left`, `leaf-attempt`, `suspended`, `resumed`, `terminal`, `pipeline-step` — every one of them appended to `run_events` before it is published. |

**The run id is the server's, and the engine's is recorded beside it.** `run`
mints its own and hands it back when it stops, so a call that must answer with
an id before the run has done anything has nothing to answer with. A
consumer's `record` receives the framework's `RunOutcome`, whose `runId` is the
engine's — the one the snapshot is under — and the server's record carries it
as `engineRunId`, so the two names for one run join in one hop.

### Runs survive a restart

Three tables on `bun:sqlite`, in
[`packages/server/src/store.ts`](./packages/server/src/store.ts):

| Table | Shape |
|---|---|
| `runs` | ONE row per run, UPDATED as its status changes: run id, workflow id, engine run id, input JSON, status, terminal JSON, suspension JSON, error, started/settled seq. |
| `run_events` | APPEND-ONLY. Every one of the eight event kinds, in one total order — which is also the trace, because a node a run entered is an event it published. |
| `leaf_attempts` | APPEND-ONLY. One row per model-call pair, with what each half cost. |

A SIBLING of the artifact store rather than a table inside it, and the reason
is ownership rather than taste. The artifact store is `@des/core`'s and holds
the CONSUMER's rows, whose table names arrive on an effect at run time; this
schema is the server's and is written where the server can migrate it. Nothing
has to be atomic across the two, because no artifact write is part of a run
write.

**The registry is a projection.** `getRun`, `listRuns`, the pipeline step tree
and `statusOf` read the database; the trace is derived from a run's own
`node-entered` events rather than kept beside them; the step a run belongs to is
read off the `pipeline-step` events rather than a map. The runner holds nothing
— it rebuilds the graph from the registration and re-parses the input off the
row — so **a restarted server shows every prior run, keeps a delivered pipeline
step delivered, and answers the suspension its predecessor left.**
`packages/server/src/restart.test.ts` drives exactly that through two real
`serve()` calls over one directory.

Every durable fact about a run lives in one of four other stores — the engine's
snapshot, the journal, the VCS event log, the consumer's own rows — and these
three tables are what JOIN them. A map in their place would be the one table
not on disk, which is what makes it the wrong shape rather than a cheap one.

One correction falls out of the trace being the event log. Resuming
re-executes the step the run parked on, because that is how the answer is
delivered, and the engine emits a second `node-entered` for it while its own
trace records the visit once. The watcher drops that one re-entry, so the log
and the trace agree.

**What is still in memory is a fact about THIS PROCESS**, and a second process
has its own answer to each: which pipelines are being driven right now, what
refused the last drive, and who holds which shared resource lease.

### The drawing

JointJS paints and dagre lays out. Every id on the canvas is one the author
wrote. A branch's edges carry the key they are taken on. A loop's body is a
dagre **cluster** and comes out as a dashed box with the bound written on it —
which is what makes a bounded loop legible as a bound rather than as an arrow
that goes backwards — and the loop node sits outside that box, because it is
the thing that decides whether there is another iteration rather than part of
one. A run paints itself over the same drawing: every node it entered, the one
it is on, and the iteration counter on anything it entered twice.

**dagre places the edge labels too.** The layout graph is a MULTIGRAPH, because
a branch routinely sends two or three edges to one target — every loop-exit edge
converges on the loop node — and a simple graph collapses them into one edge
with one place to put three keys. And a label goes where dagre put it rather
than at its edge's midpoint, because for edges that share an endpoint and span
the same two ranks those midpoints coincide, which paints `exhausted`,
`cannot-decompose` and `invalid` on top of one another. `layout.ts` hands dagre
each label's size, dagre reserves a rank for it and answers with a point, and
the link's own view converts that point into the distance-and-offset a JointJS
label is addressed by.

JointJS is imported inside the effect that draws, because every route is
server-rendered and a drawing library that wants a document has nothing to do
on a server.

**One process.** `serve()` mounts `@des/ui`'s built handler: the hashed assets
by path, everything else to TanStack Start's own `{ fetch }`, which dispatches
server functions, then server routes, then SSR. `@des/*` is external to that
build, so the bundle imports the very modules the process already loaded rather
than carrying copies of the registry, of `bun:sqlite`, of everything. `dist/`
is not committed, and a server whose UI is not built answers 503 with the
command that builds it. There is no separate dev server: the data comes from a
registry only `serve()` supplies, so the loop is `bun run ui:build` (~1.5 s)
then `bun run todo`.

### A browser has rendered it

`bun run e2e` is six Playwright tests against a real `serve()` on a free port,
over the four example graphs and the two pipelines, with every leaf scripted
at the binding — an unscripted leaf refuses by name, so a test that reached a
model would fail rather than spend one. The fixture builds its registrations
with `todoRegistrations(dir, { models: scripted })` and nothing more.

- **The index** lists four graphs and two pipelines, server-rendered.
- **The drawing**: every node under the id its author wrote, the `author` loop
  as a box labelled `max 2` with the loop node outside it and its body inside,
  and `human` / `human-review` drawn as suspends — and the only two.
- **A suspension**: a roadmap run started from the form, parked at
  `human-review` under `edges-added`, offering exactly `approve` / `revise` /
  `abandon`; approve carries the SAME run to `accepted` and the trace spans
  both halves. Recorded to video.
- **A pipeline**: two pending steps, one button, both `accepted`, and each step's
  link opening its own run page with the step cycle's trace on it — nothing
  below the graph stubbed, so each step writes a real body through the real
  write path with a real `tsc`, `biome check` and `bun test` at the gate.

Screenshots are committed under
[`packages/ui/e2e/screenshots/`](./packages/ui/e2e/screenshots) at a fixed
1440×960 viewport, so what the tests saw is reviewable here. The video is not:
`test-results/` is gitignored.

**About 5.5 s, zero model calls.** What is still untested by a browser is
everything a model would say: see [The real run](#the-real-run).

## The todo target

[`targets/todo/`](./targets/todo) is what the three waves are pointed at. A `TodoStore` with `add`, `complete`, `remove` and `list`; `add` and `list` implemented; **`complete` and `remove` stubs whose bodies throw**; a `design.md` that is the authority for the public surface, the driving port, and the test path scope; and a [`.des/commands.ts`](#declared-commands) that is the authority for how it is checked.

**There is no test file**, and that is the point rather than an omission. The oracle for each value is authored by DISTILL into `test/` and measured red before one production byte is written. A pre-written test would make RED a thing the repository asserted rather than a thing the runner measured.

The walking-skeleton shape still matters for the production half. `replace-symbol` names an existing symbol, so a stub is what gives DELIVER something to write into: the missing behaviour is a gap in a body, which the framework can close, and a missing *symbol* is a gap it cannot. `write-file` is what creates the oracle; `replace-symbol` is what fills the body.

`design.md` declares the scope on one line:

```
- Test path scope: `test/`
```

Three consumers read it, which is why it is one line and not three constants: the author writes there, the executor walls the oracle there, and the manifest validator refuses a support outside it. `testPathScope` refuses by name when it is absent, because a default of `test/` would work silently for every project whose substrate lives there and mis-scope every project whose does not.

`.des/commands.ts` is the same shape of declaration one layer over, and it is refused by name for the same reason:

```ts
export const commands: Commands = {
  typecheck: () => ["bunx", "tsc", "--noEmit"],
  lint: ({ paths }) => ["bunx", "biome", "check", ...paths],
  tests:  ({ file, selector, junit }) => ["bun", "test", file, ...(selector ? ["-t", selector] : []),
                                          "--reporter=junit", `--reporter-outfile=${junit}`],
  oracle: ({ file, selector, junit }) => ["bun", "test", file, ...(selector ? ["-t", selector] : []),
                                          "--reporter=junit", `--reporter-outfile=${junit}`],
};
```

The target carries `@biomejs/biome` as a dev dependency and a three-line `biome.json`, so **lint is real**: it is the write path's third stage over every file a write touches, and it is the DELIVER cycle's whole quality gate. `biome check` exits 0 on warnings and non-zero on errors, which is why the two stub bodies — whose `id` parameters are unused, and warned about — pass the gate before they are implemented and pass it after.

It is read by the framework and by nothing in the project, which is why it sits in `.des/` with the composition rather than in the target's own source. `.des/` is excluded from the copy every run works in, so the copy carries no declaration: the commands are loaded once from beside the composition and RUN with `cwd` set to the copy, which resolves `bunx biome` and `bunx tsc` through the `node_modules` symlink the copy is made with. It is typechecked here: the repo's own `tsconfig.json` includes `targets/*/.des/**/*.ts` and excludes everything else in a target, because a declaration nothing checks is a declaration that drifts. The no-nondeterminism scanner covers it for the same reason, one property over.

**The template is never mutated.** Every run copies it to `runs/<name>/todo/` and works there.

### The server

```bash
bun run ui:build                    # once, so there is an app to mount
bun run todo [run-name]             # http://localhost:3000, run directory `first`
```

`targets/todo/.des/main.ts` is a list of registrations and a call to `serve`. One process rather than a command per wave, because a suspension has to survive the process that produced it: a server stays up, so a suspension is answered where it is read rather than reconstructed by whatever runs next.

It registers **four graphs** — `roadmap`, `obligations`, `oracle`, `deliver` — and **two pipelines**: `oracles` (one oracle per value, in dependency order) and `delivery` (the step cycle, once per red-oracled step). A pipeline step names one of those four graphs and the input one run of it takes, so a graph and a pipeline are two front doors onto ONE registration rather than onto one graph twice — same seed, same executor, same journal. Neither escapes what the other enforces: the standalone `deliver` seed refuses a step whose oracle has not been measured red, by name, and the pipeline declares the same fact as its `readiness`.

**A roadmap is an argument, not a constant.** `roadmap` takes the request a person types, bounded and non-empty; the other three take the ID of a roadmap that already exists, and the two pipelines take one too. That id IS the request text: the roadmap graph persists its `roadmaps` row under `roadmap.request`, as nWave keys a handover by the request it was authored for — so "which roadmap" and "for what" are one string, and there is nothing to keep in step. An id the artifact store does not hold is refused by name rather than answered with an empty step list. The design source and the symbol inventory still come from the run directory, because they are facts about the target rather than about what is being asked of it.

A run directory holds the copied project plus five stores — `vcs.sqlite`, `artifacts.sqlite`, `journal.sqlite`, `mastra.sqlite`, `runs.sqlite` — all of them files, so a restarted server continues rather than beginning again: it shows every prior run, keeps a delivered step delivered, and answers a suspension its predecessor produced. `runs/` is gitignored. `test/` is tracked only once it exists, because the oracle is what creates it.

**It starts without a key**, and that is a position rather than a convenience. The graphs, the projections, the artifact store and the event stream are all readable without one, so refusing at the door would make every one of them unreadable to say one thing about a leaf. The refusal is where the need is: a leaf with no key throws by name, `runStep` records it as a trail entry the way it records any provider error, and the graph routes the exhausted leaf where it routes one. Measured rather than assumed — starting a roadmap run with no key parks it at `human` under `validator-exhausted`, with the credential message on both attempts and in the trail, and the server still up.

**`models` is the composition's only injection point.** `todoRegistrations(dir, { models })` takes a `ModelBinding` per leaf ROLE — `decompose`, `authorOracle`, `implement`, `other`, `validator` — and nothing else. Production passes `todoModels()`; a test passes scripted ones. Nothing else is injectable, so what the suite actually printed is what every DELIVER run quotes rather than something a test could substitute.

Models: `decompose` on `anthropic/claude-opus-5`, `author-oracle` and `implement` on `anthropic/claude-sonnet-5`, every other leaf and every validator on `anthropic/claude-haiku-4-5`. `author-oracle` sits on the open-output class for the same reason `implement` does — writing an executable oracle that falsifies every obligation through a declared port is code generation, and what makes it safe is narrow validation plus a measurement, not a smaller model. No escalation is wired, deliberately: `escalateTo` unset is what makes the exhaustion count the number of decisions the *small* models could not get past their own validators. Those are the defaults: `DES_OPENAI_COMPATIBLE_URL`, with `DES_OPENAI_COMPATIBLE_MODEL` beside it, points all five roles at one OpenAI-compatible endpoint instead — a gateway, a proxy, or a model served locally — and `describeModels()` prints what is in effect rather than what is written in the file. See [the target's README](./targets/todo/README.md).

**The design source is `design.md` plus the VCS symbol inventory**, and the addition is load-bearing: `predictedTouches` and `implement`'s `symbolId` are opaque VCS ids assigned at track time, so a model that has never seen the inventory names one that does not exist and every write it proposes comes back `rejected: contract`.

Full detail in [`examples/nwave/README.md`](./examples/nwave/README.md#targetstododes--the-waves-pointed-at-a-real-project).

### The stubbed end-to-end

`targets/todo/.des/todo.test.ts` is the same path with the inference removed — every leaf scripted at the binding, so the schemas, the mechanical checks and the validators all run — and it is the one test that covers all three waves:

- the target copied to a temp directory without its `.des/`, the composition's own `commands.ts` loaded from beside it exactly as a run directory loads it, and the copy tracked with the **default** verifier over those commands — a real `bunx tsc --noEmit`, a real `bunx biome check`, a real impact-scoped `bun test`, a real oracle measurement;
- the roadmap authored through the roadmap workflow's own graph and persisted by its own `persist`, with all three of DISTILL's fields empty;
- the obligations graph filling them in and `persist` writing the enriched rows back;
- the oracle graph authoring one test file per value through a real `write-file` and a **real `bun test` measuring each one red** — nothing in the test file asserts the redness, because the runner is what says so;
- DELIVER refusing nothing (both steps are oracled), writing both stub bodies through the real gate, running `bunx biome check src/todo.ts` for real as the quality gate, and leaving both oracle files **byte-identical**;
- and the project's own suite: 2 pass, 0 skip, exit 0.

Every one of those is driven **through the server**: `todoRegistrations` is the
same function `main.ts` calls, the registry is the one `serve` would build, and
a wave is `startRun` or `runPipeline` rather than a call into a composition.
Each step of each pipeline comes back with a run id the run store answers for,
and the trace on it is of the graph the author wrote.

Both halves of the declaration are asserted against what actually ran: the `oracle-measured` event carries the `--reporter=junit` argv the target declared, and the gate's `trail` event carries `["bunx", "biome", "check", "src/todo.ts"]` at exit 0.

**About 3.6 s, zero model calls.** A companion test asserts the other half: with
no `oracle_runs` row the pipeline's `readiness` refuses both values, no run is
started at all, and the stubs are untouched — the model bindings throw, so
reaching a leaf would fail it. The same precondition refuses a step started BY
HAND, and lands on that run rather than on the call, because a seed runs where
the run does.

## What every leaf call cost

One `leaf_attempts` row per model-call pair, in `runs/<name>/runs.sqlite`:

```json
{"runId":"…","stepId":"deliver.implement","attempt":2,"model":"anthropic/claude-sonnet-5",
 "decision":"written","accepted":true,"verdict":"pass","violations":[],"mechanical":[],
 "workerTokens":{"input":2104,"output":312},"validatorTokens":{"input":1580,"output":44}}
```

**The gap between the calls a leaf made and the decisions it produced is the number worth reading** — it is what the validator and the mechanical checks cost, in inference, to keep the graph honest, and it is the open question the design says should be measured before the legibility argument is used to justify the approach. The UI shows it per run, and `exportRun(runId)` emits the same facts as JSON lines.

A journal HIT writes no row, because no model was called; counting a replay as a call would make every rate a fiction.

**The token counts are exact whatever the concurrency.** `runStep` hands each call its own `onUsage` sink, closed over the attempt being made, so nothing queues and nothing interleaves. A server does not serialise its runs, and two in flight cannot swap each other's numbers — which an observer firing after a worker/validator pair, over a queue drained in call order, could only guarantee while one leaf was in flight.

## The real run

**Not performed.** No Anthropic credential is available in this environment: `ANTHROPIC_API_KEY` is unset and there is no `ant` CLI to check. Every leaf that would call a model refuses by name rather than proceeding, and nothing in this repository fabricates a transcript.

Everything except the inference is exercised without it. What the real run would answer, and nothing else can:

- whether Opus, given `design.md` plus the symbol inventory, proposes a decomposition a person would approve;
- whether a small model, given one observation and a declared port, states an obligation as a stimulus and an expected result rather than restating the observation;
- **whether an oracle a model wrote is an oracle worth measuring.** The framework can prove it was executed, that it failed on its assertion rather than its scaffolding, and that the crafter never touched it. It cannot prove it asserts the right thing, and the rules bound to that leaf — a total relation in both directions, the declared public port, no invented expected result — are prose refuted by a small model, which is the class this design is least confident about elsewhere;
- whether a Haiku validator refuting a Haiku worker catches what a frontier reviewer catches;
- what a completed task costs, in calls and in tokens.

To perform it:

```bash
bun run ui:build
ANTHROPIC_API_KEY=... bun run todo
```

then, in the UI: run `roadmap` with the request you want decomposed, read the roadmap it parks with and answer `approve`; run `obligations` naming that roadmap; pick it on the `oracles` pipeline page and drive it; then pick it on `delivery` and drive that. A roadmap is named by the request it was authored for — that is the id its `roadmaps` row is written under — so the pipeline pages offer the requests the artifact store holds and a person picks one. What every call decided and cost lands in `runs/first/runs.sqlite`, and the UI shows it per run.

Or, for the smallest real thing — one oracle, one subagent, one measurement, no run directory:

```bash
ANTHROPIC_API_KEY=... bun run smoke:oracle
```

## Deviations from the design

The document's code sketches are sketches. Where one of them is underspecified or does not survive contact with a type checker, here is what changed and why.

1. **`needs-human` is a suspension, not a terminal.** `Terminal<S>` is `accepted | rejected`; a fifth node type, `suspend`, parks the run. This is a change to the design document itself (§ Five rules, rule 3), made because the runner now has somewhere to park. `run` therefore returns a `RunOutcome<S>` — `{ kind: "terminal", terminal, trace, runId }` or `{ kind: "suspended", reason, trail, trace, runId }` — rather than `{ result, trace }`, and `resume(wf, runId, answer, execute)` continues the parked run.

2. **Four constructors, not one: `branch`, `suspend`, `loop` and `leaf`.** `branch<S, D>` ties an edge table to a decision union. `suspend<S, R>` is the same shape of guarantee one level over: it ties a `resumeSchema` to the `absorb` that consumes it, so a node cannot be built whose schema parses something its `absorb` does not accept. The erasure to `Node<S>` happens in those two functions and nowhere else. `loop<S>` needs no erasure; it exists so that the bound is a named, required field at every call site. `leaf<S, I, O>` is new surface, approved rather than derived from the document — see deviation 17.

3. **`LanguageModel` → `ModelBinding`.** The sketches import `LanguageModel` from the Vercel AI SDK, which is gone. `StepDef`'s three model slots take `ModelBinding` — `{ id, generate({system, prompt, schema}) }`. This is the seam that lets the whole test suite run with fakes: no agent constructed, no key read, no socket opened. `Attempt.model` carries `binding.id`, where the sketch had `model.modelId`.

4. **The fanout merge is a per-slice merge, and the runner no longer does it.** The sketch's `outs.reduce((acc, s) => ({...acc, ...s}), state)` is wrong for any state with more than one field: each sub-step computes a *whole* state from the pre-fanout state, so spreading them in order lets the last sub-step's unchanged copies overwrite every earlier sub-step's work. In the worked example that silently drops three of four classifier verdicts and routes `undecidable` to `accepted` — a trajectory change, not a cosmetic one. Under Mastra each sub-step returns only the keys it changed and the merge re-applies those slices onto `getInitData()`, so no ordering can lose a write. Regression-locked by `exhaustion is detected regardless of which classifier exhausted` and by `a fanout merges each sub-step's own writes, never a whole-state overwrite`.

5. **The example's `State` uses one slot per classifier.** The sketch's `anchors: Record<string, string>` and `exhausted: Kind[]` are *shared* fields that all four classifiers write, and no shallow merge can keep four writes to one key. `State` carries `e2e | expectation | benchmark | dst: { lane?, anchor?, exhausted? }`, so each sub-step writes exactly one top-level key. Consequence for the document's second test: `result.state.expectation` becomes `terminal.state.expectation.lane`.

6. **The journal key keeps the step id and version in plain text.** The sketch hashes `id`, `version`, and the input together into one opaque digest. The prose says "keyed by (step id, step version, input hash)", so the key is literally `<step id>@<version>:<sha256 of input>`. Same three components, same collision resistance on the input, and a reader can tell which step a key belongs to without hashing anything. `journalKey` is exported so a test can assert that two steps never collide on one.

7. **Input canonicalisation is a recursive sort, not a replacer array.** The sketch uses `JSON.stringify(input, Object.keys(input).sort())`. A replacer *array* is a key allowlist applied at every nesting level, so any nested key not also present at the top level is silently dropped from the hash — two different inputs can collide. `canonicalJson` sorts keys recursively instead.

8. **`stepOutput` takes `readonly [string, ...string[]]`.** With the sketch's `[string, ...string[]]`, `z.enum(...).options` (a plain array in zod 4) does not typecheck as an argument. Widening to `readonly` accepts an `as const` tuple and preserves literal inference, so `decision` is still a closed union.

9. **A thrown model call becomes a trail entry.** `runStep` returns exactly the two documented variants, so a provider error must not escape. Worker and validator calls are wrapped; a failure records `{ model, violations: [], error }` and the loop continues to the next attempt. `Attempt` gained `error?: string` and its `output` is now optional, so the trail stays complete when the call produced nothing.

10. **Graph bugs throw, and they throw at compile time.** `compileWorkflow` refuses any graph `graphDefects` rejects — a dangling edge, an unreachable node, a fanout target that is not a step, a malformed loop, a back edge, or no reachable terminal — before a single step runs. The one graph bug that can only be caught at run time is a branch whose `on` returns a key the edge table does not hold, which the branch's entry step throws on before any predicate is evaluated. Guarantee 3 is about *decision* outcomes being data; those are, without exception.

11. **The journal records successes only.** As in the sketch: `validator-exhausted` is not written back, so a replay retries an exhausted step rather than replaying the exhaustion. Stated because it is load-bearing for replay semantics and the sketch does not say it out loud.

12. **`fileJournal` was replaced by `sqliteJournal`.** The scaffold had a JSON-file journal that rewrites the whole file per put. `bun:sqlite` with `INSERT OR REPLACE` was asked for and is strictly better.

13. **The graph is recompiled per `run` and per `resume`.** Compilation is a pure function of the graph and costs about 0.2 ms, so `run` builds the Mastra workflow each time rather than caching it. That is what lets `resume` take a `Workflow<S>` rather than a live handle: it rebuilds the identical workflow and reattaches by `runId`.

14. **Tests beyond the two in the document.** The document shows two tests. This repo ships 503 plus six in a browser, including the compiler's graph-bug rejections, six malformed-loop rejections, the snapshot assertions behind suspend/resume, a cross-process resume over a libSQL file, a `Run.restart()` exercise, the `runStep` unit tests, the `leaf` constructor's ownership of the exhaustion trail, the Claude Code binding against a scripted `query`, the three mechanical checks, the effect executor's optimistic concurrency, the path walker's own arithmetic, the observer seam's view of a refused attempt, the todo target delivered end to end against a real gate, the four graphs projected as a drawing reads them, every server function driven through a suspension and back, and a source scanner that fails the build if `Date.now`, `Math.random`, or `new Date(` appears in the contract, the compiler, or any decision-function file. That scanner was verified by planting a violation in `compile.ts` and watching it fail.

15. **Nested workflow ids carry the path that reached them.** The previous cut named a branch tail `${branchId}=${key}`, which collides once a node is reachable by two different paths and has a branch of its own. DELIVER has exactly that shape: `commit` is reached from `cycle.verdict` and from `human.route`. Ids are now `${parentSegmentId}>${branchId}=${key}`, unique by construction. The top-level id is unchanged (`wf:${wf.start}`), so `resume` still reattaches.

16. **The engine's state carries loop counters as well as the trace.** It was `{ trace }`; it is now `{ trace, loops }`. Both need the same lifetime, which is "survives suspension", and that is what makes a run parked inside a loop body resume into the same iteration with the same count. `readTrace` is unchanged.

17. **`leaf` is new public surface the design document does not name.** It was approved rather than derived. The document's two graphs each hand-wrote the same wrapper around `runStep`, and the fourth thing that wrapper does — record the trail when the validator was never satisfied — is the one a graph author forgets, so it is now the constructor's and cannot be opted out of. See [Four constructors over six node types](#four-constructors-over-six-node-types).

18. **`leaf` has two folds, not one.** The approved spec names one `absorb`, taking the `StepResult`. A node has two results to fold and they arrive at different times: the step's, and the `EffectResult[]` the executor returns for the effects the step asked for, which do not exist yet when the first fold runs. DELIVER's `implement` needs both — its write outcome *is* its routable decision — so the spec carries `absorbEffects` beside `absorb`. A leaf that asks for no effects needs only the first, and the DISTILL classifiers use only the first.

19. **The journal is a `leaf` spec field, not a closure variable.** Both examples pass a journal into their graph builder today and close over it. As a field it sits beside the other three dependencies a leaf has — the `StepDef`, the projection out of state, the fold back in — and nothing reads module-level state, so two graphs in one process cannot disagree about which journal they meant.

20. **The Claude Agent SDK has a native schema option, so the binding uses it.** `options.outputFormat = { type: "json_schema", schema }`; the validated object arrives as `structured_output` on the result message. No prompt-engineered JSON extraction was needed. What the SDK forced is smaller and is documented in [What `claudeCode` does with the SDK](#what-claudecode-does-with-the-sdk): `z.toJSONSchema` is a projection rather than a translation, so the binding re-parses with the step's own zod schema and retries within a small bound; the subagent's own prompt is its system prompt, so the step's `system` leads the user turn instead of being passed as `systemPrompt`; and a `success` result can carry no `structured_output` at all, which the binding treats as a failure because the SDK's own docs say to.

21. **`DeliverModels` gained a per-leaf worker override.** The diagnosis branch routes each cause to the agent that owns it, and "which agent" is a binding, not a graph edge — so the routing is expressed in the model table rather than in the graph. `workers?: Partial<Record<LeafId, ModelBinding>>` falls back to `worker`, so a test that supplies only `worker` stubs every leaf the same way and the enumeration suite is unchanged.

22. **The DISTILL exhaustion trail line changed shape.** It was `{"kind":"benchmark",…}`, written by hand; it is `{"leaf":"benchmark",…}`, written by the constructor, because one line format for both graphs is the point of moving it there. That is the one existing assertion this cut changed.

23. **`EffectResult`'s `rejected.by` gained `contract` and `structural`.** It was `typecheck | tests | schema`, which cannot express the contract-violation category the VCS distinguishes from a verification failure — "you declared one thing and did another" is not the same answer as "your change broke a test", and § 5.4 of `ai-vcs.md` is explicit that the responses differ. It is now `typecheck | tests | schema | contract | structural`, and `structural` is the narrower case of "the edit does not parse". This was the only change to the framework's own core that cut made. `memoryEffects` needed no edit, because it never produced a `rejected` outcome. The `Effect` union did **not** need extending: `replace-symbol` already carries `symbolId`, `expectedVersion` and `body`, and the lease and the intent belong to the executor rather than to the graph.

24. **The no-nondeterminism scanner covers `packages/core/src/vcs/**` and gained `randomUUID`.** The VCS takes its clock and its id generator as constructor arguments so that a lease TTL is a function call rather than a wait; `packages/core/src/vcs/defaults.ts` is the one file allowed to supply the real ones, and it is the one file excluded. A fourth test asserts that the exemption has something behind it, because a defaults file that read no clock would mean the injection seam is decorative.

25. **`Effect`'s `run-tests` gained `extra`, and the floor moved into the VCS.** The design's union has one field, `impacted`, which makes test selection the workflow's in both directions. `extra?: string[]` splits it: the VCS recomputes the floor from the symbols the batch wrote and refuses a union that misses one of its tests. The shape that forced is a signature the design does not name — `WritePath.runTests` takes `extra` and `wrote` beside `symbolIds`, and `ImpactGraph` gained `testsById` so a test id is runnable at all. Three named sets rather than one, because "the floor is computed by the VCS, not trusted from the effect" needs the written symbols to reach the place that computes it, and the design specifies the rule without specifying the call. See [The `run-tests` union](#the-run-tests-union).

26. **The effect's outcome decides whether the suite passed, and the classifier leaf is gone.** The previous cut left this open: `select-tests` carried a selection nothing consumed, because the design does not say whether a leaf's classification or the effect's outcome wins. It is the effect's outcome, and the classifying `run-tests` leaf is deleted rather than left dead — its enum, its requirement rows, its prompt and its tests. A suite's result is what running it produces, and a model asked the same question is a second source of truth for a fact the runner already answered. The routing table and the three arms that are positions rather than mechanics are under [`run-tests` is effect-driven](#run-tests-is-effect-driven). (`run-tests.red` survived this deviation and not the next one: see 46.)

27. **`MAX_CYCLES` is 1, and the documented fallback was not enough.** The README's own advice was that `MAX_GATE_ATTEMPTS` is the cheapest bound to cut. It was applied first and measured at 5615 paths in 254 s, because `select-tests` sits inside `test-loop` inside `cycle` and the gates loop is neither. All three single-bound cuts were measured and the cycle is the one that gave way; the table and the reasoning are in [DELIVER, why it starts at `implement`, and why 347](#deliver-why-it-starts-at-implement-and-why-347). Since `add-test` went away the cycle cannot iterate at any bound, so the bound is now inert rather than tight.

28. **The roadmap's `human` suspend node has a one-member decision enum.** The design names the three answers at `human-review` and routes four things to `human` without naming an answer space for it. One answer is the honest closure: every block reaching it needs work outside a closed enum, and a second answer would be a route the design does not have. Reasoned in full under [One loop, two people](#one-loop-two-people-and-what-revise-costs).

29. **The roadmap's suspend payload is `{ reason, trail }`, not four named fields.** The design's sketch gives `human-review` a `suspendSchema { reason, roadmap, addedEdges, defects }`. The framework's `suspend` node has `reason: (s) => string` and `trail: (s) => unknown[]`, and `compile.ts` parses exactly that. So the other three ride as the trail's first three rows, in that order, plus two more the block path needs. Changing core's suspend contract to carry a caller-shaped payload was not in scope and would have been a larger change than the example warranted.

30. **`validate-slices` is one leaf, not a fanout, and `shapeDefects` gained a sixth defect kind.** The first is a choice the design explicitly delegates, with the reasoning under [The fanout-sizing decision](#the-fanout-sizing-decision-one-leaf-not-eight). The second is `no-steps`: the design lists five checks for `validate-shape`, and the schema deliberately admits an empty `steps` array because that is what `cannot-decompose` returns. An empty roadmap passes all five of the others *vacuously* and would reach `human-review` as a proposal worth approving. nWave's own validator refuses it in the same breath as a missing request.

31. **The roadmap's disjointness measures the declaration once, rather than re-measuring after each repair.** The design says "for every pair with no dependency path between them, intersect; add an edge; if adding edges would create a cycle, `drift-unresolvable`". Read as a re-measuring loop, `drift-unresolvable` is unreachable — the first implementation here was, and the fixture proved it dead. Measuring the declaration once and applying the edges in order makes it reachable and keeps the finding the author's rather than the tool's.

32. **`RoadmapModels` carries a `decomposeWith` slot beside `worker`.** The design says `decompose`'s worker is "a frontier-class binding (injected)". `DeliverModels` solves the same problem with `workers?: Partial<Record<LeafId, ModelBinding>>` because DELIVER routes three leaves to three different agents; the roadmap workflow has one such leaf, so it has one named slot falling back to `worker` rather than a per-leaf map with one live key.


33. **`EffectResult`'s `rejected` gained `detail?: { failed?: string[] }`.** The still-red-versus-broke-other split is a set membership against the step's own acceptance tests, so the failing ids have to reach the branch; the design's union carries only `by`. `StageOutcome`'s failed variant gained `failed?` for the same reason one layer down, and the tests stage populates it from the JUnit report's own failing cases. A stage that cannot name which test failed leaves it absent, and the graph reads the absence honestly rather than guessing — which is why the no-ids case is `broke-other` rather than `still-red`.

34. **The write path's tests stage excludes any test the write is itself rewriting.** Not a design change so much as a design *omission*: running the very test you just rewrote to decide whether you were allowed to rewrite it makes an acceptance test unwritable, since its first honest run fails by design. Every other test that reaches the file still runs, so `ai-vcs.md` § 6.1's actual question ("did you break something else") is still answered, and a production symbol's write is unaffected because its id is not a test id. Widened twice since: to the batch (44) and to known-red targets (49).

35. **The tree-sitter layer sees `test.skip("x")` as the same symbol as `test("x")`.** A modifier — `skip`, `todo`, `only`, `failing` — on a `test` or `it` call is recognised, and it does not change the identity key, because identity is `(kind, container, name)` and a modifier is none of those. `ai-vcs.md` § 4.1 lists what a test symbol is without addressing modifiers. Nothing depends on this any more — pending markers were the previous cut's model of DISTILL and are gone — but the parser is more correct with it than without, so it stays.

36. **`StepUnderDelivery` carries the roadmap step's own facts.** `acceptance`, `predictedTouches`, `authority` and `oracle`, so a leaf reads what the step declares rather than a projection of it. `State` carries `acceptanceTests` — the test ids the step's oracle names, resolved ONCE where the step becomes a run. Resolving them inside the graph would read an inventory that has moved since the oracle was measured.

37. **`run-tests` is a step, not a leaf.** It had a model behind it in an earlier cut. It does not need one: reading whether a suite passed is reading an effect's typed result. `TEST_OUTCOMES` is deleted with its rows. This is the design's "what decomposes and what stays wide" applied one notch further than the document takes it, and the document now says so.

38. **The harness gained a second axis, `scriptedExecutor(choose, space)`.** The design's harness is "stub journal, path enumeration, trace matchers" — the first of which is a scripted BINDING here, per deviation 84 — and the walk enumerated leaf decisions only — which covered half of DELIVER's edge tables, because the other half route an `EffectResult`. An `EffectOutcomeSpace` names, per effect type, the outcomes to try, and the executor forks the path per outcome. An effect type the space does **not** declare is refused rather than answered `committed`: a silent commit makes the coverage claim a fiction for the edges the other outcomes route to, and nothing would say so. It is one outcome per effect rather than per batch, so a graph whose batch is atomic (the roadmap's `persist`, where a partial write is not a smaller success) keeps its own executor.

39. **The scheduler's `runOne` consumes the framework's own `RunOutcome<S>`, and a throw is not absorbed.** The design says `runOne(step) → Promise<RunOutcome>` without saying whose. Using the framework's own means the scheduler maps `accepted | rejected | suspended` off it and hands the whole outcome (`runId` included) to `record`, so a consumer persists what it needs without a second vocabulary. A `runOne` that *throws* propagates: everything a graph decides is data, so a throw means the graph itself is malformed and swallowing it into a status would hide that. `resumeOne` is injected beside it, symmetrically, because `resume` needs the graph the step was run with.

40. **The scheduler holds a parked step's `runId` in memory, and `StepStatus` has no `running`.** State is a projection, so nothing about an *unfinished* run is persisted, and `pending` therefore covers both "never run" and "in flight" — which is the honest reading, since the two are indistinguishable to a reader and the right thing to do with an unfinished run is to run it. The scheduler knows its own in-flight set and does not start one twice; a second scheduler over the same steps would, which is why `record` is the consumer's place to refuse that (the pipeline does, by id collision on `step_runs`).

41. **`runStep` gained an optional observer, and so did `leaf`.** New surface the design does not name, forced by the run report. The journal records what a step DECIDED and the exhaustion trail exists only when the validator was never satisfied; neither records what a *successful* step cost — how many attempts it took, which mechanical check refused the first one, what the validator said about the second. Those facts exist only inside `runStep`'s loop, and a report claiming a first-attempt acceptance rate needs them. So `runStep(def, raw, journal, observe?)` and `leaf({ …, observe? })` take a `StepObserver`, which is handed one `StepAttempt` per attempt and is **never read back**: nothing in the framework branches on an observation and removing the sink changes no trajectory. A journal hit emits nothing, because no model was called. The three graph builders thread it through as an optional last argument. What each call cost rides on the same seam — see deviation 83.

42. **`mastraAgent` gained `onUsage`, and the shape it hands over is unshaped.** Token counts come from the provider layer and there is more than one shape of them in this dependency graph: `@mastra/core`'s own `TokenUsage` is flat (`promptTokens` / `completionTokens`) and the AI SDK's `LanguageModelUsage` nests (`inputTokens.total`). A binding that picked one would report zero against the other and say nothing about it, so the binding hands over whatever the provider reported, verbatim, and the consumer's `readTokens` reads all three known shapes — yielding an EMPTY object rather than a zero for anything else, because "the provider did not say" and "the call cost nothing" are different claims.

43. **The DELIVER composition carried a per-step observer factory, an `onRun` hook and `resumeParked`.** The observer was `(stepId) => StepObserver` rather than one observer, because a record's most useful field is which roadmap step it belongs to and the journal key does not carry it — the step id is inside the hashed input. `onRun` existed because the `step_runs` row records the outcome and the run id but the TRACE only exists on the outcome. `resumeParked` read the parked run id off the step's own `step_runs` row instead of out of the scheduler's memory, which was deviation 40's limitation answered where the projection already lives. All three went with `openPipeline` in deviation 76: the server holds the run, so it holds the observer seam, the trace and the id a resume needs.

44. **The tests stage excludes every test the BATCH is rewriting, not just the write in hand.** Deviation 34 established the exclusion and scoped it per write. The todo target broke it: a value with TWO acceptance tests writes both as two writes under one lease, and the per-write filter leaves the first in the second's impacted set — where it fails, by design, because the production code it asserts is still a stub. The lease is what names the batch, so the lease is what the filter is over. A defect found by pointing the framework at a real project, which is what the target is for.

45. **`bun test` names its roots rather than scanning the tree.** `bun test ./packages ./examples ./targets/todo/.des`. A target's own project files and the run copies under `runs/` — including the oracles DISTILL writes into them — would otherwise be collected by a bare `bun test` at the root. The root `tsconfig.json` excludes the same two, because the target has its own and the copies are typechecked by the write path's own `tsc` stage, inside the run.

46. **`run-tests.red`, `oracle` and `activate-at` are deleted, and RED moved a layer out.** The previous cut had DELIVER locate a pre-authored acceptance test behind a `test.skip(` marker, strip the marker, and classify the first run. All three were built on a model of DISTILL that the shipped nwave runner does not have: nothing there pre-authors a body behind a marker, and `des oracle` is a separate step that WRITES the test and has software measure it. So the step cycle starts at `implement`, and "no edge bypasses RED" is a readiness precondition — `oracleIsRed` on the `oracle_runs` projection, `eligible` on the scheduler — which is stronger than an edge rather than weaker, because an edge can be reached with a fabricated observation and a step that is not ready has no run at all.

47. **`Effect` gained `write-file` and `measure-oracle`.** The first because every other write resolves a symbol id, so a file that does not exist is unreachable from all of them — and an author's whole job is to write a test that is not there yet. Its concurrency model is a lease PATH SCOPE rather than a version, its structural stage asks only that no identity the file already held vanished, and its tests stage is absent rather than stubbed: an oracle's first honest run fails, so a stage that ran the suite would refuse every oracle for being what an oracle is. The second because measuring one oracle is a different question from running a suite, with a different desired answer.

48. **`OracleMeasurement` rides on `EffectResult` as an optional `measured`, not as a fifth outcome.** The outcome union is what every other graph's edge tables are total over, and a fifth member would give each of them a dead edge. All four verdicts come off one field, so a pure branch stays a pure branch; `measurementOf` does the union narrowing once, because `conflict` is the one outcome that can never carry one. The mapping is the only place in `vcsExecutor` that is not the identity function: `green` is `committed` and the other three are `rejected { by: "tests" }`.

49. **`knownRed` on `replaceSymbolBody` and `runTests`.** Deviation 34's rule one step wider: a test whose failure this write did not cause must not refuse it. Once oracles are live files rather than pending markers, every undelivered value has a live red oracle in the modules it shares, and the gate was refusing a sibling's correct write for it — found on the first end-to-end run of the todo target, where `complete`'s write was refused by `remove`'s red oracle. Only the caller can know which tests those are, so it says; and for `runTests` the set comes off the floor as well as the run, because excluding it from one and not the other would make the caller refuse itself for omitting a test it was told to leave out.

50. **`protected` on `vcsExecutor`.** `_crafter_owns` as an executor rule rather than a graph edge. A write landing under a declared scope is `rejected { by: "contract" }` before a lease is asked for, which is what makes it hold for every write the graph could emit — including one a model proposed and the graph merely passed along. `ai-vcs.md` has no such thing: § 9.4's authorization is what it would have belonged to, and that is not built.

51. **`SchedulerSpec` gained `eligible`.** "Is everything this step waits on done" and "may this step start at all" are different questions, and `statusOf` cannot carry the second because a step that has not run is `pending` whether or not it may. Read once per refresh beside `statusOf`, so `ready` stays synchronous. An ineligible step blocks its dependents exactly the way a rejected one does.

52. **`claudeCode` gained `proposal`, and the effects land on `payload.proposal`.** The agent still edits, because a tool set is what makes it an agent; it edits a SCRATCH COPY, and the diff afterwards is what becomes effects. A `replace-symbol` needs a symbol id, which is the VCS's to assign, so the binding takes a `symbolFor` port and falls back to `write-file` rather than importing the VCS to guess one. `stepOutput` fixes the output shape at `{ decision, payload }`, which makes `payload.proposal` the one unambiguous place for the result; the step declares it optional, which is also what keeps the JSON Schema handed to the SDK satisfiable by an agent that never produces it.

53. **`AcceptanceObligation` is `{ id, stimulus, expected }`, and the locator moved to the step.** It was `{ id, text, oracleLocator? }`. The shipped `distill_document.py` has the three fields, and the split is load-bearing: an oracle author handed one sentence of prose has to invent both a stimulus and an expected result before it can write an assertion. The locator moved onto `RoadmapStep` as `oracle` because there is exactly ONE per value — the thing that measures a value has to be a thing software can run and read a verdict off, and two would make "the oracle was red" ambiguous — with `supports` beside it.

54. **`validate-shape` dropped `no-acceptance` and gained `observation-too-short`.** What a value must be observed to do is DISTILL's act; a shape check demanding obligations at ROADMAP time would refuse every roadmap for not having done a later wave's job. What ROADMAP can still ask is whether the observation says enough to be worked from, with nwave's own `MINIMUM_OBSERVATION_CHARACTERS` of 40 — measured rather than chosen, from the shortest real accepted-turn diagnostic in the shipped runner. The boundary is enforced twice: `acceptanceIsDistills` is a mechanical check on `decompose`'s own output.

55. **The test path scope is read off one declared line in `design.md`.** Three consumers need it — the author writes there, the executor walls the oracle there, the manifest validator refuses a support outside it — so it is one line and not three constants. `testPathScope` refuses by name when it is absent rather than defaulting to `test/`, because a default would work silently for every project whose substrate lives there and mis-scope every project whose does not.

56. **`support-ignored` is answered by an injected predicate, not by the VCS.** `git check-ignore` is the only thing that can say whether a repository ignores a path, and the VCS has no opinion: its registry tracks what it was told to track. A repository with no git in it answers `false`, because an unanswered ignore question is not a defect and refusing every support in a checkout without git would be inventing one.

57. **`Commands` is new public surface, and it is the framework core's.** The design document's effect union has no `run-command` and no notion of a declared command; every process was hardcoded to bun, and `measure-oracle` carried an `argv` override as the escape hatch. `packages/core/src/core/commands.ts` replaces that with a contract: `CommandArgs`, `Command`, `Commands`, `normalizeCommand`, and the one `runCommand` behind every process the framework runs. `measure-oracle`'s `argv` is **deleted** rather than kept beside it, because two ways to name the runner is one more than "there is one declaration" allows. See [Declared commands](#declared-commands).

58. **The VCS module now imports `core/commands.ts` as well as the two effect types.** The stated boundary was "`executor.ts` imports `Effect` and `EffectResult` and nothing else from the framework". The verifier is constructed with `Commands` and emits `run-command` effects through an injected executor, which is what makes "typecheck, lint, tests and the oracle are compositions of one effect" structurally true rather than a claim; that needs three types and one function across the seam. The direction is unchanged: `core` still imports nothing from `vcs`.

59. **`commandOf`, `commandOutput`, `commandEffect` and `executeCommand` sit beside `measurementOf` in `packages/core/src/core/effects.ts`.** None is named by the design. `commandOf` is the narrowing `measurementOf` already established, one field over; `commandEffect` is the one place a normalised command becomes an effect, so a stage never has to remember which fields are optional; `executeCommand` is shared by both executors, because a command means the same thing to both and duplicating a spawn across the core/VCS boundary is the drift this repo spends its comments avoiding.

60. **The `policy` stage is deleted, not renamed.** It was a stub that returned "passed", justified by neither of `ai-vcs.md` § 6.1's policy mechanisms being built. `lint` is not that stage with a new name: it takes the paths a write touched, runs a command a consumer declared, and rejects with `by: "lint"`. `RejectedBy` gained `lint` for it and `command` for an exit nothing has interpreted yet. `STAGE_NAMES` is `structural | typecheck | lint | tests`.

61. **The tests stage can now answer `advisory`.** § 6.4's "the check could not decide" outcome existed in the type and nothing produced it. A test command that exits non-zero while its own JUnit report records neither a failure nor an error is exactly that world: it is recorded, it downgrades the write's verification status, and it does not block. Answering `failed` there would refuse a write on no evidence.

62. **A selector naming no test moved from `broken` to `indeterminate`.** Under bun's stdout summary it printed nothing, so the verdict was `broken` on the `no-summary` axis. Under bun's JUnit report it says two tests existed and both were skipped, and exits non-zero anyway — which is the definition of `indeterminate`, and is now what it is called. The rule did not change; the input got better. See [The JUnit rule](#the-junit-rule).

63. **`gates` is a step, and `add-test` is deleted.** The design's diagram has a `gates` leaf classifying a lint run and a `mutation-below-gate` arm reaching an `add-test` leaf. A gate run's verdict is its exit status, so `gates` is a step; and no command produces a mutation verdict yet, so that arm has no producer, `add-test` becomes unreachable, and `graphDefects` refuses an unreachable node by name. `HUMAN_REASONS` lost `out-of-scope-structural` and `cycle-exhausted` with them. The consequence worth stating plainly: **the outer cycle can no longer iterate**, because `add-test` was the only thing inside it that could invalidate a green verdict. The loop node stays, and a declared mutation command is what brings the second pass back. See [`gates` is effect-driven too](#gates-is-effect-driven-too).

64. **`State.paths` and a fourth argument to `seed`.** The gate lints the files the step writes, and a `predictedTouches` entry is an opaque SYMBOL id. Only the registry can map one to a path, so `pipeline.ts` resolves them once where the step becomes a run — the same boundary the impact floor and the acceptance-test ids already sit on — and the graph carries the result. `writtenPaths` is exported for the same reason `oracleTests` is.

65. **`openRunDir` is async, and `openVcs` takes `commands`.** The run directory loads the composition's `commands.ts` from `.des/`, which is a dynamic import, which is a promise. `openVcs` refuses by name when neither `commands` nor a `verifier` is supplied, because a default set of commands would run bun and biome against a project that is neither and call the result a verdict.

66. **The repo's `tsconfig.json` gained an `include`.** It excluded `targets` wholesale. `targets/*/.des` is the part of a target that is the composition's — including the `commands.ts` that declares conformance to a framework type — so it is typechecked here; everything else in a target is that target's own project, checked by the target's own declared typecheck command inside a run.

67. **The repository is a bun workspace, and the framework is `@des/core`.** `src/` became `packages/core/src`, with `@des/server` and `@des/ui` beside it. Consumers import subpaths — `@des/core/workflow` — resolved through the package's own `exports` map rather than a `paths` alias, because `moduleResolution: "bundler"` reads exports and bun resolves the same way at run time: one resolution story rather than two, and no relative path into a package. The map points at the TypeScript sources; bun runs `.ts` directly, so there is no build step and no compiled copy between a stack trace and its source. `targets/todo` is deliberately not a member: it is a template a run COPIES, and a workspace member is a thing bun links.

68. **`run` and `resume` take an optional watcher, and it reports AUTHORED node ids.** `trace` is only readable once a run has stopped, and a person watching one wants to see where it is. A run with no watcher takes the path it always took, through the same `start` call; a watched one goes through the engine's streaming entry point, which resolves the identical `WorkflowResult` — `success`, `suspended` and `failed` all arrive through `.result` rather than as a rejection. The two stay separate because an event stream nobody reads is a queue that fills. The projection back onto authored ids lives in `compile.ts` because that is the file that minted the compiled ones: a nested workflow's prefix is stripped, a loop's `#iteration` is the loop entering and its `#exit` is the loop leaving, and everything else the compiler minted is dropped.

69. **A `step` node gained an optional `leaf`, set by the `leaf` constructor.** The compiler does not read it — a leaf IS a step, and telling them apart would buy the compiler nothing. What reads it is whatever has to say which nodes are model calls: a drawing of the graph, a report over what each leaf decided. It carries the `StepDef` id, which is the same id `StepAttempt.stepId` carries, so the two join. The alternative was a hand-maintained list beside the graph, which drifts.

70. **The server's run id is its own, and the engine's is recorded beside it.** `run` mints a run id and hands it back when the run stops, so a call that must answer with an id before the run has done anything has nothing to answer with. The surface's id is the server's; the engine's is on the record as `engineRunId`, is what a resume reattaches to, and is the `runId` a consumer's `record` sees — because `RunOutcome` is the framework's type and the engine's id is the one the snapshot is under. The two join in one hop, in either direction.

71. **A registration's `graph` is a factory and its `executor` sees the input.** The obvious shapes — a `Workflow<S>` value and an `executor(runId)` — cannot do their jobs: a graph handed over has its observer already closed over, so the server cannot see what its leaves decided, and an executor that cannot see what the run is ABOUT cannot wall off that step's oracle or excuse the red tests it did not cause.

72. **A pipeline's steps are announced as they move, and its refusal is held.** The server starts each step's run, so it knows when one starts and when it settles and publishes `pipeline-step` at both — no polling, which the previous cut needed because the pipeline ran itself and nothing here saw it. A refusal that stops a drive early lands on the pipeline's tree as `error`, because the drive is asynchronous and whatever started it answered long ago.

73. **A suspend node's REASON is not projected, and its answer space is.** `reason` is `(s: S) => string`, a function of state, so the closed set it draws from lives in the consumer's own enum and not in the node; `resumeSchema` is a value, so the answers are readable. The half a person has to choose from is the half that travels, and the reason arrives with the suspension itself.

74. **The credential is refused at the leaf, not at the door.** The six `todo:*` commands checked for a key and exited. A server cannot: the graphs, the projections, the rows and the event stream are all readable without one. So the binding throws by name when it is asked to generate, `runStep` records it as a trail entry the way it records any provider error, and the graph routes the exhausted leaf where it routes one — which for the roadmap graph is a park at `human` under `validator-exhausted`, with the message on both attempts and in the trail.

75. **The run report kept its writer and lost its table.** `summarize` and `renderTable` had one reader, `todo:report`, and that command went with the other five. The lines are still written per run directory, one per model call; the same facts are on each run in the UI. A renderer nothing renders is dead code, and the deletion took its tests with it.

76. **A pipeline registration owns no execution.** It was `{ steps, status, run, resume }`, where `run` called `@des/core`'s `run` itself — so a step's run had no server id, published no events, had no trace anybody could read, and parked where no dialog could reach it. It is `{ steps, readiness?, record?, concurrency?, resourcesFor? }` now: steps name a registered workflow and the input one run of it takes, and the SERVER schedules them through the same `openScheduler` and the same `runner.start` a person's button uses. `readiness` is the precondition the frontier rule cannot express; `record` is the consumer's one write. The consequence is the point: a step's run is an ordinary run.

77. **A step's status is read off its run, not off the consumer's rows.** `statusOf` was the consumer's projection over `step_runs`; it is now the server's reading of the run it started for that step, because a registration that owns no execution cannot be asked what happened. What that costs is honest and worth saying: a restarted server no longer sees the steps a previous process delivered, so it would run them again. The durable `step_runs` and `oracle_runs` rows are still appended and are still what "did it ever fail" is answered from — they stopped being what "is it done" is answered from.

78. **A `seed` that refuses lands on the run, not on the call.** DELIVER's seed refuses a step with no red oracle by name, and it used to throw out of a command. `seed` now runs inside the driver, so the refusal is recorded as a `failed` run carrying the message — which is where a person reads it, and which keeps starting a run from blocking on whatever the seed does. The todo target's DELIVER seed runs the project's whole suite; a start that waited for it would be a start that waited for `bun test`.

79. **`unknown` is not a serializable type, and the boundary says so.** TanStack Start validates a server function's return type against a serializable bound, and a type containing `unknown` degrades every call site to `unknown` rather than erroring where the problem is. Every value affected was JSON in fact — a JSON Schema, a form's input, an artifact row body that is JSON text in the store it came from, a trail on its way to a person — so `@des/server` has a `Json` type and one named widening, `asJson`, at each boundary that knows. Nothing in `@des/core` changed.

80. **`@des/server` depends on `@des/ui`, and the module graph is still acyclic.** `serve()` mounts the built application, which is a `@des/ui` artifact; `@des/ui`'s server functions read `@des/server`'s registry. The package graph is therefore a cycle, which a bun workspace links without complaint. The MODULE graph is not: `@des/ui/handler` imports nothing from `@des/server`, and `serve` reaches it by dynamic import at run time. The registry is kept on a well-known symbol besides, so two copies of that module — one imported by the process, one inlined by a bundler — would still read one registry. Two defences, because that failure would be silent.

81. **`bun run ui:dev` is gone, and browser tests replaced it.** The UI's data comes from a registry only `serve()` supplies, and a Vite dev server has none — the page would render "no registry is set". The build is about 1.5 s, so the loop is `bun run ui:build` then `bun run todo`; and what the dev server was really for, seeing whether the thing works, is now six Playwright tests that say so without a person looking.

82. **A run is rows, and the registry is a projection of them.** Runs, traces, attempts, the step-to-run mapping and the event stream were maps, and deviation 77 said what that cost: a restarted server saw no steps delivered and would run them again. Three tables in `packages/server/src/store.ts` — `runs`, updated as a status changes; `run_events` and `leaf_attempts`, append-only — make the whole of it durable, and `getRun`, `listRuns`, the pipeline tree and `statusOf` read them. The trace is DERIVED from a run's own `node-entered` events rather than stored beside them; the step a run belongs to is read off the `pipeline-step` events. Deviation 77's cost is therefore paid off rather than restated: `step_runs` and `oracle_runs` answer "did it ever fail" as they always did, and "is it done" is answered by the run's own row.

83. **`ModelBinding.generate` takes a `step`, and a per-call `onUsage`.** A binding is shared across steps — one worker binding answers every leaf a consumer points at it — so `generate({ system, prompt, schema })` could not say which step it was answering for, which a scripted binding needs in order to refuse an unscripted one by name. And token attribution was order-based, which holds only while one leaf is in flight; `runStep` now hands each call its own sink and already knows which attempt made it, so `StepAttempt` carries `workerTokens` and `validatorTokens` and the `concurrent: true` caveat is gone with the flag. `MastraAgentOptions.onUsage` went with it, and `readTokens` moved into `@des/core/step` because the attribution happens there now.

84. **`stubJournal` became `noReplayJournal`, and stubbing moved to the binding.** The stub journal seeded `StepResult`s per step id, which short-circuits `runStep` before any model is reached: a test using one exercised neither the output schema, nor the mechanical checks, nor the validator, and the composition under test had to grow an `evidence` hook so a test could compute the journal key `runStep` would compute. `scriptedBinding` replaced the seeding. What survived is the half that was never about it — a journal that answers nothing and keeps nothing — because `enumeratePaths` re-runs a workflow once per path and a leaf inside a bounded loop is a choice point that replay would delete. New surface beyond what was asked for, and named here for that reason.

85. **`scriptedBinding` takes a function as well as a table, and the function sees the prompt.** A table keyed by step id cannot express the two things this repo's tests need: which answer a leaf gives when that is the choice being enumerated, and which subject a call is about when one graph is driven over several steps. Both are functions of the call, and the second is on the PROMPT — `Step 01-01`, `Value 01-02` — which is exactly where the model it stands in for would read it. The function is consulted once per INVOCATION, on attempt 1, so a leaf a mechanical check refused and re-drove is one choice point rather than two.

86. **`targets/todo/.des/request.ts` folded into `registrations.ts`, and `openRunDir`'s `track` option went.** The first was a one-constant module and the second had no caller. A composition is what production needs and nothing else; both are checked by looking at the directory, which is now `main.ts`, `models.ts`, `registrations.ts`, `run-dir.ts` and `todo.test.ts`.

87. **Two enumerated path counts moved, and the move is the finding.** Running the mechanical checks — which stubbing at the binding does and seeding the journal did not — showed that a leaf carrying the same rules as its gate refuses most bad proposals before the gate ever sees them. The obligations walk fell from 55 paths to 28; the roadmap walk moved from 169 to 176, having gained a fifth proposal (`UNSHAPED`) carrying only the two defects the leaf cannot see, without which the gate's `invalid` edge is unreachable. `examples/nwave/deliver/pipeline.test.ts` gave up a matching pretence: its roadmap fixture pre-filled `acceptance` and `oracle`, which `roadmap.acceptance-facts-are-distills` refuses, so a decomposer could never have returned it.

88. **The edge labels are dagre's to place, over a multigraph.** The layout graph was simple, so two edges between one pair became one; and a label went at its edge's midpoint, which for edges sharing an endpoint is the same coordinate. Both were visible in the committed screenshots as `exhausted`, `cannot-decompose` and `invalid` painted on top of one another. `labelSize` estimates the label box rather than measuring it, because this module has no DOM — it rounds up, since too wide costs a little space and too narrow costs a collision.

89. **`mastraAgent` gained an injected `agent` factory, and the credential guard moved into the binding.** The binding constructed its `Agent` itself, so a test of it could not avoid constructing a real one — the same gap `claudeCode`'s injected `query` closed, and closed the same way: `agent?: AgentFactory` defaults to a real Mastra `Agent`, and `mastra.test.ts` supplies a factory that keeps the config it was handed and answers from a fixture. The guard moved because the rule it now applies is about the MODEL CONFIG — an endpoint carrying its own `apiKey` needs nothing — and the model config is the binding's. `targets/todo/.des/models.ts` lost its `credentialed` wrapper and the hardcoded `ANTHROPIC_API_KEY` with it; deviation 74's account of where a credential is refused is unchanged, and now literally true of the binding.

Source is ~31,330 lines: ~18,660 of implementation and ~12,670 of tests. The VCS module is ~7,410 of that; DELIVER is ~3,570; DISTILL is ~3,065; the server is ~3,470, split ~2,535 implementation and ~935 tests; the UI is ~2,700, of which ~700 are the browser tests and their fixture; the roadmap example is ~2,520; the todo composition is ~1,515, split ~840 and ~675; the artifact store is ~415.

## Not built yet

- **Emitting a Mastra dynamic-workflow JSON definition from a `Workflow<S>`.** Mastra's dynamic workflows (beta) are the design's "graph topology as data" already built: a JSON graph over registered agents, tools, and nested workflows, validated and persisted by `addDynamicWorkflow()`. The compiler currently emits live `createStep` closures; emitting the JSON definition instead is what would let the authoring workflow write a graph without writing source.
- **A real-model run.** The server exists, every graph is registered, a browser has driven all of it, and a leaf refuses by name without a key. None has been run against a model. See [The real run](#the-real-run).
- **A declared MUTATION command.** The design's quality gate is clippy plus a mutation kill rate. Lint is a declared command now; mutation is not, so `commands` has four keys and not five, the `gates` step emits one effect rather than two, and there is no `mutation-below-gate` verdict and no `add-test` leaf for one to reach. The consequence is that the outer cycle cannot iterate — see deviation 63. Adding the key is additive: a fifth `CommandArgs` member, a second effect from the same node, and a fourth gate verdict.

- **A declared command per LANGUAGE, or per part of a project.** `Commands` is one set per target. A repository whose frontend and backend are checked by different tools has to say so inside one `lint` function, by branching on the paths it is handed. That works and it is not modelled; what is missing is a way to declare more than one toolchain and have the framework pick.

- **`resources` reaching the write path.** The scheduler leases what a step's commands declare, before the step runs. A `run-command` emitted from inside the write path — the typecheck, lint and tests stages — carries its `resources` on the effect and nothing reads it there, because the write path takes no scheduler lease. Today the only resource that matters is one a whole step needs, so the gap is stated rather than closed.

- **A second oracle measurement.** `measure-oracle` runs the oracle once and reads one verdict, so a flaky oracle — red on its first run, green on its second — is indistinguishable from a stable one and the first answer is recorded as the fact. Running it twice would detect it and would double the cost of the one observation that is a fixed floor; nothing has measured how often it matters.
- **A resume path for a parked ORACLE run.** Its block node takes one answer, `abandon`, and the composition does not offer it: a parked oracle run is read from the trail and the roadmap or the design is changed instead. The projection therefore reads every non-red run as `suspended`, which is exact — every block in that graph *is* a suspension, and the only route to its `reject` terminal is a person answering.
- **A support that is itself a value.** The manifest admits whole-file supports and refuses a support that names the oracle, but nothing stops two values declaring the same support file, and nothing sequences who writes it first. In a roadmap where that happened the second author's write would land on the first's bytes and the `wholeFileStage` identity check would be the only thing standing between them.
- **Derived `step_edges`.** The scheduler reads the `dependencies` the roadmap step declares, and the roadmap workflow's disjointness measurement is what adds the ones the author missed. The design's stronger version derives the DAG from symbol overlap *instead of* hand-authored edges, which would remove the highest-error part of roadmap authoring from the model. The measurement exists; the replacement does not.
- **the VCS module's own remaining items**, in full in [`packages/core/src/vcs/README.md`](./packages/core/src/vcs/README.md#not-built-yet). The ones that matter to the framework: the **ast-grep pattern layer** (the lint stage is a declared command, and what is missing is a pattern layer inside the VCS); the **LSP layer**, so there is no cross-file reference resolution and the declared typecheck command runs over the whole project; **coverage-refined impact**, so the test-impact graph is the static import graph alone; **per-case impact**, so the tests stage runs one declared command per impacted test rather than one command covering several; the **asynchronous verification tier**, so a slow test blocks a write rather than committing it `pending`; **wait-die** and **queued acquires**, so an acquire is fail-fast and hold-and-request has no fallback; **lease-level rollback**, so a lease whose second write fails leaves the first committed; **git export**; **cross-repository coordination**; and **authorization**, because a session is a string and any session may lease anything.
- **The symbol-set-difference check.** `deliver.implement-to-the-design` carries no mechanical check, only a model refuting against the rule text. The symbol inventory that would make it a set difference over exported symbols now exists in `packages/core/src/vcs/structural`; the check that consumes it does not.
- **The authoring workflow that writes GRAPH rows.** Bootstrap step 4: requirements in, graph rows out, diffed against the hand-written graph. Nothing generates a graph; all four here are hand-written, which is what makes them the oracle. The roadmap-authoring workflow is a different thing that the design's table lists on the same line: it writes *roadmap* rows, not graph rows, and it is built.
- **Graph topology as data.** Nodes and edges are TypeScript, not rows. Exhaustiveness is the compiler's red squiggle, not a constraint query. The design takes the middle path; this prototype takes the typed end of it.
- **`symbol-diff.ts`.** The fourth mechanical check in the design's `checks/` listing. Its input, the symbol inventory, is now built; the check is not. See the symbol-set-difference item above.
- **Escalation cost accounting.** `escalateTo` fires once after the attempt budget, as specified, but nothing measures cost per completed task — the open question the design says should be answered before the legibility argument is used to justify the approach.
