/**
 * The todo target, delivered end to end, with no model calls.
 *
 * This is the stubbed twin of the five commands, and everything they do is
 * done here except the inference:
 *
 *   ROADMAP    two rows, persisted through the roadmap workflow's own `persist`
 *   DISTILL    the obligations graph fills in their acceptance facts; the
 *              oracle graph authors one test file per value through a real
 *              `write-file`, and a REAL `bun test` measures each one red
 *   DELIVER    the scheduler reads the rows back, refuses any value whose
 *              oracle is not red, and runs the step cycle once per row against
 *              a REAL `tsc --noEmit` and a REAL impact-scoped `bun test`
 *
 * Every leaf is a journal hit at the key `runStep` will compute, so the model
 * bindings throw if anything reaches them. Nothing about the RED is asserted by
 * this file: the oracle bodies are handed to the author leaf, and what says
 * they fail is the runner. An oracle that was accidentally green would park the
 * run under `vacuous-oracle`, which is the whole reason the measurement exists.
 *
 * It shells out — a `tsc` per production write, a `bun test` per measurement
 * and per write gate, and one at the end — and it is the second test in the
 * repo allowed to, for the reason the pipeline test is: the claim is about what
 * the gate and the measurement DO, and stubbing either proves nothing.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifacts } from "../../../src/artifacts/store.ts";
import { memoryEffects } from "../../../src/core/effects.ts";
import { memoryJournal } from "../../../src/core/journal.ts";
import { journalKey, type StepResult } from "../../../src/core/step.ts";
import { resume, run } from "../../../src/core/workflow.ts";
import { openVcs, type Vcs } from "../../../src/vcs/index.ts";
import { openPipeline, readRoadmap, statusOf, stepUnderDelivery } from "../../../src/examples/nwave/deliver/pipeline.ts";
import { deliverDefs, LeafInput, type DeliverDefs, type LeafId } from "../../../src/examples/nwave/deliver/steps.ts";
import { obligationsDefs, ProposeInput } from "../../../src/examples/nwave/distill/obligations/steps.ts";
import { AuthorInput, oracleDefs } from "../../../src/examples/nwave/distill/oracle/steps.ts";
import { openOracles, runObligations } from "../../../src/examples/nwave/distill/pipeline.ts";
import { oracleIsRed, oracleRunsOf } from "../../../src/examples/nwave/distill/runs.ts";
import { roadmapGraph, seed as seedRoadmap, type State as RoadmapState } from "../../../src/examples/nwave/roadmap/graph.ts";
import type { Roadmap } from "../../../src/examples/nwave/roadmap/schema.ts";
import { roadmapDefs } from "../../../src/examples/nwave/roadmap/steps.ts";
import { REQUEST } from "./request.ts";
import {
  createRunDir,
  designSource,
  loadCommands,
  openRunDir,
  REPO,
  RUNS,
  runSuite,
  TARGET,
} from "./run-dir.ts";

/* --------------------------------------------------------------- the copy */

/** A temp copy of `targets/todo`, tracked in a fresh VCS with the real gate. */
const openProject = async () => {
  const root = mkdtempSync(join(tmpdir(), "dw-todo-"));
  cpSync(TARGET, root, { recursive: true });
  // `tsc`, `biome` and `bun test` all resolve out of here; one symlink beats
  // one install per copy.
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));

  // The target's OWN declaration, loaded out of the copy exactly as a run
  // directory loads it. Every process this test runs against the project comes
  // from here and from nowhere else.
  const commands = await loadCommands(root);

  // The DEFAULT verifier over those commands: a real `bunx tsc --noEmit`, a
  // real `bunx biome check`, a real impact-scoped `bun test`, a real oracle
  // measurement. Nothing is stubbed at the gate.
  const vcs = openVcs({ root, commands });
  vcs.trackTree("src");

  const symbolId = (path: string, name: string): string => {
    const file = vcs.registry.file(path);
    const symbol = file === undefined ? undefined : vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`the target has no ${path}::${name}`);
    return symbol.id;
  };

  return { root, vcs, commands, symbolId, read: (p: string) => readFileSync(join(root, p), "utf8") };
};

