/**
 * The exhaustive test for the obligations graph.
 *
 * One bounded loop, so the path space is SEQUENCES and `enumeratePaths` walks
 * it rather than `cartesian`. Two things are choices: what the leaf proposed
 * — which is a choice of MANIFEST, because the branch after it reads a pure
 * function of the data — and how the artifact rows landed.
 *
 * Zero model calls, no API key, no network. The stub journal throws on a miss
 * and the model bindings throw if called at all.
 */

import { describe, expect, test } from "bun:test";
import type { Effect, EffectResult } from "@des/core/effects";
import { stepIdFromKey, type Journal } from "@des/core/journal";
import type { StepResult } from "@des/core/step";
import { resume, run, type EffectExecutor } from "@des/core/workflow";
import {
  enumeratePaths,
  graphDefects,
  inspectGraph,
  type Choose,
} from "@des/core/harness";
import { endedOnDeclaredNode, isDeclaredOutcome, visitCount, visited } from "@des/core/harness";
import { exhausted, ok, stubJournal } from "@des/core/harness/stub-journal";
import { ROADMAP_STEPS_TABLE } from "../../roadmap/graph.ts";
import type { Roadmap } from "../../roadmap/schema.ts";
import { manifestDefects, type ProposedValue } from "../manifest.ts";
import {
  BLOCK_REASONS,
  MAX_PROPOSALS,
  obligationsGraph,
  seed,
  type State,
} from "./graph.ts";
import { obligationsDefs } from "./steps.ts";

/** A model binding that fails the test if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T,>(): Promise<T> => {
    throw new Error(`model "${id}" was called; this suite must spend zero model calls`);
  },
});

const defs = obligationsDefs({ worker: forbidden("worker"), validator: forbidden("validator") });

const DESIGN = "TodoStore.complete(id) returns the todo with done set. UnknownTodoError otherwise.";
const TEST_PATHS = ["test"];

const ROADMAP: Roadmap = {
  request: "Implement the stubbed behaviours in the todo store.",
  steps: [
    {
      id: "01-01",
      observation: "TodoStore.complete marks a todo done and rejects an id the store does not hold.",
      dependencies: [],
      authority: "design.md § Behaviour -> complete",
      predictedTouches: ["sym-complete"],
      acceptance: [],
      supports: [],
    },
  ],
};

/** A manifest that validates against `ROADMAP`. */
const GOOD: ProposedValue[] = [
  {
    observation: ROADMAP.steps[0]?.observation ?? "",
    acceptance: [
      {
        id: "01-01-AC-1",
        stimulus: "Complete a todo the store holds.",
        expected: "It is returned with done set, and list narrowed to done returns it.",
      },
    ],
    oracle: "test/todo.test.ts::complete marks the todo done",
    supports: [],
  },
];

/** Every kind of refusal the validator can produce, one manifest each. */
const PROPOSALS: Record<string, ProposedValue[]> = {
  good: GOOD,
  "unknown-observation": [{ ...(GOOD[0] as ProposedValue), observation: "something else entirely" }],
  "no-obligations": [{ ...(GOOD[0] as ProposedValue), acceptance: [] }],
  "bad-oracle": [{ ...(GOOD[0] as ProposedValue), oracle: "../outside/the/repo.test.ts::x" }],
  "ignored-support": [{ ...(GOOD[0] as ProposedValue), supports: ["test/generated.ts"] }],
  none: [],
};
type ProposalName = keyof typeof PROPOSALS;

/** The sentinel for "this leaf's validator was never satisfied". */
const EXHAUSTED = "$exhausted";

const journalFor = (proposal: ProposalName | typeof EXHAUSTED) =>
  stubJournal({
    "distill.propose-obligations":
      proposal === EXHAUSTED
        ? exhausted()
        : ok({ decision: "proposed", payload: { values: PROPOSALS[proposal] ?? [], rationale: "stubbed" } }),
  } as Record<string, StepResult<unknown>>);

/** The one path this repository "ignores", for the injected predicate. */
const ignores = (path: string) => path === "test/generated.ts";

const landsCleanly: EffectExecutor = async (effects) =>
  effects.map((effect) => ({ effect, outcome: "committed" as const, version: 1 }));

const start = (proposal: ProposalName | typeof EXHAUSTED, execute: EffectExecutor = landsCleanly) =>
  run<State>(
    obligationsGraph(journalFor(proposal), defs, ignores),
    seed({ roadmap: ROADMAP, design: DESIGN, testPaths: TEST_PATHS, versions: { "01-01": 1 } }),
    execute,
  );

