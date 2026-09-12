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

## Four rules that make a workflow deterministic

The workflow is a finite graph. Every path through it is enumerable before it runs.

1. **Only enums and booleans drive edges.** Every step output splits into `decision`, a closed enum the graph may branch on, and `payload`, free text the graph carries but never reads.
2. **Every branch's edge table is exhaustive at compile time.** A branch over a decision type `D` takes `Record<D, NodeId>`. Adding a decision value without an edge is a type error.
3. **Terminals are enumerated, not thrown.** A workflow ends in `accepted`, `rejected`, or `needs-human`. No exception crosses the graph boundary. A step that cannot produce a valid output returns a state carrying that fact, and a branch routes it.
4. **Effects are data.** A step returns `Effect[]`. The runner executes them and feeds typed results back into state. Steps never touch a filesystem, a database, or a network directly.

Given these, the graph's path space is finite, so you can enumerate it with a stub model and assert every path lands on a declared terminal. No API key, no network, milliseconds. That is the property the rest of this document builds on.

What is not deterministic: the leaf model calls. The framework does not need them to be. It needs their output space to be closed, their outputs validated, and their results journaled so a replay never re-infers.

## Primitives

The framework is provider-agnostic. The sketches below use the Vercel AI SDK because it is the thinnest layer; every orchestration concept maps one-to-one onto Mastra's `createStep` and `.parallel()`.

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

const journalKey = (def: StepDef<any, any>, input: unknown) =>
  createHash("sha256")
    .update(`${def.id}@${def.version}:${JSON.stringify(input, Object.keys(input as object).sort())}`)
    .digest("hex");
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

### Workflow graph and runner

Four node types. `branch` is the load-bearing one: its edge table is typed by the decision union.

```ts
export type NodeId = string;

export type Terminal<S> =
  | { kind: "accepted";    state: S }
  | { kind: "rejected";    state: S; trail: unknown[] }
  | { kind: "needs-human"; state: S; reason: string };   // a closed enum per workflow

export type Node<S> =
  | { type: "step";     run: (s: S) => Promise<{ state: S; effects: Effect[] }>;
                        absorb: (s: S, results: EffectResult[]) => S; next: NodeId }
  | { type: "fanout";   steps: NodeId[]; join: NodeId }
  | { type: "branch";   on: (s: S) => string; edges: Record<string, NodeId> }
  | { type: "terminal"; done: (s: S) => Terminal<S> };

export type Workflow<S> = { start: NodeId; nodes: Record<NodeId, Node<S>> };

export const branch = <S, D extends string>(on: (s: S) => D, edges: Record<D, NodeId>): Node<S> =>
  ({ type: "branch", on, edges });
```

The runner. The only errors it throws are graph bugs: a missing node or an unhandled edge, both of which the enumeration test catches before any model runs.

```ts
export async function run<S>(
  wf: Workflow<S>,
  state: S,
  execute: (effects: Effect[]) => Promise<EffectResult[]>,
  trace: NodeId[] = [],
): Promise<{ result: Terminal<S>; trace: NodeId[] }> {
  let cursor = wf.start;
  for (;;) {
    const node = wf.nodes[cursor];
    if (!node) throw new Error(`graph bug: no node ${cursor}`);
    trace.push(cursor);
    switch (node.type) {
      case "step": {
        const out = await node.run(state);
        const results = await execute(out.effects);
        state = node.absorb(out.state, results);
        cursor = node.next;
        break;
      }
      case "fanout": {
        // Results merge positionally, so completion order cannot change the trajectory.
        const outs = await Promise.all(node.steps.map(async id => {
          const n = wf.nodes[id];
          if (n?.type !== "step") throw new Error(`graph bug: fanout target ${id} is not a step`);
          trace.push(id);
          const out = await n.run(state);
          return n.absorb(out.state, await execute(out.effects));
        }));
        state = outs.reduce((acc, s) => ({ ...acc, ...s }), state);
        cursor = node.join;
        break;
      }
      case "branch": {
        const key = node.on(state);
        const next = node.edges[key];
        if (!next) throw new Error(`graph bug: ${cursor} has no edge for ${key}`);
        cursor = next;
        break;
      }
      case "terminal":
        return { result: node.done(state), trace };
    }
  }
}
```

The trace is the provenance record. The runner writes it as it traverses. A model cannot claim to have reached a node it did not reach.

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