/** A model binding that fails the test if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T,>(): Promise<T> => {
    throw new Error(`model "${id}" was called; this suite spends zero model calls`);
  },
});

/* ------------------------------------------------------------ the roadmap */

const OBSERVATIONS = {
  complete: "TodoStore.complete marks a todo done and rejects an id the store does not hold.",
  remove: "TodoStore.remove drops a todo from the list and rejects an id the store does not hold.",
} as const;

/**
 * The roadmap as ROADMAP proposes it: no obligations, no oracle, no supports.
 * DISTILL fills those in, which is the boundary this whole cut is about.
 */
const roadmapFor = (symbolId: (path: string, name: string) => string): Roadmap => ({
  request: REQUEST,
  steps: [
    {
      id: "01-01",
      observation: OBSERVATIONS.complete,
      dependencies: [],
      authority: "design.md § Behaviour -> complete",
      predictedTouches: [symbolId("src/todo.ts", "complete")],
      acceptance: [],
      supports: [],
    },
    {
      id: "01-02",
      observation: OBSERVATIONS.remove,
      dependencies: ["01-01"],
      authority: "design.md § Behaviour -> remove",
      predictedTouches: [symbolId("src/todo.ts", "remove")],
      acceptance: [],
      supports: [],
    },
  ],
});

/* ---------------------------------------------------------- the manifest */

const ORACLES = {
  "01-01": "test/complete.test.ts::complete marks the todo done and rejects an unknown id",
  "01-02": "test/remove.test.ts::remove drops the todo and rejects an unknown id",
} as const;

const MANIFEST = [
  {
    observation: OBSERVATIONS.complete,
    acceptance: [
      {
        id: "01-01-AC-1",
        stimulus: "Add a todo, complete it, then narrow list to done.",
        expected: "complete returns the todo with done set, and list narrowed to done returns it.",
      },
      {
        id: "01-01-AC-2",
        stimulus: "Complete an id the store does not hold.",
        expected: "UnknownTodoError is thrown.",
      },
    ],
    oracle: ORACLES["01-01"],
    supports: [],
  },
  {
    observation: OBSERVATIONS.remove,
    acceptance: [
      {
        id: "01-02-AC-1",
        stimulus: "Add two todos and remove one.",
        expected: "list no longer returns the removed one.",
      },
      {
        id: "01-02-AC-2",
        stimulus: "Remove an id the store does not hold.",
        expected: "UnknownTodoError is thrown.",
      },
    ],
    oracle: ORACLES["01-02"],
    supports: [],
  },
];

/* ------------------------------------------------------------- the oracles */

/**
 * The oracle bodies the author leaf returns.
 *
 * They are red against the stubs, and nothing here says so: the `measure` node
 * runs them and the runner's verdict is what the graph reads.
 */
const ORACLE_BODIES: Record<string, string> = {
  "test/complete.test.ts": `import { expect, test } from "bun:test";
import { TodoStore, UnknownTodoError } from "../src/todo.ts";

test("complete marks the todo done and rejects an unknown id", () => {
  const store = new TodoStore();
  const todo = store.add("ship the cut");
  expect(store.complete(todo.id).done).toBe(true);
  expect(store.list("done").map((t) => t.title)).toEqual(["ship the cut"]);
  expect(() => store.complete("t-999")).toThrow(UnknownTodoError);
});
`,
  "test/remove.test.ts": `import { expect, test } from "bun:test";
import { TodoStore, UnknownTodoError } from "../src/todo.ts";

test("remove drops the todo and rejects an unknown id", () => {
  const store = new TodoStore();
  const kept = store.add("keep me");
  const dropped = store.add("drop me");
  store.remove(dropped.id);
  expect(store.list().map((t) => t.title)).toEqual([kept.title]);
  expect(() => store.remove("t-999")).toThrow(UnknownTodoError);
});
`,
};

