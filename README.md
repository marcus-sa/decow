# deterministic-workflows

A prototype of the framework described in [`DETERMINISTIC-WORKFLOWS.md`](./DETERMINISTIC-WORKFLOWS.md): a finite graph owns control flow, small models own one decision each, and the whole path space is enumerable before anything runs.

The property the rest of the design rests on is testable in this repo right now, on two graphs: **162 paths through the DISTILL classification graph and 1270 through the DELIVER step cycle, zero model calls, no API key, no network.** The whole suite — 96 tests, including those 1432 runs through the real Mastra engine — takes **about 10 s**, essentially all of it the DELIVER walk.

The DELIVER graph is the one with cycles in it. Its path space is four figures rather than infinite because every repetition in it is a `loop` node with a required bound.

## Install, test, run

```bash
bun install
bun test          # 96 tests, no network, no key, ~10 s
bun run typecheck # tsc --noEmit
bun run check     # both
```

The smoke script is the only thing that talks to a model. It is never invoked by the test suite and refuses to run without a key:

```bash
ANTHROPIC_API_KEY=... bun run smoke

# Optional: a different model family for the validator, which refutes more
# independently than Haiku refuting Haiku.
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun run smoke
```

It pushes one scenario through four real classifiers and prints each lane verdict, the merge verdict, the terminal or the suspension, and the trace.

## Map to the design document

| Path | Implements |
|---|---|
| `src/core/requirement.ts` | § Primitives → Requirement. The rule as a row: verbatim text, FK to its source, closed decision space, optional mechanical check. |
| `src/core/step.ts` | § Step: a worker paired with a validator, always. `stepOutput`, `StepDef`, `Attempt`, `StepResult`, `journalKey`, `runStep` and its six guardrails. |
| `src/core/workflow.ts` | § Workflow graph and runner. The contract: `NodeId`, `Terminal`, `Node`, `Workflow`, `branch`, `suspend`, `run`, `resume`. |
| `src/core/compile.ts` | § Workflow graph and runner. The compiler from the node map to a Mastra workflow. |
| `src/core/effects.ts` | § Effects with typed results. The `Effect` / `EffectResult` unions plus an in-memory executor with optimistic concurrency. |
| `src/core/journal.ts` | § Journal. The interface, an in-memory implementation, and a persistent one on `bun:sqlite`. |
| `src/checks/` | § Framework versus consumer → "a library of mechanical checks": `verbatim.ts`, `enum-member.ts`, `id-in-set.ts`. |
| `src/harness/` | § Framework versus consumer → "test harness": `stub-journal.ts`, `enumerate-paths.ts` (the graph inspector plus the reachable-path walker), `matchers.ts`. |
| `src/examples/distill/` | § Worked example: DISTILL test-lane classification. Bootstrap steps 2 and 3 — the known-good hand-written graph and its requirement rows. |
| `src/examples/deliver/` | § DELIVER is two graphs → The step cycle as a graph. Bootstrap step 6 — the fixed step cycle, as three nested bounded loops. |

`src/examples/distill/smoke.ts` also holds the Mastra model binding, because the design's framework/consumer table puts "which small models, which validator family" on the consumer side.

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

`@mastra/core` and `zod`. That is still the whole list, and no dependency was added for this change.

