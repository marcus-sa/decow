# `@des/core`

The framework. A finite graph owns control flow, small models own one decision
each, and the whole path space is enumerable before anything runs.

Nothing here imports `@des/server` or `@des/ui`. The dependency runs one way,
always: the examples depend on the server, the server depends on this, and
nothing depends back.

| Subpath | What it is |
|---|---|
| `@des/core/workflow` | The contract: `Node`, `Workflow`, `Terminal`, the four constructors (`branch`, `suspend`, `loop`, `leaf`), `run` and `resume`. |
| `@des/core/step` | `StepDef` with its mandatory validator, `runStep` and its six guardrails, `ModelBinding`, the attempt observer. |
| `@des/core/effects` | The `Effect` / `EffectResult` unions, the in-memory executor, the oracle measurement and the command result. |
| `@des/core/commands` | The consumer's `Commands` contract, and the one process runner behind every command the framework runs. |
| `@des/core/journal` | Keyed by `(step id, version, input hash)`. In memory, or on `bun:sqlite`. |
| `@des/core/compile` | The compiler from the node map to a Mastra workflow, the durable runtime, and the run-event projection. |
| `@des/core/scheduler` | The frontier, the concurrency limit, the resource leases. Generic in steps. |
| `@des/core/requirement` | The rule as a row: verbatim text, a foreign key, a closed decision space, an optional mechanical check. |
| `@des/core/artifacts` | Typed rows on `bun:sqlite`: one version column, one append-only event log, one time-travel read. |
| `@des/core/vcs` | The agent-native VCS: symbol inventory, identity registry, leases, the write path and its verification gate. |
| `@des/core/harness` | `inspectGraph`, `enumeratePaths`, `scriptedExecutor`, and the trace matchers. |
| `@des/core/harness/scripted-binding` | The ONE way a test stubs a leaf: a `ModelBinding` that answers from a script. |
| `@des/core/harness/no-replay` | A journal that answers nothing and keeps nothing, for a walk that must not replay. |
| `@des/core/bindings/mastra` | One model call, through a Mastra Agent at temperature 0. |
| `@des/core/bindings/claude-code` | A Claude Code subagent, in the opaque or the proposal shape. |
| `@des/core/checks/*` | The mechanical checks: `verbatim`, `enum-member`, `id-in-set`. |

## A leaf is stubbed at the BINDING, never at the journal

`scriptedBinding(script)` is the one stub mechanism. A script is keyed by STEP
ID, per attempt; each entry is a decision plus a payload — validated against
the leaf's own output schema — or an error the call throws, and a step with no
script refuses by name. So a stubbed leaf runs the WHOLE step: the schema, the
mechanical checks, and a validator that passes, because the scripted worker's
answer is the decision under test.

It replaced a stub journal, and the reason is not convenience. A seeded journal
short-circuits `runStep` before any model is reached, so a test using one
exercised none of the three — and, worse, the composition had to grow a hook so
the test could compute the journal key `runStep` would compute. That is
production shaped by its tests. A binding is the seam production already has.

Running the checks is not free of consequence: see the README's
[worked examples](../../README.md#the-four-worked-examples) for the two graphs
whose enumerated path counts MOVED when the checks their leaves carry started
firing.

`noReplayJournal()` is what survived the stub journal, and it is the half that
was never about seeding. `enumeratePaths` re-runs a workflow once per path, and
a leaf inside a bounded loop is a choice point — a real journal would replay
its first answer and delete every path below it. Replay is the one thing a walk
must have off, and that is journal-level control a binding cannot give.

The exports map is over the TypeScript sources: bun runs `.ts` directly, so
there is no build step and no compiled copy between a stack trace and its
source. A consumer never reaches a relative path into this package.

Full detail: [`../../README.md`](../../README.md) and
[`../../DETERMINISTIC-WORKFLOWS.md`](../../DETERMINISTIC-WORKFLOWS.md).
