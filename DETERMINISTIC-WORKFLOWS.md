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

The model slot is one method. It takes a system prompt, a prompt and a schema, and returns something the schema accepts. That is the seam where an agent plugs in, not just a provider. A Claude Code subagent is a binding: from the step's side there is no difference between one model call and a subagent that spent forty turns reading a checkout, as long as what comes back satisfies the schema and the decision is a member of the closed enum. There are two shapes of that, and the difference is not stylistic. In the **opaque** shape the agent edits the workspace itself and returns only the object; the writes happened outside the effect boundary, so the framework cannot lease them, verify them, or roll them back, and a lease conflict is unrepresentable because nothing ever crossed the boundary where a version check could happen. In the **proposal** shape the agent returns its writes as `replace-symbol` effects and the runner commits them through the agent-native VCS, under a lease, with the write-boundary gate and the journal key as the intent; a conflict comes back as a decision value a branch routes. The VCS is what makes the second shape possible, which is why it is the data plane in "The agent-native VCS is the effect executor and mechanical verifier" below and not an optional extra.

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
  | { type: "upsert-artifact"; table: string;    id: string; expectedVersion: number; row: unknown }
  | { type: "run-tests";       impacted: string[] }
  | { type: "append-trail";    line: string };

export type EffectResult =
  | { effect: Effect; outcome: "committed";    version: number }
  | { effect: Effect; outcome: "conflict";     currentVersion: number }
  | { effect: Effect; outcome: "rejected";     by: "typecheck" | "tests" | "schema" }
  | { effect: Effect; outcome: "infra-failed" };
```

`outcome` is a decision value. A step absorbs it into state and the next branch routes on it. A lease conflict is an edge to a rebase-and-retry node, never an exception. `infra-failed` is distinct from `rejected` so a flaky test harness does not burn the retry budget on a change that was fine. The distinct-failure-modes discipline matters more here than anywhere else in the framework because each misrouted failure costs model calls.

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

## Worked example: DISTILL test-lane classification

Input: one test scenario. Output: which lanes it needs, from `testing.md § Classify external execution` and the DISTILL completeness gate. Four classifiers fan out, each a small model answering one question with one of three words. A pure merge applies the cross-cutting rules. No `if` lives anywhere a model can reach.

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

const small = anthropic("claude-haiku-4-5");
const smallOther = openai("gpt-5-mini");     // different family for the validator
const big = anthropic("claude-sonnet-5");

export const Scenario = z.object({
  id: z.string(),
  text: z.string(),
  crossesBoundary: z.boolean(),   // set upstream by DISTILL, not inferred here
});
type Scenario = z.infer<typeof Scenario>;

const Lane = z.enum(["needed", "not-needed", "cannot-tell"]);
type Lane = z.infer<typeof Lane>;

// `anchor` and `rationale` are payload. The graph cannot read them.
const Classification = stepOutput(Lane.options, {
  anchor: z.string().describe("Verbatim quote from the scenario that justifies the decision"),
  rationale: z.string().max(300),
});

const anchorMustBeVerbatim: Requirement<{ input: Scenario; output: z.infer<typeof Classification> }> = {
  id: "distill.anchor-verbatim",
  sourceId: "verification.enforcement.unanchored-claims",
  text: "The justification must quote the scenario verbatim. Paraphrase is an unanchored claim.",
  decisions: Lane.options,
  check: ({ input, output }) =>
    input.text.includes(output.payload.anchor) ? null
      : { requirementId: "distill.anchor-verbatim", evidence: output.payload.anchor },
};

type Kind = "e2e" | "expectation" | "benchmark" | "dst";

const QUESTION: Record<Kind, string> = {
  e2e:         "Does the assembled system need to keep satisfying a deterministic contract, rerun in CI?",
  expectation: "Is this a one-time, point-in-time operator-observable claim to capture as SHA-pinned evidence?",
  benchmark:   "Does this ask how fast, how much, or how variable, needing repeated samples and a statistical method?",
  dst:         "Does correctness depend on ordering, timing, concurrency, retry, or convergence, needing a seeded simulation invariant?",
};

const classifier = (kind: Kind, requirements: Requirement<any>[]): StepDef<Scenario, z.infer<typeof Classification>> => ({
  id: `distill.classify.${kind}`,
  version: 1,
  input: Scenario,
  output: Classification,
  requirements: [anchorMustBeVerbatim, ...requirements],
  worker: {
    model: small,
    system: "You classify a single test scenario. Answer only the question asked. Quote the scenario verbatim in `anchor`.",
    prompt: s => `${QUESTION[kind]}\n\nScenario ${s.id}:\n${s.text}`,
  },
  validator: { model: smallOther },
  maxAttempts: 2,
  escalateTo: big,
});
```

