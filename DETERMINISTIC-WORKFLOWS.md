# Deterministic Agent Workflows

A framework for building software with many small models inside workflows that are deterministic, exhaustively testable, and authored by AI once rather than interpreted by AI on every run. This is a new project. Overdrive is the first consumer and the worked example throughout; nothing here belongs to Overdrive.

## Thesis

Today a frontier model is trusted with judgment on every run. It reads a directory of rules files, decides which apply, branches, executes, and grades itself. The rules are prose. The branching is invisible. Whether the same input produces the same path depends on the model's mood.

Invert it. Use a frontier model once, per rule change, to generate a workflow graph. From then on the graph owns control flow and small models own one decision each. Every small model's output is checked by something cheaper and more deterministic than itself: a schema, a mechanical predicate, then a second small model whose only job is to refute the first against a short list of requirements.

The model fills in values. It never picks a transition.

This is a codemod stance. AI generates code that is more deterministic than AI, so that AI has correct instructions, context, and guardrails to run inside. Workflows do not fit inside the AI. The AI fits inside the workflows.

## Why rules as prose fail

The rules files that drive agents in a project like Overdrive run to tens of thousands of words. They are written as decision tables, symptom lists, and precedents. A frontier model reads them well. It also reads them differently each time, and the reader has no way to enumerate the paths it might take.

Testing is the sharpest case. Overdrive has four test tiers, an executed-evidence catalogue, and a classification table separating expectations from E2E tests from benchmarks. Deciding which lanes a scenario needs is a judgment the frontier model makes per scenario, inside a DISTILL dispatch, with the whole rules file in context. Three things are wrong with that:

- The decision space is closed (a handful of lanes) but the model's output is open (prose, then a scaffold).
- The cross-cutting rules (a benchmark is never an expectation; a boundary-crossing scenario needs a composed-system proof) are applied by the same model that made the leaf decisions, so a mistake in one masks the other.
- Nothing can test the decision procedure without running the model.

The same shape repeats for reconciler-versus-workflow triage, deferral handling, API-surface conformance, and every other rule that ends in "symptoms during review."

## Five rules that make a workflow deterministic

The workflow is a finite graph. Every path through it is enumerable before it runs.

1. **Only enums and booleans drive edges.** Every step output splits into `decision`, a closed enum the graph may branch on, and `payload`, free text the graph carries but never reads.
2. **Every branch's edge table is exhaustive at compile time.** A branch over a decision type `D` takes `Record<D, NodeId>`. Adding a decision value without an edge is a type error.
3. **Terminals are enumerated, not thrown, and a person is a suspension rather than a terminal.** A workflow ends in `accepted` or `rejected`. No exception crosses the graph boundary. A step that cannot produce a valid output returns a state carrying that fact, and a branch routes it. When the branch routes to a person, the run does not end: a `needs-human` node **suspends**, parking the run with a typed reason and the trail behind it. The person answers with a value from a closed decision enum, the graph branches on that answer, and the same run continues to a terminal. A person is another input the graph reads, not a place the graph stops.
4. **Effects are data.** A step returns `Effect[]`. The runner executes them and feeds typed results back into state. Steps never touch a filesystem, a database, or a network directly.
5. **Repetition is a bounded `loop` node, and a back edge is rejected.** A retry, a fix-and-recheck, a cycle that repeats until a gate comes back clean: each is a `loop` node naming the sub-graph it repeats, the condition that ends it, and a required `max`. There is no unbounded form, because rule 1 buys a finite path space only if the number of times an edge can be taken is finite too. An arbitrary back edge in the node map is refused by name rather than compiled, so the one way to repeat is the one way that stays enumerable.

Given these, the graph's path space is finite, so you can enumerate it with a stub model and assert every path lands on a declared outcome: a terminal, or parked for a person. No API key, no network, milliseconds. That is the property the rest of this document builds on.

What is not deterministic: the leaf model calls. The framework does not need them to be. It needs their output space to be closed, their outputs validated, and their results journaled so a replay never re-infers.

## Primitives

The framework is provider-agnostic at the leaves. The step sketches below use the Vercel AI SDK because it is the thinnest layer, and a step's model slot is a one-method seam any provider can fill. The graph is not provider-agnostic: it compiles to Mastra, for the reasons in "Workflow graph and runner" below.

### Requirement

A requirement is a row, not a paragraph. It carries the rule verbatim, a foreign key to its source, the closed decision space it admits, and optionally a mechanical check that runs with no model.

```ts
export type Violation = { requirementId: string; evidence: string };

export type Requirement<Ctx = unknown> = {
  id: string;                 // "testing.classify.cohort-is-never-expectation"
  sourceId: string;           // FK to the rules row this came from
  text: string;               // the rule, verbatim
  decisions: readonly string[];  // the closed enum a step bound to this rule may return
  check?: (ctx: Ctx) => Violation | null;  // deterministic, no LLM
};
```

Mechanical checks are the cheapest guardrail and run first. A check that the model quoted its input verbatim, that an id it cited exists, or that an enum value it returned is in the declared set costs nothing and catches the most common failure: a plausible-sounding answer with no grounding.

### Step: a worker paired with a validator, always

A step is one small-model call with a strict output schema, followed by a second small model that tries to refute the output against the step's requirements. The validator is mandatory by type. You cannot construct a step without one.

The output schema has a fixed shape. `decision` is the only field the graph reads.

```ts
import { z } from "zod";

export const stepOutput = <D extends [string, ...string[]], P extends z.ZodRawShape>(
  decision: D,
  payload: P,
) => z.object({ decision: z.enum(decision), payload: z.object(payload) });
```

The step definition, the validator's verdict schema, and the result type:

```ts
import { generateObject, type LanguageModel } from "ai";
import { createHash } from "node:crypto";

const Verdict = z.object({
  verdict: z.enum(["pass", "fail"]),
  violations: z.array(z.object({
    requirementId: z.string(),
    evidence: z.string().describe("Verbatim quote from the output that breaks the rule"),
  })),
});

export type StepDef<I, O> = {
  id: string;
  version: number;                      // bump on prompt change; changes the journal key
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  requirements: Requirement<{ input: I; output: O }>[];
  worker: { model: LanguageModel; system: string; prompt: (input: I) => string };
  validator: { model: LanguageModel };  // a different model family refutes more independently
  maxAttempts: number;
  escalateTo?: LanguageModel;
};

export type Attempt<O> = { model: string; output: O; violations: Violation[] };

export type StepResult<O> =
  | { decision: "ok"; output: O }
  | { decision: "validator-exhausted"; trail: Attempt<O>[] };

export interface Journal {
  get<O>(key: string): Promise<O | undefined>;
  put<O>(key: string, value: O): Promise<void>;
}

// Canonical JSON, not `JSON.stringify(input, Object.keys(input).sort())`. A
// replacer *array* is a key allowlist applied at every nesting level, so a
// nested key absent from the top level is dropped from the hash and two
// different inputs collide. Sort recursively instead.
const canonicalJson = (v: unknown): string =>
  v === null || typeof v !== "object" ? JSON.stringify(v) ?? "null"
  : Array.isArray(v) ? `[${v.map(canonicalJson).join(",")}]`
  : `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;

const journalKey = (def: StepDef<any, any>, input: unknown) =>
  `${def.id}@${def.version}:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
```

`runStep` never throws. Mechanical checks run before the validator model is spent. Violations feed back into the next attempt. After the budget, one escalation to a larger model, then a typed failure that preserves the whole trail.

