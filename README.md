# deterministic-workflows

A prototype of the framework described in [`DETERMINISTIC-WORKFLOWS.md`](./DETERMINISTIC-WORKFLOWS.md): a finite graph owns control flow, small models own one decision each, and the whole path space is enumerable before anything runs.

The property the rest of the design rests on is testable in this repo right now, on two graphs: **162 paths through the DISTILL classification graph and 2215 through the DELIVER step cycle, zero model calls, no API key, no network.** The whole suite — 204 tests, including those 2377 runs through the real Mastra engine — takes **about 43 s**, essentially all of it the DELIVER walk.

The DELIVER graph is the one with cycles in it. Its path space is four figures rather than infinite because every repetition in it is a `loop` node with a required bound.

The second half of the repo is the [VCS module](#vcs-module): `replace-symbol` and `run-tests` now execute for real, under a lease, through a verification gate, into an append-only event log.

## Install, test, run

```bash
bun install
bun test          # 204 tests, no network, no key, no model, ~43 s
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
| `src/examples/distill/` | § Worked example: DISTILL test-lane classification. Bootstrap steps 2 and 3 — the known-good hand-written graph and its requirement rows. |
| `src/examples/deliver/` | § DELIVER is two graphs → The step cycle as a graph. Bootstrap step 6 — the fixed step cycle, as three nested bounded loops. |
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
| `vcsExecutor({ vcs, session, intent })` | the [VCS module](#vcs-module): one lease per batch, the verification gate, the event log | executed for real, and the outcome is what the branch routes |

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

**87 tests, 1.9 s.** Full detail, the storage schema, the write path step by step, the deviations and what is still missing: [`src/vcs/README.md`](./src/vcs/README.md).

## The two worked examples

| | DISTILL | DELIVER |
|---|---|---|
| Shape | one fanout of four classifiers, then two merge branches | three nested bounded loops, twelve leaves, eleven branches |
| Cycles | none; the second merge is re-convergence, not a back edge | `cycle` ⊃ `test-loop`, `gates-loop`, each bounded at 2 |
| Decision space | a tuple: four classifiers answer once each | a sequence: a loop asks the same leaf again next iteration |
| Enumerated by | `cartesian(LANES, 4)` × two boundary flags | `enumeratePaths`, a walk of the reachable decision tree |
| Paths | **162** | **2215** |
| Wall clock | ~0.2 s | ~34 s |

### DELIVER, and why 2215

The DELIVER step cycle is the design's fixed graph: activate the acceptance test, observe RED, implement until green, refactor, gate, commit. Every leaf is a `runStep` with an injected model binding, exactly like DISTILL. Four of them classify and carry the enums the design names:

- `run-tests.red` → `red-observed | already-green | harness-failed`
- `run-tests` → `green | still-red | broke-other | harness-failed`
- `diagnose` → `impl-wrong | at-wrong | design-missing | harness-failed`
- `gates` → `clean | clippy-in-scope | mutation-below-gate | out-of-scope-structural`

The other eight (`activate-at`, `implement`, `fix-acceptance-test`, `surface-design-gap`, `refactor`, `fix-lint`, `add-test`, `commit`) are generative. "Make this AT pass with the minimal change" is code generation, not a closed-enum decision, so their decision space is a singleton and the routable outcome downstream is something else: for `implement`, the **effect result**. It returns a `replace-symbol` effect and the branch after it routes `committed | conflict | rejected | infra-failed`, plus `exhausted` for "the validator was never satisfied". A conflict rebases onto the version the world moved to and retries inside the bound; `infra-failed` is distinct from `rejected` so a flaky harness does not burn the implement budget on a change that was fine.

Nothing in the DELIVER example runs a test or writes a symbol. The leaves classify evidence the state carries, and `memoryEffects()` returns `infra-failed` for `replace-symbol` because there is nothing behind that executor. That outcome is **routed, not hidden**: a test drives `memoryEffects()` through the real graph and asserts the run parks under `write-infra-failed`. Swapping in `vcsExecutor` is what makes the same graph write code; the [VCS module](#vcs-module) covers that path with its own graph, deliberately smaller, so the 2215-path walk stays a control-flow test rather than a filesystem one.

**2215 paths** is every leaf decision, every effect result, and every loop count up to its bound, with unreachable combinations never run. The bounds are all 2, which is the smallest value that still exercises every edge: one iteration to reach a retry, a second to reach the bound. Raising them multiplies the walk without adding an edge. Coverage is asserted, not assumed: the walk visits every node the graph declares except `human.route` (reachable only by answering a suspension, which the resume tests cover), produces all nine declared `HUMAN_REASONS`, and produces both terminal kinds.

It was 1270 paths at 7.5 ms each before the diagnosis branch; it is 2215 at ~15 ms each after it, because two more branches inside a loop body make the compiler build a larger tree per run. 34 s, measured. That is the number the bounds were checked against, and no bound was reduced, because the walk is inside the budget. If it stops being, the cheapest bound to cut is `MAX_GATE_ATTEMPTS`: 901 paths, ~7 s, every node, reason and terminal still covered — at the cost of the only place the gates loop is observed repeating.

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

14. **Tests beyond the two in the document.** The document shows two tests. This repo ships 116, including the compiler's graph-bug rejections, six malformed-loop rejections, the snapshot assertions behind suspend/resume, a `Run.restart()` exercise, the `runStep` unit tests, the `leaf` constructor's ownership of the exhaustion trail, the Claude Code binding against a scripted `query`, the three mechanical checks, the effect executor's optimistic concurrency, the path walker's own arithmetic, and a source scanner that fails the build if `Date.now`, `Math.random`, or `new Date(` appears in the contract, the compiler, or any decision-function file. That scanner was verified by planting a violation in `compile.ts` and watching it fail.

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

Source is ~10,150 lines: ~6,020 of implementation and ~4,130 of tests. The VCS module is ~4,350 of that, split ~2,580 implementation and ~1,780 tests.

## Not built yet

- **Emitting a Mastra dynamic-workflow JSON definition from a `Workflow<S>`.** Mastra's dynamic workflows (beta) are the design's "graph topology as data" already built: a JSON graph over registered agents, tools, and nested workflows, validated and persisted by `addDynamicWorkflow()`. The compiler currently emits live `createStep` closures; emitting the JSON definition instead is what would let the authoring workflow write a graph without writing source.
- **Durable snapshots.** Suspend and resume run against `InMemoryStore`, so a parked run survives a fresh compile but not a process restart. Pointing the runtime at a durable adapter is a storage swap, and it is not wired.
- **Artifact rows in a real database.** `upsert-artifact` writes to a `Map` with a version column under `memoryEffects`, and comes back `infra-failed` under `vcsExecutor`, because the VCS is the data plane for code rather than for artifact rows. The design's "artifacts are typed rows, not documents" — a schema you derive zod types from, so the row type and the step output type are one definition — is not here. The append-only event log *is*, for code: `src/vcs/log.ts`.
- **The proposal-shape binding.** `claudeCode` is the opaque shape: the agent edits the workspace through its own tools and the framework never sees the writes, so it cannot lease them, verify them, or roll them back — and a `conflict` is unrepresentable, because nothing crossed the effect boundary. The proposal shape returns the agent's writes as `replace-symbol` effects, which `vcsExecutor` now knows how to commit. The executor exists; the binding that would produce a proposal does not. This is the next cut.
- **`src/vcs`'s own remaining items**, in full in [`src/vcs/README.md`](./src/vcs/README.md#not-built-yet). The ones that matter to the framework: the **ast-grep pattern layer** and the **policy stage** it would carry (the stage is a stub that passes); the **LSP layer**, so there is no cross-file reference resolution and the typecheck stage shells out to `tsc` over the whole project; **coverage-refined impact**, so the test-impact graph is the static import graph alone; the **asynchronous verification tier**, so a slow test blocks a write rather than committing it `pending`; **wait-die** and **queued acquires**, so an acquire is fail-fast and hold-and-request has no fallback; **lease-level rollback**, so a lease whose second write fails leaves the first committed; **git export**; **cross-repository coordination**; and **authorization**, because a session is a string and any session may lease anything.
- **DELIVER driven through the VCS.** The step cycle's `implement` leaf emits `replace-symbol` and the executor that commits it exists, but the 2215-path walk still runs `memoryEffects()`, deliberately: the walk is a control-flow test and giving it a filesystem would make it something else. Nothing yet runs the DELIVER graph against a real checkout with `vcsExecutor`, and DELIVER's `run-tests` leaves still classify evidence the caller seeded rather than output they produced.
- **The symbol-set-difference check.** `deliver.implement-to-the-design` carries no mechanical check, only a model refuting against the rule text. The symbol inventory that would make it a set difference over exported symbols now exists in `src/vcs/structural`; the check that consumes it does not.
- **The parallel scheduler.** Roadmap steps as a DAG in rows, `step_edges` derived from declared symbol overlap, a frontier of steps whose in-edges are all `accepted`, and resource leases for shared test infrastructure. `fanout` runs one node's sub-steps concurrently; that is not a scheduler.
- **The authoring workflow.** Bootstrap step 4: requirement rows in, graph rows out, diffed against the hand-written graph. Nothing generates a graph; both DISTILL and DELIVER are hand-written, which is what makes them the oracle.
- **Graph topology as data.** Nodes and edges are TypeScript, not rows. Exhaustiveness is the compiler's red squiggle, not a constraint query. The design takes the middle path; this prototype takes the typed end of it.
- **`symbol-diff.ts`.** The fourth mechanical check in the design's `checks/` listing. Its input, the symbol inventory, is now built; the check is not. See the symbol-set-difference item above.
- **Escalation cost accounting.** `escalateTo` fires once after the attempt budget, as specified, but nothing measures cost per completed task — the open question the design says should be answered before the legibility argument is used to justify the approach.