- **`zod`** is Mastra's only peer dependency and the schema language for step outputs, requirement decision spaces, and resume payloads.
- **`@mastra/core`** supplies the workflow engine, the `Agent` used by the smoke script, and — the reason no storage package was needed — `InMemoryStore` from `@mastra/core/storage`. Snapshots go there, which is what makes suspend/resume work in the test suite with no file, no socket, and no `@mastra/libsql`. See [Not built yet](#not-built-yet) for what that store does *not* give you.

Mastra's model router takes a `provider/model` string (`anthropic/claude-haiku-4-5`), resolves `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment itself, and needs no provider package — so `ai`, `@ai-sdk/anthropic`, and `@ai-sdk/openai` are not here. The `@ai-sdk/provider*` packages still under `node_modules` are Mastra's own transitive dependencies, not ours.

## The two worked examples

| | DISTILL | DELIVER |
|---|---|---|
| Shape | one fanout of four classifiers, then two merge branches | three nested bounded loops, nine leaves, eight branches |
| Cycles | none; the second merge is re-convergence, not a back edge | `cycle` ⊃ `test-loop`, `gates-loop`, each bounded at 2 |
| Decision space | a tuple: four classifiers answer once each | a sequence: a loop asks the same leaf again next iteration |
| Enumerated by | `cartesian(LANES, 4)` × two boundary flags | `enumeratePaths`, a walk of the reachable decision tree |
| Paths | **162** | **1270** |
| Wall clock | ~0.2 s | ~9.5 s |

### DELIVER, and why 1270

The DELIVER step cycle is the design's fixed graph: activate the acceptance test, observe RED, implement until green, refactor, gate, commit. Every leaf is a `runStep` with an injected model binding, exactly like DISTILL. Three of them classify and carry the enums the design names:

- `run-tests.red` → `red-observed | already-green | harness-failed`
- `run-tests` → `green | still-red | broke-other | harness-failed`
- `gates` → `clean | clippy-in-scope | mutation-below-gate | out-of-scope-structural`

The other six (`activate-at`, `implement`, `refactor`, `fix-lint`, `add-test`, `commit`) are generative. "Make this AT pass with the minimal change" is code generation, not a closed-enum decision, so their decision space is a singleton and the routable outcome downstream is something else: for `implement`, the **effect result**. It returns a `replace-symbol` effect and the branch after it routes `committed | conflict | rejected | infra-failed`, plus `exhausted` for "the validator was never satisfied". A conflict rebases onto the version the world moved to and retries inside the bound; `infra-failed` is distinct from `rejected` so a flaky harness does not burn the implement budget on a change that was fine.

Nothing runs a test or writes a symbol. The leaves classify evidence the state carries, and the in-memory executor returns `infra-failed` for `replace-symbol` because there is no VCS behind it. That outcome is **routed, not hidden**: a test drives `memoryEffects()` through the real graph and asserts the run parks under `write-infra-failed`.

**1270 paths** is every leaf decision, every effect result, and every loop count up to its bound, with unreachable combinations never run. The bounds are all 2, which is the smallest value that still exercises every edge: one iteration to reach a retry, a second to reach the bound. Raising them multiplies the walk without adding an edge. Coverage is asserted, not assumed: the walk visits every node the graph declares except `human.route` (reachable only by answering a suspension, which the resume tests cover), produces all eight declared `HUMAN_REASONS`, and produces both terminal kinds.

The walker itself is `enumeratePaths(runOnce)`: run with every choice at its first option, re-run forcing the last choice point to its next option, repeat until none is left. It requires the decision order to be a function of the decisions already made, so it covers sequential graphs and refuses a `fanout` by name rather than miscounting. DISTILL keeps its `cartesian` product.

**One `human` node, outside all three loops.** A loop body leaves only through the loop's own id, so an outcome that needs a person does not jump out of the cycle. It sets a block in state, every enclosing `until` goes true, the run unwinds, and `cycle.verdict` routes it. Reaching a bound arrives the same way with its own reason (`test-loop-exhausted`, `gates-loop-exhausted`, `cycle-exhausted`), so a person is told which budget was spent and how many times it ran. Because DELIVER's person sits outside the loops, the "a suspension inside a loop body resumes into the same iteration" guarantee is tested in `src/core/workflow.test.ts` against a hand-built graph, where the assertion can be exact: the trace reads `spin, ask, apply, spin, ask` rather than `spin, ask, spin, ask`.

## Deviations from the design

The document's code sketches are sketches. Where one of them is underspecified or does not survive contact with a type checker, here is what changed and why.

1. **`needs-human` is a suspension, not a terminal.** `Terminal<S>` is `accepted | rejected`; a fifth node type, `suspend`, parks the run. This is a change to the design document itself (§ Five rules, rule 3), made because the runner now has somewhere to park. `run` therefore returns a `RunOutcome<S>` — `{ kind: "terminal", terminal, trace, runId }` or `{ kind: "suspended", reason, trail, trace, runId }` — rather than `{ result, trace }`, and `resume(wf, runId, answer, execute)` continues the parked run.

2. **Three constructors, not one: `branch`, `suspend` and `loop`.** `branch<S, D>` ties an edge table to a decision union. `suspend<S, R>` is the same shape of guarantee one level over: it ties a `resumeSchema` to the `absorb` that consumes it, so a node cannot be built whose schema parses something its `absorb` does not accept. The erasure to `Node<S>` happens in those two functions and nowhere else. `loop<S>` needs no erasure; it exists so that the bound is a named, required field at every call site.

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

14. **Tests beyond the two in the document.** The document shows two tests. This repo ships 96, including the compiler's graph-bug rejections, six malformed-loop rejections, the snapshot assertions behind suspend/resume, a `Run.restart()` exercise, the `runStep` unit tests, the three mechanical checks, the effect executor's optimistic concurrency, the path walker's own arithmetic, and a source scanner that fails the build if `Date.now`, `Math.random`, or `new Date(` appears in the contract, the compiler, or any decision-function file. That scanner was verified by planting a violation in `compile.ts` and watching it fail.

15. **Nested workflow ids carry the path that reached them.** The previous cut named a branch tail `${branchId}=${key}`, which collides once a node is reachable by two different paths and has a branch of its own. DELIVER has exactly that shape: `commit` is reached from `cycle.verdict` and from `human.route`. Ids are now `${parentSegmentId}>${branchId}=${key}`, unique by construction. The top-level id is unchanged (`wf:${wf.start}`), so `resume` still reattaches.

16. **The engine's state carries loop counters as well as the trace.** It was `{ trace }`; it is now `{ trace, loops }`. Both need the same lifetime, which is "survives suspension", and that is what makes a run parked inside a loop body resume into the same iteration with the same count. `readTrace` is unchanged.

Source is ~4,600 lines: ~2,760 of implementation and ~1,840 of tests.

## Not built yet

- **Emitting a Mastra dynamic-workflow JSON definition from a `Workflow<S>`.** Mastra's dynamic workflows (beta) are the design's "graph topology as data" already built: a JSON graph over registered agents, tools, and nested workflows, validated and persisted by `addDynamicWorkflow()`. The compiler currently emits live `createStep` closures; emitting the JSON definition instead is what would let the authoring workflow write a graph without writing source.
- **Durable snapshots.** Suspend and resume run against `InMemoryStore`, so a parked run survives a fresh compile but not a process restart. Pointing the runtime at a durable adapter is a storage swap, and it is not wired.
- **Artifact rows in a real database.** `upsert-artifact` writes to a `Map` with a version column. The design's "artifacts are typed rows, not documents" — a schema you derive zod types from, so the row type and the step output type are one definition — is not here. Neither is the append-only event log.
- **Agent-native VCS integration.** `replace-symbol` and `run-tests` return `infra-failed` because no executor is wired. There is no lease, no typecheck gate, no test-impact graph, no symbol-set-difference check. `infra-failed` rather than `rejected` is the honest answer and is asserted as such: the DELIVER example routes it to a person under `write-infra-failed` rather than swallowing it. The consequence for DELIVER is that its `deliver.implement-to-the-design` requirement carries no mechanical check, only a model refuting against the rule text; the symbol-set difference that would make it mechanical needs the symbol inventory.
- **Real test execution.** DELIVER's `run-tests` leaves classify evidence the state carries, not output they produced. Nothing shells out, and the `evidence` field is seeded by the caller. Wiring it is a `run-tests` effect executor plus the test-impact graph above.
- **The parallel scheduler.** Roadmap steps as a DAG in rows, `step_edges` derived from declared symbol overlap, a frontier of steps whose in-edges are all `accepted`, and resource leases for shared test infrastructure. `fanout` runs one node's sub-steps concurrently; that is not a scheduler.
- **The authoring workflow.** Bootstrap step 4: requirement rows in, graph rows out, diffed against the hand-written graph. Nothing generates a graph; both DISTILL and DELIVER are hand-written, which is what makes them the oracle.
- **Graph topology as data.** Nodes and edges are TypeScript, not rows. Exhaustiveness is the compiler's red squiggle, not a constraint query. The design takes the middle path; this prototype takes the typed end of it.
- **`symbol-diff.ts`.** The fourth mechanical check in the design's `checks/` listing needs a symbol inventory, which needs the VCS.
- **Escalation cost accounting.** `escalateTo` fires once after the attempt budget, as specified, but nothing measures cost per completed task — the open question the design says should be answered before the legibility argument is used to justify the approach.
