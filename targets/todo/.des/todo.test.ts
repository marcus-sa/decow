/**
 * The todo target, delivered end to end, with no model calls.
 *
 * This is the stubbed twin of the five commands, and everything they do is
 * done here except the inference:
 *
 *   ROADMAP    two steps, persisted through the roadmap workflow's own `persist`
 *   DISTILL    the obligations graph fills in their acceptance facts; the
 *              oracle graph authors one test file per value through a real
 *              `write-file`, and a REAL `bun test` measures each one red
 *   DELIVER    the scheduler reads the steps back, refuses any value whose
 *              oracle is not red, and runs the step cycle once per step against
 *              a REAL `tsc --noEmit` and a REAL impact-scoped `bun test`
 *
 * Every leaf is stubbed at the BINDING — the one seam this composition has —
 * so the output schema, the mechanical checks and the validator all run for
 * real and nothing computes a journal key. Nothing about the RED is asserted by
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
import { openArtifacts } from "@des/core/artifacts";
import { memoryEffects } from "@des/core/effects";
import { memoryJournal } from "@des/core/journal";
import type { ModelBinding } from "@des/core/step";
import { resume, run } from "@des/core/workflow";
import { openVcs, type Vcs } from "@des/core/vcs";
import { scriptedBinding, type Script, type ScriptedAnswer } from "@des/core/harness/scripted-binding";
import { readRoadmap, statusOf, stepUnderDelivery } from "../../../examples/nwave/deliver/pipeline.ts";
import { leafStepId, type LeafId } from "../../../examples/nwave/deliver/steps.ts";
import { oracleIsRed, oracleRunsOf } from "../../../examples/nwave/distill/runs.ts";
import { roadmapGraph, seed as seedRoadmap, type State as RoadmapState } from "../../../examples/nwave/roadmap/graph.ts";
import type { Roadmap } from "../../../examples/nwave/roadmap/schema.ts";
import { roadmapDefs } from "../../../examples/nwave/roadmap/steps.ts";
import { todoRoadmapDefs, type Models } from "./models.ts";
import {
  getPipeline,
  getRun,
  openRegistry,
  openRunDatabase,
  project,
  runPipeline,
  startRun,
  type Registry,
} from "@des/server";
import { openWorkflowRuntime } from "@des/core/compile";
import type { Journal } from "@des/core/journal";
import { REQUEST, todoRegistrations } from "./registrations.ts";
import {
  createRunDir,
  designSource,
  loadCommands,
  openRunDir,
  REPO,
  RUNS,
  runSuite,
  TARGET,
  type RunDir,
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

/** The decision each DELIVER leaf of a happy run returns. */
const HAPPY: Partial<Record<LeafId, string>> = {
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  commit: "committed",
};

/* -------------------------------------------------------------- the script */

/**
 * Every leaf this run reaches, and what its worker answers.
 *
 * Keyed by STEP ID, not by journal key — so nothing here computes what
 * `runStep` will compute, and the composition needs no hook to make that
 * computation possible. The `evidence` override this file used to pass existed
 * for exactly that reason and is gone: what the suite actually printed is what
 * every DELIVER run now quotes.
 *
 * The payloads have to be RIGHT rather than merely well-typed, because every
 * mechanical check runs now. `select-tests` answers `no-extra` with an empty
 * list, because `deliver.selection-matches-its-decision` refuses a decision
 * its own payload contradicts.
 */
const STEP_IDS = ["01-01", "01-02"] as const;

/** The step a prompt is about. Every leaf's prompt names it; a model reads it too. */
const stepIn = (prompt: string): string => STEP_IDS.find((id) => prompt.includes(id)) ?? "01-01";

const leafPayload = (step: string, symbolId: string): Record<string, unknown> => ({
  anchor: "",
  rationale: "stubbed",
  symbolId,
  body: BODIES[step] ?? "",
  gap: "",
  extra: [],
});

/**
 * The five roles, all answered by ONE scripted binding, which is the whole of
 * what this test injects.
 *
 * A binding is answered per CALL, and which step a call is about is on the
 * prompt — `Step 01-01`, `Value 01-02` — exactly where the model it stands in
 * for would read it. So one script serves both steps without the composition
 * growing anywhere for a test to reach.
 */
