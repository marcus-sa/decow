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
import { openArtifacts } from "../../../artifacts/store.ts";
import { memoryEffects } from "../../../core/effects.ts";
import { memoryJournal } from "../../../core/journal.ts";
import { journalKey, type StepResult } from "../../../core/step.ts";
import { resume, run } from "../../../core/workflow.ts";
import { openVcs } from "../../../vcs/index.ts";
import { counterIds, manualClock, passingVerifier, tempProject } from "../../../vcs/testing.ts";
import { bunTests } from "../../../vcs/verify.ts";
import { roadmapGraph, seed as seedRoadmap, type State as RoadmapState } from "../roadmap/graph.ts";
import type { Roadmap } from "../roadmap/schema.ts";
import { roadmapDefs } from "../roadmap/steps.ts";
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

/** This file is `<root>/src/examples/nwave/deliver/pipeline.test.ts`. */
const REPO = dirname(dirname(dirname(dirname(dirname(import.meta.path)))));

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

const PROJECT = {
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
    verifier: passingVerifier({ tests: bunTests }),
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
        {
          id: "01-01-AC-1",
          text: "alpha() returns 42.",
          oracleLocator: "src/alpha.test.ts::alpha returns 42",
        },
      ],
      predictedTouches: [symbolId("src/alpha.ts", "alpha")],
    },
    {
      id: "01-02",
      observation: "bravo returns 7, observed by its own acceptance test.",
      dependencies: ["01-01"],
      authority: "DESIGN § bravo",
      acceptance: [
        {
          id: "01-02-AC-1",
          text: "bravo() returns 7.",
          oracleLocator: "src/bravo.test.ts::bravo returns 7",
        },
      ],
      predictedTouches: [symbolId("src/bravo.ts", "bravo")],
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
  gates: "clean",
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

    // 3. Two rows, one scheduler, one VCS, one journal.
    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
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

    // 4. The production bodies were written for real, and the oracles were
    //    not touched: RED to GREEN is bought by production.
    expect(project.read("src/alpha.test.ts")).toBe(oracleFor("alpha", 42));
    expect(project.read("src/bravo.test.ts")).toBe(oracleFor("bravo", 7));
    expect(project.read("src/alpha.ts")).toContain("return 42;");
    expect(project.read("src/bravo.ts")).toContain("return 7;");

    // 5. The event log shows both, under each row's own session and task id.
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

    // 6. And the whole suite passes, which is what "the two ATs pass at the
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

    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
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

  test("a roadmap the store does not hold is refused by name", () => {
    const artifacts = openArtifacts();
    expect(() => readRoadmap(artifacts, "no such roadmap")).toThrow(/no roadmap/);
    artifacts.close();
  });
});