```ts
export async function runStep<I, O>(def: StepDef<I, O>, raw: unknown, journal: Journal): Promise<StepResult<O>> {
  const input = def.input.parse(raw);                      // guardrail 1: typed input
  const key = journalKey(def, input);
  const replayed = await journal.get<StepResult<O>>(key);  // guardrail 2: replay beats re-inference
  if (replayed !== undefined) return replayed;

  const trail: Attempt<O>[] = [];
  const models = [...Array(def.maxAttempts).fill(def.worker.model), ...(def.escalateTo ? [def.escalateTo] : [])];

  for (const model of models) {
    const feedback = trail.at(-1)?.violations ?? [];
    const { object: output } = await generateObject({
      model,
      temperature: 0,
      schema: def.output,                                    // guardrail 3: output space is the schema
      system: def.worker.system,
      prompt: def.worker.prompt(input) + (feedback.length
        ? `\n\nYour previous attempt violated:\n${feedback.map(v => `- ${v.requirementId}: "${v.evidence}"`).join("\n")}`
        : ""),
    });

    // guardrail 4: mechanical checks before spending a second model call
    const mechanical = def.requirements
      .map(r => r.check?.({ input, output }) ?? null)
      .filter((v): v is Violation => v !== null);
    if (mechanical.length) { trail.push({ model: model.modelId, output, violations: mechanical }); continue; }

    // guardrail 5: an independent model tries to refute the output
    const { object: verdict } = await generateObject({
      model: def.validator.model,
      temperature: 0,
      schema: Verdict,
      system: "You are an adversarial reviewer. Your job is to REFUTE the output against the requirements. Default to 'fail' when a requirement is dodged, paraphrased, or unaddressed. Cite requirement ids only from the list you were given.",
      prompt: JSON.stringify({ requirements: def.requirements.map(({ id, text }) => ({ id, text })), input, output }),
    });

    // guardrail 6: the validator is itself mechanically validated. Invented rule ids are noise, not rejections.
    const known = new Set(def.requirements.map(r => r.id));
    const violations = verdict.violations.filter(v => known.has(v.requirementId));

    if (verdict.verdict === "pass" && violations.length === 0) {
      const result: StepResult<O> = { decision: "ok", output };
      await journal.put(key, result);
      return result;
    }
    trail.push({ model: model.modelId, output, violations });
  }

  return { decision: "validator-exhausted", trail };
}
```

Two design choices worth defending. Temperature zero is not for determinism; it narrows the distribution so retries with feedback converge instead of wandering. Mixing model families for worker and validator is the reason to stay provider-agnostic: a Haiku worker refuted by a GPT-mini validator shares fewer blind spots than Haiku refuting Haiku.

The model slot is one method. It takes a system prompt, a prompt and a schema, and returns something the schema accepts. That is the seam where an agent plugs in, not just a provider. A Claude Code subagent is a binding: from the step's side there is no difference between one model call and a subagent that spent forty turns reading a checkout, as long as what comes back satisfies the schema and the decision is a member of the closed enum. There are two shapes of that, and the difference is not stylistic. In the **opaque** shape the agent edits the workspace itself and returns only the object; the writes happened outside the effect boundary, so the framework cannot lease them, verify them, or roll them back, and a lease conflict is unrepresentable because nothing ever crossed the boundary where a version check could happen. In the **proposal** shape the agent still edits, because a tool set is what makes it an agent rather than a chat — but it edits a *scratch copy*, and afterwards the copy is diffed: every changed file under the allowed paths becomes a `write-file` or a `replace-symbol` effect, and the runner commits them through the agent-native VCS, under a lease, with the write-boundary gate and the task id as the intent. A conflict comes back as a decision value a branch routes, and a byte moved outside the allowed paths refuses the whole turn before any effect is emitted. The VCS is what makes the second shape possible, which is why it is the data plane in "The agent-native VCS is the effect executor and mechanical verifier" below and not an optional extra.

### Workflow graph and runner

Six node types. `branch` is the load-bearing one: its edge table is typed by the decision union. `suspend` is the same guarantee one level over: it ties the schema a person answers with to the function that folds that answer into state. `loop` is the third: it ties a sub-graph to the condition that ends it and the bound that ends it anyway. `leaf` is the fourth constructor and the only one that is not about types: it builds an ordinary `step` node around one `runStep` call and owns the exhaustion trail, so a graph author cannot forget to record why a validator was never satisfied.

```ts
export type NodeId = string;

export type Terminal<S> =
  | { kind: "accepted"; state: S }
  | { kind: "rejected"; state: S; trail: unknown[] };

export type Node<S> =
  | { type: "step";     run: (s: S) => Promise<{ state: S; effects: Effect[] }>;
                        absorb: (s: S, results: EffectResult[]) => S; next: NodeId }
  | { type: "fanout";   steps: NodeId[]; join: NodeId }
  | { type: "branch";   on: (s: S) => string; edges: Record<string, NodeId> }
  | { type: "loop";     body: NodeId;                // the sub-graph one iteration runs
                        until: (s: S) => boolean;    // a decision function, pure like `on`
                        max: number;                 // required, positive; no unbounded form
                        absorb: (s: S, exit: LoopExit) => S; next: NodeId }
  | { type: "suspend";  reason: (s: S) => string;      // a closed enum per workflow
                        trail: (s: S) => unknown[];    // the evidence behind it
                        resumeSchema: z.ZodType<unknown>;
                        absorb: (s: S, answer: never) => S; next: NodeId }
  | { type: "terminal"; done: (s: S) => Terminal<S> };

// What a loop tells `absorb` on the way out. This is the whole surface through
// which "the bound was reached" becomes something a following branch can route.
export type LoopExit = { iterations: number; exhausted: boolean };

export type Workflow<S> = { start: NodeId; nodes: Record<NodeId, Node<S>> };

export const branch = <S, D extends string>(on: (s: S) => D, edges: Record<D, NodeId>): Node<S> =>
  ({ type: "branch", on, edges });

// The erasure to `Node<S>` happens here and nowhere else, so a node cannot be
// built whose schema parses something its `absorb` does not accept.
export const suspend = <S, R>(spec: {
  reason: (s: S) => string;
  trail: (s: S) => unknown[];
  resumeSchema: z.ZodType<R>;
  absorb: (s: S, answer: R) => S;
  next: NodeId;
}): Node<S> => ({ type: "suspend", ...spec }) as Node<S>;

export const loop = <S>(spec: {
  body: NodeId;
  until: (s: S) => boolean;
  max: number;
  absorb: (s: S, exit: LoopExit) => S;
  next: NodeId;
}): Node<S> => ({ type: "loop", ...spec });

// One `runStep` call as a node. `absorb` folds the step's own result; the
// optional `absorbEffects` folds the effect results, which arrive later. A
// `validator-exhausted` result always emits an `append-trail` effect carrying
// the trail, whatever `effects` returned, because that is the part a graph
// author forgets.
export const leaf = <S, I, O>(spec: {
  id?: string;                                 // defaults to def.id
  def: StepDef<I, O>;
  journal: Journal;
  input: (s: S) => I;
  absorb: (s: S, r: StepResult<O>) => S;
  effects?: (s: S, r: StepResult<O>) => Effect[];
  absorbEffects?: (s: S, results: EffectResult[]) => S;
  next: NodeId;
}): Node<S> => …;
```

A loop's body is delimited by a convention the graph declares rather than one the
compiler infers: **a body node whose edge names the loop's own id is the
iteration boundary, and that is the only edge allowed to leave the body.** The
loop's `next` is the only way past it. So "route this finding to a person" from
inside a loop is not an edge out of the body. It is a fact the body records, an
`until` that goes true because of it, and a branch after the loop that reads it.
That is the same move rule 3 makes for a failing step, one level up.