The graph. Every cross-cutting rule is one line in `mergeVerdict`, a total function into a closed enum, and the branch's edge table is exhaustive over it.

`State` gives each classifier its own slot. A shared `anchors` map and a shared `exhausted` array would be four writes to one key, and no merge over parallel sub-steps can keep four writes to one key. One top-level key per sub-step is what makes the fanout merge lossless.

```ts
type LaneSlot = { lane?: Lane; anchor?: string; exhausted?: boolean };

type State = {
  scenario: Scenario;
  e2e: LaneSlot; expectation: LaneSlot; benchmark: LaneSlot; dst: LaneSlot;
  human?: HumanAnswer;   // absorbed by the suspend node; read only by human.route
};

const classify = (kind: Kind, def: StepDef<Scenario, any>, journal: Journal): Node<State> => ({
  type: "step",
  run: async s => {
    const r = await runStep(def, s.scenario, journal);
    return r.decision === "ok"
      ? { state: { ...s, [kind]: { lane: r.output.decision, anchor: r.output.payload.anchor } }, effects: [] }
      : { state: { ...s, [kind]: { lane: "cannot-tell", exhausted: true } },
          effects: [{ type: "append-trail", line: JSON.stringify({ kind, trail: r.trail }) }] };
  },
  absorb: s => s,
  next: "merge",
});

type MergeVerdict = "complete" | "benchmark-expectation-conflict" | "incomplete-boundary" | "undecidable";

const exhaustedKinds = (s: State): Kind[] => KINDS.filter(k => s[k].exhausted === true);

const mergeVerdict = (s: State): MergeVerdict => {
  if (exhaustedKinds(s).length > 0) return "undecidable";
  if (s.benchmark.lane === "needed" && s.expectation.lane === "needed") return "benchmark-expectation-conflict";
  if (s.scenario.crossesBoundary && s.dst.lane !== "needed" && s.e2e.lane !== "needed") return "incomplete-boundary";
  return "complete";
};
```

The person's half. `reason` is the closed enum the run parks under; `HumanAnswer` is the closed enum it wakes on. Neither is free text, so the graph branches on a person's answer exactly the way it branches on a model's.

```ts
const HUMAN_DECISIONS = ["proceed", "abandon", "override"] as const;

const HumanAnswer = z.object({
  decision: z.enum(HUMAN_DECISIONS),
  override: z.object({ kind: z.enum(KINDS), lane: Lane }).optional(),  // read only when decision is "override"
});
type HumanAnswer = z.infer<typeof HumanAnswer>;
type HumanDecision = HumanAnswer["decision"];

const humanReason = (s: State) =>
  exhaustedKinds(s).length > 0 ? "validator-exhausted" : "incomplete-boundary";

// The evidence a person reads: every classifier's slot, as it stands.
const humanTrail = (s: State): unknown[] => KINDS.map(kind => ({ kind, ...s[kind] }));
```

