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
| `@des/core/strict-schema` | Whether a schema is one a strict structured-output endpoint can answer, and the refusal `stepOutput` and `stepDef` make from it. |
| `@des/core/effects` | The `Effect` / `EffectResult` unions, the in-memory executor, the oracle measurement and the command result. |
| `@des/core/commands` | The consumer's `Commands` contract, and the one process runner behind every command the framework runs. |
| `@des/core/journal` | Keyed by `(step id, version, input hash)`. In memory, or on `bun:sqlite`. |
| `@des/core/compile` | The compiler from the node map to a Mastra workflow, the durable runtime, and the run-event projection. |
| `@des/core/scheduler` | The frontier, the concurrency limit, the resource leases. Generic in steps. |
| `@des/core/requirement` | The rule itself: verbatim text, a foreign key to its source, a closed decision space, an optional mechanical check. |
| `@des/core/artifacts` | Typed rows on `bun:sqlite`: one version column, one append-only event log, one time-travel read. |
| `@des/core/vcs` | The agent-native VCS: symbol inventory, identity registry, leases, the write path and its verification gate. |
| `@des/core/harness` | `inspectGraph`, `enumeratePaths`, `scriptedExecutor`, and the trace matchers. |
| `@des/core/harness/scripted-binding` | The ONE way a test stubs a leaf: a `ModelBinding` that answers from a script. |
| `@des/core/harness/no-replay` | A journal that answers nothing and keeps nothing, for a walk that must not replay. |
| `@des/core/bindings/mastra` | One model call, through a Mastra Agent at temperature 0, against a router id or an OpenAI-compatible endpoint. |
| `@des/core/bindings/claude-code` | A Claude Code subagent, in the opaque or the proposal shape. |
| `@des/core/checks/*` | The mechanical checks: `verbatim`, `enum-member`, `id-in-set`. |

## A schema is valid for strict structured output, or it is refused

A binding puts a step's output schema to an endpoint as
`response_format: { type: "json_schema", strict: true, schema }`. Strict mode is
a **narrower schema language**, not the same language enforced — and a schema
outside it is not refused as a schema: the provider stops constraining the
answer and returns whatever it felt like, which surfaces at the step's own zod
re-parse three layers from the cause.

So `stepOutput` refuses one, and names every defect: a property not in
`required` (`.optional()` is what leaves one out — write `.nullable()`), an
object without `additionalProperties: false`, an object with no properties at
all, a subschema that constrains nothing, a root that is not an object, and a
construct zod cannot convert (`z.custom()`). `stepDef` catches the schemas
`stepOutput` did not build, which is what a leaf picking one of four shapes at
run time and casting needs. Either way the failure is at **import**, where the
schema is.

`strictJsonSchema` is the conversion the wire actually carries — zod's draft-7
conversion at Mastra's target, plus the object closure Mastra applies on the
way out — and `bindings/mastra.endpoint.test.ts` asserts a real `Agent` sends
exactly that, for a real leaf's schema, against a real loopback endpoint.

Keyword restrictions OpenAI has relaxed over time (`maxLength`, `pattern`,
`minItems`, …) are **not** checked: nothing available offline says which of
them a strict endpoint rejects today, and guessing would refuse
`z.string().max(600)`.

## A model is a router id or an OpenAI-compatible endpoint

`mastraAgent({ model })` takes either. A **string** is Mastra's model-router
id, `provider/model`, and the router resolves that provider's key out of the
environment itself. An **object** is an `OpenAICompatibleConfig` — Mastra's own
type, imported rather than restated — carrying a `url`, an `apiKey` and
headers of the caller's choosing, which is what a gateway, a proxy or a model
served locally looks like from here. The object reaches `Agent` unchanged, so a
field this binding does not know about survives. The binding's `id` — what
lands in `Attempt.model` and in `leaf_attempts.model_id` — is the string, or
`providerId/modelId`, or the config's own `id`; `options.id` overrides it.

The **credential is refused at the leaf**, on the attempt, and what a call needs
is read off the config: an endpoint carrying its own `apiKey`, or one naming
its own `url`, needs nothing from the environment and is never refused, while a
bare router string needs the variables Mastra's registry declares for that
provider. A server therefore starts without a key and stays readable, and the
refusal lands in the run's trail where a person reads it.

Two caveats belong to the endpoint rather than to the binding. **Structured
output depends on the endpoint honouring the schema**: the step re-parses every
answer with its own zod schema, so an endpoint that returns prose or a
differently-shaped object fails the parse — visibly, as a trail entry and a
`validator-exhausted` run, never as a silent wrong answer. And **token usage
may be absent**, in which case the attempt records no counts rather than zeros.

## A leaf is stubbed at the BINDING, never at the journal

`scriptedBinding(script)` is the one stub mechanism. A script is keyed by STEP
ID, per attempt; each entry is a decision plus a payload — validated against
the leaf's own output schema — or an error the call throws, and a step with no
script refuses by name. So a stubbed leaf runs the WHOLE step: the schema, the
mechanical checks, and a validator that passes, because the scripted worker's
answer is the decision under test.

The alternative is seeding the journal, and it is not merely less convenient. A
seeded journal short-circuits `runStep` before any model is reached, so a test
using one exercises none of the three — and, worse, the composition has to grow
a hook so the test can compute the journal key `runStep` would compute. That is
production shaped by its tests. A binding is the seam production already has.

Running the checks shapes the path space: see the README's
[worked examples](../../README.md#the-four-worked-examples) for what the
enumerated counts mean.

`noReplayJournal()` is journal-level control, which is the half a binding
cannot give. `enumeratePaths` re-runs a workflow once per path, and a leaf
inside a bounded loop is a choice point — a real journal would replay its first
answer and delete every path below it. Replay is the one thing a walk must have
off.

The exports map is over the TypeScript sources: bun runs `.ts` directly, so
there is no build step and no compiled copy between a stack trace and its
source. A consumer never reaches a relative path into this package.

Full detail: [`../../README.md`](../../README.md) and
[`../../DETERMINISTIC-WORKFLOWS.md`](../../DETERMINISTIC-WORKFLOWS.md).
