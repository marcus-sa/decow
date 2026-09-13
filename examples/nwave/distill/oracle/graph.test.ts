/**
 * The exhaustive test for the oracle graph.
 *
 * One bounded loop, three choice axes: what the author decided, how its writes
 * landed, and what the measurement said. The third is the one the whole graph
 * is shaped around, and it is an EFFECT outcome rather than a leaf decision —
 * the two roles that hold an oracle cannot run it, so the verdict is
 * software's and the walk gets it from `scriptedExecutor` like any other
 * effect result.
 *
 * Zero model calls, no API key, no network. The leaf is stubbed at the
 * BINDING rather than at the journal, so its three mechanical checks and its
 * validator run on every path, and the scripted payloads below satisfy them.
 * That is what "the author declared exactly these paths" means here.
 */

import { describe, expect, test } from "bun:test";
import { memoryEffects, type Effect, type EffectResult, type OracleVerdict } from "@des/core/effects";
import type { ModelBinding } from "@des/core/step";
import { resume, run, type EffectExecutor } from "@des/core/workflow";
import {
  enumeratePaths,
  graphDefects,
  inspectGraph,
  scriptedExecutor,
  type Choose,
  type EffectOutcomeSpace,
} from "@des/core/harness";
import { endedOnDeclaredNode, isDeclaredOutcome, visitCount, visited } from "@des/core/harness";
import { noReplayJournal } from "@des/core/harness/no-replay";
import { scriptedBinding, throws, type ScriptedAnswer } from "@des/core/harness/scripted-binding";
import {
  BLOCK_REASONS,
  MAX_AUTHOR_ATTEMPTS,
  oracleGraph,
  seed,
  writeVerdictOf,
  type State,
} from "./graph.ts";
import { AUTHOR_OUTCOMES, oracleDefs, type AuthorOutcome, type ValueUnderOracle } from "./steps.ts";

/** The leaf's step id, which is what a script is keyed by. */
const AUTHOR = "distill.author-oracle";

/** The defs over one scripted binding, which serves both slots. */
const defsFor = (binding: ModelBinding) => oracleDefs({ worker: binding, validator: binding });

const DESIGN = "TodoStore.complete(id): Todo. Throws UnknownTodoError for an id the store does not hold.";
const TEST_PATHS = ["test"];

const VALUE: ValueUnderOracle = {
  stepId: "01-01",
  observation: "TodoStore.complete marks a todo done and rejects an id the store does not hold.",
  acceptance: [
    {
      id: "01-01-AC-1",
      stimulus: "Complete a todo the store holds.",
      expected: "It is returned with done set.",
    },
  ],
  oracle: "test/todo.test.ts::complete marks the todo done",
  supports: ["test/support/store.ts"],
  authority: "design.md § Behaviour -> complete",
};

const ORACLE_BODY = 'import { test } from "bun:test";\n\ntest("complete marks the todo done", () => {});\n';
const SUPPORT_BODY = "export const aStore = () => undefined;\n";

/** The payload an `authored` turn returns: the oracle and its one support. */
const AUTHORED = {
  files: [
    { path: "test/todo.test.ts", body: ORACLE_BODY },
    { path: "test/support/store.ts", body: SUPPORT_BODY },
  ],
  reason: "the obligation is falsified by the one assertion",
};

const REJECTED = {
  files: [],
  reason: "the store declares no way to observe done without reading a private field",
};

/** The sentinel for "this leaf's validator was never satisfied". */
const EXHAUSTED = "$exhausted";
type Script = AuthorOutcome | typeof EXHAUSTED;

/** The answers a worker gives, per script. The last one repeats. */
const answersFor = (script: Script): ScriptedAnswer[] =>
  script === EXHAUSTED
    ? throws("the author had nothing to say")
    : [{ decision: script, payload: script === "authored" ? AUTHORED : REJECTED }];

const bindingFor = (script: Script): ModelBinding =>
  scriptedBinding({ [AUTHOR]: answersFor(script) });