```ts
export const distillGraph = (journal: Journal, defs: Record<Kind, StepDef<Scenario, any>>): Workflow<State> => ({
  start: "classify",
  nodes: {
    classify: { type: "fanout", steps: ["classify.e2e", "classify.expectation", "classify.benchmark", "classify.dst"], join: "merge" },
    "classify.e2e":         classify("e2e", defs.e2e, journal),
    "classify.expectation": classify("expectation", defs.expectation, journal),
    "classify.benchmark":   classify("benchmark", defs.benchmark, journal),
    "classify.dst":         classify("dst", defs.dst, journal),

    // Drop a MergeVerdict member from this table and it will not compile.
    merge: branch<State, MergeVerdict>(mergeVerdict, {
      "complete":                       "accept",
      "benchmark-expectation-conflict": "demote-expectation",
      "incomplete-boundary":            "human",
      "undecidable":                    "human",
    }),

    "demote-expectation": {
      type: "step",
      run: async s => ({ state: { ...s, expectation: { ...s.expectation, lane: "not-needed" } },
                         effects: [{ type: "append-trail", line: `${s.scenario.id}: expectation demoted, benchmark wins` }] }),
      absorb: s => s,
      next: "accept",
    },

    // The run parks here with a typed reason and the evidence behind it.
    human: suspend<State, HumanAnswer>({
      reason: humanReason,
      trail: humanTrail,
      resumeSchema: HumanAnswer,
      absorb: (s, answer) => ({ ...s, human: answer }),
      next: "human.route",
    }),

    // Drop a HumanDecision member from this table and it will not compile.
    "human.route": branch<State, HumanDecision>(s => s.human!.decision, {
      "proceed":  "merge.after-human",
      "abandon":  "reject",
      "override": "apply-override",
    }),

    "apply-override": {
      type: "step",
      // A person answering "override" is answering what the validator could not,
      // so the override clears `exhausted` as well as setting the lane.
      run: async s => {
        const o = s.human?.override;
        return o === undefined
          ? { state: s, effects: [{ type: "append-trail", line: `${s.scenario.id}: override with no payload` }] }
          : { state: { ...s, [o.kind]: { lane: o.lane, anchor: "<human override>", exhausted: false } },
              effects: [{ type: "append-trail", line: `${s.scenario.id}: ${o.kind} overridden to ${o.lane} by a person` }] };
      },
      absorb: s => s,
      next: "merge.after-human",
    },

    // The same verdict function, a terminal edge table. A person has already
    // answered, so nothing here routes back to them. This is how "re-run the
    // merge" is expressed without a back edge: a second branch node, not a cycle.
    "merge.after-human": branch<State, MergeVerdict>(mergeVerdict, {
      "complete":                       "accept",
      "benchmark-expectation-conflict": "demote-expectation",
      "incomplete-boundary":            "reject",
      "undecidable":                    "reject",
    }),

    accept: { type: "terminal", done: s => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: s => ({ kind: "rejected", state: s, trail: humanTrail(s) }) },
  },
});
```

`merge.after-human` routing `benchmark-expectation-conflict` back to the same `demote-expectation` node the first merge uses is re-convergence, not a cycle. Nothing downstream of `demote-expectation` leads back to either merge, so the compiler builds that tail once per path and the graph stays acyclic.

The exhaustive test. Three lanes, four classifiers, two boundary flags: 162 paths. A journal pre-seeded with the outputs stands in for the models. Every path must land on a declared outcome: a terminal, or parked for a person.