const scriptedModels = (symbolFor: (step: string) => string): Models => {
  const binding: ModelBinding = scriptedBinding(({ step, prompt }): ScriptedAnswer[] | undefined => {
    if (step.id === "distill.propose-obligations") {
      return [{ decision: "proposed", payload: { values: MANIFEST, rationale: "stubbed" } }];
    }
    if (step.id === "distill.author-oracle") {
      const path = (ORACLES[stepIn(prompt) as keyof typeof ORACLES] ?? "").split("::")[0] as string;
      return [
        {
          decision: "authored",
          payload: {
            files: [{ path, body: ORACLE_BODIES[path] ?? "" }],
            reason: "every obligation is falsified by one of the two assertions",
          },
        },
      ];
    }
    const leaf = step.id.slice("deliver.".length) as LeafId;
    const decision = HAPPY[leaf];
    if (decision === undefined) return undefined;
    const stepId = stepIn(prompt);
    return [{ decision, payload: leafPayload(stepId, symbolFor(stepId)) }];
  });

  return {
    decompose: binding,
    authorOracle: binding,
    implement: binding,
    other: binding,
    validator: binding,
  };
};

/** The roadmap, persisted the way it is produced: through its own graph. */
const persistRoadmap = async (roadmap: Roadmap, design: string, effects: ReturnType<typeof memoryEffects>) => {
  // The two roadmap leaves, scripted. The slice verdicts quote each step's own
  // observation because `roadmap.slice-anchor-verbatim` is mechanical and runs
  // for real — a paraphrase would be refused here rather than judged.
  const binding = scriptedBinding({
    "roadmap.decompose": [
      { decision: "proposed", payload: { roadmap, rationale: "one step per stub" } },
    ],
    "roadmap.validate-slices": [
      {
        decision: "is-slice",
        payload: {
          verdicts: roadmap.steps.map((s) => ({ stepId: s.id, verdict: "is-slice", anchor: s.observation })),
          rationale: "both are reachable through the store's own public surface",
        },
      },
    ],
  });

  const wf = roadmapGraph(
    memoryJournal(),
    roadmapDefs({ worker: binding, validator: binding, decomposeWith: binding }),
  );
  const parked = await run<RoadmapState>(wf, seedRoadmap(REQUEST, design), effects.execute);
  if (parked.kind !== "suspended") throw new Error("expected the roadmap to park for a person");
  const approved = await resume<RoadmapState>(wf, parked.runId, { decision: "approve" }, effects.execute);
  if (approved.kind !== "terminal" || approved.terminal.kind !== "accepted") {
    throw new Error("expected the approved roadmap to be accepted");
  }
};

/* ------------------------------------------------------------- the server */

/**
 * The four registrations and the two pipelines, over the temp copy.
 *
 * This is `todoRegistrations` — the same function `main.ts` calls — handed a
 * run directory whose stores are this test's. Everything below is driven
 * through it: a graph is started with `startRun`, a pipeline with
 * `runPipeline`, and the server's scheduler is what decides which step runs
 * when. Nothing here calls `run()`.
 */
const openStubbedServer = (
  project: Awaited<ReturnType<typeof openProject>>,
  design: string,
) => {
  const artifacts = openArtifacts();
  // A REAL journal: production replay, nothing seeded. Two runs of the same
  // step on the same input replay here exactly as they would in a run
  // directory, which is one more thing this test no longer has to pretend.
  const seeded = memoryJournal();
  const journal: Journal & { close: () => void } = { ...seeded, close: () => {} };
  const store = openRunDatabase();
  const dir: RunDir = {
    name: "stubbed",
    path: project.root,
    project: project.root,
    commands: project.commands,
    vcs: project.vcs,
    artifacts,
    journal,
    runtime: openWorkflowRuntime(),
    runs: store,
    design,
    close: () => {},
  };
  const { workflows, pipelines } = todoRegistrations(dir, {
    models: scriptedModels((step) => project.symbolId("src/todo.ts", METHODS[step] ?? "")),
  });
  const registry = openRegistry({ workflows, pipelines, artifacts, store });
  return { registry, artifacts, journal, dir };
};

/** Which method each step rewrites, so `implement` can name the symbol. */
const METHODS: Record<string, string> = { "01-01": "complete", "01-02": "remove" };

