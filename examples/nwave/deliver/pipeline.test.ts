/**
 * The pipeline, end to end, with no model calls.
 *
 * This is the test the whole cut is for: a roadmap persisted by the ROADMAP
 * workflow's own `persist`, read back out of the artifact store by the
 * SCHEDULER, and one DELIVER run per row against a real VCS on a real temp
 * project — locating the acceptance tests, activating them through the write
 * path, writing the production symbols, and running `bun test` for real at the
 * verification gate.
 *
 * Every leaf is a journal hit, so nothing reaches a model. The journal is one
 * SHARED journal keyed by content, which is the point of the last assertion:
 * the row id is in every leaf's input, so two rows cannot collide on a key and
 * one row's decision cannot replay as another's.
 *
 * It shells out — `bun test` inside the temp project, at each write's
 * verification gate, at each `run-tests` effect, and once at the end over the
 * whole suite — and it is the one test in the repo allowed to. Measured at
 * about 0.8 s for the file: a `bun test` of one file with one test costs about
 * 30 ms, which is what makes a real gate affordable here at all.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { openArtifacts } from "../../../src/artifacts/store.ts";
import { memoryEffects } from "../../../src/core/effects.ts";
import { inMemoryLeases } from "../../../src/core/scheduler.ts";
import { memoryJournal } from "../../../src/core/journal.ts";
import { journalKey, type StepResult } from "../../../src/core/step.ts";
import { resume, run } from "../../../src/core/workflow.ts";
import { openVcs } from "../../../src/vcs/index.ts";
import { bunCommands, counterIds, manualClock, passingVerifier, tempProject } from "../../../src/vcs/testing.ts";
import { spawningExecutor, testsStage } from "../../../src/vcs/verify.ts";
import { roadmapGraph, seed as seedRoadmap, type State as RoadmapState } from "../roadmap/graph.ts";
import type { Roadmap } from "../roadmap/schema.ts";
import { roadmapDefs } from "../roadmap/steps.ts";
import { oracleIsRed, ORACLE_RUNS_TABLE, type OracleRun } from "../distill/runs.ts";
import { LeafInput, deliverDefs, leafStepId, type LeafId } from "./steps.ts";
import {
  openPipeline,
  readRoadmap,
  runsOf,
  statusOf,
  stepUnderDelivery,
  STEP_RUNS_TABLE,
  type StepRun,
} from "./pipeline.ts";

/** This file is `<root>/examples/nwave/deliver/pipeline.test.ts`. */
const REPO = dirname(dirname(dirname(dirname(import.meta.path))));

const REQUEST = "Two functions return the numbers their acceptance tests assert.";
const DESIGN = "alpha(): number returns 42. bravo(): number returns 7. No other surface.";

/* ------------------------------------------------------------- the project */

const source = (name: string, value: number) =>
  `export function ${name}(): number {\n  return ${value};\n}\n`;

/**
 * The row's oracle, as `des oracle` left it: authored, ACTIVE, and measured
 * red before the row was ever ready. It asserts a value the production symbol
 * does not return yet, so it is genuinely red until `implement` writes one.
 */
const oracleFor = (name: string, value: number) =>
  `import { expect, test } from "bun:test";\nimport { ${name} } from "./${name}.ts";\n\n` +
  `test("${name} returns ${value}", () => {\n  expect(${name}()).toBe(${value});\n});\n`;

/** Biome's own defaults, with the formatter off. Real, and small. */
const BIOME = `${JSON.stringify(
  { linter: { enabled: true }, formatter: { enabled: false }, assist: { enabled: false } },
  null,
  2,
)}\n`;

const PROJECT = {
  "biome.json": BIOME,
  "src/alpha.ts": source("alpha", 1),
  "src/bravo.ts": source("bravo", 1),
  "src/alpha.test.ts": oracleFor("alpha", 42),
  "src/bravo.test.ts": oracleFor("bravo", 7),
};

/** The body `implement` writes. The symbol's span includes `export`. */
const IMPLEMENTED = { alpha: source("alpha", 42).trimEnd(), bravo: source("bravo", 7).trimEnd() };

