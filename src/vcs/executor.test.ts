/**
 * The seam, end to end, through the real Mastra runner.
 *
 * The design document's own words for what this covers: "The first integration
 * test is not the VCS's own phase one. It is: the runner executes an
 * `Effect[]` through the VCS with lease, verify, and log, and gets back a
 * typed result a branch can route on. That one path exercises every seam."
 *
 * So the graph here is deliberately the smallest one that has the shape of
 * DELIVER's `implement`: one leaf that emits a `replace-symbol`, and a branch
 * that routes the write outcome. The leaf's model is a stub journal hit, so no
 * model is called; the verifier's stages are injected, so no compiler runs.
 * Everything between the effect and the file on disk is real.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { measurementOf, memoryEffects, type EffectResult } from "../core/effects.ts";
import { stepOutput, type StepDef } from "../core/step.ts";
import { branch, leaf, run, type Node, type Workflow } from "../core/workflow.ts";
import { ok, stubJournal } from "../harness/stub-journal.ts";
import { vcsExecutor } from "./executor.ts";
import { openVcs, type Vcs } from "./index.ts";
import { counterIds, failingStage, manualClock, measuresAs, passingVerifier, tempProject } from "./testing.ts";
import type { Verifier } from "./verify.ts";

const SOURCE = `export function alpha(): number {
  return 1;
}
`;
const NEW_BODY = "export function alpha(): number {\n  return 42;\n}";

/* --------------------------------------------------------------- the step */

const Input = z.object({ symbolId: z.string(), criteria: z.string() });
type Input = z.infer<typeof Input>;

const Output = stepOutput(["written"] as const, { body: z.string() });
type Output = z.infer<typeof Output>;

/** A model binding that fails the test if anything reaches a model. */
const forbidden = {
  id: "forbidden",
  generate: async <T,>(): Promise<T> => {
    throw new Error("a model was called; this suite spends zero model calls");
  },
};

const implementDef: StepDef<Input, Output> = {
  id: "implement",
  version: 1,
  input: Input,
  output: Output,
  requirements: [],
  worker: {
    model: forbidden,
    system: "Make the acceptance test pass with the minimal change.",
    prompt: (input) => input.criteria,
  },
  validator: { model: forbidden },
  maxAttempts: 1,
};

/* -------------------------------------------------------------- the graph */

type WriteVerdict = EffectResult["outcome"] | "exhausted";

type State = {
  symbolId: string;
  criteria: string;
  expectedVersion: number;
  write?: EffectResult["outcome"];
  version?: number;
  rejectedBy?: string;
};

const writeVerdict = (s: State): WriteVerdict => s.write ?? "exhausted";

const graph = (journal: ReturnType<typeof stubJournal>): Workflow<State> => ({
  start: "implement",
  nodes: {
    implement: leaf<State, Input, Output>({
      def: implementDef,
      journal,
      input: (s) => ({ symbolId: s.symbolId, criteria: s.criteria }),
      absorb: (s) => s,
      effects: (s, r) =>
        r.decision === "ok"
          ? [
              {
                type: "replace-symbol",
                symbolId: s.symbolId,
                expectedVersion: s.expectedVersion,
                body: r.output.payload.body,
              },
            ]
          : [],
      absorbEffects: (s, results) => {
        const landed = results.find((r) => r.effect.type === "replace-symbol");
        if (landed === undefined) return s;
        if (landed.outcome === "committed") return { ...s, write: "committed", version: landed.version };
        if (landed.outcome === "conflict") return { ...s, write: "conflict", version: landed.currentVersion };
        if (landed.outcome === "rejected") return { ...s, write: "rejected", rejectedBy: landed.by };
        return { ...s, write: "infra-failed" };
      },
      next: "write.verdict",
    }),

    // The whole point of a typed effect result: a lease conflict is an edge to
    // a rebase node, and a rejected write is an edge to a person. Neither is
    // an exception crossing the graph boundary.
    "write.verdict": branch<State, WriteVerdict>(writeVerdict, {
      committed: "accept",
      conflict: "rebase",
      rejected: "reject",
      "infra-failed": "reject",
      exhausted: "reject",
    }),

    rebase: {
      type: "step",
      run: async (s) => ({ state: { ...s, expectedVersion: s.version ?? s.expectedVersion }, effects: [] }),
      absorb: (s) => s,
      next: "reject",
    } satisfies Node<State>,

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: [s.write] }) },
  },
});

/* ------------------------------------------------------------- the fixture */

