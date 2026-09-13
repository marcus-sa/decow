/**
 * The pipeline, end to end, with no model calls — through the server.
 *
 * This is the test the cut is for: a roadmap persisted by the ROADMAP
 * workflow's own `persist`, read back out of the artifact store as a
 * PIPELINE's declared rows, and driven by the SERVER's scheduler — which
 * starts each ready row as an ordinary run of the registered `deliver` graph,
 * against a real VCS on a real temp project, writing the production symbols
 * and running `bun test` for real at the verification gate.
 *
 * The registration here is the same shape `targets/todo/.des/registrations.ts`
 * writes: rows are data, `readiness` is the RED precondition, `record` appends
 * the `step_runs` row. Nothing in this file calls `run()`.
 *
 * Every leaf is scripted at the BINDING, so nothing reaches a model. The
 * journal is one SHARED journal keyed by content, which is the point of one of
 * the
 * assertions: the row id is in every leaf's input, so two rows cannot collide
 * on a key and one row's decision cannot replay as another's.
 *
 * It shells out — `bun test` inside the temp project, at each write's
 * verification gate, at each `run-tests` effect, and once at the end over the
 * whole suite — and it is one of the two tests in the repo allowed to.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { openArtifacts, type ArtifactStore } from "@des/core/artifacts";
import { memoryEffects } from "@des/core/effects";
import { memoryJournal } from "@des/core/journal";
import { journalKey, type ModelBinding } from "@des/core/step";
import { scriptedBinding, type ScriptedAnswer } from "@des/core/harness/scripted-binding";
import { resume, run } from "@des/core/workflow";
import { openVcs, type Vcs } from "@des/core/vcs";
import { vcsExecutor } from "@des/core/vcs/executor";
import { bunCommands, counterIds, manualClock, passingVerifier, tempProject } from "@des/core/vcs/testing";
import { parseOracleLocator, spawningExecutor, testsStage } from "@des/core/vcs/verify";
import {
  getPipeline,
  openRegistry,
  registration,
  runPipeline,
  type PipelineRegistration,
  type Registry,
} from "@des/server";
import { z } from "zod";
import { roadmapGraph, seed as seedRoadmap, type State as RoadmapState } from "../roadmap/graph.ts";
import type { Roadmap } from "../roadmap/schema.ts";
import { roadmapDefs } from "../roadmap/steps.ts";
import { oracleIsRed, ORACLE_RUNS_TABLE, type OracleRun } from "../distill/runs.ts";
import { deliverGraph, type State } from "./graph.ts";
import { LeafInput, deliverDefs, leafStepId, type LeafId } from "./steps.ts";
import {
  declaredResources,
  deliverSeed,
  knownRedTests,
  readRoadmap,
  recordStepRun,
  ROADMAP_STEPS_TABLE,
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

/* --------------------------------------------------------------- the project */

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

/* --------------------------------------------------------------- the roadmap */

/** Two steps, B after A, each writing one symbol and asserting one test. */
const roadmapFor = (symbolId: (path: string, name: string) => string): Roadmap => ({
  request: REQUEST,
  steps: [
    {
      id: "01-01",
      observation: "alpha returns 42, observed by its own acceptance test.",
      dependencies: [],
      authority: "DESIGN § alpha",
      acceptance: [{ id: "01-01-AC-1", stimulus: "Call alpha().", expected: "It returns 42." }],
      predictedTouches: [symbolId("src/alpha.ts", "alpha")],
      oracle: "src/alpha.test.ts::alpha returns 42",
      supports: [],
    },
    {
      id: "01-02",
      observation: "bravo returns 7, observed by its own acceptance test.",
      dependencies: ["01-01"],
      authority: "DESIGN § bravo",
      acceptance: [{ id: "01-02-AC-1", stimulus: "Call bravo().", expected: "It returns 7." }],
      predictedTouches: [symbolId("src/bravo.ts", "bravo")],
      oracle: "src/bravo.test.ts::bravo returns 7",
      supports: [],
    },
  ],
});

/**
 * The roadmap as ROADMAP itself proposes it: no acceptance facts anywhere.
 *
 * `roadmap.acceptance-facts-are-distills` is a mechanical check on
 * `decompose`, so a proposal carrying obligations, an oracle or a support list
 * is refused before a validator is spent — a decomposer cannot return one. The
 * fixture above is the roadmap AFTER DISTILL; this is what the graph is given.
 */
const asProposed = (roadmap: Roadmap): Roadmap => ({
  ...roadmap,
  steps: roadmap.steps.map((step) => {
    const { oracle: _oracle, ...rest } = step;
    return { ...rest, acceptance: [], supports: [] };
  }),
});