/* ------------------------------------------------------------- executors */

const measured = (effect: Effect, verdict: OracleVerdict): EffectResult => ({
  effect,
  outcome: verdict === "green" ? "committed" : "rejected",
  ...(verdict === "green" ? { version: 1 } : { by: "tests" as const }),
  measured: {
    verdict,
    axis: "counts",
    output: `the runner said ${verdict}`,
    exitCode: verdict === "green" ? 0 : 1,
    argv: ["bun", "test"],
  },
}) as EffectResult;

/** Every write lands; the measurement answers with the verdicts in order. */
const measuresLike = (verdicts: readonly OracleVerdict[]): EffectExecutor => {
  let n = 0;
  return async (effects) =>
    effects.map((effect) =>
      effect.type === "measure-oracle"
        ? measured(effect, verdicts[n++] ?? "red")
        : ({ effect, outcome: "committed", version: 1 } as EffectResult),
    );
};

/** Every write comes back the same way; nothing is measured. */
const writesAs = (outcome: EffectResult["outcome"], by?: "contract" | "typecheck"): EffectExecutor =>
  async (effects) =>
    effects.map((effect): EffectResult => {
      if (effect.type !== "write-file") return { effect, outcome: "committed", version: 1 };
      switch (outcome) {
        case "committed":
          return { effect, outcome, version: 1 };
        case "conflict":
          return { effect, outcome, currentVersion: 1 };
        case "rejected":
          return { effect, outcome, by: by ?? "typecheck" };
        case "infra-failed":
          return { effect, outcome };
      }
    });

const start = (script: Script, execute: EffectExecutor = measuresLike(["red"])) =>
  run<State>(
    oracleGraph(noReplayJournal(), defsFor(bindingFor(script))),
    seed({ value: VALUE, design: DESIGN, testPaths: TEST_PATHS }),
    execute,
  );

