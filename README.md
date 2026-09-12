# deterministic-workflows

A prototype of the framework described in [`DETERMINISTIC-WORKFLOWS.md`](./DETERMINISTIC-WORKFLOWS.md): a finite graph owns control flow, small models own one decision each, and the whole path space is enumerable before anything runs.

The property the rest of the design rests on is testable in this repo right now: **162 paths through the DISTILL classification graph, zero model calls, no API key, no network, 50 ms.**

## Install, test, run

```bash
bun install
bun test          # 36 tests, no network, no key
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

It pushes one scenario through four real classifiers and prints each lane verdict, the merge verdict, the terminal, and the trace.

## Map to the design document

| Path | Implements |
|---|---|
| `src/core/requirement.ts` | § Primitives → Requirement. The rule as a row: verbatim text, FK to its source, closed decision space, optional mechanical check. |
| `src/core/step.ts` | § Step: a worker paired with a validator, always. `stepOutput`, `StepDef`, `Attempt`, `StepResult`, `journalKey`, `runStep` and its six guardrails. |
| `src/core/workflow.ts` | § Workflow graph and runner. `NodeId`, `Terminal`, `Node`, `Workflow`, `branch`, `run`. |
| `src/core/effects.ts` | § Effects with typed results. The `Effect` / `EffectResult` unions plus an in-memory executor with optimistic concurrency. |
| `src/core/journal.ts` | § Journal. The interface, an in-memory implementation, and a persistent one on `bun:sqlite`. |
| `src/checks/` | § Framework versus consumer → "a library of mechanical checks": `verbatim.ts`, `enum-member.ts`, `id-in-set.ts`. |
| `src/harness/` | § Framework versus consumer → "test harness": `stub-journal.ts`, `enumerate-paths.ts`, `matchers.ts`. |
| `src/examples/distill/` | § Worked example: DISTILL test-lane classification. Bootstrap steps 2 and 3 — the known-good hand-written graph and its requirement rows. |

`src/examples/distill/smoke.ts` also holds the Mastra model binding, because the design's framework/consumer table puts "which small models, which validator family" on the consumer side.

## Substrate: Mastra for agents, a hand-written runner for the graph

**Decision: the graph runner is the design's hand-written runner. Mastra is used for agents only.**

Mastra Workflows were evaluated properly, not dismissed. A probe (`createWorkflow().then().branch().commit()`, `createRun()`, `start()`) runs standalone with no `Mastra` instance, no storage adapter, and no network, at ~0.15 ms per run — so guarantee 7 (exhaustive enumeration with a stub journal, in the normal test suite) is *not* what rules it out. Four things do:

1. **`.branch()` is a predicate list, not an edge table.** Mastra takes `[[async ({inputData}) => boolean, step], ...]`, evaluated in order. Nothing makes the list total over a decision union. The design's `branch<S, D>(on, edges: Record<D, NodeId>)` could compile *down* to that list and keep compile-time exhaustiveness at my surface — but every guarantee below it would have to be re-established by hand.
2. **The graph is not a chain.** `Workflow<S> = { start, nodes: Record<NodeId, Node<S>> }` is an arbitrary directed graph with cycles. The design's own DELIVER step cycle is explicitly cyclic — `gates → fix-lint → gates`, `run-tests → implement → run-tests`. Mastra's builder is a linear chain of combinators; cycles need `dountil` / `dowhile` wrappers, and arbitrary re-entry into an earlier node is not expressible. Hosting the runner on Mastra would work for the acyclic DISTILL example and break at the second graph in the document.
3. **The trace would be lossy.** The design's trace is `NodeId[]`, ordered and repeating — the provenance record, and the thing a bounded-retry assertion reads. Mastra returns `steps` keyed by step id, so a node visited twice collapses to one key. Its `stepExecutionPath` did not include the branch target at all in the probe.
4. **Terminals are three differently-shaped variants.** Mastra requires all branch targets to share one input/output schema and keys the result by the executed step's id. `accepted` / `rejected` (carries a trail) / `needs-human` (carries a typed reason) would have to be flattened into one schema and re-widened after.

Each of these is surmountable alone. Together they mean writing a compatibility layer larger than the ~100-line runner it replaces, whose failure modes are Mastra's rather than the design's. The design's own framework/consumer table already claims the runner for the framework; this keeps that line.

Mastra earns its place at the leaves, which is where the work actually is: `Agent` with `structuredOutput`, provider credential resolution, the model router, retries, and the schema-compat layer that makes one zod schema work across provider APIs.

### Dependencies

`@mastra/core` and `zod`. That is the whole list.

Mastra's only peer dependency is `zod`. Its model router takes a `provider/model` string (`anthropic/claude-haiku-4-5`), resolves `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment itself, and needs no provider package — so `ai`, `@ai-sdk/anthropic`, and `@ai-sdk/openai` were removed from the scaffold. The `@ai-sdk/provider*` packages still under `node_modules` are Mastra's own transitive dependencies, not ours.

## Deviations from the design

The document's code sketches are sketches. Where one of them is underspecified or does not survive contact with a type checker, here is what changed and why.

1. **`LanguageModel` → `ModelBinding`.** The sketches import `LanguageModel` from the Vercel AI SDK, which is gone. `StepDef`'s three model slots now take `ModelBinding` — `{ id, generate({system, prompt, schema}) }`. This is the seam that lets the whole test suite run with fakes: no agent constructed, no key read, no socket opened. `Attempt.model` carries `binding.id`, where the sketch had `model.modelId`.