const TASK = { taskId: "task-executor", parentTaskId: "roadmap-02-03", description: "make alpha return 42" };

const open = (verifier: Partial<Verifier> = {}) => {
  const root = tempProject({ "a.ts": SOURCE });
  const vcs = openVcs({
    root,
    verifier: passingVerifier(verifier),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  const file = vcs.track("a.ts");
  const symbolId = vcs.registry.symbolsOf(file.id)[0]?.id ?? "";
  const inventoryEvents = vcs.log.all().length;
  const read = () => readFileSync(join(root, "a.ts"), "utf8");
  return { root, vcs, symbolId, inventoryEvents, read };
};

const journal = () => stubJournal({ implement: ok({ decision: "written", payload: { body: NEW_BODY } }) });

const drive = (vcs: Vcs, symbolId: string, expectedVersion: number) =>
  run<State>(
    graph(journal()),
    { symbolId, criteria: "alpha returns 42", expectedVersion },
    vcsExecutor({ vcs, session: "session-executor", intent: TASK }),
  );

describe("the VCS as the framework's effect executor", () => {
  test("a leaf's replace-symbol commits, and absorbEffects sees the version", async () => {
    const { vcs, symbolId, read } = open();
    const outcome = await drive(vcs, symbolId, 1);

    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") throw new Error("unreachable");
    expect(outcome.terminal.kind).toBe("accepted");
    expect(outcome.terminal.state.write).toBe("committed");
    expect(outcome.terminal.state.version).toBe(2);
    expect(outcome.trace).toEqual(["implement", "write.verdict", "accept"]);

    // The write went all the way to the file, under a lease, through the gate.
    expect(read()).toBe(`${NEW_BODY}\n`);
    expect(vcs.registry.symbol(symbolId)?.version).toBe(2);
    vcs.close();
  });

  test("a stale expected version comes back as a conflict the branch routes", async () => {
    const { vcs, symbolId, read } = open();
    await drive(vcs, symbolId, 1);

    // The world moved to version 2. A second run still claiming 1 is the
    // rebase-and-retry edge, not an error.
    const outcome = await drive(vcs, symbolId, 1);
    if (outcome.kind !== "terminal") throw new Error("expected a terminal");
    expect(outcome.terminal.state.write).toBe("conflict");
    expect(outcome.terminal.state.version).toBe(2);
    expect(outcome.trace).toEqual(["implement", "write.verdict", "rebase", "reject"]);

    // And the conflicting run changed nothing.
    expect(read()).toBe(`${NEW_BODY}\n`);
    vcs.close();
  });

  test("a failing typecheck stage is rejected: typecheck, and the file is rolled back", async () => {
    const { vcs, symbolId, read } = open({
      typecheck: failingStage("typecheck", "TS2322: Type 'string' is not assignable to type 'number'"),
    });
    const outcome = await drive(vcs, symbolId, 1);

    if (outcome.kind !== "terminal") throw new Error("expected a terminal");
    expect(outcome.terminal.kind).toBe("rejected");
    expect(outcome.terminal.state.write).toBe("rejected");
    expect(outcome.terminal.state.rejectedBy).toBe("typecheck");
    expect(outcome.trace).toEqual(["implement", "write.verdict", "reject"]);

    expect(read()).toBe(SOURCE);
    expect(vcs.registry.symbol(symbolId)?.version).toBe(1);
    vcs.close();
  });

  test("every event the executor produced carries its task id", async () => {
    const { vcs, symbolId, inventoryEvents } = open();
    await drive(vcs, symbolId, 1);

    const produced = vcs.log.all().slice(inventoryEvents);
    expect(produced.map((e) => e.kind)).toEqual([
      "lease-acquired",
      "symbol-modified",
      "transaction",
      "lease-released",
    ]);
    // The provenance link the design asks for: the journal answers what each
    // step decided, the VCS log answers what changed, and the task id is what
    // joins them.
    expect(produced.every((e) => e.taskId === "task-executor")).toBe(true);
    expect(produced.every((e) => e.parentTaskId === "roadmap-02-03")).toBe(true);
    expect(vcs.log.byTask("task-executor").length).toBe(produced.length);
    vcs.close();
  });

  test("one lease covers the whole batch, and it is released before the run ends", async () => {
    const { vcs, symbolId } = open();
    await drive(vcs, symbolId, 1);

    const acquired = vcs.log.all().filter((e) => e.kind === "lease-acquired");
    expect(acquired.length).toBe(1);
    expect(vcs.leases.live()).toEqual([]);
    vcs.close();
  });

  test("a run-tests effect runs the impacted subset and commits at the event's seq", async () => {
    const { vcs, symbolId } = open();
    const execute = vcsExecutor({ vcs, session: "session-executor", intent: TASK });
    const [result] = await execute([{ type: "run-tests", impacted: [symbolId] }]);

    expect(result).toMatchObject({ outcome: "committed" });
    expect(vcs.log.all().at(-1)).toMatchObject({ kind: "tests-run", taskId: "task-executor" });
    vcs.close();
  });

  test("a failing tests stage makes run-tests rejected: tests", async () => {
    const { vcs, symbolId } = open({ tests: failingStage("tests", "1 failing") });
    const execute = vcsExecutor({ vcs, session: "session-executor", intent: TASK });
    const [result] = await execute([{ type: "run-tests", impacted: [symbolId] }]);
    expect(result).toMatchObject({ outcome: "rejected", by: "tests" });
    vcs.close();
  });
});

/**
 * The union rule. `impactedTests(symbols) ∪ extra` is what runs, and the floor
 * is recomputed by the VCS from the symbols the batch wrote rather than read
 * off the effect. So a workflow owns test selection ABOVE the floor and cannot
 * reach below it: adding a test is a selection, omitting an impacted one is a
 * contract violation with the omitted ids named.
 */
describe("run-tests is a union: the LLM may add tests, never subtract", () => {
  const PROJECT = {
    "src/alpha.ts": "export function alpha(): number {\n  return 1;\n}\n",
    "src/bravo.ts": "export function bravo(): number {\n  return 2;\n}\n",
    "src/alpha.test.ts":
      'import { alpha } from "./alpha.ts";\ntest("alpha is one", () => {\n  alpha();\n});\n',
    "src/bravo.test.ts":
      'import { bravo } from "./bravo.ts";\ntest("bravo is two", () => {\n  bravo();\n});\n',
  };

  /** A tests stage that records the targets it was handed instead of running them. */
  const recordingTests = () => {
    const runs: string[][] = [];
    const tests: Verifier["tests"] = async (ctx) => {
      runs.push(ctx.targets.map((t) => t.id));
      return { status: "passed" };
    };
    return { runs, tests };
  };

  const openProject = (tests: Verifier["tests"]) => {
    const root = tempProject(PROJECT);
    const vcs = openVcs({
      root,
      verifier: passingVerifier({ tests }),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    const files = vcs.trackTree("src");
    const id = (path: string, name: string) => {
      const file = files.find((f) => f.path === path);
      const symbol =
        file === undefined
          ? undefined
          : vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
      if (symbol === undefined) throw new Error(`fixture has no ${path}::${name}`);
      return symbol.id;
    };
    const execute = vcsExecutor({ vcs, session: "session-union", intent: TASK });
    return { vcs, id, execute };
  };

  test("extra is added to the floor and the tests stage is handed both", async () => {
    const { runs, tests } = recordingTests();
    const { vcs, id, execute } = openProject(tests);
    const alphaTest = id("src/alpha.test.ts", "alpha is one");
    const bravoTest = id("src/bravo.test.ts", "bravo is two");

    const [result] = await execute([
      { type: "run-tests", impacted: [id("src/alpha.ts", "alpha")], extra: [bravoTest] },
    ]);

    expect(result).toMatchObject({ outcome: "committed" });
    // The floor came from the impact graph; `bravo is two` came from the leaf.
    expect(runs).toEqual([[alphaTest, bravoTest]]);
    vcs.close();
  });

  test("an extra test the floor already chose is added once, not twice", async () => {
    const { runs, tests } = recordingTests();
    const { vcs, id, execute } = openProject(tests);
    const alphaTest = id("src/alpha.test.ts", "alpha is one");

    await execute([
      { type: "run-tests", impacted: [id("src/alpha.ts", "alpha")], extra: [alphaTest] },
    ]);
    expect(runs).toEqual([[alphaTest]]);
    vcs.close();
  });

  test("omitting an impacted test for a symbol the batch wrote is rejected: contract", async () => {
    const { runs, tests } = recordingTests();
    const { vcs, id, execute } = openProject(tests);
    const alpha = id("src/alpha.ts", "alpha");
    const alphaTest = id("src/alpha.test.ts", "alpha is one");

    // The batch writes `alpha` and then asks to run only bravo's tests. The
    // floor is computed from the write, not from `impacted`, so the omission
    // is visible whatever the effect declared.
    const results = await execute([
      {
        type: "replace-symbol",
        symbolId: alpha,
        expectedVersion: 1,
        body: "export function alpha(): number {\n  return 42;\n}",
      },
      { type: "run-tests", impacted: [id("src/bravo.ts", "bravo")] },
    ]);

    expect(results[0]).toMatchObject({ outcome: "committed" });
    expect(results[1]).toMatchObject({ outcome: "rejected", by: "contract" });
    // One entry, and it is the WRITE's own gate at step 8 of the write path.
    // The refused effect added none: it is refused before anything runs,
    // because a narrower run is not a cheaper run.
    expect(runs).toEqual([[alphaTest]]);

    // The omitted ids ARE the finding, so they are in the failure event.
    const event = vcs.log.all().at(-1);
    expect(event).toMatchObject({ kind: "tests-run", verification: "failed", category: "contract" });
    expect(JSON.parse(String(event?.detail))).toMatchObject({
      omitted: [alphaTest],
      status: "omitted-impacted-tests",
    });
    vcs.close();
  });

  test("extra can cover the floor: the union is what matters, not the declaration", async () => {
    const { runs, tests } = recordingTests();
    const { vcs, id, execute } = openProject(tests);
    const alpha = id("src/alpha.ts", "alpha");
    const alphaTest = id("src/alpha.test.ts", "alpha is one");
    const bravoTest = id("src/bravo.test.ts", "bravo is two");

    const results = await execute([
      {
        type: "replace-symbol",
        symbolId: alpha,
        expectedVersion: 1,
        body: "export function alpha(): number {\n  return 42;\n}",
      },
      { type: "run-tests", impacted: [id("src/bravo.ts", "bravo")], extra: [alphaTest] },
    ]);

    expect(results[1]).toMatchObject({ outcome: "committed" });
    // The first entry is the write's own gate; the second is the effect's
    // union. The effect declared the wrong symbol scope and `extra` covered
    // the floor anyway, which is the whole point of checking the union.
    expect(runs.at(-1)).toEqual([bravoTest, alphaTest]);
    vcs.close();
  });

  test("a run-tests effect in a batch that wrote nothing has no floor to miss", async () => {
    const { runs, tests } = recordingTests();
    const { vcs, id, execute } = openProject(tests);
    const [result] = await execute([{ type: "run-tests", impacted: [id("src/bravo.ts", "bravo")] }]);

    // Nothing was written, so nothing could have been subtracted. A scoped
    // run on its own stays a scoped run.
    expect(result).toMatchObject({ outcome: "committed" });
    expect(runs).toEqual([[id("src/bravo.test.ts", "bravo is two")]]);
    vcs.close();
  });

  test("an append-trail effect becomes provenance, and upsert-artifact stays unwired", async () => {
    const { vcs } = open();
    const execute = vcsExecutor({ vcs, session: "session-executor", intent: TASK });
    const results = await execute([
      { type: "append-trail", line: '{"leaf":"implement","trail":[]}' },
      { type: "upsert-artifact", table: "requirements", id: "r-1", expectedVersion: 0, row: {} },
    ]);

    expect(results[0]).toMatchObject({ outcome: "committed" });
    expect(vcs.log.all().at(-1)).toMatchObject({
      kind: "trail",
      taskId: "task-executor",
      detail: '{"leaf":"implement","trail":[]}',
    });
    // The VCS is the data plane for code. Artifact rows are the other half of
    // the state layer and no executor is wired for them, which is an
    // infrastructure fact rather than a rejection.
    expect(results[1]).toMatchObject({ outcome: "infra-failed" });
    vcs.close();
  });

  test("a desynced file is infra-failed, not rejected, because the agent did not cause it", async () => {
    const { vcs, symbolId, root } = open();
    writeFileSync(join(root, "a.ts"), "export function alpha(): number {\n  return 0;\n}\n", "utf8");
    vcs.reinventory("a.ts");

    const outcome = await drive(vcs, symbolId, 1);
    if (outcome.kind !== "terminal") throw new Error("expected a terminal");
    expect(outcome.terminal.state.write).toBe("infra-failed");
    expect(outcome.trace).toEqual(["implement", "write.verdict", "reject"]);
    vcs.close();
  });
});

/**
 * `write-file` through the executor, and the wall around the oracle.
 *
 * The batch is still the unit: one lease covers every symbol AND every path the
 * batch names, so an author that writes an oracle and its supports holds one
 * territorial claim rather than three. The protected scope sits in front of all
 * of it, because RED to GREEN is bought by production and never by editing the
 * test that measures it.
 */
describe("the executor: whole files, and protected paths", () => {
  const ORACLE = 'import { test } from "bun:test";\n\ntest("alpha returns 42", () => {});\n';
  const SUPPORT = "export const driver = () => 1;\n";

  const execute = (vcs: Vcs, options: { protected?: readonly string[] } = {}) =>
    vcsExecutor({
      vcs,
      session: "session-author",
      intent: TASK,
      ...(options.protected === undefined ? {} : { protected: options.protected }),
    });

  test("one lease covers every path in the batch, and both files land", async () => {
    const { root, vcs } = open();
    const results = await execute(vcs)([
      { type: "write-file", path: "test/a.test.ts", body: ORACLE },
      { type: "write-file", path: "test/support/driver.ts", body: SUPPORT },
    ]);

    expect(results.map((r) => r.outcome)).toEqual(["committed", "committed"]);
    expect(readFileSync(join(root, "test/a.test.ts"), "utf8")).toBe(ORACLE);
    expect(readFileSync(join(root, "test/support/driver.ts"), "utf8")).toBe(SUPPORT);

    // ONE lease, not two: § 5.3's acquire names the complete set it will need.
    const acquired = vcs.log.byTask(TASK.taskId).filter((e) => e.kind === "lease-acquired");
    expect(acquired).toHaveLength(1);
    expect(JSON.parse(String(acquired[0]?.detail)).paths.sort()).toEqual([
      "test/a.test.ts",
      "test/support/driver.ts",
    ]);
    expect(vcs.log.byTask(TASK.taskId).filter((e) => e.kind === "lease-released")).toHaveLength(1);
    vcs.close();
  });

  test("a symbol write and a file write ride the same batch and the same lease", async () => {
    const { vcs, symbolId, read } = open();
    const results = await execute(vcs)([
      { type: "replace-symbol", symbolId, expectedVersion: 1, body: NEW_BODY },
      { type: "write-file", path: "test/a.test.ts", body: ORACLE },
    ]);

    expect(results.map((r) => r.outcome)).toEqual(["committed", "committed"]);
    expect(read()).toBe(`${NEW_BODY}\n`);
    expect(vcs.log.byTask(TASK.taskId).filter((e) => e.kind === "lease-acquired")).toHaveLength(1);
    vcs.close();
  });

  test("a write into a protected scope is refused as a contract violation, before the lease", async () => {
    const { root, vcs } = open();
    const results = await execute(vcs, { protected: ["test"] })([
      { type: "write-file", path: "test/a.test.ts", body: ORACLE },
    ]);

    expect(results[0]).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(existsSync(join(root, "test/a.test.ts"))).toBe(false);
    // No lease was even asked for: the refusal is ahead of the whole path.
    expect(vcs.log.byTask(TASK.taskId).filter((e) => e.kind === "lease-acquired")).toHaveLength(0);
    // And the refusal is in the log, so "why did nothing happen" is answerable.
    const trail = vcs.log.byTask(TASK.taskId).filter((e) => e.kind === "trail");
    expect(JSON.parse(String(trail[0]?.detail))).toMatchObject({
      refused: "test/a.test.ts",
      scope: "test",
    });
    vcs.close();
  });

  test("a replace-symbol whose file is protected is refused too", async () => {
    // The crafter's own effect shape, pointed at the oracle. `_crafter_owns`
    // is about the PATH, so the wall does not care which effect names it.
    const root = tempProject({ "a.ts": SOURCE, "test/a.test.ts": ORACLE });
    const vcs = openVcs({
      root,
      verifier: passingVerifier(),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    vcs.track("a.ts");
    const oracleFile = vcs.track("test/a.test.ts");
    const testSymbol = vcs.registry.symbolsOf(oracleFile.id)[0]?.id ?? "";

    const results = await execute(vcs, { protected: ["test/a.test.ts"] })([
      { type: "replace-symbol", symbolId: testSymbol, expectedVersion: 1, body: 'test("alpha returns 42", () => {});' },
    ]);

    expect(results[0]).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(readFileSync(join(root, "test/a.test.ts"), "utf8")).toBe(ORACLE);
    vcs.close();
  });

  test("a protected refusal does not stop the rest of the batch", async () => {
    // The crafter's production write still lands; only the oracle is walled.
    const root = tempProject({ "a.ts": SOURCE, "test/a.test.ts": ORACLE });
    const vcs = openVcs({
      root,
      verifier: passingVerifier(),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    const file = vcs.track("a.ts");
    vcs.track("test/a.test.ts");
    const symbolId = vcs.registry.symbolsOf(file.id)[0]?.id ?? "";

    const results = await execute(vcs, { protected: ["test"] })([
      { type: "write-file", path: "test/b.test.ts", body: ORACLE },
      { type: "replace-symbol", symbolId, expectedVersion: 1, body: NEW_BODY },
    ]);

    expect(results[0]).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(results[1]?.outcome).toBe("committed");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(`${NEW_BODY}\n`);
    vcs.close();
  });

  test("two sessions whose path scopes overlap see a conflict the graph routes", async () => {
    const { vcs } = open();
    const held = vcs.acquire({
      session: "session-other",
      paths: ["test"],
      mode: "write",
      ttlMs: 60_000,
      intent: { ...TASK, expectedOutcome: { created: ["test/held.test.ts"] } },
    });
    expect(held.outcome).toBe("granted");

    const results = await execute(vcs)([{ type: "write-file", path: "test/a.test.ts", body: ORACLE }]);
    expect(results[0]?.outcome).toBe("conflict");
    vcs.close();
  });

  test("memoryEffects cannot land a write-file, and says so rather than pretending", async () => {
    const { execute: memory } = memoryEffects();
    const results = await memory([{ type: "write-file", path: "test/a.test.ts", body: ORACLE }]);
    expect(results[0]?.outcome).toBe("infra-failed");
  });
});

/**
 * `measure-oracle` through the executor: the one effect whose desired answer
 * is a failure.
 */
describe("the executor: measuring an oracle", () => {
  const ORACLE = 'import { expect, test } from "bun:test";\n\ntest("alpha returns 42", () => {\n  expect(1).toBe(42);\n});\n';

  const openWith = (verdict: "green" | "red" | "broken" | "indeterminate") => {
    const root = tempProject({ "a.ts": SOURCE, "test/a.test.ts": ORACLE });
    const vcs = openVcs({
      root,
      verifier: passingVerifier({ measure: measuresAs(verdict) }),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    vcs.track("a.ts");
    vcs.track("test/a.test.ts");
    return vcs;
  };

  const measure = async (vcs: Vcs) =>
    (
      await vcsExecutor({ vcs, session: "session-author", intent: TASK })([
        { type: "measure-oracle", oracle: "test/a.test.ts::alpha returns 42" },
      ])
    )[0];

  test("red is a rejection carrying the verdict, which is the answer the author wants", async () => {
    const vcs = openWith("red");
    const result = await measure(vcs);
    expect(result).toMatchObject({ outcome: "rejected", by: "tests" });
    expect(measurementOf(result)?.verdict).toBe("red");
    expect(measurementOf(result)?.output).toBe("measured red");
    vcs.close();
  });

  test("green is committed, because it is the one verdict the world accepted", async () => {
    const vcs = openWith("green");
    const result = await measure(vcs);
    expect(result?.outcome).toBe("committed");
    expect(measurementOf(result)?.verdict).toBe("green");
    vcs.close();
  });

  test("broken and indeterminate are distinguishable from red on one field", async () => {
    // All four verdicts off `measured.verdict`, which is what lets a pure
    // branch route them without reading `outcome` twice.
    for (const verdict of ["broken", "indeterminate"] as const) {
      const vcs = openWith(verdict);
      const result = await measure(vcs);
      expect(result?.outcome).toBe("rejected");
      expect(measurementOf(result)?.verdict).toBe(verdict);
      vcs.close();
    }
  });

  test("a runner that never started is infra-failed and carries no verdict", async () => {
    // `passingVerifier`'s default `measure` is exactly this: the neutral answer
    // for a fixture that measures nothing is "the runner did not start", not
    // "it passed".
    const root = tempProject({ "a.ts": SOURCE });
    const vcs = openVcs({
      root,
      verifier: passingVerifier(),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    vcs.track("a.ts");
    const result = await measure(vcs);
    expect(result?.outcome).toBe("infra-failed");
    expect(measurementOf(result)).toBeUndefined();
    vcs.close();
  });

  test("memoryEffects cannot measure an oracle, and says so", async () => {
    const { execute: memory } = memoryEffects();
    const results = await memory([{ type: "measure-oracle", oracle: "test/a.test.ts" }]);
    expect(results[0]?.outcome).toBe("infra-failed");
  });
});