```ts
const LANES = ["needed", "not-needed", "cannot-tell"] as const;

const cartesian = <T>(xs: readonly T[], n: number): T[][] =>
  n === 0 ? [[]] : cartesian(xs, n - 1).flatMap(rest => xs.map(x => [x, ...rest]));

test("every classifier outcome reaches a declared outcome", async () => {
  for (const [e2e, expectation, benchmark, dst] of cartesian(LANES, 4)) {
    for (const crossesBoundary of [true, false]) {
      const outcome = await run(
        distillGraph(stubJournal({ e2e, expectation, benchmark, dst }), defs),
        seed({ id: "S-1", text: "…", crossesBoundary }),
        async () => [],
      );
      expect(["terminal", "suspended"]).toContain(outcome.kind);
      expect(outcome.trace.at(-1)).toMatch(/^(accept|reject|human)$/);
    }
  }
});

test("benchmark plus expectation always demotes expectation", async () => {
  const outcome = await run(
    distillGraph(stubJournal({ e2e: "not-needed", expectation: "needed", benchmark: "needed", dst: "not-needed" }), defs),
    seed({ id: "S-1", text: "…", crossesBoundary: false }), async () => [],
  );
  expect(outcome.trace).toContain("demote-expectation");
  expect(outcome.kind === "terminal" && outcome.terminal.kind === "accepted"
    && outcome.terminal.state.expectation.lane).toBe("not-needed");
});

test("a blocked scenario parks, and an override clears the block", async () => {
  const wf = distillGraph(stubJournal({ e2e: "not-needed", expectation: "not-needed",
                                        benchmark: "not-needed", dst: "not-needed" }), defs);
  const parked = await run(wf, seed({ id: "S-1", text: "…", crossesBoundary: true }), async () => []);
  expect(parked.kind === "suspended" && parked.reason).toBe("incomplete-boundary");

  const resumed = await resume(wf, parked.runId,
    { decision: "override", override: { kind: "e2e", lane: "needed" } }, async () => []);
  expect(resumed.kind === "terminal" && resumed.terminal.kind).toBe("accepted");
});
```

Changing a rule in `testing.md` means changing one line in `mergeVerdict`, and the compiler names every edge that needs updating. The models' job has been reduced to producing one of three words per classifier. Everything they cannot decide routes to a person with a trail attached.

## The agent-native VCS is the effect executor and mechanical verifier

This is now built, as `src/vcs/` in this repo. It is a library rather than the separate Rust CLI its own design plans, because the caller here is the workflow runner and not a free agent: there is no bash to drift to, so the tool surface and the preference experiment that motivated a CLI are moot, and a coordinator in another language would need an IPC protocol before it could be used at all. The seam is one function, `vcsExecutor({ vcs, session, intent })`, which returns an `EffectExecutor`. The dependency runs one way: `src/core` imports nothing from `src/vcs`, and `src/vcs/executor.ts` imports the `Effect` and `EffectResult` types and nothing else from the framework. Four of the five things listed under "what needs changing" below are closed by it. Typed effect results are closed: `outcome` is a decision value and the write path's own result union is the same shape, so the mapping between them is the identity function. The gate separating "you broke it" from "the harness broke" is closed by the three failure categories, `contract`, `verification` and `infrastructure`, each routed to a different edge, with `contract` and `structural` added to `rejected.by` so the first of them is representable at all. Per-symbol leases in fanout are closed by atomic multi-acquire: a batch takes one write lease covering every symbol it names, which is also why holding a lease and asking for more can be refused. Two provenance stores drifting is closed by the task id on every event, so the journal's answer to "what did this step decide" and the log's answer to "what changed" join on one key. What remains open is the fifth, the symbol-set difference that would make "implement to the design, never invent public API" mechanical: the symbol inventory it needs exists, and the check that consumes it does not.

A separate design (agent-native version control: symbol-level granularity via tree-sitter, stable symbol identity across renames, optimistic concurrency with leases, verification at write boundaries via typecheck and a test-impact graph, an immutable event log keyed by task and intent) fits this framework as its data plane for code. The framework is the control plane: what happens, in what order, validated how. The VCS is how writes land, under what concurrency, with what provenance. Neither needs the other, but together they close a loop each leaves open alone.

What works:

- **`replace-symbol` is the code effect.** The runner hands it to the VCS, which does the lease, the version check, and the verification gate. The workflow never touches a file.
- **Verification at boundaries is the strongest mechanical check.** Typecheck plus impact-scoped tests run synchronously before commit. That is a `Requirement.check` with no model in it. The validator chain for a code-writing step becomes: schema, then VCS gate, then a small model refuting against requirements. The expensive stochastic check runs last and only on outputs that already compile.
- **Provenance links two logs instead of merging them.** The journal answers what each step decided. The VCS event log answers what changed and why. Every effect carries the journal key and step id as intent. Blame on a symbol resolves to which workflow, which step, which requirement, which model, which validator passed it.
- **Stable symbol identity makes API-surface conformance mechanical.** "Implement to the design, never invent public API" is a prose rule reviewers apply by reading. With a symbol inventory it is a set difference: exported symbols after the change, minus the symbols the design declares, must be empty. No model. Overdrive's `TerminalErrorKind::Retryable` and `ctx.run_retryable` incidents, both caught only in adversarial review, are the shape this catches at the gate.
- **The "do agents prefer structured tools" question is moot here.** Inside a workflow the agent does not pick tools; the graph does. The VCS does not need to win a preference contest because the runner is its only caller.

What needs changing:

- **Effects need typed results.** Covered above; the VCS is what forced it. A write can come back `conflict` or `rejected` or `infra-failed`, and those must route to edges.
- **The gate must separate "you broke it" from "the harness broke."** Same point, higher stakes. A flaky test reported as `rejected: tests` sends the worker into a retry loop on a correct change.
- **Fanout over writes needs leases per symbol, not per step.** Parallel read-only classifiers are trivial. Parallel write steps need the VCS lease model, and a lease conflict is a decision value routed to an edge.
- **Two provenance stores can drift.** The dependency is one-directional: journal produces effects, VCS records them. Anything that writes the VCS log and expects the journal to reflect it breaks replay. Symbol version tags help: a journal entry that produced effects records the versions it wrote, so replay detects that the world moved.

The first integration test is not the VCS's own phase one. It is: the runner executes an `Effect[]` through the VCS with lease, verify, and log, and gets back a typed result a branch can route on. That one path exercises every seam.

## DELIVER is two graphs

nWave's DELIVER wave generates a roadmap, then runs each step through a RED→GREEN→COMMIT cycle with a crafter agent, a reviewer, a mutation gate, and a phase log. That is two graphs. One is authored per feature: the roadmap. One is fixed: the step cycle. Today both are enforced after the fact, by hooks checking that the phase log has the right events in the right order and that the dispatch prompt carried the full template. In the framework they are enforced by topology. The model cannot skip RED because no edge bypasses it.

| nWave DELIVER today | In the framework |
|---|---|
| `roadmap.json`, written by a frontier model | Rows: `steps`, `step_edges`, `acceptance_criteria` bound to steps. A frontier model proposes; a human reads the diff |
| `des.cli.roadmap validate` | A constraint query: DAG, every step has at least one AC, every AC has a closed decision space, every step reaches a terminal |
| `nw-execute` dispatches one step to a crafter with a template prompt | The runner traverses the fixed step-cycle graph; each node is a leaf step with a validator |
| `execution-log.json`, write-locked and HMAC-signed | The runner's trace. A model cannot log COMMIT because it never writes the log |
| Reviewer dispatched after the step | The step-level validator, same primitive at coarser grain |
| "No effort budget cuts" | Terminal is `accepted` only when every bound AC is `green`. Partial suspends for a person; no edge leads from partial to `accepted` |
| "Deferrals need a GH issue and user approval" | No `create-issue` effect exists. The only deferral is a `needs-human` suspension with a typed reason |

### The step cycle as a graph

The obvious drawing of this has back edges in it: `gates` to `fix-lint` to
`gates`, `run-tests` to `implement` to `run-tests`. Rule 5 does not allow them.
The same shape written with bounded loops is three nested `loop` nodes, and the
nesting is the thing the back-edge drawing was hiding.