2. **The fanout merge is a changed-keys patch, not a spread.** The sketch's `outs.reduce((acc, s) => ({...acc, ...s}), state)` is wrong for any state with more than one field. Each fanout sub-step returns a *whole* state computed from the pre-fanout state, so spreading them in order lets the last sub-step's unchanged copies overwrite every earlier sub-step's work. In the worked example that silently drops three of four classifier verdicts, and — because `exhausted` would be lost the same way — routes `undecidable` to `accepted`. That is a trajectory change, not a cosmetic one. The runner now diffs each sub-step's result against the common pre-fanout ancestor and merges only the keys it changed. Still positional, so completion order still cannot change the trajectory; two sub-steps writing the same key is a graph-authoring mistake and the later one wins in declaration order. Regression-locked by `exhaustion is detected regardless of which classifier exhausted`.

3. **The example's `State` uses one slot per classifier.** The sketch's `anchors: Record<string, string>` and `exhausted: Kind[]` are *shared* fields that all four classifiers write. No shallow merge can keep four writes to one key. `State` now carries `e2e | expectation | benchmark | dst: { lane?, anchor?, exhausted? }`, so each sub-step writes exactly one top-level key and the merge is lossless. Consequence for the document's second test: `result.state.expectation` becomes `result.state.expectation.lane`.

4. **The journal key keeps the step id and version in plain text.** The sketch hashes `id`, `version`, and the input together into one opaque digest. The prose says "keyed by (step id, step version, input hash)", so the key is now literally `<step id>@<version>:<sha256 of input>`. Same three components, same collision resistance on the input, and the stub journal can answer by step id without knowing the input — which is what makes the enumeration harness a dozen lines instead of a hundred. `journalKey` is exported for the same reason.

5. **Input canonicalisation is a recursive sort, not a replacer array.** The sketch uses `JSON.stringify(input, Object.keys(input).sort())`. A replacer *array* is a key allowlist applied at every nesting level, so any nested key not also present at the top level is silently dropped from the hash — two different inputs can collide. `canonicalJson` sorts keys recursively instead.

6. **`stepOutput` takes `readonly [string, ...string[]]`.** With the sketch's `[string, ...string[]]`, `z.enum(...).options` (a plain array in zod 4) does not typecheck as an argument. Widening to `readonly` accepts a `as const` tuple and preserves literal inference, so `decision` is still a closed union.

7. **A thrown model call becomes a trail entry.** `runStep` returns exactly the two documented variants, so a provider error must not escape. Worker and validator calls are wrapped; a failure records `{ model, violations: [], error }` and the loop continues to the next attempt. `Attempt` gained `error?: string` and its `output` is now optional, so the trail stays complete when the call produced nothing. Everything else about `Attempt` is unchanged.

8. **Graph bugs still throw, as the document specifies.** A missing node, a missing edge, a fanout target that is not a step, and a step input that fails its own schema are all caller errors — the graph was built wrong. They throw, and `graphDefects()` plus the type checker catch them before any model runs. Guarantee 3 is about *decision* outcomes being data; those are, without exception.

9. **The journal records successes only.** As in the sketch: `validator-exhausted` is not written back, so a replay retries an exhausted step rather than replaying the exhaustion. Stated because it is load-bearing for replay semantics and the sketch does not say it out loud.

10. **`fileJournal` was replaced by `sqliteJournal`.** The scaffold had a JSON-file journal that rewrites the whole file per put. `bun:sqlite` with `INSERT OR REPLACE` was asked for and is strictly better.

11. **Tests beyond the two in the document.** The document shows two tests. This repo ships 36, including the `runStep` unit tests, the three mechanical checks, the effect executor's optimistic concurrency, and a source scanner that fails the build if `Date.now`, `Math.random`, or `new Date(` appears in the runner or any decision-function file. That scanner was verified by planting a violation and watching it fail.

Source is ~1,760 lines: ~1,095 of implementation and ~665 of tests.

## Not built yet

- **Artifact rows in a real database.** `upsert-artifact` writes to a `Map` with a version column. The design's "artifacts are typed rows, not documents" — a schema you derive zod types from, so the row type and the step output type are one definition — is not here. Neither is the append-only event log.
- **Agent-native VCS integration.** `replace-symbol` and `run-tests` return `infra-failed` because no executor is wired. There is no lease, no typecheck gate, no test-impact graph, no symbol-set-difference check. `infra-failed` rather than `rejected` is the honest answer and is asserted as such.
- **The DELIVER step-cycle graph.** The fixed RED → GREEN → COMMIT graph, its bounded retry loops, and the `gates` branch. This is the graph that needs cycles, and the reason the runner is not hosted on Mastra Workflows.
- **The parallel scheduler.** Roadmap steps as a DAG in rows, `step_edges` derived from declared symbol overlap, a frontier of steps whose in-edges are all `accepted`, and resource leases for shared test infrastructure. `fanout` runs one node's sub-steps concurrently; that is not a scheduler.
- **The authoring workflow.** Bootstrap step 4: requirement rows in, graph rows out, diffed against the hand-written graph. Nothing generates a graph; the DISTILL graph is hand-written, which is what makes it the oracle.
- **Graph topology as data.** Nodes and edges are TypeScript, not rows. Exhaustiveness is the compiler's red squiggle, not a constraint query. The design takes the middle path; this prototype takes the typed end of it.
- **`symbol-diff.ts`.** The fourth mechanical check in the design's `checks/` listing needs a symbol inventory, which needs the VCS.
- **Escalation cost accounting.** `escalateTo` fires once after the attempt budget, as specified, but nothing measures cost per completed task — the open question the design says should be answered before the legibility argument is used to justify the approach.
