# deterministic-workflows

A prototype of the framework described in [`DETERMINISTIC-WORKFLOWS.md`](./DETERMINISTIC-WORKFLOWS.md): a finite graph owns control flow, small models own one decision each, and the whole path space is enumerable before anything runs.

The property the rest of the design rests on is testable in this repo right now, on three graphs: **162 paths through the DISTILL classification graph, 447 through the DELIVER step cycle, and 169 through the roadmap authoring workflow, zero model calls, no API key, no network.** The whole suite — 247 tests, including all 778 of those walked paths through the real Mastra engine — takes **about 5 s**.

DELIVER and the roadmap workflow are the two with cycles in them. Their path spaces are three figures rather than infinite because every repetition in them is a `loop` node with a required bound.

The second half of the repo is the [VCS module](#vcs-module): `replace-symbol` and `run-tests` now execute for real, under a lease, through a verification gate, into an append-only event log. `run-tests` is a **union**: the VCS owns the impact floor and the workflow owns selection above it, so a leaf may add a test and can never subtract one.

## Install, test, run

```bash
bun install
bun test          # 247 tests, no network, no key, no model, ~5 s
bun run typecheck # tsc --noEmit
bun run check     # both
```

The two smoke scripts are the only things that talk to a model. Neither is invoked by the test suite and both refuse to run without a key:

```bash
ANTHROPIC_API_KEY=... bun run smoke

# Optional: a different model family for the validator, which refutes more
# independently than Haiku refuting Haiku.
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun run smoke

# DELIVER, where three leaves are Claude Code subagents rather than one model
# call each. They run against DW_WORKSPACE, defaulting to the cwd.
ANTHROPIC_API_KEY=... DW_WORKSPACE=/path/to/repo bun run smoke:deliver
```

`smoke` pushes one scenario through four real classifiers and prints each lane verdict, the merge verdict, the terminal or the suspension, and the trace. `smoke:deliver` pushes one roadmap step through the step cycle, with the three diagnosis leaves bound to subagents — see [Bindings](#bindings).

## Map to the design document

| Path | Implements |
|---|---|
| `src/core/requirement.ts` | § Primitives → Requirement. The rule as a row: verbatim text, FK to its source, closed decision space, optional mechanical check. |
| `src/core/step.ts` | § Step: a worker paired with a validator, always. `stepOutput`, `StepDef`, `Attempt`, `StepResult`, `journalKey`, `runStep` and its six guardrails. |
| `src/core/workflow.ts` | § Workflow graph and runner. The contract: `NodeId`, `Terminal`, `Node`, `Workflow`, `branch`, `suspend`, `run`, `resume`. |
| `src/core/compile.ts` | § Workflow graph and runner. The compiler from the node map to a Mastra workflow. |
| `src/core/effects.ts` | § Effects with typed results. The `Effect` / `EffectResult` unions plus an in-memory executor with optimistic concurrency. |
| `src/core/journal.ts` | § Journal. The interface, an in-memory implementation, and a persistent one on `bun:sqlite`. |
| `src/bindings/` | § Framework versus consumer → "model bindings: which small models, which validator family". `mastra.ts` is one model call; `claude-code.ts` is a Claude Code subagent. |
| `src/checks/` | § Framework versus consumer → "a library of mechanical checks": `verbatim.ts`, `enum-member.ts`, `id-in-set.ts`. |
| `src/harness/` | § Framework versus consumer → "test harness": `stub-journal.ts`, `enumerate-paths.ts` (the graph inspector plus the reachable-path walker), `matchers.ts`. |
| `src/examples/nwave/distill/` | § Worked example: DISTILL test-lane classification. Bootstrap steps 2 and 3 — the known-good hand-written graph and its requirement rows. |
| `src/examples/nwave/deliver/` | § DELIVER is two graphs → The step cycle as a graph. Bootstrap step 6 — the fixed step cycle, as three nested bounded loops. |
| `src/examples/nwave/roadmap/` | § DELIVER is two graphs → the roadmap half, and § Framework versus consumer → the authoring workflow. Bootstrap step 7's first half — the roadmap as rows, with two pure decision functions and no generator. |
| `src/vcs/` | § The agent-native VCS is the effect executor and mechanical verifier, and the whole of [`ai-vcs.md`](./ai-vcs.md) phases 2 to 4. See [`src/vcs/README.md`](./src/vcs/README.md). |

The model bindings live under `src/bindings/` and nothing in `core/` imports them: the design's framework/consumer table puts "which small models, which validator family" on the consumer side, and the smoke scripts are where a consumer picks.

## Substrate: Mastra Workflows, all the way down

**Decision: the graph runner is Mastra. `run` compiles the node map to a Mastra workflow and drives it through `createRun()`.**

This reverses an earlier decision in this repo to hand-write the runner and use Mastra for leaf model calls only. That decision rested on four objections; each was overstated.

1. **"`.branch()` is a predicate list, not an edge table."** It is a predicate list, and that is fine, because `branch<S, D>(on, edges: Record<D, NodeId>)` *compiles down* to one `[state => on(state) === k, target]` entry per key of the edge table. Exhaustiveness stays where it always was — in the wrapper's type — and by construction exactly one predicate is true. Nothing below has to be re-established: the compiler emits the predicate list from a table the compiler already proved total.
2. **"The graph is not a chain."** Mastra's builder is a chain, but `Workflow` implements `Step`, so a branch target can be a nested workflow. The compiler exploits that: a chain runs until it reaches a branch, and each edge compiles to a nested workflow carrying the rest of that path. Arbitrary re-convergence works — a node reachable from two edges is compiled once per path. Repetition works too, through `.dountil()` over the same nested-workflow trick: a `loop` node compiles to a nested workflow for its body and a condition carrying the bound. Arbitrary back edges stay refused, by `graphDefects`, by name.
3. **"The trace would be lossy."** Only if the trace were Mastra's `steps` record. It is not: the compiler accumulates `NodeId[]` in Mastra's *workflow state*, which is exactly the right lifetime, because state survives suspend/resume. The trace of a run that parked for a person and was answered three days later spans both halves.
4. **"Terminals are three differently-shaped variants."** They are a discriminated union over `kind`, which one schema holds. Mastra's requirement that branch targets share a schema is satisfied by a permissive schema plus the union's own tag.

And Mastra buys three things a hand-written runner cannot, without writing a durable-execution engine:

- **Crash-resume from snapshots.** A suspended run is persisted and reattachable by `runId`, from a freshly compiled workflow, in a different process.
- **Suspend and resume.** Which is what turned `needs-human` from a dead end into a live one — see below.
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

- **The fanout-merge defect is now structurally impossible.** The earlier hand runner had to diff each sub-step's whole-state result against the pre-fanout ancestor, because a sub-step that returned the whole state would let the last one's unchanged copies overwrite every earlier one's work. Under `.parallel()`, Mastra keys each sub-step's output by its own step id and the merge re-applies slices onto a base nobody else wrote. There is no ordering in which a sub-step's own write can be lost.
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

`leaf` is the one that is not about types. Every graph that calls a model did the same four things around `runStep` by hand: project the step's input out of state, run it, fold the decision or the exhaustion back in, and record the trail when the validator was never satisfied. The fourth one is the one that gets forgotten, so the constructor owns it: a `validator-exhausted` result always emits `{ type: "append-trail", line: JSON.stringify({ leaf, trail }) }`, in addition to whatever the author's own `effects` hook returned.

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

`Terminal<S>` is now `accepted | rejected`. Parking for a person is a *suspension*: the run stops with a typed payload, and the same run continues when a person answers.

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
- `resume` recompiles the graph. The compilation is a pure function of the graph, so the step ids match the persisted snapshot and the run reattaches by `runId`. That is the same path a different process would take, which is what makes this crash-resume rather than a handle you have to hold onto.

In the DISTILL example the person answers `proceed | abandon | override`. `abandon` rejects. `proceed` and `override` both re-run the merge — as a **second branch node**, not a back edge — whose edge table is terminal on every verdict, so a person's answer cannot bounce the run back to the same person. `override` sets one classifier's lane (and clears its `exhausted` flag, since a person answered what the validator could not), which is what typically clears the block.

### Two journals

Mastra has a journal and so do we. They are complements, not duplicates, and neither can do the other's job.

| | Our `Journal` | Mastra's snapshot |
|---|---|---|
| Key | `step id @ version : sha256(input)` | `runId` |
| Scope | every run, forever | one run |
| Answers | "what did this step decide, for this input, under this prompt version?" | "where was this run when it stopped?" |
| Enables | replay with zero inference; the 162-path enumeration with a stub | crash-resume, suspend/resume, `restart()` |
| Consulted | first thing inside `runStep` | by the engine, on `resume` / `restart` |
| Survives a prompt change? | no — `version` is in the key, so the step re-infers | yes — it is about position, not content |

Re-running a workflow against a warm journal is byte-identical and spends nothing. Resuming a *parked* run continues where it stopped without re-running the steps before it. A run that is both replayed and resumed uses both.

### Dependencies

`@mastra/core`, `zod`, and `@anthropic-ai/claude-agent-sdk`.

- **`zod`** is Mastra's only peer dependency and the schema language for step outputs, requirement decision spaces, and resume payloads.
- **`@anthropic-ai/claude-agent-sdk`** is what `src/bindings/claude-code.ts` dispatches a subagent through. It is a runtime dependency because the binding ships in `src/`, but it is imported lazily — `bun test` never loads it, and nothing outside that one file references it.
- **`tree-sitter`** and **`tree-sitter-typescript`** are the structural layer of the VCS module. The native Node bindings, not `web-tree-sitter` plus wasm grammars, which do not load under bun; see [`src/vcs/README.md`](./src/vcs/README.md#the-parser-native-tree-sitter-not-wasm). Prebuilt binaries ship for every supported platform, so nothing compiles at install time, and the whole surface sits behind a three-method `Parser` interface.
- **`@mastra/core`** supplies the workflow engine, the `Agent` used by the smoke scripts, and — the reason no storage package was needed — `InMemoryStore` from `@mastra/core/storage`. Snapshots go there, which is what makes suspend/resume work in the test suite with no file, no socket, and no `@mastra/libsql`. See [Not built yet](#not-built-yet) for what that store does *not* give you.

Mastra's model router takes a `provider/model` string (`anthropic/claude-haiku-4-5`), resolves `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment itself, and needs no provider package — so `ai`, `@ai-sdk/anthropic`, and `@ai-sdk/openai` are not here. The `@ai-sdk/provider*` packages still under `node_modules` are Mastra's own transitive dependencies, not ours.

## Bindings

`StepDef.worker.model`, `validator.model` and `escalateTo` are all `ModelBinding` — `{ id, generate({ system, prompt, schema }) }`. One method. That seam is the whole provider story, and it is also where an *agent* plugs in: from the step's side there is no difference between a single model call and a subagent that spent forty turns reading a checkout, as long as what comes back satisfies the schema.

| Binding | Behind it | `id` |
|---|---|---|
| `mastraAgent({ model, id? })` | a Mastra Agent, structured output, temperature 0 | the model router id, e.g. `anthropic/claude-haiku-4-5` |
| `claudeCode({ agent, cwd, model?, maxTurns?, … })` | a Claude Code subagent, through the Claude Agent SDK's `query()` | `claude-code:<agent>`, so `Attempt.model` in a trail names the agent |

### Opaque and proposal

Two shapes, and only the first is built.

**Opaque.** The agent edits the workspace itself, through its own tools, and the binding returns only what the schema asks for. The writes have already happened by the time `generate` resolves; the framework never sees them, so it cannot lease them, verify them, or roll them back. `claudeCode` is this shape. The consequence is not stylistic: under it a `conflict` is *unrepresentable*, because the write never crossed the effect boundary where a version check could have happened.

**Proposal.** The agent returns its writes as data — `replace-symbol` effects — and the runner commits them through the agent-native VCS, under a lease, with the typecheck-and-impacted-tests gate at the write boundary and the task id recorded as the intent. A conflict comes back as a decision value a branch routes. **The half of this that was missing is now built**: the VCS is in [`src/vcs/`](./src/vcs/README.md) and its executor is `vcsExecutor`, below. What is still missing is the binding: `claudeCode` returns an object, not effects, so nothing yet produces a proposal for the executor to commit. That is the next cut.

### Executors

A `ModelBinding` is where a model plugs in. An `EffectExecutor` is where the *world* plugs in: `(effects) => Promise<EffectResult[]>`, injected into `run` and `resume`.

| Executor | Behind it | `replace-symbol` / `run-tests` |
|---|---|---|
| `memoryEffects()` | a `Map` with a version column, and an array for the trail | `infra-failed`, because there is nothing behind it and that is the honest answer |
| `vcsExecutor({ vcs, session, intent })` | the [VCS module](#vcs-module): one lease per batch, the verification gate, the event log | executed for real, and the outcome is what the branch routes. `run-tests` runs the union and enforces the floor — see [The `run-tests` union](#the-run-tests-union) |

`vcsExecutor` takes ONE write lease covering every `replace-symbol` target in the batch, applies the writes, releases, and maps each outcome onto an `EffectResult`. The session and the task intent are fixed per executor instance, so the `EffectExecutor` signature does not change: one executor per task is the answer, rather than threading provenance through the runner.

### What `claudeCode` does with the SDK

- **Structured output is native.** `options.outputFormat = { type: "json_schema", schema }` makes the SDK validate the agent's final answer and re-prompt on mismatch; the validated object arrives on the result message as `structured_output`. No prompt-engineered JSON extraction was needed.
- **The zod schema is still the guarantee.** `z.toJSONSchema(schema, { target: "draft-07" })` is a projection, not a translation: a refinement zod can express and draft-07 cannot is widened rather than carried across. So the SDK's validation is necessary and not sufficient, and the binding re-parses the returned object with the step's own zod schema. That re-parse is what the binding's small retry bound (default 2) exists for, alongside the two failures the SDK documents: `error_max_structured_output_retries`, and a `success` result carrying no `structured_output` at all. After the bound it throws, and `runStep` turns the throw into a trail entry — the path that is asserted end-to-end in `src/bindings/claude-code.test.ts`.
- **The subagent is selected by name.** `options.agent` names the agent for the main thread, and the agent must exist in the settings the run loads, which is what `settingSources` controls — `"project"` loads `.claude/agents` from `cwd`. The default is `["user", "project"]`.
- **The step's `system` leads the turn.** The subagent's own prompt *is* its system prompt, so passing `systemPrompt` would replace it. The step's `system` is prepended to the user turn instead, and a retry appends what the previous attempt got wrong, which is the same feedback shape `runStep` uses one level up.

### The injected `query`

`claudeCode` takes the SDK's `query` as an option, defaulting to the real one. The default is a lazy `await import`, so the SDK's 1.5 MB module is not loaded unless a call is actually made — and `bun test` never makes one: every test in `claude-code.test.ts` supplies a fake that yields scripted messages. A binding that could only be tested by spawning an agent would not be a seam.

## VCS module

[`src/vcs/`](./src/vcs/README.md) implements [`ai-vcs.md`](./ai-vcs.md) as a library on `bun:sqlite`: a tree-sitter symbol inventory, an identity registry with opaque ids that survive declared renames, an append-only event log, a lease manager with atomic multi-acquire and hierarchical modes, and a verification pipeline that runs inside the write path and rolls the file back byte for byte when a stage refuses.

**The dependency runs one way.** `src/core` imports nothing from `src/vcs`. `src/vcs/executor.ts` imports the `Effect` and `EffectResult` types from `src/core/effects.ts` and nothing else from the framework, and every other file under `src/vcs/` does not know the framework exists. The framework is the control plane; the VCS is the data plane for code.

The design document's own test for whether the seam works is one path: "the runner executes an `Effect[]` through the VCS with lease, verify, and log, and gets back a typed result a branch can route on." That path is `src/vcs/executor.test.ts`, driven through the real Mastra runner on a temp TypeScript project: a `leaf` emits a `replace-symbol`, the branch after it routes `committed`, and a second run with a stale `expectedVersion` routes `conflict` to a rebase node instead.

**95 tests, 1.7 s.** Full detail, the storage schema, the write path step by step, the deviations and what is still missing: [`src/vcs/README.md`](./src/vcs/README.md).

## The three worked examples

| | DISTILL | DELIVER | ROADMAP |
|---|---|---|---|
| Shape | one fanout of four classifiers, then two merge branches | three nested bounded loops, thirteen leaves, fourteen branches | one bounded loop, two leaves, three non-model steps, eight branches, two suspend nodes |
| Cycles | none; the second merge is re-convergence, not a back edge | `cycle` ⊃ `test-loop`, `gates-loop` | `author`, bounded at 2 |
| Decision space | a tuple: four classifiers answer once each | a sequence: a loop asks the same leaf again next iteration | a sequence, and a choice of *data*: two branches read pure functions of the roadmap |
| Enumerated by | `cartesian(LANES, 4)` × two boundary flags | `enumeratePaths`, a walk of the reachable decision tree | `enumeratePaths`, resuming every suspension it reaches |
| Paths | **162** | **447** | **169** |
| Wall clock | ~0.2 s | ~2 s | ~0.6 s |

### The `run-tests` union

`run-tests` used to carry `impacted: string[]` and the executor ran whatever it named. That made the size of a test run the workflow's to decide in *both* directions, which is the wrong split: the workflow knows things the static import graph does not, and the import graph knows the one thing the workflow must not be allowed to forget.

So the effect gained `extra?: string[]` and the two halves got separate owners.

| | Owner | How |
|---|---|---|
| The **floor** | the VCS | `writes.runTests` recomputes `impactedTests(wrote)` from the symbols the batch actually wrote, rather than reading it off the effect |
| The **selection** above it | the workflow | a leaf returns test ids in `extra`, and `impactedTests(impacted) ∪ testsById(extra)` is what runs |

A selection that misses a test the floor holds comes back:

```ts
{ effect, outcome: "rejected", by: "contract" }
```

with the omitted ids named in the rejection detail and in the `tests-run` event's `detail` as `{ omitted, selected, wrote, status: "omitted-impacted-tests" }`, at `verification: "failed"` and `category: "contract"`. It is refused before anything runs, because a narrower run is not a cheaper run. The union is what is checked rather than the declaration, so an effect whose `impacted` names the wrong symbols but whose `extra` covers the floor is fine.

`memoryEffects` is unchanged and still answers `infra-failed`, deliberately: enforcing a floor needs an impact graph, that executor has none, and an executor that cannot tell an omission from a selection must not pretend to.

`ImpactGraph.testsById` is what makes `extra` runnable at all. A test is a symbol of kind `test`, so its id is already stable. An id naming no live test is **dropped rather than refused** — `extra` may only add, so an id that names nothing adds nothing and cannot shrink a run, and the event records what actually ran so the drop is visible in provenance.

In DELIVER the selection is a leaf, `select-tests`, between `implement` and `run-tests`. Its decision space is `no-extra | extra` and the ids are payload: a set of test ids is not a closed enum, so it cannot drive an edge, and keeping it out of the decision is also what stops the path space scaling with the size of the suite. There is no `fewer`, and that is the rule rather than an omission. `no-extra` does not carry the ids even when the payload holds some — the mechanical check `deliver.selection-matches-its-decision` refuses that contradiction at the model boundary, and reading the decision in the `carry` hook makes it structural for a journal replay that never ran the check.

### DELIVER, and why 447

The DELIVER step cycle is the design's fixed graph: activate the acceptance test, observe RED, implement until green, refactor, gate, commit. Every leaf is a `runStep` with an injected model binding, exactly like DISTILL. Four of them classify and carry the enums the design names:

- `run-tests.red` → `red-observed | already-green | harness-failed`
- `run-tests` → `green | still-red | broke-other | harness-failed`
- `diagnose` → `impl-wrong | at-wrong | design-missing | harness-failed`
- `gates` → `clean | clippy-in-scope | mutation-below-gate | out-of-scope-structural`

`select-tests` carries a fifth, `no-extra | extra`, which is the union rule above. The other eight (`activate-at`, `implement`, `fix-acceptance-test`, `surface-design-gap`, `refactor`, `fix-lint`, `add-test`, `commit`) are generative. "Make this AT pass with the minimal change" is code generation, not a closed-enum decision, so their decision space is a singleton and the routable outcome downstream is something else: for `implement`, the **effect result**. It returns a `replace-symbol` effect and the branch after it routes `committed | conflict | rejected | infra-failed`, plus `exhausted` for "the validator was never satisfied". A conflict rebases onto the version the world moved to and retries inside the bound; `infra-failed` is distinct from `rejected` so a flaky harness does not burn the implement budget on a change that was fine.

Nothing in the DELIVER example runs a test or writes a symbol. The leaves classify evidence the state carries, and `memoryEffects()` returns `infra-failed` for `replace-symbol` because there is nothing behind that executor. That outcome is **routed, not hidden**: a test drives `memoryEffects()` through the real graph and asserts the run parks under `write-infra-failed`. Swapping in `vcsExecutor` is what makes the same graph write code; the [VCS module](#vcs-module) covers that path with its own graph, deliberately smaller, so the walk stays a control-flow test rather than a filesystem one.

**447 paths** is every leaf decision, every effect result, and every loop count up to its bound, with unreachable combinations never run. Coverage is asserted, not assumed: the walk visits every node the graph declares except `human.route` (reachable only by answering a suspension, which the resume tests cover), produces all nine declared `HUMAN_REASONS`, and produces both terminal kinds.

**Why `MAX_CYCLES` is 1 while the other two bounds are 2.** It was 1270 paths at 7.5 ms each before the diagnosis branch, 2215 at ~15 ms each after it, and adding `select-tests` took it past 7000 paths and 544 s. `select-tests` sits inside `test-loop`, which sits inside `cycle`, so its multiplier compounds once per (cycle × test) iteration, and the branch after it converging two edges on `run-tests` makes the compiler build the rest of the loop body twice per compile on top of that. The documented fallback was applied first and measured: `MAX_GATE_ATTEMPTS: 2 → 1` gives **5615 paths in 254 s**, because the gates loop is not one of the two loops the new leaf is inside. So the bound that gave way is the one the new leaf is actually inside, and the three single-bound cuts were measured rather than guessed:

| Bounds | Paths | Wall clock |
|---|---|---|
| 2 / 2 / 2 | > 7000 | > 544 s |
| `MAX_GATE_ATTEMPTS` → 1 (the documented fallback) | 5615 | 254 s |
| `MAX_TEST_ATTEMPTS` → 1 | 285 | ~2 s |
| **`MAX_CYCLES` → 1** | **447** | **~2 s** |

`MAX_TEST_ATTEMPTS` is the most expensive to cut in signal: five tests depend on the test loop running twice — the implement retry, the conflict rebase, the rejected-write retry, `broke-other`, and the whole `at-wrong` re-run-without-re-implementing claim. So the cycle gives way, and the one observation that costs is bought back rather than dropped: the test that needs two cycles (`a surviving mutant re-enters the test loop on the next cycle`) rebuilds the `cycle` node at `max: 2` for itself, using nothing but `loop` and the node map. The walk pays for one cycle; the one test that needs two builds two.

### The diagnosis branch

A `still-red` suite used to loop straight back to `implement`, which assumes the answer to a question nobody asked. Now it is classified first, and each cause routes to the agent that owns it.

| `diagnose` | Route | Why |
|---|---|---|
| `impl-wrong` | iterate: `implement` again | the loop it always was |
| `at-wrong` | `fix-acceptance-test`, then re-run the suite without re-implementing | the test asserts the criterion wrongly; rewriting the code would be answering the wrong question |
| `design-missing` | leave the cycle → `surface-design-gap` → `human`, reason `design-gap` | the design is a contract, and a gap in it is not something a model may close by inventing the surface a test happens to need |
| `harness-failed` | block, reason `harness-failed` | the same distinction one leaf up: a runner that produced no verdict is not a failing test |

`design-missing` is the interesting one, because it has to *leave* a loop. The body-boundary rule says a body node's only edge out is the loop's own id, so there is no edge from `diagnose.route` to `human`. Instead the diagnosis lands in state, `blockedReason` reads it, `testDone` and `cycleDone` go true because of it, the run unwinds through both loops, and `cycle.verdict` — the one branch after the outermost loop — routes it to the architect's leaf and then to a person. That is the same move rule 3 makes for a failing step, two levels up.

`at-wrong` is the other shape worth naming. "Back to `run-tests`" cannot be an edge, because `fix-acceptance-test → run-tests` closes a cycle inside the body that is not the loop's boundary, and `graphDefects` refuses it by name. So the correction routes to the loop boundary and the body gains a head branch: `test-loop.head` starts the next iteration at `run-tests` when an acceptance test has just been corrected, and at `implement` otherwise. The suite runs twice and the implementation is written once, which is exactly the difference between `at-wrong` and `impl-wrong`, and it is asserted as such.

The walker itself is `enumeratePaths(runOnce)`: run with every choice at its first option, re-run forcing the last choice point to its next option, repeat until none is left. It requires the decision order to be a function of the decisions already made, so it covers sequential graphs and refuses a `fanout` by name rather than miscounting. DISTILL keeps its `cartesian` product.

**One `human` node, outside all three loops.** A loop body leaves only through the loop's own id, so an outcome that needs a person does not jump out of the cycle. It sets a block in state, every enclosing `until` goes true, the run unwinds, and `cycle.verdict` routes it. Reaching a bound arrives the same way with its own reason (`test-loop-exhausted`, `gates-loop-exhausted`, `cycle-exhausted`), so a person is told which budget was spent and how many times it ran. Because DELIVER's person sits outside the loops, the "a suspension inside a loop body resumes into the same iteration" guarantee is tested in `src/core/workflow.test.ts` against a hand-built graph, where the assertion can be exact: the trace reads `spin, ask, apply, spin, ask` rather than `spin, ask, spin, ask`.

### ROADMAP: the roadmap is data, and this is the graph that writes it

The third example is the authoring workflow, and the thing it is there to say is that **a roadmap is rows**. An agent does not generate a workflow per feature. It generates rows, and a scheduler instantiates the one fixed step cycle per row. Nothing about a feature changes the graph.

So this graph is fixed and hand-written like the other two, and what it produces is `roadmaps` and `roadmap_steps` artifact rows through the effect executor.

#### The rows

Modelled on nWave's own `handover.json`, with our naming. A `StoredHandover` there is a request plus an ordered tuple of `HandoverValue`s; these are the same facts, as zod schemas, in `src/examples/nwave/roadmap/schema.ts`:

```ts
RoadmapStep = {
  id: string;                          // stable, unique within the roadmap
  observation: string;                 // what will be observably true when it is done
  dependencies: string[];              // step ids that must be accepted first
  authority: string;                   // a locator into the design source it implements
  acceptance: AcceptanceObligation[];  // ≥ 1
  predictedTouches: string[];          // symbol ids or paths it expects to write
}
AcceptanceObligation = { id: string; text: string; oracleLocator?: string }
Roadmap = { request: string; steps: RoadmapStep[] }
```

`predictedTouches` is the one field beyond the handover's own, and it is there because the disjointness check needs an axis to measure. `steps` is deliberately allowed to be empty by the schema: that is what `decompose` returns when it answers `cannot-decompose`, and an empty roadmap is refused by `validate-shape` as a *named defect* rather than by the parser, so the refusal reaches the graph as data.

Declaration order is significant. It is the total order the disjointness resolution uses to decide which way a new dependency edge points, and nWave's handover relies on the same order for the same reason.

#### Two of the nodes are pure functions, not models

That is the point of the example. A graph's branches do not have to read a model's answer; they have to read a closed enum, and a pure function over the data produces one just as well.

**`validate-shape`** returns the six named defects nWave's own `read_handover` refuses a persisted handover for:

| Defect | What it names |
|---|---|
| `no-steps` | the roadmap has no rows at all |
| `duplicate-id` | two rows claim one identity |
| `dangling-dependency` | a dependency names no step in the roadmap |
| `cycle` | the dependency graph is not a DAG, named by the path that closes it |
| `no-acceptance` | a step declares nothing it must satisfy |
| `empty-authority` | a step implements no named design source |

They are **named rather than boolean** because they are the feedback `decompose` reads on the next iteration: "invalid" tells a model nothing it can act on. And `decompose`'s own requirement rows consume the same predicates through `firstDefectOfKind`, so the step's mechanical guardrail (which runs before a validator model is spent) and the graph's gate (which runs on whatever got past it) cannot drift apart.

**`measure-disjointness`** mirrors `parallel_safety.py`. A pair the roadmap declares independent whose `predictedTouches` overlap is DRIFT, and the overlapping entries are the finding. The resolution on top of that is deterministic: order the pair by declaration order, lower ordinal first, and record the edge. If adding one would close a cycle, the verdict is `drift-unresolvable` and the pair is named.

The measurement is taken **once**, against the roadmap as the author declared it, and only then are the edges applied. That ordering is load-bearing twice over, and the first draft of this got it wrong in a way the fixture caught:

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

169 paths, ~0.6 s, and two things make it unlike DELIVER's.

**It resumes.** DELIVER's person sits outside all three loops, so its walk stops at the suspension and leaves `human.route` to the resume tests. Here the review is in the middle, and `persist`, `accept`, `review.route` and `human.route` are only reachable through an answer. So the walk answers: while a run is parked it chooses from that node's own closed enum and resumes. The walker allows it because the choice point's id is `resume:${reason}`, and the reason is a function of the choices already made, which is the walker's one requirement. The coverage assertion is therefore stronger than DELIVER's: **every node the graph declares is visited, with nothing excused.**

**It chooses data, not just decisions.** Two branches read pure functions of the roadmap, so to reach `shape.route`'s `invalid` edge or `disjointness.route`'s `consistent` and `drift-unresolvable` edges the walk has to vary the *roadmap*. The choice point at `decompose` is therefore a choice of **proposal**, drawn from the hand-written roadmaps in `src/examples/nwave/roadmap/fixture.ts`: `KNOWN_GOOD` (three steps, one declared dependency, one deliberate overlap → `edges-added`), `DISJOINT` (→ `consistent`), `UNRESOLVABLE` (→ `drift-unresolvable`), `MALFORMED` (every shape defect at once), plus `cannot-decompose` and the exhausted validator. Enumerating a graph whose decisions are functions of its data means enumerating enough data to reach every edge.

`KNOWN_GOOD` is also the oracle in the framework/consumer sense: the harness proves a roadmap is well-formed, and a hand-written one is the only thing that says a well-formed one is *right*. `KNOWN_GOOD_RESOLVED` beside it is the expected output rows, which is what makes "the resolution is not advice" a testable claim rather than a comment.

## Deviations from the design

The document's code sketches are sketches. Where one of them is underspecified or does not survive contact with a type checker, here is what changed and why.

1. **`needs-human` is a suspension, not a terminal.** `Terminal<S>` is `accepted | rejected`; a fifth node type, `suspend`, parks the run. This is a change to the design document itself (§ Five rules, rule 3), made because the runner now has somewhere to park. `run` therefore returns a `RunOutcome<S>` — `{ kind: "terminal", terminal, trace, runId }` or `{ kind: "suspended", reason, trail, trace, runId }` — rather than `{ result, trace }`, and `resume(wf, runId, answer, execute)` continues the parked run.

2. **Four constructors, not one: `branch`, `suspend`, `loop` and `leaf`.** `branch<S, D>` ties an edge table to a decision union. `suspend<S, R>` is the same shape of guarantee one level over: it ties a `resumeSchema` to the `absorb` that consumes it, so a node cannot be built whose schema parses something its `absorb` does not accept. The erasure to `Node<S>` happens in those two functions and nowhere else. `loop<S>` needs no erasure; it exists so that the bound is a named, required field at every call site. `leaf<S, I, O>` is new surface, approved rather than derived from the document — see deviation 17.

3. **`LanguageModel` → `ModelBinding`.** The sketches import `LanguageModel` from the Vercel AI SDK, which is gone. `StepDef`'s three model slots take `ModelBinding` — `{ id, generate({system, prompt, schema}) }`. This is the seam that lets the whole test suite run with fakes: no agent constructed, no key read, no socket opened. `Attempt.model` carries `binding.id`, where the sketch had `model.modelId`.

4. **The fanout merge is a per-slice merge, and the runner no longer does it.** The sketch's `outs.reduce((acc, s) => ({...acc, ...s}), state)` is wrong for any state with more than one field: each sub-step computes a *whole* state from the pre-fanout state, so spreading them in order lets the last sub-step's unchanged copies overwrite every earlier sub-step's work. In the worked example that silently drops three of four classifier verdicts and routes `undecidable` to `accepted` — a trajectory change, not a cosmetic one. Under Mastra each sub-step returns only the keys it changed and the merge re-applies those slices onto `getInitData()`, so no ordering can lose a write. Regression-locked by `exhaustion is detected regardless of which classifier exhausted` and by `a fanout merges each sub-step's own writes, never a whole-state overwrite`.

5. **The example's `State` uses one slot per classifier.** The sketch's `anchors: Record<string, string>` and `exhausted: Kind[]` are *shared* fields that all four classifiers write, and no shallow merge can keep four writes to one key. `State` carries `e2e | expectation | benchmark | dst: { lane?, anchor?, exhausted? }`, so each sub-step writes exactly one top-level key. Consequence for the document's second test: `result.state.expectation` becomes `terminal.state.expectation.lane`.

6. **The journal key keeps the step id and version in plain text.** The sketch hashes `id`, `version`, and the input together into one opaque digest. The prose says "keyed by (step id, step version, input hash)", so the key is literally `<step id>@<version>:<sha256 of input>`. Same three components, same collision resistance on the input, and the stub journal can answer by step id without knowing the input — which is what makes the enumeration harness a dozen lines instead of a hundred. `journalKey` is exported for the same reason.

7. **Input canonicalisation is a recursive sort, not a replacer array.** The sketch uses `JSON.stringify(input, Object.keys(input).sort())`. A replacer *array* is a key allowlist applied at every nesting level, so any nested key not also present at the top level is silently dropped from the hash — two different inputs can collide. `canonicalJson` sorts keys recursively instead.

8. **`stepOutput` takes `readonly [string, ...string[]]`.** With the sketch's `[string, ...string[]]`, `z.enum(...).options` (a plain array in zod 4) does not typecheck as an argument. Widening to `readonly` accepts an `as const` tuple and preserves literal inference, so `decision` is still a closed union.

9. **A thrown model call becomes a trail entry.** `runStep` returns exactly the two documented variants, so a provider error must not escape. Worker and validator calls are wrapped; a failure records `{ model, violations: [], error }` and the loop continues to the next attempt. `Attempt` gained `error?: string` and its `output` is now optional, so the trail stays complete when the call produced nothing.

10. **Graph bugs throw, and they throw at compile time.** `compileWorkflow` refuses any graph `graphDefects` rejects — a dangling edge, an unreachable node, a fanout target that is not a step, a malformed loop, a back edge, or no reachable terminal — before a single step runs. The one graph bug that can only be caught at run time is a branch whose `on` returns a key the edge table does not hold, which the branch's entry step throws on before any predicate is evaluated. Guarantee 3 is about *decision* outcomes being data; those are, without exception.

11. **The journal records successes only.** As in the sketch: `validator-exhausted` is not written back, so a replay retries an exhausted step rather than replaying the exhaustion. Stated because it is load-bearing for replay semantics and the sketch does not say it out loud.

12. **`fileJournal` was replaced by `sqliteJournal`.** The scaffold had a JSON-file journal that rewrites the whole file per put. `bun:sqlite` with `INSERT OR REPLACE` was asked for and is strictly better.

13. **The graph is recompiled per `run` and per `resume`.** Compilation is a pure function of the graph and costs about 0.2 ms, so `run` builds the Mastra workflow each time rather than caching it. That is what lets `resume` take a `Workflow<S>` rather than a live handle: it rebuilds the identical workflow and reattaches by `runId`.

14. **Tests beyond the two in the document.** The document shows two tests. This repo ships 152 outside the VCS module (95 more inside it), including the compiler's graph-bug rejections, six malformed-loop rejections, the snapshot assertions behind suspend/resume, a `Run.restart()` exercise, the `runStep` unit tests, the `leaf` constructor's ownership of the exhaustion trail, the Claude Code binding against a scripted `query`, the three mechanical checks, the effect executor's optimistic concurrency, the path walker's own arithmetic, and a source scanner that fails the build if `Date.now`, `Math.random`, or `new Date(` appears in the contract, the compiler, or any decision-function file. That scanner was verified by planting a violation in `compile.ts` and watching it fail.

15. **Nested workflow ids carry the path that reached them.** The previous cut named a branch tail `${branchId}=${key}`, which collides once a node is reachable by two different paths and has a branch of its own. DELIVER has exactly that shape: `commit` is reached from `cycle.verdict` and from `human.route`. Ids are now `${parentSegmentId}>${branchId}=${key}`, unique by construction. The top-level id is unchanged (`wf:${wf.start}`), so `resume` still reattaches.

16. **The engine's state carries loop counters as well as the trace.** It was `{ trace }`; it is now `{ trace, loops }`. Both need the same lifetime, which is "survives suspension", and that is what makes a run parked inside a loop body resume into the same iteration with the same count. `readTrace` is unchanged.

17. **`leaf` is new public surface the design document does not name.** It was approved rather than derived. The document's two graphs each hand-wrote the same wrapper around `runStep`, and the fourth thing that wrapper does — record the trail when the validator was never satisfied — is the one a graph author forgets, so it is now the constructor's and cannot be opted out of. See [Four constructors over six node types](#four-constructors-over-six-node-types).

18. **`leaf` has two folds, not one.** The approved spec names one `absorb`, taking the `StepResult`. A node has two results to fold and they arrive at different times: the step's, and the `EffectResult[]` the executor returns for the effects the step asked for, which do not exist yet when the first fold runs. DELIVER's `implement` needs both — its write outcome *is* its routable decision — so the spec carries `absorbEffects` beside `absorb`. A leaf that asks for no effects needs only the first, and the DISTILL classifiers use only the first.

19. **The journal is a `leaf` spec field, not a closure variable.** Both examples pass a journal into their graph builder today and close over it. As a field it sits beside the other three dependencies a leaf has — the `StepDef`, the projection out of state, the fold back in — and nothing reads module-level state, so two graphs in one process cannot disagree about which journal they meant.

20. **The Claude Agent SDK has a native schema option, so the binding uses it.** `options.outputFormat = { type: "json_schema", schema }`; the validated object arrives as `structured_output` on the result message. No prompt-engineered JSON extraction was needed. What the SDK forced is smaller and is documented in [What `claudeCode` does with the SDK](#what-claudecode-does-with-the-sdk): `z.toJSONSchema` is a projection rather than a translation, so the binding re-parses with the step's own zod schema and retries within a small bound; the subagent's own prompt is its system prompt, so the step's `system` leads the user turn instead of being passed as `systemPrompt`; and a `success` result can carry no `structured_output` at all, which the binding treats as a failure because the SDK's own docs say to.

21. **`DeliverModels` gained a per-leaf worker override.** The diagnosis branch routes each cause to the agent that owns it, and "which agent" is a binding, not a graph edge — so the routing is expressed in the model table rather than in the graph. `workers?: Partial<Record<LeafId, ModelBinding>>` falls back to `worker`, so a test that supplies only `worker` stubs every leaf the same way and the enumeration suite is unchanged.

22. **The DISTILL exhaustion trail line changed shape.** It was `{"kind":"benchmark",…}`, written by hand; it is `{"leaf":"benchmark",…}`, written by the constructor, because one line format for both graphs is the point of moving it there. That is the one existing assertion this cut changed.

23. **`EffectResult`'s `rejected.by` gained `contract` and `structural`.** It was `typecheck | tests | schema`, which cannot express the contract-violation category the VCS distinguishes from a verification failure — "you declared one thing and did another" is not the same answer as "your change broke a test", and § 5.4 of `ai-vcs.md` is explicit that the responses differ. It is now `typecheck | tests | schema | contract | structural`, and `structural` is the narrower case of "the edit does not parse". This is the only change to `src/core` this cut made. `memoryEffects` needed no edit, because it never produced a `rejected` outcome. The `Effect` union did **not** need extending: `replace-symbol` already carries `symbolId`, `expectedVersion` and `body`, and the lease and the intent belong to the executor rather than to the graph.

24. **The no-nondeterminism scanner covers `src/vcs/**` and gained `randomUUID`.** The VCS takes its clock and its id generator as constructor arguments so that a lease TTL is a function call rather than a wait; `src/vcs/defaults.ts` is the one file allowed to supply the real ones, and it is the one file excluded. A fourth test asserts that the exemption has something behind it, because a defaults file that read no clock would mean the injection seam is decorative.

25. **`Effect`'s `run-tests` gained `extra`, and the floor moved into the VCS.** The design's union has one field, `impacted`, which makes test selection the workflow's in both directions. `extra?: string[]` splits it: the VCS recomputes the floor from the symbols the batch wrote and refuses a union that misses one of its tests. The shape that forced is a signature the design does not name — `WritePath.runTests` takes `extra` and `wrote` beside `symbolIds`, and `ImpactGraph` gained `testsById` so a test id is runnable at all. Three named sets rather than one, because "the floor is computed by the VCS, not trusted from the effect" needs the written symbols to reach the place that computes it, and the design specifies the rule without specifying the call. See [The `run-tests` union](#the-run-tests-union).

26. **DELIVER's `select-tests` carries the selection in state; nothing emits the `run-tests` effect yet.** The leaf, its decision space and its edges are as specified, and `extra` lands in `State.extra`. What does not exist is a DELIVER `run-tests` *effect*: the graph's `run-tests` leaf classifies evidence the caller seeded, as it always has, and giving the effect a routable result would need the graph to reconcile two sources of truth for "did the suite pass" — the leaf's classification and the effect's outcome. The design does not say which wins, so nothing was invented. The rule is enforced and tested where the design put it, at the executor. This is the same boundary as the existing "DELIVER driven through the VCS" item below.

27. **`MAX_CYCLES` is 1, and the documented fallback was not enough.** The README's own advice was that `MAX_GATE_ATTEMPTS` is the cheapest bound to cut. It was applied first and measured at 5615 paths in 254 s, because `select-tests` sits inside `test-loop` inside `cycle` and the gates loop is neither. All three single-bound cuts were measured and the cycle is the one that gives way; the table and the reasoning are in [DELIVER, and why 447](#deliver-and-why-447). The one observation it costs is rebuilt locally by the one test that needs it.

28. **The roadmap's `human` suspend node has a one-member decision enum.** The design names the three answers at `human-review` and routes four things to `human` without naming an answer space for it. One answer is the honest closure: every block reaching it needs work outside a closed enum, and a second answer would be a route the design does not have. Reasoned in full under [One loop, two people](#one-loop-two-people-and-what-revise-costs).

29. **The roadmap's suspend payload is `{ reason, trail }`, not four named fields.** The design's sketch gives `human-review` a `suspendSchema { reason, roadmap, addedEdges, defects }`. The framework's `suspend` node has `reason: (s) => string` and `trail: (s) => unknown[]`, and `compile.ts` parses exactly that. So the other three ride as the trail's first three rows, in that order, plus two more the block path needs. Changing core's suspend contract to carry a caller-shaped payload was not in scope and would have been a larger change than the example warranted.

30. **`validate-slices` is one leaf, not a fanout, and `shapeDefects` gained a sixth defect kind.** The first is a choice the design explicitly delegates, with the reasoning under [The fanout-sizing decision](#the-fanout-sizing-decision-one-leaf-not-eight). The second is `no-steps`: the design lists five checks for `validate-shape`, and the schema deliberately admits an empty `steps` array because that is what `cannot-decompose` returns. An empty roadmap passes all five of the others *vacuously* and would reach `human-review` as a proposal worth approving. nWave's own validator refuses it in the same breath as a missing request.

31. **The roadmap's disjointness measures the declaration once, rather than re-measuring after each repair.** The design says "for every pair with no dependency path between them, intersect; add an edge; if adding edges would create a cycle, `drift-unresolvable`". Read as a re-measuring loop, `drift-unresolvable` is unreachable — the first implementation here was, and the fixture proved it dead. Measuring the declaration once and applying the edges in order makes it reachable and keeps the finding the author's rather than the tool's.

32. **`RoadmapModels` carries a `decomposeWith` slot beside `worker`.** The design says `decompose`'s worker is "a frontier-class binding (injected)". `DeliverModels` solves the same problem with `workers?: Partial<Record<LeafId, ModelBinding>>` because DELIVER routes three leaves to three different agents; the roadmap workflow has one such leaf, so it has one named slot falling back to `worker` rather than a per-leaf map with one live key.

Source is ~13,050 lines: ~7,990 of implementation and ~5,050 of tests. The VCS module is ~4,650 of that, split ~2,690 implementation and ~1,960 tests; the roadmap example is ~2,280, split ~1,650 and ~630.

## Not built yet

- **Emitting a Mastra dynamic-workflow JSON definition from a `Workflow<S>`.** Mastra's dynamic workflows (beta) are the design's "graph topology as data" already built: a JSON graph over registered agents, tools, and nested workflows, validated and persisted by `addDynamicWorkflow()`. The compiler currently emits live `createStep` closures; emitting the JSON definition instead is what would let the authoring workflow write a graph without writing source.
- **Durable snapshots.** Suspend and resume run against `InMemoryStore`, so a parked run survives a fresh compile but not a process restart. Pointing the runtime at a durable adapter is a storage swap, and it is not wired.
- **Artifact rows in a real database.** `upsert-artifact` writes to a `Map` with a version column under `memoryEffects`, and comes back `infra-failed` under `vcsExecutor`, because the VCS is the data plane for code rather than for artifact rows. The roadmap example is the first thing to *use* the artifact path — `roadmaps` and `roadmap_steps` rows, one schema serving as both the step output type and the row type, which is the design's "artifacts are typed rows, not documents" — but the store behind it is still a `Map`. Nothing persists a roadmap across a process. The append-only event log *is* real, for code: `src/vcs/log.ts`.
- **The DELIVER scheduler over roadmap rows, with the `oracle` leaf. This is the next cut.** The roadmap is now rows and the step cycle is fixed, so what is missing between them is the scheduler: read the `roadmap_steps` rows, derive `step_edges` from the declared `predictedTouches` overlap the disjointness check already measures, take the frontier of steps whose in-edges are all `accepted`, and instantiate one DELIVER run per row. The `oracle` leaf is the step-level half of it — a roadmap row carries `acceptance` obligations with an optional `oracleLocator`, and nothing yet turns an obligation into the acceptance test DELIVER's `activate-at` activates. `fanout` runs one node's sub-steps concurrently; that is not a scheduler, and resource leases for shared test infrastructure are not built either.

- **The proposal-shape binding.** `claudeCode` is the opaque shape: the agent edits the workspace through its own tools and the framework never sees the writes, so it cannot lease them, verify them, or roll them back — and a `conflict` is unrepresentable, because nothing crossed the effect boundary. The proposal shape returns the agent's writes as `replace-symbol` effects, which `vcsExecutor` now knows how to commit. The executor exists; the binding that would produce a proposal does not.
- **`src/vcs`'s own remaining items**, in full in [`src/vcs/README.md`](./src/vcs/README.md#not-built-yet). The ones that matter to the framework: the **ast-grep pattern layer** and the **policy stage** it would carry (the stage is a stub that passes); the **LSP layer**, so there is no cross-file reference resolution and the typecheck stage shells out to `tsc` over the whole project; **coverage-refined impact**, so the test-impact graph is the static import graph alone; the **asynchronous verification tier**, so a slow test blocks a write rather than committing it `pending`; **wait-die** and **queued acquires**, so an acquire is fail-fast and hold-and-request has no fallback; **lease-level rollback**, so a lease whose second write fails leaves the first committed; **git export**; **cross-repository coordination**; and **authorization**, because a session is a string and any session may lease anything.
- **DELIVER driven through the VCS.** The step cycle's `implement` leaf emits `replace-symbol` and the executor that commits it exists, but the 447-path walk still runs `memoryEffects()`, deliberately: the walk is a control-flow test and giving it a filesystem would make it something else. Nothing yet runs the DELIVER graph against a real checkout with `vcsExecutor`. DELIVER's `run-tests` leaves still classify evidence the caller seeded rather than output they produced, and `select-tests` is the same boundary one field over: its `extra` lands in state and no DELIVER node emits the `run-tests` effect that would carry it, because giving that effect a routable result needs a rule for which of the leaf's classification and the effect's outcome decides "did the suite pass". The union rule itself is enforced and tested at the executor, which is where the design put it.
- **The symbol-set-difference check.** `deliver.implement-to-the-design` carries no mechanical check, only a model refuting against the rule text. The symbol inventory that would make it a set difference over exported symbols now exists in `src/vcs/structural`; the check that consumes it does not.
- **The parallel scheduler.** Roadmap steps as a DAG in rows, `step_edges` derived from declared symbol overlap, a frontier of steps whose in-edges are all `accepted`, and resource leases for shared test infrastructure. `fanout` runs one node's sub-steps concurrently; that is not a scheduler.
- **The authoring workflow that writes GRAPH rows.** Bootstrap step 4: requirement rows in, graph rows out, diffed against the hand-written graph. Nothing generates a graph; DISTILL, DELIVER and the roadmap workflow are all hand-written, which is what makes them the oracle. The roadmap-authoring workflow is a different thing that the design's table lists on the same line: it writes *roadmap* rows, not graph rows, and it is built.
- **Graph topology as data.** Nodes and edges are TypeScript, not rows. Exhaustiveness is the compiler's red squiggle, not a constraint query. The design takes the middle path; this prototype takes the typed end of it.
- **`symbol-diff.ts`.** The fourth mechanical check in the design's `checks/` listing. Its input, the symbol inventory, is now built; the check is not. See the symbol-set-difference item above.
- **Escalation cost accounting.** `escalateTo` fires once after the attempt budget, as specified, but nothing measures cost per completed task — the open question the design says should be answered before the legibility argument is used to justify the approach.