/** The bodies `implement` returns. A method's span starts at its name. */
const BODIES: Record<string, string> = {
  "01-01": `complete(id: string): Todo {
    const todo = this.#todos.find((t) => t.id === id);
    if (todo === undefined) throw new UnknownTodoError(id);
    todo.done = true;
    return todo;
  }`,
  "01-02": `remove(id: string): void {
    const at = this.#todos.findIndex((t) => t.id === id);
    if (at < 0) throw new UnknownTodoError(id);
    this.#todos.splice(at, 1);
  }`,
};

/* -------------------------------------------------------------- seeding */

/** The obligations leaf, at the key `runStep` will compute. */
const seedObligations = (
  defs: ReturnType<typeof obligationsDefs>,
  rows: ReturnType<typeof readRoadmap>,
  design: string,
): Record<string, StepResult<unknown>> => {
  const input = ProposeInput.parse({
    roadmap: {
      request: REQUEST,
      steps: rows.map((row) => ({
        id: row.id,
        observation: row.observation,
        dependencies: row.dependencies,
        authority: row.authority,
        predictedTouches: row.predictedTouches,
        acceptance: row.acceptance,
        supports: row.supports,
      })),
    },
    design,
    testPaths: ["test"],
    defects: [],
  });
  return {
    [journalKey(defs["propose-obligations"], input)]: {
      decision: "ok",
      output: { decision: "proposed", payload: { values: MANIFEST, rationale: "stubbed" } },
    },
  } as Record<string, StepResult<unknown>>;
};

/** The author leaf, per value, at the key `runStep` will compute. */
const seedAuthors = (
  defs: ReturnType<typeof oracleDefs>,
  rows: ReturnType<typeof readRoadmap>,
  design: string,
): Record<string, StepResult<unknown>> => {
  const seeded: Record<string, StepResult<unknown>> = {};
  for (const row of rows) {
    const oracle = row.oracle as string;
    const path = oracle.split("::")[0] as string;
    const input = AuthorInput.parse({
      value: {
        stepId: row.id,
        observation: row.observation,
        acceptance: row.acceptance,
        oracle,
        supports: row.supports,
        authority: row.authority,
      },
      design,
      testPaths: ["test"],
    });
    seeded[journalKey(defs["author-oracle"], input)] = {
      decision: "ok",
      output: {
        decision: "authored",
        payload: {
          files: [{ path, body: ORACLE_BODIES[path] as string }],
          reason: "every obligation is falsified by one of the two assertions",
        },
      },
    } as StepResult<unknown>;
  }
  return seeded;
};

/** The decision each DELIVER leaf of a happy run returns. */
const HAPPY: Partial<Record<LeafId, string>> = {
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  commit: "committed",
};

/** Leaves that run BEFORE `implement` carries `wrote`, so they key differently. */
const BEFORE_THE_WRITE: readonly LeafId[] = ["implement"];

/** Seed one row's DELIVER leaves at the exact keys `runStep` will compute. */
const seedRow = (
  rows: Record<string, StepResult<unknown>>,
  defs: DeliverDefs,
  vcs: Vcs,
  row: ReturnType<typeof readRoadmap>[number],
  design: string,
  evidence: string,
): void => {
  const step = stepUnderDelivery(row, design);
  const symbolId = row.predictedTouches[0] as string;
  const impacted = vcs.impact.impactedTests([symbolId]).map((t) => t.id);

  for (const [leaf, decision] of Object.entries(HAPPY) as [LeafId, string][]) {
    const wrote = BEFORE_THE_WRITE.includes(leaf) ? undefined : symbolId;
    const input = LeafInput.parse({
      step,
      evidence,
      impacted,
      ...(wrote === undefined ? {} : { wrote }),
    });
    rows[journalKey(defs[leaf], input)] = {
      decision: "ok",
      output: {
        decision,
        payload: {
          anchor: evidence,
          rationale: "stubbed",
          symbolId,
          body: BODIES[row.id] as string,
          gap: "",
          extra: [] as string[],
        },
      },
    } as StepResult<unknown>;
  }
};