Notably absent from the union: `create-issue`, `send-message`, or anything else that is a shared, outward-facing action. A worker step cannot defer work by opening a ticket. The only way to defer is a `needs-human` terminal with a typed reason. The rule "agents never create issues unilaterally" is unrepresentable rather than enforced.

### Journal

Keyed by `(step id, step version, input hash)`. A hit returns the stored `StepResult` and the model is never called. This is what makes a workflow replayable: rerun it against the same journal and the trajectory is identical, byte for byte, with zero inference.

The journal answers "what did each step decide." It is not the provenance log for code changes. That lives in the VCS event log, linked one way: every effect the runner executes carries the journal key and step id as its intent. The dependency never runs the other direction.

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

```ts
type State = {
  scenario: Scenario;
  e2e?: Lane; expectation?: Lane; benchmark?: Lane; dst?: Lane;
  anchors: Record<string, string>;
  exhausted: Kind[];
};

const classify = (kind: Kind, def: StepDef<Scenario, any>, journal: Journal): Node<State> => ({
  type: "step",
  run: async s => {
    const r = await runStep(def, s.scenario, journal);
    return r.decision === "ok"
      ? { state: { ...s, [kind]: r.output.decision, anchors: { ...s.anchors, [kind]: r.output.payload.anchor } }, effects: [] }
      : { state: { ...s, [kind]: "cannot-tell", exhausted: [...s.exhausted, kind] },
          effects: [{ type: "append-trail", line: JSON.stringify({ kind, trail: r.trail }) }] };
  },
  absorb: s => s,
  next: "merge",
});

type MergeVerdict = "complete" | "benchmark-expectation-conflict" | "incomplete-boundary" | "undecidable";

const mergeVerdict = (s: State): MergeVerdict => {
  if (s.exhausted.length > 0) return "undecidable";
  if (s.benchmark === "needed" && s.expectation === "needed") return "benchmark-expectation-conflict";
  if (s.scenario.crossesBoundary && s.dst !== "needed" && s.e2e !== "needed") return "incomplete-boundary";
  return "complete";
};

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
      "incomplete-boundary":            "needs-human",
      "undecidable":                    "needs-human",
    }),

    "demote-expectation": {
      type: "step",
      run: async s => ({ state: { ...s, expectation: "not-needed" },
                         effects: [{ type: "append-trail", line: `${s.scenario.id}: expectation demoted, benchmark wins` }] }),
      absorb: s => s,
      next: "accept",
    },

    accept:        { type: "terminal", done: s => ({ kind: "accepted", state: s }) },
    "needs-human": { type: "terminal", done: s => ({
      kind: "needs-human", state: s,
      reason: s.exhausted.length ? "validator-exhausted" : "incomplete-boundary",
    }) },
  },
});
```

The exhaustive test. Three lanes, four classifiers, two boundary flags: 162 paths. A journal pre-seeded with the outputs stands in for the models. Every path must land on a declared terminal.

```ts
const LANES = ["needed", "not-needed", "cannot-tell"] as const;

const cartesian = <T>(xs: readonly T[], n: number): T[][] =>
  n === 0 ? [[]] : cartesian(xs, n - 1).flatMap(rest => xs.map(x => [x, ...rest]));

test("every classifier outcome reaches a declared terminal", async () => {
  for (const [e2e, expectation, benchmark, dst] of cartesian(LANES, 4)) {
    for (const crossesBoundary of [true, false]) {
      const { result, trace } = await run(
        distillGraph(stubJournal({ e2e, expectation, benchmark, dst }), defs),
        { scenario: { id: "S-1", text: "…", crossesBoundary }, anchors: {}, exhausted: [] },
        async () => [],
      );
      expect(["accepted", "rejected", "needs-human"]).toContain(result.kind);
      expect(trace.at(-1)).toMatch(/^(accept|needs-human)$/);
    }
  }
});

test("benchmark plus expectation always demotes expectation", async () => {
  const { result, trace } = await run(
    distillGraph(stubJournal({ e2e: "not-needed", expectation: "needed", benchmark: "needed", dst: "not-needed" }), defs),
    seed(false), async () => [],
  );
  expect(trace).toContain("demote-expectation");
  expect(result.kind === "accepted" && result.state.expectation).toBe("not-needed");
});
```