describe("the oracle graph", () => {
  test("the graph is structurally well-formed", () => {
    expect(graphDefects(oracleGraph(noReplayJournal(), defsFor(bindingFor("authored"))))).toEqual([]);
  });

  test("the happy path authors, writes, measures red, and accepts", async () => {
    const asked: Effect[] = [];
    const record: EffectExecutor = async (effects) => {
      asked.push(...effects);
      return measuresLike(["red"])(effects);
    };
    const outcome = await start("authored", record);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.trace).toEqual([
      "author",
      "author-oracle",
      "author.route",
      "write-oracle",
      "write.verdict",
      "measure",
      "measure.verdict",
      "author.verdict",
      "accept",
    ]);

    // One `write-file` per declared path, then the measurement — in that order,
    // because measuring an oracle that is not on disk yet measures nothing.
    expect(asked.map((e) => e.type)).toEqual(["write-file", "write-file", "measure-oracle"]);
    expect(asked[0]).toEqual({ type: "write-file", path: "test/todo.test.ts", body: ORACLE_BODY });
    expect(asked[2]).toEqual({ type: "measure-oracle", oracle: VALUE.oracle });
  });

  test("red is the ANSWER this graph wants, and the only route to accepted", async () => {
    // Every other verdict parks. That is the inversion the whole wave rests
    // on: a failure is the desired outcome, because it is what says the oracle
    // fails on its assertion before one production byte exists.
    for (const verdict of ["green", "broken", "indeterminate"] as const) {
      const parked = await start("authored", measuresLike([verdict, verdict]));
      expect(parked.kind).toBe("suspended");
    }
    const accepted = await start("authored", measuresLike(["red"]));
    expect(accepted.kind === "terminal" && accepted.terminal.kind).toBe("accepted");
  });

  test("green is a vacuous oracle and goes to a person, charged to the oracle", async () => {
    // An oracle that passes before any production code proves nothing. nwave
    // computes the same verdict and does not arm it, because four of its own
    // behaviours legitimately reach it; none of them is reachable here.
    const outcome = await start("authored", measuresLike(["green"]));
    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("vacuous-oracle");
    expect(outcome.trail[2]).toMatchObject({ defectOwner: "oracle" });
    expect(visitCount(outcome.trace, "author-oracle")).toBe(1);
  });

  test("broken gets the correction turn, with the runner's own output as the finding", async () => {
    const outcome = await start("authored", measuresLike(["broken", "broken"]));

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    // The bound was spent on corrections, and the reason names the OWNER:
    // a broken oracle is its author's, and no role downstream may repair it.
    expect(outcome.reason).toBe("oracle-broken");
    expect(outcome.trail[2]).toMatchObject({ defectOwner: "oracle" });
    expect(visitCount(outcome.trace, "author-oracle")).toBe(MAX_AUTHOR_ATTEMPTS);
    expect(visitCount(outcome.trace, "measure")).toBe(MAX_AUTHOR_ATTEMPTS);
    // The finding handed back is the runner's own words, not a paraphrase.
    expect(outcome.trail[4]).toMatchObject({ finding: "the runner said broken" });
  });

  test("a broken oracle corrected inside the bound reaches red and accepts", async () => {
    const outcome = await start("authored", measuresLike(["broken", "red"]));
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(visitCount(outcome.trace, "author-oracle")).toBe(2);
  });

  test("cannot-express is a design gap: nothing is written and the owner is the design", async () => {
    // The rejecting author owns no byte. Its finding travels, its edits do not.
    const asked: Effect[] = [];
    const outcome = await start("cannot-express", async (effects) => {
      asked.push(...effects);
      return measuresLike(["red"])(effects);
    });

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("design-gap");
    expect(outcome.trail[2]).toMatchObject({ defectOwner: "design", reason: REJECTED.reason });
    expect(asked.filter((e) => e.type === "write-file")).toEqual([]);
    expect(visited(outcome.trace, "measure")).toBe(false);
  });

  test("a write the executor refuses on contract is a block, not a retry", async () => {
    // That is the protected-path wall, or a path outside the lease's scope.
    // Nothing inside this loop repairs a turn that wrote where it may not.
    const outcome = await start("authored", writesAs("rejected", "contract"));
    expect(outcome.kind === "suspended" && outcome.reason).toBe("write-refused");
    expect(visitCount(outcome.trace, "author-oracle")).toBe(1);
    expect(visited(outcome.trace, "measure")).toBe(false);
  });

  test("a write a gate refused is a defect in the bytes, so the author gets it back", async () => {
    const outcome = await start("authored", writesAs("rejected", "typecheck"));
    expect(outcome.kind === "suspended" && outcome.reason).toBe("author-loop-exhausted");
    expect(visitCount(outcome.trace, "author-oracle")).toBe(MAX_AUTHOR_ATTEMPTS);
    // And the gate's own words are the finding the correction reads.
    expect(outcome.kind === "suspended" && outcome.trail[4]).toMatchObject({
      finding: "test/todo.test.ts: the typecheck gate refused the file",
    });
  });

  test("a conflict retries; an infra failure does not", async () => {
    const retried = await start("authored", writesAs("conflict"));
    expect(retried.kind === "suspended" && retried.reason).toBe("author-loop-exhausted");
    expect(visitCount(retried.trace, "author-oracle")).toBe(MAX_AUTHOR_ATTEMPTS);

    const gaveUp = await start("authored", writesAs("infra-failed"));
    expect(gaveUp.kind === "suspended" && gaveUp.reason).toBe("write-infra-failed");
    expect(visitCount(gaveUp.trace, "author-oracle")).toBe(1);
  });

  test("an exhausted validator parks under its own reason", async () => {
    const outcome = await start(EXHAUSTED);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("validator-exhausted");
    expect(visited(outcome.trace, "write-oracle")).toBe(false);
  });

  test("the in-memory executor cannot write a file, and the graph routes that", async () => {
    const outcome = await start("authored", memoryEffects().execute);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("write-infra-failed");
  });

  test("a measurement that carries no verdict is the harness, not the oracle", async () => {
    // The runner never started, so nothing about the oracle was observed and
    // nothing about it is claimed — in particular its author is not blamed.
    const unmeasured: EffectExecutor = async (effects) =>
      effects.map((effect): EffectResult =>
        effect.type === "measure-oracle"
          ? { effect, outcome: "infra-failed" }
          : { effect, outcome: "committed", version: 1 },
      );
    const outcome = await start("authored", unmeasured);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("harness");
    expect(outcome.kind === "suspended" && outcome.trail[2]).toMatchObject({ defectOwner: undefined });
  });

  test("a person's abandon reaches the rejected terminal", async () => {
    const wf = oracleGraph(noReplayJournal(), defsFor(bindingFor("cannot-express")));
    const parked = await run<State>(
      wf,
      seed({ value: VALUE, design: DESIGN, testPaths: TEST_PATHS }),
      measuresLike(["red"]),
    );
    if (parked.kind !== "suspended") throw new Error("expected the run to park");
    const done = await resume<State>(wf, parked.runId, { decision: "abandon" }, measuresLike(["red"]));
    expect(done.kind === "terminal" && done.terminal.kind).toBe("rejected");
  });

  test("a proposal-shape binding's effects are preferred over file bodies", async () => {
    // The two binding shapes reach the same node with the same meaning: a
    // structured-output turn returns bodies, a proposal turn returns the
    // effects it derived from its own writes, and `write-oracle` takes
    // whichever arrived.
    const asked: Effect[] = [];
    const proposing = scriptedBinding({
      [AUTHOR]: [
        {
          decision: "authored",
          payload: {
            ...AUTHORED,
            proposal: [{ type: "write-file", path: "test/from-a-proposal.ts", body: "// proposed\n" }],
          },
        },
      ],
    });
    await run<State>(
      oracleGraph(noReplayJournal(), defsFor(proposing)),
      seed({ value: VALUE, design: DESIGN, testPaths: TEST_PATHS }),
      async (effects) => {
        asked.push(...effects);
        return measuresLike(["red"])(effects);
      },
    );

    expect(asked.filter((e) => e.type === "write-file")).toEqual([
      { type: "write-file", path: "test/from-a-proposal.ts", body: "// proposed\n" },
    ]);
  });
});