/** The roadmap, persisted the way it is produced: through its own graph. */
const persistRoadmap = async (roadmap: Roadmap, design: string, effects: ReturnType<typeof memoryEffects>) => {
  const defs = roadmapDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
  const seeded = {
    "roadmap.decompose": {
      decision: "ok",
      output: { decision: "proposed", payload: { roadmap, rationale: "one row per stub" } },
    },
    "roadmap.validate-slices": {
      decision: "ok",
      output: {
        decision: "is-slice",
        payload: {
          verdicts: roadmap.steps.map((s) => ({ stepId: s.id, verdict: "is-slice", anchor: s.observation })),
          rationale: "both are reachable through the store's own public surface",
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
  const parked = await run<RoadmapState>(wf, seedRoadmap(REQUEST, design), effects.execute);
  if (parked.kind !== "suspended") throw new Error("expected the roadmap to park for a person");
  const approved = await resume<RoadmapState>(wf, parked.runId, { decision: "approve" }, effects.execute);
  if (approved.kind !== "terminal" || approved.terminal.kind !== "accepted") {
    throw new Error("expected the approved roadmap to be accepted");
  }
};

describe("the todo target, delivered", () => {
  test("DISTILL states the facts and measures each oracle red, then DELIVER turns them green", async () => {
    const project = await openProject();
    const artifacts = openArtifacts();
    const design = designSource(project.root, project.vcs);

    // The target as it ships: two stubs, and NO test file at all. The oracle
    // is authored here rather than pre-written, which is the point.
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');
    expect(existsSync(join(project.root, "test"))).toBe(false);

    /* ---- ROADMAP ------------------------------------------------------ */

    await persistRoadmap(roadmapFor(project.symbolId), design, memoryEffects({ store: artifacts }));
    expect(readRoadmap(artifacts, REQUEST).map((r) => r.id)).toEqual(["01-01", "01-02"]);
    // As ROADMAP leaves them: no acceptance facts anywhere.
    expect(readRoadmap(artifacts, REQUEST).every((r) => r.acceptance.length === 0)).toBe(true);

    /* ---- DISTILL, first half: the acceptance facts --------------------- */

    const obligations = obligationsDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const facts = await runObligations({
      artifacts,
      vcs: project.vcs,
      journal: memoryJournal(seedObligations(obligations, readRoadmap(artifacts, REQUEST), design)),
      defs: obligations,
      roadmapId: REQUEST,
      design,
    });
    expect(facts.kind === "terminal" && facts.terminal.kind).toBe("accepted");

    const enriched = readRoadmap(artifacts, REQUEST);
    expect(enriched.map((r) => r.oracle)).toEqual([ORACLES["01-01"], ORACLES["01-02"]]);
    expect(enriched.map((r) => r.acceptance.length)).toEqual([2, 2]);

    /* ---- DISTILL, second half: the oracle, authored and measured ------- */

    const oracles = oracleDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const { scheduler: oracleScheduler } = openOracles({
      artifacts,
      vcs: project.vcs,
      journal: memoryJournal(seedAuthors(oracles, enriched, design)),
      defs: oracles,
      roadmapId: REQUEST,
      design,
      concurrency: 1,
    });
    const oracleStatuses = await oracleScheduler.run();

    expect(oracleStatuses.get("01-01")).toBe("accepted");
    expect(oracleStatuses.get("01-02")).toBe("accepted");
    // The verdict is the RUNNER's, not this file's: both oracles were executed
    // against the stub bodies and both failed on their assertions.
    expect(oracleRunsOf(artifacts, "01-01").at(-1)?.verdict).toBe("red");
    expect(oracleRunsOf(artifacts, "01-02").at(-1)?.verdict).toBe("red");
    expect(project.read("test/complete.test.ts")).toBe(ORACLE_BODIES["test/complete.test.ts"] ?? "");
    expect(project.read("test/remove.test.ts")).toBe(ORACLE_BODIES["test/remove.test.ts"] ?? "");
    // And the measurements are on the event log, under each value's own task,
    // with the argv the TARGET declared rather than one the framework picked.
    for (const row of ["01-01", "01-02"]) {
      const events = project.vcs.log.byTask(row).filter((e) => e.kind === "oracle-measured");
      expect(events).toHaveLength(1);
      const detail = JSON.parse(String(events[0]?.detail));
      expect(detail.verdict).toBe("red");
      expect(detail.argv).toContain("--reporter=junit");
      expect(detail.argv.some((a: string) => a.startsWith("--reporter-outfile="))).toBe(true);
    }

    /* ---- DELIVER ------------------------------------------------------ */

    // The oracles are on disk now, so the impact graph can see them.
    project.vcs.trackTree("test");

    const evidence = runSuite(project.root);
    expect(evidence.exitCode).not.toBe(0);

    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const seeded: Record<string, StepResult<unknown>> = {};
    for (const row of readRoadmap(artifacts, REQUEST)) {
      seedRow(seeded, defs, project.vcs, row, design, evidence.output);
    }

    const { scheduler, unoracled } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands: project.commands,
      journal: memoryJournal(seeded),
      defs,
      roadmapId: REQUEST,
      design,
      evidence: evidence.output,
      concurrency: 1,
    });

    // Every row is oracled, so every row is deliverable.
    expect(unoracled()).toEqual([]);
    const statuses = await scheduler.run();

    expect(statuses.get("01-01")).toBe("accepted");
    expect(statuses.get("01-02")).toBe("accepted");
    expect(statusOf(artifacts, "01-01")).toBe("accepted");

    // Both stub bodies were written, for real, through the gate.
    const source = project.read("src/todo.ts");
    expect(source).not.toContain('throw new Error("not implemented")');
    expect(source).toContain("todo.done = true;");
    expect(source).toContain("this.#todos.splice(at, 1);");

    // The quality gate ran the target's OWN declared lint command, for real,
    // over the file the row wrote. Not a leaf classifying a string: a command
    // the consumer named, and an exit status.
    for (const row of ["01-01", "01-02"]) {
      const lints = project.vcs.log
        .byTask(row)
        .filter((e) => e.kind === "trail")
        .map((e) => JSON.parse(String(e.detail)) as { ran?: string[]; exit?: number });
      const gate = lints.find((l) => l.ran?.includes("biome"));
      expect(gate?.ran).toEqual(["bunx", "biome", "check", "src/todo.ts"]);
      expect(gate?.exit).toBe(0);
    }

    // And the oracles are byte-identical: RED to GREEN was bought by
    // production, and the crafter's executor is what made that structural.
    expect(project.read("test/complete.test.ts")).toBe(ORACLE_BODIES["test/complete.test.ts"] ?? "");
    expect(project.read("test/remove.test.ts")).toBe(ORACLE_BODIES["test/remove.test.ts"] ?? "");

    // And the project's own suite passes. Run it; do not infer it.
    const suite = runSuite(project.root);
    expect(suite.output).toContain("2 pass");
    expect(suite.output).not.toContain("skip");
    expect(suite.exitCode).toBe(0);

    artifacts.close();
    project.vcs.close();
  }, 120_000);

  test("a value whose oracle is not red is refused by name, and blocks its dependents", async () => {
    const project = await openProject();
    const artifacts = openArtifacts();
    const design = designSource(project.root, project.vcs);
    await persistRoadmap(roadmapFor(project.symbolId), design, memoryEffects({ store: artifacts }));

    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const { scheduler, unoracled } = openPipeline({
      artifacts,
      vcs: project.vcs,
      commands: project.commands,
      journal: memoryJournal({}),
      defs,
      roadmapId: REQUEST,
      design,
      concurrency: 1,
    });

    expect(unoracled()).toEqual(["01-01", "01-02"]);
    expect(oracleIsRed(artifacts, "01-01")).toBe(false);
    // Nothing runs: the model bindings throw, so reaching one would fail here.
    expect([...(await scheduler.run()).values()]).toEqual(["pending", "pending"]);
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');

    artifacts.close();
    project.vcs.close();
  }, 30_000);

  test("a run directory is a fresh checkout, and a second open sees what the first left", async () => {
    const name = `_test-${process.pid}`;
    const path = join(RUNS, name);
    try {
      expect(createRunDir(name)).toBe(path);
      const first = await openRunDir(name);
      expect(readFileSync(join(first.project, "src/todo.ts"), "utf8")).toContain(
        'throw new Error("not implemented")',
      );
      // Only `src/` exists on a fresh checkout: the oracle is written into
      // `test/` by a later command, and tracking follows what is there.
      expect(first.vcs.registry.files().map((f) => f.path)).toEqual(["src/todo.ts"]);
      first.save({ name, request: REQUEST, roadmapRunId: "run-abc", roadmapReason: "roadmap-ready" });
      first.close();

      const second = await openRunDir(name);
      expect(second.manifest).toMatchObject({ request: REQUEST, roadmapRunId: "run-abc" });
      expect(second.vcs.registry.files()).toHaveLength(1);
      expect(second.design).toContain("## Symbol inventory");
      second.close();

      expect(() => createRunDir(name)).toThrow(/already exists/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("a target with no commands.ts is refused by name, not defaulted", async () => {
    // The same refusal the test path scope gets, for the same reason: every
    // process the framework runs against a project comes from that file, so a
    // default would run one project's toolchain against every other project
    // and call the result a verdict.
    const empty = mkdtempSync(join(tmpdir(), "dw-no-commands-"));
    await expect(loadCommands(empty)).rejects.toThrow(/no commands\.ts/);

    // And a file that exports the wrong thing is refused by name too.
    const wrong = mkdtempSync(join(tmpdir(), "dw-wrong-commands-"));
    writeFileSync(join(wrong, "commands.ts"), "export const notCommands = {};\n", "utf8");
    await expect(loadCommands(wrong)).rejects.toThrow(/exports no `commands`/);
  });

  test("the target declares four commands, and they are the ones the framework reads", async () => {
    const project = await openProject();
    const junit = "/tmp/report.xml";

    expect(project.commands.typecheck({})).toEqual(["bunx", "tsc", "--noEmit"]);
    expect(project.commands.lint({ paths: ["src/todo.ts"] })).toEqual([
      "bunx",
      "biome",
      "check",
      "src/todo.ts",
    ]);
    expect(project.commands.tests({ file: "test/a.test.ts", selector: "does it", junit })).toEqual([
      "bun",
      "test",
      "test/a.test.ts",
      "-t",
      "does it",
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
    ]);
    // A bare path names the whole file, so the selector is simply absent.
    expect(project.commands.oracle({ file: "test/a.test.ts", junit })).toEqual([
      "bun",
      "test",
      "test/a.test.ts",
      "--reporter=junit",
      `--reporter-outfile=${junit}`,
    ]);
    project.vcs.close();
  });

  test("the design source carries the symbol ids a write has to name, and the test path scope", async () => {
    const project = await openProject();
    const design = designSource(project.root, project.vcs);
    const completeId = project.symbolId("src/todo.ts", "complete");

    expect(design).toContain("## Symbol inventory");
    expect(design).toContain(completeId);
    expect(design).toContain("There is no other exported symbol");
    // The one line three consumers read: the author writes there, the executor
    // walls the oracle there, and the manifest validator refuses outside it.
    expect(design).toContain("- Test path scope: `test/`");
    project.vcs.close();
  });
});