Changing a rule in `testing.md` means changing one line in `mergeVerdict`, and the compiler names every edge that needs updating. The models' job has been reduced to producing one of three words per classifier. Everything they cannot decide routes to a person with a trail attached.

## The agent-native VCS is the effect executor and mechanical verifier

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
| "No effort budget cuts" | Terminal is `accepted` only when every bound AC is `green`. Partial is `needs-human`; no edge leads from partial to `accepted` |
| "Deferrals need a GH issue and user approval" | No `create-issue` effect exists. The only deferral is a `needs-human` terminal with a typed reason |

### The step cycle as a graph

```
activate-at ─► run-tests ─branch─┬─ red-observed ──► implement ─► run-tests ─branch─┬─ green ────────► refactor ─► gates ─► commit ─► accepted
                                 ├─ already-green ─► needs-human (AT is vacuous)       ├─ still-red ────► implement (bounded retry)
                                 └─ harness-failed ► needs-human                        ├─ broke-other ──► implement (bounded retry)
                                                                                        └─ harness-failed ► needs-human

gates ─branch─┬─ clean ──────────────────► commit
              ├─ clippy-in-scope ────────► fix-lint ─► gates
              ├─ mutation-below-gate ────► add-test ─► run-tests
              └─ out-of-scope-structural ► needs-human
```

Every branch is a closed enum. `already-green` at RED is a first-class outcome routed to a person, because a test that passes before implementation is a testing-theater signal the current process catches only if a reviewer notices. `harness-failed` is distinct from `still-red` so a flaky run does not burn the implement retry budget.

### What decomposes and what stays wide

The crafter today is one big model doing everything in the diagram. Most nodes are narrow leaves: classify a test outcome, classify a lint finding, decide whether a diff matches the design. Each is a small model with a validator.

The `implement` leaf stays wide. "Make this AT pass with the minimal change" is code generation, not a closed-enum decision. The framework does not require that leaf to be a small model. It requires it to be validated narrowly: the output schema admits only `replace-symbol` effects, the VCS gate runs typecheck and impacted tests, and the validator runs the API-surface diff. Put a mid-size model there if it earns it. "Many small models" is the default because most leaves are classifications. It is not a law forbidding a capable model where the output is genuinely open.

What stays hard is the roadmap itself. Decomposing a design into steps that are each production-drivable vertical slices is the highest-judgment act in the pipeline. The framework validates the roadmap's shape and nothing about whether the decomposition is good. That is the frontier model's job, once per feature, and its output is a diff a person reads. Everything downstream of that diff is a graph.

## DELIVER runs in parallel

DELIVER is sequential today because one big model holds one context and one linear log. Sequencing is a property of the executor, not the work. Once the roadmap is a DAG in rows and the executor is a scheduler, the frontier is every step whose in-edges are all `accepted`, and the frontier runs concurrently.

Three things bound the parallelism. One of them changes how roadmaps should be authored.

- **Dependency edges are only as good as the author declared them.** A frontier model will call two steps independent that both touch the same symbol. The VCS catches this at write time as `conflict`, so the failure is a bounded retry, not corruption. A high conflict rate between two steps means the decomposition was wrong, and that is a metric to feed back to authoring. Better: do not hand-author edges. Each AC declares the symbols it exercises; each step declares the symbols it will write. Derive `step_edges` from symbol overlap. The author proposes steps and ACs; the scheduler computes the DAG. That removes the highest-error part of roadmap authoring from the model.
- **Shared test infrastructure needs leases the way symbols do.** Two steps with disjoint symbols can both need the same VM, the same kernel table, the same port. A `run-tests` effect acquires resource leases, and the test-impact graph says which resources each step's tests touch. Steps sharing none run fully parallel; steps sharing the kernel serialize on that one effect and nothing else. Overdrive's net-slot partitioning and `host-kernel-shared` nextest group are this problem solved by hand.
- **The export target, if it is still git.** The VCS event log is the truth and commits are per-symbol-set with version tags, so there is no global lock inside the framework. If a linear git history is still what consumers expect, serialize at export, not at execution. Export is a rendering, the same way prose is.

Beyond throughput: a `needs-human` terminal blocks that step's subtree and nothing else. Today one step waiting on a design gap stalls the whole feature. In the DAG, every branch not downstream of it keeps going, and the human's queue is a list of independent blocked subtrees.

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