```
activate-at ─► run-tests.red ─branch─┬─ red-observed ──────► cycle
                                     ├─ already-green ─────► human   (the AT is vacuous)
                                     ├─ harness-failed ────► human
                                     └─ exhausted ─────────► human

cycle  = loop(body: test-loop, until: gates are clean, max: 2) ─► cycle.verdict
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
└─ gates-loop = loop(body: gates, until: not clippy-in-scope, max: 2)
   │            ─► gate.verdict ─branch─┬─ clean ─────────────────► cycle  (until goes true)
   │                                    ├─ mutation-below-gate ───► add-test ─► cycle
   │                                    └─ everything else ───────► cycle  (blocked, or the bound)
   └─ gates ─► gate.route ─branch─┬─ clippy-in-scope ──────► fix-lint ─► gates-loop
                                  └─ everything else ──────► gates-loop

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
run-tests ─► test.route ─branch─┬─ green ─────────────► test-loop  (until goes true)
                                ├─ still-red ─────────► diagnose
                                └─ everything else ───► test-loop  (iterate, or blocked)

diagnose ─► diagnose.route ─branch─┬─ impl-wrong ──────► test-loop  (iterate: implement)
                                   ├─ at-wrong ────────► fix-acceptance-test ─► test-loop
                                   │                     (next iteration enters at run-tests)
                                   ├─ design-missing ──► test-loop  (blocked: design-gap)
                                   └─ harness-failed ──► test-loop  (blocked)
```

`human` is a suspend node, not a terminal: the cycle parks, a person answers
from a closed decision enum, and the same run continues. Every branch is a
closed enum. `already-green` at RED is a first-class outcome routed to a person,
because a test that passes before implementation is a testing-theater signal the
current process catches only if a reviewer notices. `harness-failed` is distinct
from `still-red` so a flaky run does not burn the implement retry budget, and
`infra-failed` on the write is distinct from `rejected` for the same reason one
level down.

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
to `human` under `test-loop-exhausted`, `gates-loop-exhausted`, or
`cycle-exhausted`. A person therefore gets told which budget was spent and how
many times it ran, rather than being handed a run that stopped for no stated
reason. This is what "no effort budget cuts" looks like when it is topology: the
bound cannot be raised by a model, and running out of it is not a route to
`accepted`.

### What decomposes and what stays wide

The crafter today is one big model doing everything in the diagram. Most nodes are narrow leaves: classify a test outcome, classify a lint finding, decide whether a diff matches the design. Each is a small model with a validator.

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

What stays hard is the roadmap itself. Decomposing a design into steps that are each production-drivable vertical slices is the highest-judgment act in the pipeline. The framework validates the roadmap's shape and nothing about whether the decomposition is good. That is the frontier model's job, once per feature, and its output is a diff a person reads. Everything downstream of that diff is a graph.

## DELIVER runs in parallel

DELIVER is sequential today because one big model holds one context and one linear log. Sequencing is a property of the executor, not the work. Once the roadmap is a DAG in rows and the executor is a scheduler, the frontier is every step whose in-edges are all `accepted`, and the frontier runs concurrently.

Three things bound the parallelism. One of them changes how roadmaps should be authored.

- **Dependency edges are only as good as the author declared them.** A frontier model will call two steps independent that both touch the same symbol. The VCS catches this at write time as `conflict`, so the failure is a bounded retry, not corruption. A high conflict rate between two steps means the decomposition was wrong, and that is a metric to feed back to authoring. Better: do not hand-author edges. Each AC declares the symbols it exercises; each step declares the symbols it will write. Derive `step_edges` from symbol overlap. The author proposes steps and ACs; the scheduler computes the DAG. That removes the highest-error part of roadmap authoring from the model.
- **Shared test infrastructure needs leases the way symbols do.** Two steps with disjoint symbols can both need the same VM, the same kernel table, the same port. A `run-tests` effect acquires resource leases, and the test-impact graph says which resources each step's tests touch. Steps sharing none run fully parallel; steps sharing the kernel serialize on that one effect and nothing else. Overdrive's net-slot partitioning and `host-kernel-shared` nextest group are this problem solved by hand.
- **The export target, if it is still git.** The VCS event log is the truth and commits are per-symbol-set with version tags, so there is no global lock inside the framework. If a linear git history is still what consumers expect, serialize at export, not at execution. Export is a rendering, the same way prose is.