const openProject = () => {
  const root = tempProject(PROJECT);
  // The tests stage is the REAL one. Typecheck is not: `bunx tsc` over a temp
  // project is seconds per write and the claim here is about test execution.
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  const vcs = openVcs({
    root,
    commands: bunCommands,
    // The tests stage is the REAL one, built from the declared test command
    // over the executor that spawns. Typecheck and lint are not: `bunx tsc`
    // over a temp project is seconds per write and the claim here is about
    // test execution.
    verifier: passingVerifier({ tests: testsStage(bunCommands, spawningExecutor(root)) }),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  vcs.trackTree("src");

  const symbolId = (path: string, name: string): string => {
    const file = vcs.registry.file(path);
    const symbol = file === undefined ? undefined : vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`the fixture has no ${path}::${name}`);
    return symbol.id;
  };

  return { root, vcs, symbolId, read: (p: string) => readFileSync(join(root, p), "utf8") };
};

/* ------------------------------------------------------------- the roadmap */

/** Two steps, B after A, each writing one symbol and asserting one test. */
const roadmapFor = (symbolId: (path: string, name: string) => string): Roadmap => ({
  request: REQUEST,
  steps: [
    {
      id: "01-01",
      observation: "alpha returns 42, observed by its own acceptance test.",
      dependencies: [],
      authority: "DESIGN § alpha",
      acceptance: [
        { id: "01-01-AC-1", stimulus: "Call alpha().", expected: "It returns 42." },
      ],
      predictedTouches: [symbolId("src/alpha.ts", "alpha")],
      oracle: "src/alpha.test.ts::alpha returns 42",
      supports: [],
    },
    {
      id: "01-02",
      observation: "bravo returns 7, observed by its own acceptance test.",
      dependencies: ["01-01"],
      authority: "DESIGN § bravo",
      acceptance: [
        { id: "01-02-AC-1", stimulus: "Call bravo().", expected: "It returns 7." },
      ],
      predictedTouches: [symbolId("src/bravo.ts", "bravo")],
      oracle: "src/bravo.test.ts::bravo returns 7",
      supports: [],
    },
  ],
});

/** A model binding that fails the test if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T,>(): Promise<T> => {
    throw new Error(`model "${id}" was called; this suite spends zero model calls`);
  },
});

/**
 * Persist the roadmap the way it is actually produced: through the roadmap
 * workflow's own graph, with `decompose` and `validate-slices` answered from a
 * journal, a person approving, and `persist` writing the rows.
 */
const persistRoadmap = async (roadmap: Roadmap, effects: ReturnType<typeof memoryEffects>) => {
  const defs = roadmapDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
  const seeded = {
    "roadmap.decompose": {
      decision: "ok",
      output: { decision: "proposed", payload: { roadmap, rationale: "two slices" } },
    },
    "roadmap.validate-slices": {
      decision: "ok",
      output: {
        decision: "is-slice",
        payload: {
          verdicts: roadmap.steps.map((s) => ({
            stepId: s.id,
            verdict: "is-slice",
            anchor: s.observation,
          })),
          rationale: "both are production-drivable",
        },
      },
    },
  } as Record<string, StepResult<unknown>>;

  const wf = roadmapGraph(
    {
      get: async <O,>(key: string) => seeded[key.split("@")[0] ?? key] as O | undefined,
      put: async () => {},
    },
    defs,
  );
  const parked = await run<RoadmapState>(wf, seedRoadmap(REQUEST, DESIGN), effects.execute);
  if (parked.kind !== "suspended") throw new Error("expected the roadmap to park for a person");
  const approved = await resume<RoadmapState>(wf, parked.runId, { decision: "approve" }, effects.execute);
  if (approved.kind !== "terminal" || approved.terminal.kind !== "accepted") {
    throw new Error("expected the approved roadmap to be accepted");
  }
  return approved;
};

/**
 * The `oracle_runs` row DISTILL leaves behind for a value whose oracle it
 * measured RED. Without one the row is not ready and nothing delivers it,
 * which is exactly the precondition this seeds past.
 */
const recordRedOracleAt = (
  artifacts: ReturnType<typeof openArtifacts>,
  stepId: string,
  seq: number,
): void => {
  artifacts.upsert({
    table: ORACLE_RUNS_TABLE,
    id: `${stepId}#${seq}`,
    expectedVersion: 0,
    row: { stepId, runId: `oracle-${stepId}`, verdict: "red", seq } satisfies OracleRun,
  });
};

const recordRedOracle = (artifacts: ReturnType<typeof openArtifacts>, stepId: string): void =>
  recordRedOracleAt(artifacts, stepId, 0);

/* -------------------------------------------------------------- the leaves */

/**
 * The journal, keyed by CONTENT, exactly as production is. Every leaf a happy
 * run reaches is seeded per row, which means computing the row's own leaf
 * input and hashing it — and that is the claim the last test makes: the row id
 * is in the input, so two rows never share a key.
 */
const HAPPY: Partial<Record<LeafId, string>> = {
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  commit: "committed",
};

const payloadFor = (leaf: LeafId, rowId: string, symbolId: string, body: string) => ({
  anchor: "",
  rationale: "stubbed",
  symbolId,
  body,
  gap: "",
  extra: [] as string[],
  row: rowId,
  leaf,
});

/**
 * Which leaves see `wrote` in their input, and which do not.
 *
 * The leaf input is `{ step, evidence, impacted, wrote }` and `implement`
 * CARRIES the symbol it wrote into state, so every leaf after it reads one
 * more field than every leaf before it — and the journal key is a hash of the
 * input, so the two halves key differently. That is the content-addressed
 * journal working as designed, and seeding it means saying which half a leaf
 * is in.
 */
const BEFORE_THE_WRITE: readonly LeafId[] = ["implement"];

/** Seed one row's leaves, at the exact keys `runStep` will compute. */
const seedRow = (
  rows: Record<string, StepResult<unknown>>,
  defs: ReturnType<typeof deliverDefs>,
  rowId: string,
  step: ReturnType<typeof stepUnderDelivery>,
  impacted: string[],
  symbolId: string,
  body: string,
): void => {
  for (const [leaf, decision] of Object.entries(HAPPY) as [LeafId, string][]) {
    const wrote = BEFORE_THE_WRITE.includes(leaf) ? undefined : symbolId;
    const input = LeafInput.parse({
      step,
      evidence: "",
      impacted,
      ...(wrote === undefined ? {} : { wrote }),
    });
    rows[journalKey(defs[leaf], input)] = {
      decision: "ok",
      output: { decision, payload: payloadFor(leaf, rowId, symbolId, body) },
    } as StepResult<unknown>;
  }
};

describe("the pipeline: roadmap rows in, two DELIVER runs out", () => {
  test("A runs first, B after A is accepted, and both acceptance tests pass at the end", async () => {
    const project = openProject();
    const artifacts = openArtifacts();
    const roadmap = roadmapFor(project.symbolId);

    // 1. The roadmap is persisted the way it is produced: through the roadmap
    //    workflow's own `persist`, into the artifact store.
    await persistRoadmap(roadmap, memoryEffects({ store: artifacts }));
    expect(readRoadmap(artifacts, REQUEST).map((r) => r.id)).toEqual(["01-01", "01-02"]);

    // 2. Every leaf of every row, seeded at the key `runStep` will compute.
    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const seeded: Record<string, StepResult<unknown>> = {};
    const rows = readRoadmap(artifacts, REQUEST);
    const bodies: Record<string, string> = {
      "01-01": IMPLEMENTED.alpha,
      "01-02": IMPLEMENTED.bravo,
    };
    for (const row of rows) {
      const step = stepUnderDelivery(row, DESIGN);
      const target = row.predictedTouches[0] as string;
      const impacted = project.vcs.impact.impactedTests([target]).map((t) => t.id);
      seedRow(seeded, defs, row.id, step, impacted, target, bodies[row.id] as string);
    }

    // 3. DISTILL measured both oracles red, which is what makes the rows
    //    deliverable at all.
    for (const row of rows) recordRedOracle(artifacts, row.id);

    // 4. Two rows, one scheduler, one VCS, one journal.
    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands: bunCommands,
      journal: memoryJournal(seeded),
      defs,
      roadmapId: REQUEST,
      design: DESIGN,
      concurrency: 2,
    });

    const statuses = await scheduler.run();

    // Both rows were accepted, and the dependency was honoured: B's run is
    // recorded after A's, and it only became ready because A was `accepted`.
    expect(statuses.get("01-01")).toBe("accepted");
    expect(statuses.get("01-02")).toBe("accepted");
    expect(statusOf(artifacts, "01-01")).toBe("accepted");
    expect(statusOf(artifacts, "01-02")).toBe("accepted");

    const runs = artifacts.list(STEP_RUNS_TABLE).map((r) => r.row as StepRun);
    expect(runs.map((r) => `${r.stepId}#${r.seq}`).sort()).toEqual(["01-01#0", "01-02#0"]);
    expect(runs.every((r) => r.outcome === "accepted")).toBe(true);

    // 5. The production bodies were written for real, and the oracles were
    //    not touched: RED to GREEN is bought by production.
    expect(project.read("src/alpha.test.ts")).toBe(oracleFor("alpha", 42));
    expect(project.read("src/bravo.test.ts")).toBe(oracleFor("bravo", 7));
    expect(project.read("src/alpha.ts")).toContain("return 42;");
    expect(project.read("src/bravo.ts")).toContain("return 7;");

    // 6. The event log shows both, under each row's own session and task id.
    for (const row of ["01-01", "01-02"]) {
      const events = project.vcs.log.byTask(row);
      expect(events.map((e) => e.kind)).toContain("lease-acquired");
      expect(events.filter((e) => e.kind === "symbol-modified").length).toBeGreaterThanOrEqual(1);
      expect(events.filter((e) => e.kind === "tests-run").length).toBeGreaterThanOrEqual(1);
      expect(events.every((e) => e.parentTaskId === REQUEST)).toBe(true);
      // The session is the row id, so two rows in flight hold two leases
      // rather than colliding on the one a session may hold.
      const acquired = events.find((e) => e.kind === "lease-acquired");
      expect(JSON.parse(String(acquired?.detail)).session).toBe(row);
    }

    // 7. And the whole suite passes, which is what "the two ATs pass at the
    //    end" means: run it, do not infer it.
    const suite = Bun.spawnSync(["bun", "test", "src"], { cwd: project.root });
    expect(suite.exitCode).toBe(0);
    expect(`${suite.stderr}`).toContain("2 pass");

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("an implementation that does not satisfy the activated test is refused by the real gate", async () => {
    const project = openProject();
    const artifacts = openArtifacts();
    await persistRoadmap(roadmapFor(project.symbolId), memoryEffects({ store: artifacts }));

    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const seeded: Record<string, StepResult<unknown>> = {};
    const [row] = readRoadmap(artifacts, REQUEST);
    if (row === undefined) throw new Error("the fixture has two rows");
    const target = row.predictedTouches[0] as string;
    // A body that compiles and does not make the acceptance test pass.
    seedRow(
      seeded,
      defs,
      row.id,
      stepUnderDelivery(row, DESIGN),
      project.vcs.impact.impactedTests([target]).map((t) => t.id),
      target,
      source("alpha", 5).trimEnd(),
    );

    recordRedOracle(artifacts, "01-01");
    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands: bunCommands,
      journal: memoryJournal(seeded),
      defs,
      roadmapId: REQUEST,
      design: DESIGN,
      concurrency: 1,
    });
    const statuses = await scheduler.run();

    // `bun test` ran for real and refused the write, so the row parked rather
    // than being accepted — and the file on disk was rolled back byte for
    // byte, which is the write path's own guarantee holding under the
    // pipeline.
    expect(statuses.get("01-01")).toBe("suspended");
    expect(project.read("src/alpha.ts")).toContain("return 1;");
    // The oracle is untouched, because the crafter never held it.
    expect(project.read("src/alpha.test.ts")).toBe(oracleFor("alpha", 42));
    // And B never became ready, because A was not `accepted`.
    expect(statuses.get("01-02")).toBe("pending");

    // The refusal is in the log as a verification failure, under the row's task.
    const failed = project.vcs.log.byTask("01-01").filter((e) => e.kind === "write-failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]).toMatchObject({ verification: "failed", category: "verification" });

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("two rows never share a journal key, because the row id is in every leaf's input", () => {
    const project = openProject();
    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const roadmap = roadmapFor(project.symbolId);
    const [a, b] = roadmap.steps;
    if (a === undefined || b === undefined) throw new Error("the fixture has two steps");

    const keyFor = (row: typeof a) =>
      journalKey(
        defs.implement,
        LeafInput.parse({ step: stepUnderDelivery(row, DESIGN), evidence: "", impacted: [] }),
      );

    // The same leaf, the same design, the same everything except the row. If
    // these collided, one row's `implement` decision would replay as the
    // other's and the second row would write the first row's body.
    expect(keyFor(a)).not.toBe(keyFor(b));
    expect(keyFor(a).startsWith(`${leafStepId("implement")}@`)).toBe(true);
    project.vcs.close();
  });

  test("a row's status is derived from the latest run, not remembered", async () => {
    // The `delivery_state.py` stance: the scheduler persists nothing of its
    // own, so a second scheduler over the same store reads the same frontier.
    const artifacts = openArtifacts();
    expect(statusOf(artifacts, "01-01")).toBe("pending");

    for (const [seq, outcome] of [
      [0, "rejected"],
      [1, "suspended"],
      [2, "accepted"],
    ] as const) {
      artifacts.upsert({
        table: STEP_RUNS_TABLE,
        id: `01-01#${seq}`,
        expectedVersion: 0,
        row: { stepId: "01-01", runId: `run-${seq}`, outcome, seq } satisfies StepRun,
      });
      expect(statusOf(artifacts, "01-01")).toBe(outcome);
    }

    // And the history is kept, which is what "did it ever fail" is answered
    // from. An append-only log rather than a status column.
    expect(runsOf(artifacts, "01-01").map((r) => r.outcome)).toEqual([
      "rejected",
      "suspended",
      "accepted",
    ]);
    artifacts.close();
  });

  test("a row with no red oracle never becomes ready, and it blocks its dependents", async () => {
    // This is where "no edge bypasses RED" lives now that the step cycle has
    // no RED node. `canonical_next`'s own precondition, as a readiness rule:
    // with no recorded oracle the next step for a value is `des oracle`.
    const project = openProject();
    const artifacts = openArtifacts();
    await persistRoadmap(roadmapFor(project.symbolId), memoryEffects({ store: artifacts }));

    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const { scheduler, unoracled } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands: bunCommands,
      journal: memoryJournal({}),
      defs,
      roadmapId: REQUEST,
      design: DESIGN,
      concurrency: 1,
    });

    expect(unoracled()).toEqual(["01-01", "01-02"]);
    // Nothing ran, so nothing was recorded and nothing was written. The model
    // bindings throw, so reaching a leaf at all would fail this test.
    const statuses = await scheduler.run();
    expect([...statuses.values()]).toEqual(["pending", "pending"]);
    expect(artifacts.list(STEP_RUNS_TABLE)).toEqual([]);
    expect(project.read("src/alpha.ts")).toContain("return 1;");

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("a green oracle is not a red one: only red opens the gate", async () => {
    // An unmeasured oracle proves nothing and a green one proves the wrong
    // thing, so the projection reads the verdict rather than the presence.
    const artifacts = openArtifacts();
    for (const [seq, verdict] of [
      [0, "green"],
      [1, "broken"],
      [2, "blocked"],
    ] as const) {
      artifacts.upsert({
        table: ORACLE_RUNS_TABLE,
        id: `01-01#${seq}`,
        expectedVersion: 0,
        row: { stepId: "01-01", runId: `run-${seq}`, verdict, seq } satisfies OracleRun,
      });
      expect(oracleIsRed(artifacts, "01-01")).toBe(false);
    }
    recordRedOracleAt(artifacts, "01-01", 3);
    expect(oracleIsRed(artifacts, "01-01")).toBe(true);
    artifacts.close();
  });

  test("the crafter's executor is built with the row's oracle protected", async () => {
    // `_crafter_owns`: every path the task declares is the crafter's EXCEPT
    // the oracle. The supports are not walled, because a support is the
    // oracle's dependency rather than the thing that measures the value.
    const project = openProject();
    const artifacts = openArtifacts();
    await persistRoadmap(roadmapFor(project.symbolId), memoryEffects({ store: artifacts }));
    recordRedOracle(artifacts, "01-01");

    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const [row] = readRoadmap(artifacts, REQUEST);
    if (row === undefined) throw new Error("the fixture has two rows");
    const target = row.predictedTouches[0] as string;
    const oracleSymbol = project.vcs.registry
      .symbolsOf(project.vcs.registry.file("src/alpha.test.ts")?.id ?? "")
      .find((s) => s.kind === "test");
    // The crafter's own effect shape, pointed at the oracle.
    const seeded: Record<string, StepResult<unknown>> = {};
    seedRow(
      seeded,
      defs,
      row.id,
      stepUnderDelivery(row, DESIGN),
      project.vcs.impact.impactedTests([target]).map((t) => t.id),
      oracleSymbol?.id ?? "",
      'test("alpha returns 42", () => {\n  expect(1).toBe(1);\n});',
    );

    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands: bunCommands,
      journal: memoryJournal(seeded),
      defs,
      roadmapId: REQUEST,
      design: DESIGN,
      concurrency: 1,
    });
    await scheduler.run();

    // The write never landed, and the oracle is byte-identical.
    expect(project.read("src/alpha.test.ts")).toBe(oracleFor("alpha", 42));
    const trail = project.vcs.log.byTask("01-01").filter((e) => e.kind === "trail");
    expect(JSON.parse(String(trail[0]?.detail))).toMatchObject({
      refused: "src/alpha.test.ts",
      why: "the oracle is not the crafter's",
    });

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("a roadmap the store does not hold is refused by name", () => {
    const artifacts = openArtifacts();
    expect(() => readRoadmap(artifacts, "no such roadmap")).toThrow(/no roadmap/);
    artifacts.close();
  });
});

/**
 * A declared `resources` is what makes two rows take turns.
 *
 * `run-command.resources` is where a consumer says "these tests need the
 * shared database". The scheduler is where two rows that both need it are made
 * to take turns. The join is the pipeline's default `resourcesFor`, which asks
 * the row's own declared commands what they need, and this is the pair of runs
 * that proves the join is live: the SAME two independent rows, with and
 * without the declaration, overlapping or not.
 */
describe("a declared resource serializes two rows", () => {
  /** Two rows that do not depend on each other, so nothing else orders them. */
  const independent = (symbolId: (path: string, name: string) => string): Roadmap => {
    const base = roadmapFor(symbolId);
    return {
      ...base,
      steps: base.steps.map((step) => ({ ...step, dependencies: [] })),
    };
  };

  /** `inMemoryLeases`, with the most rows that ever held one at the same time. */
  const trackingLeases = () => {
    const inner = inMemoryLeases();
    const asked: string[][] = [];
    let held = 0;
    let peak = 0;
    return {
      asked,
      peak: () => peak,
      leases: {
        acquire: async (names: readonly string[]) => {
          asked.push([...names]);
          const release = await inner.acquire(names);
          held += 1;
          peak = Math.max(peak, held);
          return () => {
            held -= 1;
            release();
          };
        },
      },
    };
  };

  const deliverBoth = async (commands: typeof bunCommands) => {
    const project = openProject();
    const artifacts = openArtifacts();
    const roadmap = independent(project.symbolId);
    await persistRoadmap(roadmap, memoryEffects({ store: artifacts }));

    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const seeded: Record<string, StepResult<unknown>> = {};
    const bodies: Record<string, string> = { "01-01": IMPLEMENTED.alpha, "01-02": IMPLEMENTED.bravo };
    for (const row of readRoadmap(artifacts, REQUEST)) {
      const target = row.predictedTouches[0] as string;
      seedRow(
        seeded,
        defs,
        row.id,
        stepUnderDelivery(row, DESIGN),
        project.vcs.impact.impactedTests([target]).map((t) => t.id),
        target,
        bodies[row.id] as string,
      );
      recordRedOracle(artifacts, row.id);
    }

    const tracked = trackingLeases();
    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands,
      journal: memoryJournal(seeded),
      defs,
      roadmapId: REQUEST,
      design: DESIGN,
      concurrency: 2,
      leases: tracked.leases,
    });
    const statuses = await scheduler.run();
    artifacts.close();
    project.vcs.close();
    return { statuses, tracked };
  };

  test("two rows whose declared tests command names a resource never overlap", async () => {
    const shared = {
      ...bunCommands,
      tests: (args: Parameters<typeof bunCommands.tests>[0]) => ({
        argv: [...(bunCommands.tests(args) as readonly string[])],
        resources: ["shared-db"],
      }),
    };
    const { statuses, tracked } = await deliverBoth(shared);

    expect([...statuses.values()]).toEqual(["accepted", "accepted"]);
    // The name came off the declaration, not off the pipeline's options.
    expect(tracked.asked).toEqual([["shared-db"], ["shared-db"]]);
    expect(tracked.peak()).toBe(1);
  }, 60_000);

  test("two rows whose commands name nothing run together", async () => {
    // The control. Same rows, same concurrency, same lease manager; the only
    // difference is what the declaration says it needs.
    const { statuses, tracked } = await deliverBoth(bunCommands);

    expect([...statuses.values()]).toEqual(["accepted", "accepted"]);
    expect(tracked.asked).toEqual([[], []]);
    expect(tracked.peak()).toBe(2);
  }, 60_000);
});