describe("the write verdict, as the pure function it is", () => {
  const write = (path: string): Effect => ({ type: "write-file", path, body: "" });

  test("a batch nobody wrote is not-run, which is not a block", () => {
    expect(writeVerdictOf(undefined)).toBe("not-run");
    expect(writeVerdictOf([])).toBe("not-run");
  });

  test("the first refusal in the batch names the verdict", () => {
    // A partial write is not a smaller success: one file refused means the
    // oracle set is not on disk, so the first failure is what the graph reads.
    expect(
      writeVerdictOf([
        { effect: write("a"), outcome: "committed", version: 1 },
        { effect: write("b"), outcome: "rejected", by: "contract" },
      ]),
    ).toBe("refused");
  });

  test("contract is the wall and every other gate is a defect in the bytes", () => {
    for (const by of ["typecheck", "structural", "tests", "schema"] as const) {
      expect(writeVerdictOf([{ effect: write("a"), outcome: "rejected", by }])).toBe("defective");
    }
    expect(writeVerdictOf([{ effect: write("a"), outcome: "rejected", by: "contract" }])).toBe("refused");
  });
});

/**
 * The walk. Every author decision, every write outcome, every verdict, and
 * both loop counts, once each.
 */
describe("the oracle graph, exhaustively", () => {
  test("every decision, write outcome and verdict reaches a declared outcome", async () => {
    const seen = new Set<string>();
    const reasons = new Set<string>();
    const terminals = new Set<string>();

    const paths = await enumeratePaths(async (choose) => {
      const wf = oracleGraph(noReplayJournal(), defsFor(chooseBinding(choose)));
      const execute = scriptedExecutor(choose, ORACLE_SPACE);
      let outcome = await run<State>(
        wf,
        seed({ value: VALUE, design: DESIGN, testPaths: TEST_PATHS }),
        execute,
      );

      for (let guard = 0; outcome.kind === "suspended"; guard += 1) {
        if (guard > MAX_AUTHOR_ATTEMPTS + 2) throw new Error("the run never reached a terminal");
        for (const id of outcome.trace) seen.add(id);
        reasons.add(outcome.reason);
        outcome = await resume<State>(wf, outcome.runId, { decision: "abandon" }, execute);
      }

      expect(isDeclaredOutcome(outcome)).toBe(true);
      expect(endedOnDeclaredNode(wf, outcome)).toBe(true);
      for (const id of outcome.trace) seen.add(id);
      terminals.add(outcome.terminal.kind);
      return outcome;
    });

    expect(paths).toHaveLength(EXPECTED_PATHS);

    const reachable = inspectGraph(oracleGraph(noReplayJournal(), defsFor(bindingFor("authored")))).reachable;
    expect(reachable.filter((id) => !seen.has(id))).toEqual([]);

    expect([...reasons].sort()).toEqual([...BLOCK_REASONS].sort());
    expect([...terminals].sort()).toEqual(["accepted", "rejected"]);
  }, 120_000);
});