describe("the obligations graph", () => {
  test("the graph is structurally well-formed", () => {
    expect(graphDefects(obligationsGraph(journalFor("good"), defs))).toEqual([]);
  });

  test("a valid manifest persists the enriched rows, with no person in the way", async () => {
    // `des distill` validates and persists in one step. Every reason it could
    // refuse is a named defect a proposal can be re-driven against, so a review
    // gate here would be a person re-reading what a total function decided.
    const asked: Effect[] = [];
    const record: EffectExecutor = async (effects) => {
      asked.push(...effects);
      return landsCleanly(effects);
    };
    const outcome = await start("good", record);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(outcome.trace).toEqual([
      "obligations",
      "propose-obligations",
      "propose.route",
      "validate-manifest",
      "manifest.route",
      "obligations.verdict",
      "persist",
      "persist.verdict",
      "accept",
    ]);

    // One upsert per roadmap row, at the version the state carried, carrying
    // the SAME row with its three empty fields filled in.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      type: "upsert-artifact",
      table: ROADMAP_STEPS_TABLE,
      id: "01-01",
      expectedVersion: 1,
    });
    const row = (asked[0] as Extract<Effect, { type: "upsert-artifact" }>).row as Record<string, unknown>;
    expect(row).toMatchObject({
      id: "01-01",
      authority: "design.md § Behaviour -> complete",
      oracle: "test/todo.test.ts::complete marks the todo done",
      supports: [],
    });
    expect((row.acceptance as unknown[])).toHaveLength(1);
  });

  test("an invalid manifest iterates with the defects named, then hands the bound to a person", async () => {
    const outcome = await start("no-obligations");

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("defects-unresolved");
    expect(visitCount(outcome.trace, "propose-obligations")).toBe(MAX_PROPOSALS);
    expect(visitCount(outcome.trace, "validate-manifest")).toBe(MAX_PROPOSALS);
    expect(visited(outcome.trace, "persist")).toBe(false);
    // The person reads the same NAMED defects the leaf was re-prompted with,
    // which is the whole reason they are rows rather than a boolean.
    expect(outcome.trail[2]).toMatchObject({ defects: [{ kind: "no-obligations" }] });
  });

  test("the repository's own ignore list is the gate's rule, not the leaf's", async () => {
    // A support the repository ignores is a generated artifact rather than
    // evidence reproducible from the commit. It is the ONE rule the leaf's
    // mechanical checks cannot carry, because the leaf's context has no
    // repository in it — so the gate owns it alone, and this is what says so.
    const outcome = await start("ignored-support");
    expect(outcome.kind === "suspended" && outcome.reason).toBe("defects-unresolved");
    expect(outcome.kind === "suspended" && outcome.trail[2]).toMatchObject({
      defects: [{ kind: "support-ignored", support: "test/generated.ts" }],
    });

    // And with no predicate the same manifest is admissible, because an
    // unanswered ignore question is not a defect.
    const unasked = await run<State>(
      obligationsGraph(journalFor("ignored-support"), defs),
      seed({ roadmap: ROADMAP, design: DESIGN, testPaths: TEST_PATHS }),
      landsCleanly,
    );
    expect(unasked.kind === "terminal" && unasked.terminal.kind).toBe("accepted");
  });

  test("an exhausted validator blocks at once rather than spending the bound", async () => {
    const outcome = await start(EXHAUSTED);
    expect(outcome.kind === "suspended" && outcome.reason).toBe("validator-exhausted");
    expect(visitCount(outcome.trace, "propose-obligations")).toBe(1);
    expect(visited(outcome.trace, "validate-manifest")).toBe(false);
  });

  test("a refused persist parks with its own reason, one per way of not committing", async () => {
    for (const [outcome, reason] of [
      ["conflict", "persist-conflict"],
      ["rejected", "persist-rejected"],
      ["infra-failed", "persist-infra-failed"],
    ] as const) {
      const parked = await start("good", async (effects) =>
        effects.map((effect): EffectResult =>
          outcome === "conflict"
            ? { effect, outcome, currentVersion: 9 }
            : outcome === "rejected"
              ? { effect, outcome, by: "schema" }
              : { effect, outcome },
        ),
      );
      expect(parked.kind === "suspended" && parked.reason).toBe(reason);
    }
  });

  test("a person's abandon reaches the rejected terminal with the trail attached", async () => {
    const wf = obligationsGraph(journalFor(EXHAUSTED), defs, ignores);
    const parked = await run<State>(
      wf,
      seed({ roadmap: ROADMAP, design: DESIGN, testPaths: TEST_PATHS }),
      landsCleanly,
    );
    if (parked.kind !== "suspended") throw new Error("expected the run to park");

    const done = await resume<State>(wf, parked.runId, { decision: "abandon" }, landsCleanly);
    expect(done.kind === "terminal" && done.terminal.kind).toBe("rejected");
    expect(done.trace.at(-1)).toBe("reject");
  });
});