/** Drive one pipeline to quiescence and answer with its tree. */
const drivePipeline = async (registry: Registry, id: string) => {
  runPipeline(registry, id);
  await registry.idle();
  return await getPipeline(registry, id);
};

describe("the todo target, delivered", () => {
  test("DISTILL states the facts and measures each oracle red, then DELIVER turns them green", async () => {
    const project = await openProject();
    const design = designSource(project.root, project.vcs);

    // The target as it ships: two stubs, and NO test file at all. The oracle
    // is authored here rather than pre-written, which is the point.
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');
    expect(existsSync(join(project.root, "test"))).toBe(false);

    // Nothing is injected but the bindings. The evidence every DELIVER leaf
    // quotes is what the project's OWN suite printed, measured per run by the
    // composition, because a script keyed by step id needs no key computed
    // from it.
    const { registry, artifacts } = openStubbedServer(project, design);

    /* ---- ROADMAP ------------------------------------------------------ */

    await persistRoadmap(roadmapFor(project.symbolId), design, memoryEffects({ store: artifacts }));
    expect(readRoadmap(artifacts, REQUEST).map((r) => r.id)).toEqual(["01-01", "01-02"]);
    // As ROADMAP leaves them: no acceptance facts anywhere.
    expect(readRoadmap(artifacts, REQUEST).every((r) => r.acceptance.length === 0)).toBe(true);

    /* ---- DISTILL, first half: the acceptance facts --------------------- */

    const facts = startRun(registry, "obligations", {});
    await registry.idle();
    expect(getRun(registry, facts.runId).status).toBe("accepted");

    const enriched = readRoadmap(artifacts, REQUEST);
    expect(enriched.map((r) => r.oracle)).toEqual([ORACLES["01-01"], ORACLES["01-02"]]);
    expect(enriched.map((r) => r.acceptance.length)).toEqual([2, 2]);

    /* ---- DISTILL, second half: the oracle, authored and measured ------- */

    const oracleTree = await drivePipeline(registry, "oracles");

    expect(oracleTree.steps.map((r) => `${r.id}:${r.status}`)).toEqual([
      "01-01:accepted",
      "01-02:accepted",
    ]);
    // Every step is an ordinary RUN: the tree links to it, and the run's own
    // trace is of the oracle graph the author wrote.
    for (const step of oracleTree.steps) {
      const record = getRun(registry, step.runId as string);
      expect(record.workflowId).toBe("oracle");
      expect(record.trace.map((t) => t.node)).toContain("measure");
    }
    // The verdict is the RUNNER's, not this file's: both oracles were executed
    // against the stub bodies and both failed on their assertions.
    expect(oracleRunsOf(artifacts, "01-01").at(-1)?.verdict).toBe("red");
    expect(oracleRunsOf(artifacts, "01-02").at(-1)?.verdict).toBe("red");
    expect(project.read("test/complete.test.ts")).toBe(ORACLE_BODIES["test/complete.test.ts"] ?? "");
    expect(project.read("test/remove.test.ts")).toBe(ORACLE_BODIES["test/remove.test.ts"] ?? "");
    // And the measurements are on the event log, under each value's own task,
    // with the argv the TARGET declared rather than one the framework picked.
    for (const step of ["01-01", "01-02"]) {
      const events = project.vcs.log.byTask(step).filter((e) => e.kind === "oracle-measured");
      expect(events).toHaveLength(1);
      const detail = JSON.parse(String(events[0]?.detail));
      expect(detail.verdict).toBe("red");
      expect(detail.argv).toContain("--reporter=junit");
      expect(detail.argv.some((a: string) => a.startsWith("--reporter-outfile="))).toBe(true);
    }

    /* ---- DELIVER ------------------------------------------------------ */

    // The oracles are on disk now, so the impact graph can see them.
    project.vcs.trackTree("test");
    expect(runSuite(project.root).exitCode).not.toBe(0);

    const deliveryTree = await drivePipeline(registry, "delivery");

    expect(deliveryTree.steps.map((r) => `${r.id}:${r.status}`)).toEqual([
      "01-01:accepted",
      "01-02:accepted",
    ]);
    expect(statusOf(artifacts, "01-01")).toBe("accepted");
    for (const step of deliveryTree.steps) {
      const record = getRun(registry, step.runId as string);
      expect(record.workflowId).toBe("deliver");
      expect(record.status).toBe("accepted");
    }

    // Both stub bodies were written, for real, through the gate.
    const source = project.read("src/todo.ts");
    expect(source).not.toContain('throw new Error("not implemented")');
    expect(source).toContain("todo.done = true;");
    expect(source).toContain("this.#todos.splice(at, 1);");

    // The quality gate ran the target's OWN declared lint command, for real,
    // over the file the step wrote. Not a leaf classifying a string: a command
    // the consumer named, and an exit status.
    for (const step of ["01-01", "01-02"]) {
      const lints = project.vcs.log
        .byTask(step)
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
  }, 180_000);

  test("a value whose oracle is not red is refused by name, and blocks its dependents", async () => {
    const project = await openProject();
    const design = designSource(project.root, project.vcs);
    const { registry, artifacts } = openStubbedServer(project, design);
    await persistRoadmap(roadmapFor(project.symbolId), design, memoryEffects({ store: artifacts }));

    expect(oracleIsRed(artifacts, "01-01")).toBe(false);

    // The pipeline's readiness refuses both steps, so nothing runs at all: the
    // model bindings throw, so reaching a leaf would fail here.
    const tree = await drivePipeline(registry, "delivery");
    expect(tree.steps.map((r) => r.status)).toEqual(["pending", "pending"]);
    expect(tree.steps.every((r) => r.runId === undefined)).toBe(true);
    expect(registry.runs.list()).toEqual([]);
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');

    // And the same precondition refuses a step started BY HAND, by name — the
    // standalone seed and the pipeline's readiness say the same thing. The
    // refusal lands ON THE RUN rather than on the call, because a seed runs
    // where the run does: a person reads it in the run they started.
    const byHand = startRun(registry, "deliver", { stepId: "01-01" });
    await registry.idle();
    const refused = getRun(registry, byHand.runId);
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatch(/has no oracle measured red/);
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');

    artifacts.close();
    project.vcs.close();
  }, 60_000);


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
      // `test/` by the oracle graph, and tracking follows what is there.
      expect(first.vcs.registry.files().map((f) => f.path)).toEqual(["src/todo.ts"]);
      first.artifacts.upsert({ table: "notes", id: "n1", expectedVersion: 0, row: { left: "behind" } });
      first.close();

      // A restart of the server against the same name is a second open, and it
      // continues rather than beginning again: every store is a file.
      const second = await openRunDir(name);
      expect(second.artifacts.read("notes", "n1")?.row).toEqual({ left: "behind" });
      expect(second.vcs.registry.files()).toHaveLength(1);
      expect(second.design).toContain("## Symbol inventory");
      second.close();

      expect(() => createRunDir(name)).toThrow(/already exists/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("the registrations are what the server serves, and they survive an empty roadmap", async () => {
    // Every registration is built before anything has run, so every reader in
    // them has to survive the state where there is no roadmap yet — which is
    // the state the server boots in.
    const name = `_test-reg-${process.pid}`;
    const path = join(RUNS, name);
    try {
      createRunDir(name);
      const dir = await openRunDir(name);
      const { workflows, pipelines } = todoRegistrations(dir, {
        models: scriptedModels(() => ""),
      });

      expect(workflows.map((w) => w.id)).toEqual(["roadmap", "obligations", "oracle", "deliver"]);
      expect(pipelines.map((p) => p.id)).toEqual(["oracles", "delivery"]);

      // Every graph is well-formed and projects under the ids its author wrote.
      for (const workflow of workflows) {
        const projection = project(workflow.graph({ journal: dir.journal, observe: () => {} }));
        expect(projection.defects).toEqual([]);
        expect(projection.nodes.some((n) => n.kind === "terminal")).toBe(true);
      }

      // With no roadmap yet, a pipeline has no steps and refuses nothing.
      expect(await pipelines[0]?.steps()).toEqual([]);
      // And a graph that needs a step refuses BY NAME rather than throwing
      // something a reader cannot act on.
      const deliver = workflows.find((w) => w.id === "deliver");
      expect(() => deliver?.seed({ stepId: "01-01" })).toThrow(/no step 01-01 in the roadmap/);

      dir.close();
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }, 30_000);

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