/** The count the walk produces, pinned so a graph change has to restate it. */
const EXPECTED_PATHS = 421;

/* ------------------------------------------------------------- walk wiring */

/**
 * Answers the author leaf from its own closed set plus "the worker never
 * answered". Consulted once per INVOCATION, because `scriptedBinding` holds
 * the chosen answers across a leaf's retries — so a leaf is one choice point
 * whether or not it retried.
 */
const chooseBinding = (choose: Choose): ModelBinding =>
  scriptedBinding(({ step }) => {
    if (step.id !== AUTHOR) throw new Error(`unexpected leaf ${step.id}`);
    return answersFor(choose<Script>("leaf:author-oracle", [...AUTHOR_OUTCOMES, EXHAUSTED]));
  });

/**
 * The walk's effect axis. Both effect types the graph emits are named, because
 * `scriptedExecutor` refuses one that is not: a silent `committed` would make
 * the coverage claim a fiction for the edges the other outcomes route to.
 *
 * `write-file` gets the four `EffectResult` outcomes, with `rejected` split by
 * the gate because the graph routes `contract` differently from every other.
 * `measure-oracle` gets the four verdicts plus the measurement that never
 * happened, which is five of the six arms its branch declares — the sixth,
 * `not-run`, is reachable only by a write that never landed and the walk gets
 * there through the first axis.
 */
const ORACLE_SPACE: EffectOutcomeSpace = {
  "write-file": [
    { name: "committed", result: (effect) => ({ effect, outcome: "committed", version: 1 }) },
    { name: "conflict", result: (effect) => ({ effect, outcome: "conflict", currentVersion: 1 }) },
    { name: "refused", result: (effect) => ({ effect, outcome: "rejected", by: "contract" }) },
    { name: "defective", result: (effect) => ({ effect, outcome: "rejected", by: "typecheck" }) },
    { name: "infra-failed", result: (effect) => ({ effect, outcome: "infra-failed" }) },
  ],
  "measure-oracle": [
    { name: "red", result: (effect) => measured(effect, "red") },
    { name: "broken", result: (effect) => measured(effect, "broken") },
    { name: "green", result: (effect) => measured(effect, "green") },
    { name: "indeterminate", result: (effect) => measured(effect, "indeterminate") },
    { name: "unmeasured", result: (effect) => ({ effect, outcome: "infra-failed" }) },
  ],
  "append-trail": [
    { name: "committed", result: (effect) => ({ effect, outcome: "committed", version: 1 }) },
  ],
};
