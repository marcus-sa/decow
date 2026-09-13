# `@des/core`

The framework. A finite graph owns control flow, small models own one decision
each, and the whole path space is enumerable before anything runs.

Nothing here imports `@des/server` or `@des/ui`. The dependency runs one way,
always.

| Subpath | What it is |
|---|---|
| `@des/core/workflow` | The contract: `Node`, `Workflow`, `Terminal`, the four constructors (`branch`, `suspend`, `loop`, `leaf`), `run` and `resume`. |
| `@des/core/step` | `StepDef` with its mandatory validator, `runStep` and its six guardrails, `ModelBinding`, the attempt observer. |
| `@des/core/effects` | The `Effect` / `EffectResult` unions, the in-memory executor, the oracle measurement and the command result. |
| `@des/core/commands` | The consumer's `Commands` contract, and the one process runner behind every command the framework runs. |
| `@des/core/journal` | Keyed by `(step id, version, input hash)`. In memory, or on `bun:sqlite`. |
| `@des/core/compile` | The compiler from the node map to a Mastra workflow, the durable runtime, and the run-event projection. |
| `@des/core/scheduler` | The frontier, the concurrency limit, the resource leases. Generic in rows. |
| `@des/core/requirement` | The rule as a row: verbatim text, a foreign key, a closed decision space, an optional mechanical check. |
| `@des/core/artifacts` | Typed rows on `bun:sqlite`: one version column, one append-only event log, one time-travel read. |
| `@des/core/vcs` | The agent-native VCS: symbol inventory, identity registry, leases, the write path and its verification gate. |
| `@des/core/harness` | `inspectGraph`, `enumeratePaths`, `scriptedExecutor`, and the trace matchers. |
| `@des/core/harness/stub-journal` | The journal that stands in for every model, so a graph walks with zero inference. |
| `@des/core/bindings/mastra` | One model call, through a Mastra Agent at temperature 0. |
| `@des/core/bindings/claude-code` | A Claude Code subagent, in the opaque or the proposal shape. |
| `@des/core/checks/*` | The mechanical checks: `verbatim`, `enum-member`, `id-in-set`. |

The exports map is over the TypeScript sources: bun runs `.ts` directly, so
there is no build step and no compiled copy between a stack trace and its
source. A consumer never reaches a relative path into this package.

Full detail: [`../../README.md`](../../README.md) and
[`../../DETERMINISTIC-WORKFLOWS.md`](../../DETERMINISTIC-WORKFLOWS.md).