Beyond throughput: a `needs-human` suspension blocks that step's subtree and nothing else. Today one step waiting on a design gap stalls the whole feature. In the DAG, every branch not downstream of it keeps going, and the human's queue is a list of independent blocked subtrees.

The one way the graph can be fooled: an AC that depends on a step it does not declare. The test goes `still-red` for the wrong reason and the retry budget burns on a correct implementation. Deriving edges from declared symbol touches closes most of this. The residue is a missed declaration, surfaced as a step that exhausts retries and lands on a person with a trail showing the failing test never referenced anything the step wrote.

## Framework versus consumer

| Framework owns | Consumer owns |
|---|---|
| `Workflow`, `Node`, `Terminal`, `Effect`, `EffectResult` types and the runner | Requirement rows, the source of truth |
| `StepDef` with a mandatory validator, `runStep`, retry and escalation policy | Graph rows and decision functions, committed and diffed in PRs |
| A library of mechanical checks: verbatim-substring, enum-membership, id-in-set, symbol-set-difference | Model bindings: which small models, which validator family |
| Journal interface plus a file or SQLite implementation | Effect executors: what `replace-symbol` and `run-tests` mean in this repo |
| Test harness: stub journal, path enumeration, trace matchers | The known-good hand-written graph used to validate the authoring workflow |
| The authoring workflow: requirement rows to graph rows plus enumeration test | Rendered views for humans |

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
2. **One graph by hand.** The DISTILL classification graph above. This is the known-good answer.
3. **The requirement rows for that graph, by hand.** Ten rows from `testing.md § Classify external execution`. The table-shaped section is the easy case.
4. **The authoring workflow, as a graph on the runtime.** Feed it the rows from step 3. Diff its output against the hand-written graph from step 2. The harness already exists to reject any graph with an unhandled decision or unreachable terminal.
5. **Migrate the prose-heavy rules.** Reconciler triage, workflow triage, deferral handling. This is where "does this rule reduce to a closed enum" gets answered honestly, and where you learn which rules become `cannot-tell` edges.
6. **The DELIVER step-cycle graph.** Fixed, hand-written once, the same for every consumer.
7. **Roadmap authoring and the scheduler.** The last piece, and the one that keeps frontier judgment in the loop. By now everything downstream of a roadmap diff is a graph.

## Open questions

These are the places where the design is a hypothesis, not a finding.

- **Which rules do not reduce to a closed enum.** The claim is that most do, and the rest become explicit escalations. Step 5 of the bootstrap is where that claim gets tested against real prose. If the `cannot-tell` rate is high, the framework is still correct but the human queue is longer than the current process, and that tradeoff needs measuring.
- **Whether small-model validators catch what frontier reviewers catch.** The framework replaces one adversarial reviewer with a mechanical check plus a small model per leaf. Whether that catches the design-divergence class of bug at the same rate is unknown. The symbol-set-difference check catches the invented-API class mechanically; the remainder is an empirical question.
- **Cost per completed task, not per call.** Many small calls plus validators plus retries versus one frontier call is not obviously cheaper. The claim is that it is cheaper *and* more legible. The first should be measured on a real feature before the second is used to justify it.
- **Derived dependency edges assume declared symbol touches.** An AC or step that under-declares produces a false independence. The failure is bounded (a conflict or a wrong-reason `still-red`), but how often it happens in practice determines whether the scheduler's parallelism is real or nominal.
- **The authoring workflow's validator is the compiler and the enumeration test.** That proves the graph is well-formed. It does not prove the graph encodes the rule correctly. The known-good hand-written graph is the only oracle for that, and there is one of it.