/**
 * DISTILL's own write, which this file skips the wave for.
 *
 * `persist` in the obligations graph upserts each `roadmap_steps` row with its
 * acceptance facts filled in; the rows are what DELIVER reads, so they have to
 * carry them. Written here through the same store and the same table.
 */
const enrichWithDistill = (artifacts: ArtifactStore, roadmap: Roadmap): void => {
  for (const step of roadmap.steps) {
    const current = artifacts.read(ROADMAP_STEPS_TABLE, step.id);
    artifacts.upsert({
      table: ROADMAP_STEPS_TABLE,
      id: step.id,
      expectedVersion: current?.version ?? 0,
      row: step,
    });
  }
};

/**
 * Persist the roadmap the way it is actually produced: through the roadmap
 * workflow's own graph, with `decompose` and `validate-slices` answered by a
 * scripted binding, a person approving, and `persist` writing the rows.
 */
const persistRoadmap = async (roadmap: Roadmap, effects: ReturnType<typeof memoryEffects>) => {
  const binding = scriptedBinding({
    "roadmap.decompose": [
      { decision: "proposed", payload: { roadmap: asProposed(roadmap), rationale: "two slices" } },
    ],
    "roadmap.validate-slices": [
      {
        decision: "is-slice",
        payload: {
          // Each verdict quotes THAT step's observation, because
          // `roadmap.slice-anchor-verbatim` is mechanical and runs for real.
          verdicts: asProposed(roadmap).steps.map((s) => ({
            stepId: s.id,
            verdict: "is-slice",
            anchor: s.observation,
          })),
          rationale: "both are production-drivable",
        },
      },
    ],
  });

  const wf = roadmapGraph(
    memoryJournal(),
    roadmapDefs({ worker: binding, validator: binding, decomposeWith: binding }),
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
const recordRedOracleAt = (artifacts: ArtifactStore, stepId: string, seq: number): void => {
  artifacts.upsert({
    table: ORACLE_RUNS_TABLE,
    id: `${stepId}#${seq}`,
    expectedVersion: 0,
    row: { stepId, runId: `oracle-${stepId}`, verdict: "red", seq } satisfies OracleRun,
  });
};

const recordRedOracle = (artifacts: ArtifactStore, stepId: string): void =>
  recordRedOracleAt(artifacts, stepId, 0);

/* ---------------------------------------------------------------- the leaves */

/**
 * What each leaf a happy run reaches answers, per row.
 *
 * Scripted at the BINDING rather than seeded into the journal: the journal is
 * production replay and nothing here writes to it. Which row a call is about
 * is on the PROMPT — `Step 01-01` — exactly where the model this stands in for
 * would read it.
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

/** What each row writes: the symbol it rewrites, and the body it rewrites it to. */
type RowScript = { symbolId: string; body: string };

/**
 * Every DELIVER leaf a happy run reaches, for however many rows the caller
 * scripted. One binding serves both slots: it dispatches on the call's role,
 * so the worker answers and the validator passes.
 */
const scriptedFor = (rows: Record<string, RowScript>): ModelBinding =>
  scriptedBinding(({ step, prompt }): ScriptedAnswer[] | undefined => {
    const leaf = step.id.slice("deliver.".length) as LeafId;
    const decision = HAPPY[leaf];
    if (decision === undefined) return undefined;
    const rowId = Object.keys(rows).find((id) => prompt.includes(id)) ?? "";
    const row = rows[rowId];
    if (row === undefined) return undefined;
    return [{ decision, payload: payloadFor(leaf, rowId, row.symbolId, row.body) }];
  });

/* -------------------------------------------------------------- the server */

/**
 * The registration pair, exactly the shape a target writes.
 *
 * The graph is `deliver`, registered once; the pipeline is rows pointed at it
 * plus the two hooks. Every row's run goes through the SAME registration a
 * person starting one row by hand would reach, which is what makes "no door
 * escapes the precondition" structural rather than duplicated.
 */
const openServerRegistry = (spec: {
  vcs: Vcs;
  artifacts: ArtifactStore;
  journal: ReturnType<typeof memoryJournal>;
  defs: ReturnType<typeof deliverDefs>;
  commands?: typeof bunCommands;
  concurrency?: number;
  resources?: boolean;
}): Registry => {
  const commands = spec.commands ?? bunCommands;
  const rowsOf = () => readRoadmap(spec.artifacts, REQUEST);
  const rowFor = (rowId: string) => {
    const row = rowsOf().find((r) => r.id === rowId);
    if (row === undefined) throw new Error(`no row ${rowId} in the roadmap`);
    return row;
  };

  const deliver = registration<State, { rowId: string }>({
    id: "deliver",
    title: "DELIVER — the step cycle over one row",
    input: z.object({ rowId: z.string().min(1) }),
    journal: spec.journal,
    graph: (ctx) => deliverGraph(ctx.journal, spec.defs, commands, ctx.observe),
    seed: (input) => {
      const row = rowFor(input.rowId);
      if (!oracleIsRed(spec.artifacts, row.id)) {
        throw new Error(`${row.id} has no oracle measured red, so nothing may deliver it.`);
      }
      return deliverSeed({ vcs: spec.vcs, row, design: DESIGN, evidence: "" });
    },
    executor: ({ runId, input }) => {
      const row = rowFor(input.rowId);
      return vcsExecutor({
        vcs: spec.vcs,
        session: runId,
        intent: { taskId: row.id, parentTaskId: REQUEST, description: row.observation },
        artifacts: spec.artifacts,
        knownRed: knownRedTests(spec.artifacts, spec.vcs, rowsOf(), row.id),
        ...(row.oracle === undefined ? {} : { protected: [parseOracleLocator(row.oracle).path] }),
      });
    },
  });

  const delivery: PipelineRegistration = {
    id: "delivery",
    title: "DELIVER, once per red-oracled row",
    rows: () =>
      rowsOf().map((row) => ({
        id: row.id,
        description: row.observation,
        dependencies: row.dependencies,
        workflowId: "deliver",
        input: { rowId: row.id },
      })),
    readiness: (rowId) => oracleIsRed(spec.artifacts, rowId),
    record: (rowId, outcome) => {
      recordStepRun(spec.artifacts, rowId, outcome);
    },
    concurrency: spec.concurrency ?? 1,
    ...(spec.resources === true
      ? { resourcesFor: (row: { id: string }) => declaredResources(spec.vcs, commands, rowFor(row.id)) }
      : {}),
  };

  return openRegistry({ workflows: [deliver], pipelines: [delivery], artifacts: spec.artifacts });
};

/** Drive the pipeline to quiescence and answer with its tree. */
const deliverAll = async (registry: Registry) => {
  runPipeline(registry, "delivery");
  await registry.idle();
  return await getPipeline(registry, "delivery");
};

describe("the pipeline: roadmap rows in, two DELIVER runs out", () => {
  test("A runs first, B after A is accepted, and both acceptance tests pass at the end", async () => {
    const project = openProject();
    const artifacts = openArtifacts();

    // 1. The roadmap is persisted the way it is produced: through the roadmap
    //    workflow's own `persist`, into the artifact store.
    await persistRoadmap(roadmapFor(project.symbolId), memoryEffects({ store: artifacts }));
    enrichWithDistill(artifacts, roadmapFor(project.symbolId));
    expect(readRoadmap(artifacts, REQUEST).map((r) => r.id)).toEqual(["01-01", "01-02"]);

    // 2. Every leaf of every row, scripted at the binding.
    const bodies: Record<string, string> = { "01-01": IMPLEMENTED.alpha, "01-02": IMPLEMENTED.bravo };
    const scripts: Record<string, RowScript> = Object.fromEntries(
      readRoadmap(artifacts, REQUEST).map((row) => [
        row.id,
        { symbolId: row.predictedTouches[0] as string, body: bodies[row.id] as string },
      ]),
    );
    const defs = deliverDefs({ worker: scriptedFor(scripts), validator: scriptedFor(scripts) });

    // 3. DISTILL measured both oracles red, which is what makes the rows
    //    deliverable at all.
    for (const row of readRoadmap(artifacts, REQUEST)) recordRedOracle(artifacts, row.id);

    // 4. Two rows, one server, one VCS, one journal.
    const registry = openServerRegistry({
      vcs: project.vcs,
      artifacts,
      journal: memoryJournal(),
      defs,
      concurrency: 2,
    });
    const tree = await deliverAll(registry);

    // Both rows were accepted, and the dependency was honoured: B only became
    // ready because A read `accepted`.
    expect(tree.rows.map((r) => `${r.id}:${r.status}`)).toEqual(["01-01:accepted", "01-02:accepted"]);
    expect(statusOf(artifacts, "01-01")).toBe("accepted");
    expect(statusOf(artifacts, "01-02")).toBe("accepted");

    // Each row's run is an ORDINARY run: it has a server run id, a trace
    // through the authored nodes, and the row links to it.
    for (const row of tree.rows) {
      expect(row.runId).toBeDefined();
      const record = registry.runs.get(row.runId as string);
      expect(record?.workflowId).toBe("deliver");
      expect(record?.status).toBe("accepted");
      expect(record?.trace.map((t) => t.node)).toContain("implement");
      expect(record?.trace.at(-1)?.node).toBe("accept");
    }

    const runs = artifacts.list(STEP_RUNS_TABLE).map((r) => r.row as StepRun);
    expect(runs.map((r) => `${r.stepId}#${r.seq}`).sort()).toEqual(["01-01#0", "01-02#0"]);
    expect(runs.every((r) => r.outcome === "accepted")).toBe(true);
    // The durable row carries the ENGINE's run id — the one the snapshot is
    // under, and the one that outlives the process — and the server's record
    // of the run a person watched carries the same id beside its own. So the
    // two names for one run join, in one hop, in either direction.
    expect(runs.map((r) => r.runId).sort()).toEqual(
      tree.rows.map((r) => registry.runs.get(r.runId as string)?.engineRunId as string).sort(),
    );

    // 5. The production bodies were written for real, and the oracles were
    //    not touched: RED to GREEN is bought by production.
    expect(project.read("src/alpha.test.ts")).toBe(oracleFor("alpha", 42));
    expect(project.read("src/bravo.test.ts")).toBe(oracleFor("bravo", 7));
    expect(project.read("src/alpha.ts")).toContain("return 42;");
    expect(project.read("src/bravo.ts")).toContain("return 7;");

    // 6. The event log shows both, under each row's own task id — and under
    //    the RUN's own session, so two runs hold two leases rather than
    //    colliding on the one a session may hold.
    for (const row of tree.rows) {
      const events = project.vcs.log.byTask(row.id);
      expect(events.map((e) => e.kind)).toContain("lease-acquired");
      expect(events.filter((e) => e.kind === "symbol-modified").length).toBeGreaterThanOrEqual(1);
      expect(events.filter((e) => e.kind === "tests-run").length).toBeGreaterThanOrEqual(1);
      expect(events.every((e) => e.parentTaskId === REQUEST)).toBe(true);
      const acquired = events.find((e) => e.kind === "lease-acquired");
      expect(JSON.parse(String(acquired?.detail)).session).toBe(row.runId);
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
    enrichWithDistill(artifacts, roadmapFor(project.symbolId));

    const [row] = readRoadmap(artifacts, REQUEST);
    if (row === undefined) throw new Error("the fixture has two rows");
    // A body that compiles and does not make the acceptance test pass.
    const scripts: Record<string, RowScript> = {
      [row.id]: {
        symbolId: row.predictedTouches[0] as string,
        body: source("alpha", 5).trimEnd(),
      },
    };
    const defs = deliverDefs({ worker: scriptedFor(scripts), validator: scriptedFor(scripts) });

    recordRedOracle(artifacts, "01-01");
    const registry = openServerRegistry({
      vcs: project.vcs,
      artifacts,
      journal: memoryJournal(),
      defs,
    });
    const tree = await deliverAll(registry);

    // `bun test` ran for real and refused the write, so the row parked rather
    // than being accepted — and the file on disk was rolled back byte for
    // byte, which is the write path's own guarantee holding under the server.
    expect(tree.rows.map((r) => r.status)).toEqual(["suspended", "pending"]);
    expect(project.read("src/alpha.ts")).toContain("return 1;");
    // The oracle is untouched, because the crafter never held it.
    expect(project.read("src/alpha.test.ts")).toBe(oracleFor("alpha", 42));

    // The parked row IS a parked run, with the enum a person answers from.
    const parked = registry.runs.get(tree.rows[0]?.runId as string);
    expect(parked?.status).toBe("suspended");
    expect(parked?.suspension?.resume?.options?.length).toBeGreaterThan(0);

    // The refusal is in the log as a verification failure, under the row's task.
    const failed = project.vcs.log.byTask("01-01").filter((e) => e.kind === "write-failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]).toMatchObject({ verification: "failed", category: "verification" });

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("two rows never share a journal key, because the row id is in every leaf's input", () => {
    const project = openProject();
    // Nothing runs here: the claim is about the key derivation, which is a
    // pure function of the def and the input.
    const defs = deliverDefs({ worker: scriptedFor({}), validator: scriptedFor({}) });
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

  test("a row's history is derived from what was persisted, not remembered", async () => {
    // The `delivery_state.py` stance, on the half that is still durable: the
    // `step_runs` rows are append-only, so "did it ever fail" is a read.
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
    enrichWithDistill(artifacts, roadmapFor(project.symbolId));

    // Nothing is scripted, because nothing should run: an unscripted leaf
    // would refuse by name, and reaching one at all would be the failure.
    const defs = deliverDefs({ worker: scriptedFor({}), validator: scriptedFor({}) });
    const registry = openServerRegistry({
      vcs: project.vcs,
      artifacts,
      journal: memoryJournal(),
      defs,
    });
    const tree = await deliverAll(registry);

    // Nothing ran, so no run exists, nothing was recorded and nothing was
    // written. The model bindings throw, so reaching a leaf would fail this.
    expect(tree.rows.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(tree.rows.every((r) => r.runId === undefined)).toBe(true);
    expect(registry.runs.list()).toEqual([]);
    expect(artifacts.list(STEP_RUNS_TABLE)).toEqual([]);
    expect(project.read("src/alpha.ts")).toContain("return 1;");

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("a green oracle is not a red one: only red opens the gate", () => {
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
    enrichWithDistill(artifacts, roadmapFor(project.symbolId));
    recordRedOracle(artifacts, "01-01");

    const [row] = readRoadmap(artifacts, REQUEST);
    if (row === undefined) throw new Error("the fixture has two rows");
    const oracleSymbol = project.vcs.registry
      .symbolsOf(project.vcs.registry.file("src/alpha.test.ts")?.id ?? "")
      .find((s) => s.kind === "test");
    // The crafter's own effect shape, pointed at the oracle.
    const scripts: Record<string, RowScript> = {
      [row.id]: {
        symbolId: oracleSymbol?.id ?? "",
        body: 'test("alpha returns 42", () => {\n  expect(1).toBe(1);\n});',
      },
    };
    const defs = deliverDefs({ worker: scriptedFor(scripts), validator: scriptedFor(scripts) });

    await deliverAll(
      openServerRegistry({ vcs: project.vcs, artifacts, journal: memoryJournal(), defs }),
    );

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
 * shared database". The server is where two rows that both need it are made to
 * take turns. The join is `declaredResources`, which asks the row's own
 * declared commands what they need — and this is the pair of runs that proves
 * the join is live: the SAME two independent rows, with and without the
 * declaration.
 */
describe("a declared resource serializes two rows", () => {
  /** Two rows that do not depend on each other, so nothing else orders them. */
  const independent = (symbolId: (path: string, name: string) => string): Roadmap => {
    const base = roadmapFor(symbolId);
    return { ...base, steps: base.steps.map((step) => ({ ...step, dependencies: [] })) };
  };

  const deliverBoth = async (commands: typeof bunCommands) => {
    const project = openProject();
    const artifacts = openArtifacts();
    await persistRoadmap(independent(project.symbolId), memoryEffects({ store: artifacts }));
    enrichWithDistill(artifacts, independent(project.symbolId));

    const bodies: Record<string, string> = { "01-01": IMPLEMENTED.alpha, "01-02": IMPLEMENTED.bravo };
    const scripts: Record<string, RowScript> = {};
    for (const row of readRoadmap(artifacts, REQUEST)) {
      scripts[row.id] = {
        symbolId: row.predictedTouches[0] as string,
        body: bodies[row.id] as string,
      };
      recordRedOracle(artifacts, row.id);
    }
    const defs = deliverDefs({ worker: scriptedFor(scripts), validator: scriptedFor(scripts) });

    const registry = openServerRegistry({
      vcs: project.vcs,
      artifacts,
      journal: memoryJournal(),
      defs,
      commands,
      concurrency: 2,
      resources: true,
    });
    const names = readRoadmap(artifacts, REQUEST).map((row) =>
      declaredResources(project.vcs, commands, row),
    );
    const tree = await deliverAll(registry);
    artifacts.close();
    project.vcs.close();
    return { tree, names };
  };

  test("the resource names come off the row's own declared commands", async () => {
    const shared = {
      ...bunCommands,
      tests: (args: Parameters<typeof bunCommands.tests>[0]) => ({
        argv: [...(bunCommands.tests(args) as readonly string[])],
        resources: ["shared-db"],
      }),
    };
    const { tree, names } = await deliverBoth(shared);

    expect(tree.rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    // The name came off the declaration, not off the registration's options.
    expect(names).toEqual([["shared-db"], ["shared-db"]]);
  }, 60_000);

  test("two rows whose commands name nothing declare nothing", async () => {
    // The control. Same rows, same concurrency; the only difference is what
    // the declaration says it needs.
    const { tree, names } = await deliverBoth(bunCommands);

    expect(tree.rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(names).toEqual([[], []]);
  }, 60_000);
});