The runner does not interpret this graph. It compiles it, once per run, to a [Mastra](https://mastra.ai) workflow and drives that through `createRun()`. The node map is a directed graph whose only cycles are declared loops; Mastra's builder is a linear chain of combinators. The bridge is the continuation: a chain runs until it reaches a branch, and each edge of that branch compiles to a *nested workflow* carrying the rest of that path. `Workflow` implements `Step`, so a nested workflow is a legal branch target. A node reachable from two edges is therefore compiled once per path.

| Node | Compiles to |
|---|---|
| `step` | `createStep`, whose `execute` runs the node, hands its `Effect[]` to the injected executor, applies `absorb`, and returns the new state |
| `fanout` | a nested workflow: `.parallel(sub-steps)` then a `.map()` that re-applies each sub-step's changed-key slice onto the pre-fanout state, in declaration order |
| `branch` | an entry step that records the visit and proves the edge exists, then `.branch([[s => on(s) === k, tail_k], ...])` with one entry per key of the edge table, then a `.map()` that unwraps the single executed target's output |
| `loop` | `.dountil(body, s => until(s) || iterationCount >= max)` over a nested workflow compiled from the body sub-graph, then an exit step that hands `{ iterations, exhausted }` to `absorb`. The bound lives in the condition, so there is no way to build the loop without it |
| `suspend` | `createStep` with a `suspendSchema` and a `resumeSchema`: the first pass calls `suspend({ reason, trail })`, and the resumed pass parses the person's answer and folds it into state |
| `terminal` | `createStep` returning the `Terminal<S>`. `accepted` completes; `rejected` goes through `bail()`, so nothing after it in its own chain can run |

The compile mapping buys the fanout merge for free. A sub-step returns only the keys it changed, and Mastra keys each sub-step's output by its own step id, so the merge re-applies slices onto a base no sub-step wrote. There is no ordering in which one sub-step's write can be lost. A whole-state merge, `outs.reduce((acc, s) => ({ ...acc, ...s }), state)`, has exactly that bug: every sub-step computes a whole state from the same ancestor, so the last one's unchanged copies overwrite every earlier one's work. In the worked example below that silently drops three of four classifier verdicts.

The state flowing through the compiled workflow is the caller's `S`. The trace is separate: it accumulates in Mastra's own workflow state, which is the right lifetime, because that state survives suspension. The trace of a run that parked for a person and was answered three days later spans both halves. A model cannot claim to have reached a node it did not reach.

A loop needs no counter to know it ran out. It leaves for exactly two reasons, `until` held or the bound was reached with `until` still false, so `exhausted` is `!until(final)` and nothing has to be threaded through the body to compute it. The iteration count does live in the engine's own state, beside the trace, which is what lets a run park inside a loop body and resume three days later into the same iteration with the same count.

What the compiler refuses. A graph with a dangling edge, an unreachable node, a fanout target that is not a step, no reachable terminal, a malformed loop, or a **back edge** is rejected before any step runs. A back edge is the repetition rule 5 forbids: it is named and refused rather than compiled into something that only looks like a loop. A malformed loop is one whose bound is not a positive integer, whose body has no path back to the loop, whose body reaches a node that cannot come back, whose body is entered from outside, or whose exit re-enters its own body. Each is checked once, by the same function the harness uses to walk the graph.

A run therefore ends one of two ways, and `run` returns which:

```ts
export type RunOutcome<S> =
  | { kind: "terminal";  terminal: Terminal<S>; trace: NodeId[]; runId: string }
  | { kind: "suspended"; reason: string; trail: unknown[]; trace: NodeId[]; runId: string };

export function run<S>(wf: Workflow<S>, state: S, execute: Executor): Promise<RunOutcome<S>>;
export function resume<S>(wf: Workflow<S>, runId: string, answer: unknown,
                          execute: Executor): Promise<RunOutcome<S>>;
```

`resume` recompiles the graph rather than taking a live handle. The compilation is a pure function of the graph, so the step ids match the snapshot the engine persisted and the run reattaches by `runId`. That is the same path a different process would take, which is what makes a suspension crash-resumable rather than a handle someone has to hold.

### Effects with typed results

Every write the runner performs has one shape: an id, an expected version, a body. Whether the target is a code symbol or an artifact row, the concurrency model is the same optimistic version check.

```ts
export type Effect =
  | { type: "replace-symbol";  symbolId: string; expectedVersion: number; body: string }
  | { type: "write-file";      path: string;     body: string }
  | { type: "upsert-artifact"; table: string;    id: string; expectedVersion: number; row: unknown }
  | { type: "run-tests";       impacted: string[]; extra?: string[] }
  | { type: "measure-oracle";  oracle: string }
  | { type: "run-command";     argv: readonly string[]; cwd?: string;
                               env?: Record<string, string>; timeoutMs: number;
                               resources?: readonly string[] }
  | { type: "append-trail";    line: string };

export type EffectResult =
  | { effect: Effect; outcome: "committed";    version: number; measured?: OracleMeasurement;
                                               command?: CommandResult }
  | { effect: Effect; outcome: "conflict";     currentVersion: number }
  | { effect: Effect; outcome: "rejected";     by: RejectedBy; detail?: RejectionDetail;
                                               measured?: OracleMeasurement; command?: CommandResult }
  | { effect: Effect; outcome: "infra-failed"; measured?: OracleMeasurement;
                                               command?: CommandResult };
```

`outcome` is a decision value. A step absorbs it into state and the next branch routes on it. A lease conflict is an edge to a rebase-and-retry node, never an exception. `infra-failed` is distinct from `rejected` so a flaky test harness does not burn the retry budget on a change that was fine. The distinct-failure-modes discipline matters more here than anywhere else in the framework because each misrouted failure costs model calls.

Three of the seven are worth naming, because each exists for one job the others could not do.

**`write-file`** is the only write that can produce a file. `replace-symbol` names a symbol id, so it can only ever rewrite something the registry already holds — the right shape for a crafter working inside a declared surface, and useless for an author whose job is to write a test that does not exist yet. Its concurrency model is the path scope of the lease rather than a version, because a file has no version to be optimistic about before it exists. What the write path checks instead is that the lease's scope covers the path, that the intent declared it, and that no identity the file already held has vanished.

**`measure-oracle`** executes one test and reads a verdict off it: `green | red | broken | indeterminate`. It is `run-tests` asking a different question, and it is a different effect because of it — `run-tests` asks "did the change break anything" and a failure is a refusal; this asks "what does this one test do, on its own, right now" and a failure is the *desired* answer. Exit status alone cannot tell `red` from `broken`, because a runner exits non-zero for both, so the counts are read and the axis that reached the verdict travels with it. The measurement rides on `EffectResult` as an optional `measured` rather than as a fifth outcome, so every other graph's edge tables stay total over the same four words and a pure branch reads all four verdicts off one field.

Why the framework runs the oracle rather than a leaf is [below](#distill-is-two-graphs).

**`run-command`** is the primitive the other process-running effects are built out of. Typecheck, lint, the tests stage and the oracle measurement are all compositions of it over a consumer's **declared commands**, and nothing in the framework spawns anything else. The declaration is four functions from typed arguments to a command:

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

The framework knows the four jobs; the consumer knows the four commands. That split is the point. Every process this framework ran used to be hardcoded to one runner, so a project whose typechecker, linter or test runner was anything else had no way to be checked at all, and lint did not exist because no declaration could carry it. A bare `string[]` normalises to the object form at the framework's default timeout, and the object form exists for the three things an argv cannot say: an environment overlay, a budget, and a named shared resource.

The result mapping is deliberately coarse, because a branch should read a verdict and not a transcript. A process that could not be spawned, or that was killed at its timeout, is `infra-failed`. Exit zero is `committed`. Any other exit is `rejected { by: "command" }`. The output rides on the result as `command` for a person, a correction turn and the event log to read, capped per channel; the exit and the outcome are the only things a branch reads. A stage that interprets a non-zero exit reports its own name instead, so `tsc` saying no is `rejected { by: "typecheck" }` and the linter saying no is `rejected { by: "lint" }`.

`resources` is how shared test infrastructure is serialised. A row's declared commands name what they need exclusively, the scheduler takes the whole set as a lease before the row runs, and two rows that name the same resource take turns while two that name none run together.

Notably absent from the union: `create-issue`, `send-message`, or anything else that is a shared, outward-facing action. A worker step cannot defer work by opening a ticket. The only way to defer is a `needs-human` suspension with a typed reason, which parks the run for a person rather than handing work to a queue nobody owns. The rule "agents never create issues unilaterally" is unrepresentable rather than enforced.

### Journal

Keyed by `(step id, step version, input hash)`. A hit returns the stored `StepResult` and the model is never called. This is what makes a workflow replayable: rerun it against the same journal and the trajectory is identical, byte for byte, with zero inference.

The journal answers "what did each step decide." It is not the provenance log for code changes. That lives in the VCS event log, linked one way: every effect the runner executes carries the journal key and step id as its intent. The dependency never runs the other direction.

It is also not the engine's snapshot, and the two are complementary rather than redundant. Mastra persists a snapshot per *run*, keyed by `runId`, recording where that run stopped: which step is suspended, with what payload, and what the workflow state held. That is what `resume` and `restart` read. Our journal is keyed by *content*, spans every run forever, and records what each step decided for a given input under a given prompt version. A snapshot cannot answer "has this step already decided this input," because it is about position, not content; and the journal cannot answer "where did this run stop," because it does not know runs exist. A prompt change bumps `version` and the journal correctly re-infers; a prompt change leaves a snapshot's meaning untouched, because position is unaffected. A workflow that is both replayed and resumed uses both, and neither can be derived from the other.

## Artifacts are typed rows, not documents

Requirements, test plans, roadmaps, acceptance criteria, and rules are typed structures in a database. They are not markdown. This removes a layer rather than adding one.

What collapses once artifacts are rows:

- An extraction step that recovers requirements from prose. Requirements are authored as rows. A verbatim-substring check against a source document was only ever a workaround for prose sources; with rows, the anchor is a foreign key.
- Stable identity for document sections. A row has a primary key. Nothing needs to parse headings.
- A second, file-level effect path for documents. `upsert-artifact` and `replace-symbol` share one contract.

A step output schema and an artifact row schema are the same type, derived from one place. A classifier cannot produce a shape the table cannot hold, and `upsert-artifact` fails with `rejected: schema` exactly the way `replace-symbol` fails with `rejected: typecheck`.

The store is built, as `src/artifacts/`: a version column on every row, the optimistic version check `upsert-artifact` already declares, an append-only event log of every accepted upsert, and a read of the body a row held at any past version. Both effect executors route to it.

The closed enum lives in the requirement row. A requirement carries `decisions: ["needed", "not-needed", "cannot-tell"]`; the graph reads it rather than hardcoding it.

### Graph topology as data, decision functions as code

There is one real fork: is a workflow graph generated TypeScript, or rows?

Take the middle. Nodes, edges, and requirement bindings are rows. Exhaustiveness is a query: every value in `requirement.decisions` must have an edge row, or the graph is invalid. Path enumeration reads the graph from the database. The pure functions that compute a decision from state stay in TypeScript, referenced by id from the branch row. Only the decision functions deserve a typed language, and they are small. Everything else is queryable, versioned in one store, and the authoring workflow writes rows instead of source files.

The cost of this choice: the compiler no longer proves exhaustiveness, a query does. The query runs in CI and in the harness, so the guarantee holds at the same points. What is lost is the red squiggle in the editor.

This fork is already built downstream, which changes what has to be invented. Mastra's dynamic workflows are workflow definitions expressed as JSON: schemas plus a step graph over registered agents, tools, and nested workflows, validated on registration, persisted, and run through the same execution API as a code-defined workflow. They are beta, and they do not carry a decision function, which is the half that should stay in TypeScript anyway. So the middle path is: nodes, edges, and requirement bindings are rows; the pure decision functions stay in source and are referenced by id; and emitting a dynamic-workflow definition from a `Workflow<S>` is the authoring workflow's natural output format. That is a serializer over a graph the runtime already knows how to run, not a second execution engine.

### What the database needs

Properties, not a product. A version column on every row. An append-only event log for provenance. A schema you can derive zod types from, so the row type and the step output type are one definition. SQLite or libSQL gets you there. Postgres when many agents write concurrently.

### Rendering

Humans read prose. A rules document becomes a view generated from rows, never the source. That enforces "no aspirational docs" structurally: the rendering cannot claim what no row says. The small model reads the row, not the rendering.

The one cost is one-time. A consumer with existing prose rules migrates them to rows once. That migration exposes every rule that was never crisp enough to be a closed enum. Those become `cannot-tell` edges to a human, which is the honest answer the prose was hiding.

## DISTILL is two graphs

nWave's DISTILL wave turns an ordered graph of values into two things: what
each value must be *observed* to do, and the executable oracle that will
observe it. Those are two disjoint steps in the shipped runner, and reading
them as one is how this document got them wrong the first time.

### `des distill` is provider-free

The first step buys no model turn and writes no test. Its input is a JSON
manifest: per value, an `observation` that must already exist in the handover
by exact string match, a non-empty list of `AcceptanceObligation { id,
stimulus, expected }`, exactly **one** `oracle` locator, and an
`acceptance_supports` list of whole-file paths — which may be empty, may never
equal the oracle, and may never name a path the repository ignores. It
validates a closed rule set, renders a markdown brief, and persists the facts
into the value graph.

The obligation's three fields are the load-bearing part. A stimulus a reader
could apply and an expected result they could observe is something an oracle
author can write an assertion from; one sentence of prose saying "complete
works" is neither, and an author handed it has to invent both halves before it
can write anything.

What is **not** there, and must not be built: `.feature` files, a `steps/**`
tree, `S-1.2`-style ids, a Contract Shape tag, pending markers of any kind, a
seven-category taxonomy, a fifteen-item checklist. Completeness is not a score.
It is a **total relation** in both directions — every obligation to at least
one falsifiable observation, and every observation the oracle makes back to
exactly one obligation — and a checklist or a scenario count is exactly the
thing that rule exists to refuse.

So the graph is one leaf in front of a pure function:

```
obligations = loop(body: propose-obligations, until: valid or blocked, max: 2)
|
+- propose-obligations -> propose.route  -+- proposed  -> validate-manifest
|                                         +- exhausted -> obligations (blocked)
+- validate-manifest --> manifest.route  -+- valid     -> obligations (leave)
                                          +- invalid   -> obligations (iterate)

obligations.verdict -+- valid   -> persist -> persist.verdict -+- committed -> accepted
                     |                                          +- else      -> human
                     +- blocked -> human -> human.route -> rejected
```

The leaf's decision space is a **singleton**. It proposes; whether the proposal
is admissible is the validator's, and the validator is a total function over
the manifest, the roadmap, and one injected repository fact. Giving the leaf a
second decision would be asking a model to grade its own manifest, which is the
arrangement the validator replaces.

Each rule is a **named defect** rather than a boolean, for the reason
`validate-shape` one wave earlier has the same shape: the defects are the
feedback the next proposal reads, and "invalid" tells a model nothing it can
act on.

There is **no human gate on the happy path**, unlike the roadmap workflow's.
That is the one shape decision here worth defending. A decomposition is the
highest-judgement act in the pipeline and its output is a diff somebody reads;
this is not that. Every reason this step can refuse is a named defect a
proposal can be re-driven against, so a review gate would be a person re-reading
what a total function already decided.

### `des oracle --value N` is the step that writes the test

The second step dispatches the acceptance designer with tools `Read, Edit` and
nothing else, scoped so it may write only under the subject's test paths. It
returns a typed `accepted | rejected` outcome, and `rejected` has a precise
meaning rather than "I could not": *the constructive chain cannot be expressed
through the declared public port without inventing a field, an operation, a
fixture fact or an expected result.* That is a finding about the **design**, and
the runner routes it to the design's owner.

Then **software executes the oracle** and reads a JUnit-style verdict off it.
This is the rule the shipped code names
`boundary:software-measures-model-decides`, and it is the load-bearing shape
rather than an optimisation: the two roles that hold an oracle — its author,
`Read, Edit`, and its reviewer, an enforced empty tool set — *cannot run it*.
So "this oracle fails on its assertion and not on its scaffolding" is a
property the software owns, and observing an execution is a fixed floor rather
than a rigor knob.

```
author = loop(body: author-oracle, until: red or blocked, max: 2)
|
+- author-oracle --> author.route --+- authored       -> write-oracle
|                                   +- cannot-express -> author (blocked: design)
|                                   +- exhausted      -> author (blocked)
+- write-oracle ---> write.verdict -+- committed      -> measure
|                                   +- conflict       -> author (iterate)
|                                   +- defective      -> author (iterate, with the gate's detail)
|                                   +- refused        -> author (blocked: out of scope)
|                                   +- infra-failed   -> author (blocked)
+- measure -------> measure.verdict +- red            -> author (leave: the desired answer)
                                    +- broken         -> author (iterate, with the output)
                                    +- green          -> author (blocked: vacuous)
                                    +- indeterminate  -> author (blocked: harness)

author.verdict -+- red     -> accepted, and an `oracle_runs` row is recorded
                +- blocked -> human -> human.route -> rejected
```

`red` is the only route to `accepted`, which is the inversion the whole wave
rests on. `broken` is the author's own defect — an import that does not
resolve, a fixture that threw, a file that does not parse — and it gets the one
correction turn, with the runner's verbatim output as the finding. `green` is a
**vacuous oracle**: a test that passes before any production code exists proves
nothing, and it goes to a person. The shipped runner computes the same verdict
and deliberately does not *arm* it, because four of its own designed behaviours
legitimately reach a green oracle before a craft turn; a graph that runs one
value once with nothing behind it reaches none of them, so parking is the
honest answer here.

The pre-craft oracle reviewer is **retired**, and this is where the
`accepted | rejected` outcome earns its keep. A judge between "measured" and
"judged" was a fourth model boundary, and the incident it existed for — an
approving review of a broken oracle, in 27 seconds — is answered by a
measurement that is software and free. The oracle's independent judgement is
the whole-diff review at the end, which sees the oracle and the implementation
together.

Then the crafter is **walled off from the oracle file**. Every path a task
declares is the crafter's except that one, because RED to GREEN must be bought
by production and never by editing the test that measures it. Here that is an
executor rule rather than a graph edge, which is what makes it hold for every
write the graph could emit — including one a model proposed and the graph
merely passed along. The supports are *not* walled: a support is the oracle's
dependency rather than the thing that measures the value.

### One defect from the shipped runner, not copied

`des distill`'s obligations never reach the oracle author. The runner's
`_derive` builds its `AuthorityFacts` with `acceptance_obligations` left at its
default, and only the craft path ever populates it — so the acceptance author
receives the obligation *ids* the design declared and not the
stimulus/expected pairs `des distill` produced, and is asked to write an oracle
for obligations it cannot read.

Here they are an input to the author leaf. That is the whole of the fix and it
is worth one sentence in a design document because the shape of the bug is
general: two steps that produce and consume the same fact, joined through a
record that carries a default.

### What this costs to enumerate

55 paths through the obligations graph and 421 through the oracle graph, with
every node visited, every block reason produced, and zero model calls. The
oracle graph's third axis is the one that makes it interesting: the verdict is
an **effect outcome** rather than a leaf decision, so the walk gets all four
verdicts from the same `scriptedExecutor` seam it gets a write outcome from.


## The agent-native VCS is the effect executor and mechanical verifier

This is now built, as `src/vcs/` in this repo. It is a library rather than the separate Rust CLI its own design plans, because the caller here is the workflow runner and not a free agent: there is no bash to drift to, so the tool surface and the preference experiment that motivated a CLI are moot, and a coordinator in another language would need an IPC protocol before it could be used at all. The seam is one function, `vcsExecutor({ vcs, session, intent, protected, knownRed })`, which returns an `EffectExecutor`. The dependency runs one way: `src/core` imports nothing from `src/vcs`, and `src/vcs/executor.ts` imports the `Effect` and `EffectResult` types and nothing else from the framework. Four of the five things listed under "what needs changing" below are closed by it. Typed effect results are closed: `outcome` is a decision value and the write path's own result union is the same shape, so the mapping between them is the identity function. The gate separating "you broke it" from "the harness broke" is closed by the three failure categories, `contract`, `verification` and `infrastructure`, each routed to a different edge, with `contract` and `structural` added to `rejected.by` so the first of them is representable at all. Per-symbol leases in fanout are closed by atomic multi-acquire: a batch takes one write lease covering every symbol it names, which is also why holding a lease and asking for more can be refused. Two provenance stores drifting is closed by the task id on every event, so the journal's answer to "what did this step decide" and the log's answer to "what changed" join on one key. What remains open is the fifth, the symbol-set difference that would make "implement to the design, never invent public API" mechanical: the symbol inventory it needs exists, and the check that consumes it does not.

A separate design (agent-native version control: symbol-level granularity via tree-sitter, stable symbol identity across renames, optimistic concurrency with leases, verification at write boundaries via typecheck and a test-impact graph, an immutable event log keyed by task and intent) fits this framework as its data plane for code. The framework is the control plane: what happens, in what order, validated how. The VCS is how writes land, under what concurrency, with what provenance. Neither needs the other, but together they close a loop each leaves open alone.

What works:

- **The verifier runs declared commands, and owns one JUnit parser.** The four stages are structural, typecheck, lint and tests, in that order, and every one after the first is a `run-command` effect built from the consumer's declared command and handed to an injected executor. Lint replaced a `policy` stage that was a stub returning "passed" because neither of the design's policy mechanisms was built; a declared lint command is one that is. The verdict a test run produces no longer comes from scraping a runner's stdout: the declared command is told where to write a JUnit report, and `src/vcs/junit.ts` is the one place in the repository that reads one. The four-word verdict rule is unchanged by that move, and what changed is where the counts come from, which is the whole point. Two absences are kept apart because they are opposite claims: no report at all means the runner ran nothing, which is `broken`; a report no reader can count means nothing was established, which a non-zero exit reads as `indeterminate`.
- **`replace-symbol` is the code effect, and `write-file` is the one that can create.** The runner hands either to the VCS, which does the lease, the version check or the path-scope check, and the verification gate. The workflow never touches a file. A symbol write claims an optimistic version; a whole-file write claims a **path scope**, because a file has no version to be optimistic about before it exists, and the structural question it answers is weaker by exactly the right amount: what appears is the author's business, what vanishes is not.
- **Verification at boundaries is the strongest mechanical check.** Typecheck plus impact-scoped tests run synchronously before commit. That is a `Requirement.check` with no model in it. The validator chain for a code-writing step becomes: schema, then VCS gate, then a small model refuting against requirements. The expensive stochastic check runs last and only on outputs that already compile.
- **Provenance links two logs instead of merging them.** The journal answers what each step decided. The VCS event log answers what changed and why. Every effect carries the journal key and step id as intent. Blame on a symbol resolves to which workflow, which step, which requirement, which model, which validator passed it.
- **Stable symbol identity makes API-surface conformance mechanical.** "Implement to the design, never invent public API" is a prose rule reviewers apply by reading. With a symbol inventory it is a set difference: exported symbols after the change, minus the symbols the design declares, must be empty. No model. Overdrive's `TerminalErrorKind::Retryable` and `ctx.run_retryable` incidents, both caught only in adversarial review, are the shape this catches at the gate.
- **Test selection above the impact floor is the workflow's; the floor is the VCS's.** A `run-tests` effect names the symbols it is scoped to and the tests a leaf chose to add; the executor runs their union and recomputes the floor from the symbols the batch actually wrote, so a selection that misses one of those tests is a contract violation rather than a smaller run. The LLM may add a test the static import graph cannot see, and has no way to remove one.
- **A protected scope is how one role's ownership becomes structural.** The executor refuses any write landing under a declared scope, before a lease is asked for. That is what walls the crafter off from the oracle, and expressing it in the executor rather than in a graph is what makes it hold for every write the graph could emit — including one a model proposed and the graph merely passed along.
- **A test that was already red must not refuse a write that did not break it.** The gate's question is "did you break something else". Once oracles are live files rather than pending markers, every undelivered value has a live failing test in the modules it shares, so the impact-scoped set takes a `knownRed` exclusion beside the one it already takes for the tests the batch is rewriting. Without it, a module with two undelivered values is undeliverable — measured on the first real run of the worked example, not predicted.
- **The "do agents prefer structured tools" question is moot here.** Inside a workflow the agent does not pick tools; the graph does. The VCS does not need to win a preference contest because the runner is its only caller.

What needs changing:

- **Effects need typed results.** Covered above; the VCS is what forced it. A write can come back `conflict` or `rejected` or `infra-failed`, and those must route to edges.
- **The gate must separate "you broke it" from "the harness broke."** Same point, higher stakes. A flaky test reported as `rejected: tests` sends the worker into a retry loop on a correct change.
- **Fanout over writes needs leases per symbol, not per step.** Parallel read-only classifiers are trivial. Parallel write steps need the VCS lease model, and a lease conflict is a decision value routed to an edge.
- **Two provenance stores can drift.** The dependency is one-directional: journal produces effects, VCS records them. Anything that writes the VCS log and expects the journal to reflect it breaks replay. Symbol version tags help: a journal entry that produced effects records the versions it wrote, so replay detects that the world moved.

The first integration test is not the VCS's own phase one. It is: the runner executes an `Effect[]` through the VCS with lease, verify, and log, and gets back a typed result a branch can route on. That one path exercises every seam.

## DELIVER is two graphs

nWave's DELIVER wave generates a roadmap, then runs each step through a RED→GREEN→COMMIT cycle with a crafter agent, a reviewer, a mutation gate, and a phase log. That is two graphs. One is authored per feature: the roadmap. One is fixed: the step cycle. Today both are enforced after the fact, by hooks checking that the phase log has the right events in the right order and that the dispatch prompt carried the full template. In the framework they are enforced by topology.

RED is the one that is not enforced by topology *inside* this graph, and the reason is the previous section. The oracle was authored and executed in its own run, so the step cycle has nothing to observe and no judgement to make: it READS a recorded verdict. That makes "no edge bypasses RED" a **readiness precondition** one layer out — a row whose oracle has no recorded `red` never becomes ready — which mirrors the shipped runner's own rule that with no recorded oracle the next step for a value is `des oracle`, never `des craft`. It is a stronger guarantee than an edge, not a weaker one: an edge could be reached with a fabricated observation, and a row that is not ready has no run at all.

| nWave DELIVER today | In the framework |
|---|---|
| `roadmap.json`, written by a frontier model | Rows: `steps`, `step_edges`, `acceptance_criteria` bound to steps. A frontier model proposes; a human reads the diff |
| `des.cli.roadmap validate` | A constraint query: DAG, every step has at least one AC, every AC has a closed decision space, every step reaches a terminal |
| `nw-execute` dispatches one step to a crafter with a template prompt | The runner traverses the fixed step-cycle graph; each node is a leaf step with a validator |
| `execution-log.json`, write-locked and HMAC-signed | The runner's trace. A model cannot log COMMIT because it never writes the log |
| RED observed by the crafter, logged by the crafter | An `oracle_runs` row a different wave recorded, from a measurement software took. The crafter cannot log it, cannot reach it, and cannot edit the oracle it came from |
| Reviewer dispatched after the step | The step-level validator, same primitive at coarser grain |
| "No effort budget cuts" | Terminal is `accepted` only when every bound AC is `green`. Partial suspends for a person; no edge leads from partial to `accepted` |
| "Deferrals need a GH issue and user approval" | No `create-issue` effect exists. The only deferral is a `needs-human` suspension with a typed reason |

The roadmap half of that is rows, and the distinction matters more than the table makes it look. An agent does not generate a workflow per feature. It generates rows, and the scheduler instantiates the one fixed step cycle per row. Nothing about a feature changes the graph; a feature is a set of rows the same graph runs against, once each. The authoring workflow that produces those rows is itself fixed and hand-written, which is why it is an example rather than a generator. The schema mirrors nWave's own `handover.json`: a `StoredHandover` is a request plus an ordered tuple of `values`, each carrying an `observation` (what will be observably true), the `dependencies` that must come first, an `authority` locating the design source it implements, and its `acceptance` obligations. One field is added, the symbols each step expects to write, because the disjointness check needs it. That check mirrors nWave's `parallel_safety.py`, whose stance it keeps: a pair the roadmap declares independent whose scopes overlap is a disagreement, and the overlapping entries are the finding rather than something the tool adjudicates. The built shape is `src/examples/nwave/roadmap/`.

### The step cycle as a graph

The obvious drawing of this has back edges in it: `gates` to `fix-lint` to
`gates`, `run-tests` to `implement` to `run-tests`. Rule 5 does not allow them.
The same shape written with bounded loops is three nested `loop` nodes, and the
nesting is the thing the back-edge drawing was hiding.

```
cycle  = loop(body: test-loop, until: gates are clean, max: 1) ─► cycle.verdict
│
├─ test-loop  = loop(body: test-loop.head, until: not still-red and not broke-other, max: 2)
│  │            ─► test.verdict ─branch─┬─ green ──────► refactor
│  │                                    └─ everything else ─► cycle   (iterate, or leave)
│  ├─ test-loop.head ─branch─┬─ implement ──► implement   (the usual entry)
│  │                         └─ run-tests ──► run-tests   (an AT was just corrected)
│  └─ implement ─► write.verdict ─branch─┬─ committed ───► run-tests ─► test.route
│                                        ├─ conflict ────► test-loop  (rebase and retry)
│                                        ├─ rejected ────► test-loop  (retry)
│                                        ├─ infra-failed ► test-loop  (blocked; until goes true)
│                                        └─ exhausted ───► test-loop  (blocked)
│
├─ refactor ─► refactor.verdict ─branch─┬─ refactored ──► gates-loop
│                                       └─ exhausted ───► cycle
│
└─ gates-loop = loop(body: gates, until: not lint-failed, max: 2)
   │            ─► gate.verdict ─branch─┬─ clean ────────────► cycle  (until goes true)
   │                                    ├─ lint-failed ──────► cycle  (the bound)
   │                                    └─ infra-failed ─────► cycle  (blocked)
   └─ gates ─► gate.route ─branch─┬─ clean ────────► gates-loop
                                  ├─ lint-failed ──► fix-lint ─► gates-loop
                                  └─ infra-failed ─► gates-loop  (blocked)

cycle.verdict ─branch─┬─ clean ──────► commit ─► commit.verdict ─┬─ committed ─► accepted
                      │                                          └─ exhausted ─► rejected
                      ├─ design-gap ─► surface-design-gap ─► human
                      └─ blocked ────► human

human ─► human.route ─branch─┬─ commit ──► commit
                             └─ abandon ─► rejected
```

The sub-branch inside `test-loop`, where a still-red suite is classified before
it is retried:

```
run-tests ─► test.route ─branch─┬─ green ─────────────────► test-loop  (until goes true)
                                ├─ still-red ─────────────► diagnose
                                ├─ broke-other ───────────► test-loop  (iterate)
                                ├─ harness-failed ────────► test-loop  (blocked)
                                ├─ selection-refused ─────► test-loop  (blocked)
                                └─ not-run ───────────────► test-loop  (iterate)

diagnose ─► diagnose.route ─branch─┬─ impl-wrong ──────► test-loop  (iterate: implement)
                                   ├─ at-wrong ────────► fix-acceptance-test ─► test-loop
                                   │                     (next iteration enters at run-tests)
                                   ├─ design-missing ──► test-loop  (blocked: design-gap)
                                   └─ harness-failed ──► test-loop  (blocked)
```

`human` is a suspend node, not a terminal: the cycle parks, a person answers
from a closed decision enum, and the same run continues. Every branch is a
closed enum. `harness-failed` is distinct from `still-red` so a flaky run does
not burn the implement retry budget, and `infra-failed` on the write is
distinct from `rejected` for the same reason one level down.

The cycle **starts at `implement`**, and nothing precedes it. There is no
`oracle` node and no RED node, because neither has anything left to do: the
oracle was authored by the acceptance designer in its own run and executed by
software there, and what this graph reads is the recorded verdict. The row's
own test ids come in with it, which is what lets `test.route` tell "my own
oracle is still red" from "I broke something else" — a set membership rather
than a judgement.

What the crafter may do with that oracle is bounded by the executor rather than
by the graph: the row's oracle file is a protected scope, so a `replace-symbol`
or a `write-file` landing in it is `rejected: contract` before a lease is
asked for. RED to GREEN is bought by production, and that is now a property of
the data plane instead of a rule a reviewer applies.

`gates` is not a leaf either, and for the same reason. Whether the quality gate
found anything is what RUNNING it answers, so the node emits a `run-command`
effect built from the consumer's declared lint command over the files the row
writes, and `gate.route` is a pure function of the typed result. Three answers,
because three are what the graph routes differently: exit zero is `clean`, any
other exit is `lint-failed`, and a command that could not be run at all is
`infra-failed`, which is the harness failing rather than the change being bad.
The gate's own output becomes the evidence, so `fix-lint` reads the linter's
words rather than a paraphrase of them, and `fix-lint` stays a leaf because
writing the fix is judgement.

One thing went with the model that used to classify a gate run. The mutation
gate was a verdict a model reported, and no command produces it yet, so
`mutation-below-gate` and the `add-test` leaf it routed to are gone. That was
the only way anything inside the cycle could invalidate a green verdict, so the
cycle now runs exactly once and cannot run out. The loop node stays, because
the day a consumer declares a mutation command the second pass comes back
with it.

`run-tests` is not a leaf either, and the reason is sharper. Whether the suite
passed is what running it answers, so the node emits a `run-tests` effect and
`test.route` is a pure function of the typed result and the step's own
acceptance-test ids. A committed run is `green`. A run rejected by the tests
gate whose failing tests are all the step's own is `still-red`, which is what
`diagnose` then classifies; one that names anything else is `broke-other`, a
different owner and not something the diagnosis leaf has evidence about. A run
rejected by `contract` is the selecting leaf reaching below the impact floor,
which nothing inside the cycle could repair, so it unwinds to a person. An
`infra-failed` run is `harness-failed`, and so is a `conflict`, because running
a suite claims no version and there is no optimistic check for it to lose. A
model asked "did the suite pass" would be a second source of truth for a fact
the runner already produced.

There is one `human` node and it sits outside all three loops, which is what the
body-boundary convention forces: a loop body leaves only through the loop's own
id. So an outcome that needs a person does not jump out of the cycle. It sets a
block in state, every enclosing `until` goes true because of it, the run unwinds
through the loops it was inside, and `cycle.verdict` routes it. The unwinding is
not overhead. It is how the run carries out what it learned inside the loop.

A loop that reaches its bound goes to the same place by the same route, with a
reason of its own. When the body has run `max` times and `until` is still false,
the loop leaves anyway and hands `absorb` an exit with `exhausted: true`. The
graph folds that into state as "which loop ran out", and `cycle.verdict` sends it
to `human` under `test-loop-exhausted` or `gates-loop-exhausted`. A person
therefore gets told which budget was spent and how many times it ran, rather
than being handed a run that stopped for no stated reason. The cycle is not on
that list, because nothing inside it can ask for a second pass: every way its
body can end either leaves cleanly or sets a block, so `until` is true after
every body and the bound is never what stops it. This is what "no effort budget cuts" looks like when it is topology: the
bound cannot be raised by a model, and running out of it is not a route to
`accepted`.

### What decomposes and what stays wide

The crafter today is one big model doing everything in the diagram. Most nodes are narrow leaves: classify why a suite is still red, fix the lint findings inside the step's own scope. Each is a small model with a validator. Some nodes decompose further than that and stop being leaves at all: reading whether the suite passed is reading an effect's typed result, reading whether the quality gate found anything is reading a declared command's exit status, and reading whether the oracle was red is reading a row a different wave recorded. A node whose answer a cheaper thing already produces does not get a model, and "cheaper" includes "a measurement somebody already took".

A failing test is classified before it is retried. `diagnose` answers
`impl-wrong | at-wrong | design-missing | harness-failed`, and each cause routes
to the agent that owns it: `impl-wrong` is the implement loop as it always was,
`at-wrong` goes to the acceptance designer and re-runs the suite without
re-implementing, `design-missing` goes to the architect, and `harness-failed` is
the same "the runner produced no verdict" distinction one leaf up. Looping
straight back to `implement` on every red assumes the answer to a question
nobody asked, and a wrong acceptance test burns the whole implement budget
proving it. `design-missing` is the one that leaves the cycle: a gap in the
design is never closed by inventing the surface a test happens to need, so the
architect's leaf describes what is missing and the run parks for a person under
`design-gap`. It leaves by the body-boundary route rather than by an edge: the
diagnosis lands in state, every enclosing `until` goes true because of it, and
`cycle.verdict` routes it on the way out.

The `implement` leaf stays wide. "Make this AT pass with the minimal change" is code generation, not a closed-enum decision. The framework does not require that leaf to be a small model. It requires it to be validated narrowly: the output schema admits only `replace-symbol` effects, the VCS gate runs typecheck and impacted tests, and the validator runs the API-surface diff. Put a mid-size model there if it earns it. "Many small models" is the default because most leaves are classifications. It is not a law forbidding a capable model where the output is genuinely open.

`author-oracle` one wave earlier is the same case for the same reason, and it is worth naming because the instinct is to treat a test as smaller than an implementation. Writing an executable oracle that falsifies every obligation through a declared port is code generation too. What makes it safe is not a smaller model; it is the same narrow validation — a mechanical check that the turn returned exactly the paths it declared and no others, a rule that completeness is a total relation in both directions, an executor that refuses a byte outside the test paths, and a measurement software takes afterwards.

What stays hard is the roadmap itself. Decomposing a design into steps that are each production-drivable vertical slices is the highest-judgment act in the pipeline. The framework validates the roadmap's shape and nothing about whether the decomposition is good. That is the frontier model's job, once per feature, and its output is a diff a person reads. Everything downstream of that diff is a graph.

## DELIVER runs in parallel

DELIVER is sequential today because one big model holds one context and one linear log. Sequencing is a property of the executor, not the work. Once the roadmap is a DAG in rows and the executor is a scheduler, the frontier is every step whose in-edges are all `accepted`, and the frontier runs concurrently.

This is built, as `src/core/scheduler.ts` plus `src/examples/nwave/deliver/pipeline.ts`. The scheduler is generic: a row is `{ id, dependencies }`, a run is an injected `runOne`, and the frontier is every row whose dependencies all read `accepted`. The pipeline is the composition: it reads `roadmap_steps` rows out of the artifact store, instantiates the fixed step cycle once per row with that row's obligations, predicted touches and authority, and runs the ready set up to a concurrency limit.

State is a projection rather than something the scheduler holds. Each finished run appends a `step_runs` row carrying the step id, the run id, the outcome and a sequence number, and a step's status is read back as the latest of those. The scheduler persists nothing of its own: it asks for each row's status, reports each outcome, and re-reads. That is the stance nwave's `delivery_state.py` takes, where the next step is derived from persisted facts and never decided, and it buys the property that matters here: a scheduler that died mid-feature restarts by reading rather than by remembering. A row in flight has nothing persisted yet, so it reads `pending` and is simply run again.

Resource leases serialize shared test infrastructure and nothing else. A row declares the names it needs, the scheduler takes the whole set atomically before the run and releases it after, and two rows that share one name serialize on that name while two rows that share none run together. Taking the set at once is what makes it deadlock-free, since a run never holds one name while waiting for another.

A suspended row blocks only its subtree, and that falls out of the frontier rule rather than being enforced: a dependent of a row that is not `accepted` never becomes ready, and every row not downstream of it keeps running. Answering the suspension resumes that row through the framework's own `resume` and re-evaluates the frontier in the same call, so a person's answer continues the feature rather than the row.

Three things still bound the parallelism. One of them changes how roadmaps should be authored.

- **Dependency edges are only as good as the author declared them.** A frontier model will call two steps independent that both touch the same symbol. The VCS catches this at write time as `conflict`, so the failure is a bounded retry, not corruption. A high conflict rate between two steps means the decomposition was wrong, and that is a metric to feed back to authoring. Better: do not hand-author edges. Each AC declares the symbols it exercises; each step declares the symbols it will write. Derive `step_edges` from symbol overlap. The author proposes steps and ACs; the scheduler computes the DAG. That removes the highest-error part of roadmap authoring from the model.
- **Shared test infrastructure needs leases the way symbols do.** Two steps with disjoint symbols can both need the same VM, the same kernel table, the same port. A `run-tests` effect acquires resource leases, and the test-impact graph says which resources each step's tests touch. Steps sharing none run fully parallel; steps sharing the kernel serialize on that one effect and nothing else. Overdrive's net-slot partitioning and `host-kernel-shared` nextest group are this problem solved by hand.
- **The export target, if it is still git.** The VCS event log is the truth and commits are per-symbol-set with version tags, so there is no global lock inside the framework. If a linear git history is still what consumers expect, serialize at export, not at execution. Export is a rendering, the same way prose is.

Beyond throughput: a `needs-human` suspension blocks that step's subtree and nothing else. Today one step waiting on a design gap stalls the whole feature. In the DAG, every branch not downstream of it keeps going, and the human's queue is a list of independent blocked subtrees.

The one way the graph can be fooled: an AC that depends on a step it does not declare. The test goes `still-red` for the wrong reason and the retry budget burns on a correct implementation. Deriving edges from declared symbol touches closes most of this. The residue is a missed declaration, surfaced as a step that exhausts retries and lands on a person with a trail showing the failing test never referenced anything the step wrote.

## Framework versus consumer

| Framework owns | Consumer owns |
|---|---|
| `Workflow`, `Node`, `Terminal`, `Effect`, `EffectResult`, `OracleMeasurement` and the runner | Requirement rows, the source of truth |
| `StepDef` with a mandatory validator, `runStep`, retry and escalation policy | Graph rows and decision functions, committed and diffed in PRs |
| A library of mechanical checks: verbatim-substring, enum-membership, id-in-set, symbol-set-difference | Model bindings: which small models, which validator family |
| Journal interface plus a file or SQLite implementation | Effect executors: what `replace-symbol`, `write-file`, `run-tests` and `measure-oracle` mean in this repo |
| Test harness: stub journal, path enumeration, trace matchers | The known-good hand-written graph used to validate the authoring workflow |
| The authoring workflow: requirement rows to graph rows plus enumeration test. The roadmap-authoring shape of it is built, at `src/examples/nwave/roadmap/` | Rendered views for humans |

Two properties fall out of the split. Generated graphs are source, committed and reviewed, not runtime artifacts; regenerating at run time would put the frontier model back inside the loop. And the framework is self-hosting: the authoring workflow is itself a graph on the runtime, with the same step contract, and its validator is the compiler plus path enumeration, so the one output that needs frontier judgment is checked without a model.

### Package layout

```
core/       workflow.ts  step.ts  requirement.ts  journal.ts  effects.ts
checks/     verbatim.ts  enum-member.ts  id-in-set.ts  symbol-diff.ts
harness/    stub-journal.ts  enumerate-paths.ts  matchers.ts
codemod/    author.graph.ts
```

A consumer depends on `core`, `checks`, and `harness`, runs `codemod` from CI on requirement changes, and commits what comes out.

### Bootstrap order

Each piece is what validates the next.

1. **Runtime, step contract, harness, by hand.** Roughly three hundred lines. No model involved. The only code a person writes from scratch.
2. **One graph by hand.** The obligations graph above. This is the known-good answer.
3. **The requirement rows for that graph, by hand.** The rules `des distill`'s own validator enforces, as rows. A closed rule set over a typed manifest is the easy case.
4. **The authoring workflow, as a graph on the runtime.** Feed it the rows from step 3. Diff its output against the hand-written graph from step 2. The harness already exists to reject any graph with an unhandled decision or unreachable terminal.
5. **Migrate the prose-heavy rules.** Reconciler triage, workflow triage, deferral handling. This is where "does this rule reduce to a closed enum" gets answered honestly, and where you learn which rules become `cannot-tell` edges.
6. **The oracle graph, then the DELIVER step-cycle graph.** Both fixed, hand-written once, the same for every consumer. In that order, because the step cycle reads a verdict the oracle graph records and a cycle with nothing to read has no RED.
7. **Roadmap authoring and the scheduler.** The last piece, and the one that keeps frontier judgment in the loop. By now everything downstream of a roadmap diff is a graph.

## Open questions

These are the places where the design is a hypothesis, not a finding.

- **Which rules do not reduce to a closed enum.** The claim is that most do, and the rest become explicit escalations. Step 5 of the bootstrap is where that claim gets tested against real prose. If the `cannot-tell` rate is high, the framework is still correct but the human queue is longer than the current process, and that tradeoff needs measuring.
- **Whether small-model validators catch what frontier reviewers catch.** The framework replaces one adversarial reviewer with a mechanical check plus a small model per leaf. Whether that catches the design-divergence class of bug at the same rate is unknown. The symbol-set-difference check catches the invented-API class mechanically; the remainder is an empirical question.
- **Cost per completed task, not per call.** Many small calls plus validators plus retries versus one frontier call is not obviously cheaper. The claim is that it is cheaper *and* more legible. The first should be measured on a real feature before the second is used to justify it.
- **Derived dependency edges assume declared symbol touches.** An AC or step that under-declares produces a false independence. The failure is bounded (a conflict or a wrong-reason `still-red`), but how often it happens in practice determines whether the scheduler's parallelism is real or nominal.
- **The authoring workflow's validator is the compiler and the enumeration test.** That proves the graph is well-formed. It does not prove the graph encodes the rule correctly. The known-good hand-written graph is the only oracle for that, and there is one of it.
- **Whether an oracle authored by a model is an oracle worth measuring.** The framework can prove a test was executed, that it failed on its assertion rather than on its scaffolding, and that the crafter never touched it. It cannot prove the test asserts the *right* thing. The rules bound to that leaf — a total relation in both directions, the declared public port, no invented expected result — are prose refuted by a small model, which is exactly the class this design is least confident about elsewhere.
- **None of it has been run against a real model.** Every graph is enumerated, every gate is real, and the worked example is delivered end to end — with the inference removed. As of this cut no Anthropic credential was available in the environment: `ANTHROPIC_API_KEY` is unset and there is no `ant` CLI to check, so the `todo:*` commands refuse by name rather than proceeding, and nothing here fabricates a transcript. Every number in this document is a path count, a test count or a wall clock. None of them is a token count, an acceptance rate, or a cost, and none of the three questions above can be answered until one is.