describe("the manifest validator, as the pure function it is", () => {
  const defectsIn = (values: ProposedValue[]) =>
    manifestDefects({ manifest: { values }, roadmap: ROADMAP, ignored: ignores }).map((d) => d.kind);

  test("the good manifest has no defects", () => {
    expect(defectsIn(GOOD)).toEqual([]);
  });

  test("an observation the roadmap does not declare is named, and so is the row it left uncovered", () => {
    // Exact string match, the way nwave's join reads it: an observation is the
    // key a value is addressed by, so a near miss is a value about something
    // else rather than a typo to forgive.
    expect(defectsIn(PROPOSALS["unknown-observation"] ?? []).sort()).toEqual([
      "uncovered-value",
      "unknown-observation",
    ]);
  });

  test("an empty manifest is one defect rather than every check passing vacuously", () => {
    expect(defectsIn([])).toEqual(["no-values"]);
  });

  test("an oracle that escapes the repository is not a locator", () => {
    expect(defectsIn(PROPOSALS["bad-oracle"] ?? [])).toEqual(["oracle-not-a-locator"]);
  });

  test("a support that is the oracle's own file is refused", () => {
    // The oracle is the one path a crafter may not write and a support is one
    // it may; a path that is both makes the wall ambiguous.
    const both = [{ ...(GOOD[0] as ProposedValue), supports: ["test/todo.test.ts"] }];
    expect(defectsIn(both)).toEqual(["support-is-the-oracle"]);
  });

  test("a duplicate obligation id and a blank field are each named", () => {
    const bad = [
      {
        ...(GOOD[0] as ProposedValue),
        acceptance: [
          { id: "a", stimulus: "do it", expected: "it happened" },
          { id: "a", stimulus: "  ", expected: "it happened" },
        ],
      },
    ];
    expect(defectsIn(bad)).toEqual(["duplicate-obligation-id", "blank-field"]);
  });
});

/**
 * The walk. Every proposal, every row outcome, every answer, and both loop
 * counts, once each.
 */
describe("the obligations graph, exhaustively", () => {
  test("every proposal, row outcome and answer reaches a declared outcome", async () => {
    const seen = new Set<string>();
    const reasons = new Set<string>();
    const terminals = new Set<string>();

    const paths = await enumeratePaths(async (choose) => {
      const wf = obligationsGraph(chooseJournal(choose), defs, ignores);
      const execute = chooseExecutor(choose);
      let outcome = await run<State>(
        wf,
        seed({ roadmap: ROADMAP, design: DESIGN, testPaths: TEST_PATHS, versions: { "01-01": 1 } }),
        execute,
      );

      // The walk answers the person, because `human.route` and `reject` are
      // reachable no other way.
      for (let guard = 0; outcome.kind === "suspended"; guard += 1) {
        if (guard > MAX_PROPOSALS + 2) throw new Error("the run never reached a terminal");
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

    // Every node the graph declares was exercised, with nothing excused: the
    // walk resumes, so there is no node only a resume test can reach.
    const reachable = inspectGraph(obligationsGraph(journalFor("good"), defs)).reachable;
    expect(reachable.filter((id) => !seen.has(id))).toEqual([]);

    expect([...reasons].sort()).toEqual([...BLOCK_REASONS].sort());
    expect([...terminals].sort()).toEqual(["accepted", "rejected"]);
  }, 60_000);
});

/** The count the walk produces, pinned so a graph change has to restate it. */
const EXPECTED_PATHS = 55;

/* ------------------------------------------------------------- walk wiring */

/**
 * Answers the leaf from the proposal set. A choice of MANIFEST rather than of
 * decision, because the branch after `validate-manifest` reads a pure function
 * of the data: reaching its `invalid` edge means varying the manifest.
 */
const chooseJournal = (choose: Choose): Journal => ({
  async get<O>(key: string) {
    const leaf = stepIdFromKey(key);
    if (leaf !== "distill.propose-obligations") throw new Error(`unexpected leaf ${leaf}`);
    const proposals: (ProposalName | typeof EXHAUSTED)[] = [
      ...(Object.keys(PROPOSALS) as ProposalName[]),
      EXHAUSTED,
    ];
    const proposal = choose("leaf:propose-obligations", proposals);
    return (proposal === EXHAUSTED
      ? exhausted()
      : ok({ decision: "proposed", payload: { values: PROPOSALS[proposal] ?? [], rationale: "stubbed" } })) as O;
  },
  async put() {
    // The walk never re-infers, so nothing is written back.
  },
});

/**
 * Answers the artifact-row batch from `EffectResult`'s own outcome space, one
 * outcome per BATCH rather than per effect: `persist` is atomic here, and a
 * partial write is not a smaller success.
 */
const PERSIST_OUTCOMES = ["committed", "conflict", "rejected", "infra-failed"] as const;

const chooseExecutor = (choose: Choose): EffectExecutor => async (effects) => {
  if (!effects.some((e) => e.type === "upsert-artifact")) {
    return effects.map((effect): EffectResult => ({ effect, outcome: "committed", version: 1 }));
  }
  const outcome = choose("effect:upsert-artifact", PERSIST_OUTCOMES);
  return effects.map((effect): EffectResult => {
    switch (outcome) {
      case "committed":
        return { effect, outcome, version: 1 };
      case "conflict":
        return { effect, outcome, currentVersion: 2 };
      case "rejected":
        return { effect, outcome, by: "schema" };
      case "infra-failed":
        return { effect, outcome };
    }
  });
};
