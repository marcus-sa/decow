/**
 * The todo target, delivered end to end, with no model calls.
 *
 * This is the stubbed twin of the three commands. Everything they do is done
 * here except the inference: the target is copied to a temp directory, the
 * roadmap is authored through the ROADMAP workflow's own graph and persisted by
 * its own `persist`, the SCHEDULER reads the rows back out of the artifact
 * store, and one DELIVER run per row locates the pending acceptance tests,
 * activates them through the write path, writes the stubbed method bodies, and
 * is gated by a REAL `bunx tsc --noEmit` and a REAL impact-scoped `bun test` on
 * every write. The suite runs for real at the end, because "the acceptance
 * tests pass" is a thing you run.
 *
 * Every leaf is a journal hit at the key `runStep` will compute, so the model
 * bindings throw if anything reaches them. The RED evidence is not stubbed
 * either: `redEvidence` produces it by running the target's own suite with the
 * pending markers stripped in a scratch copy, which is what the deliver command
 * hands the leaf.
 *
 * It shells out — four `tsc` runs, a `bun test` per write gate, one per
 * `run-tests` effect, one for the evidence, and one at the end — and it is the
 * second test in the repo allowed to, for the same reason the pipeline test is:
 * the claim is about what the gate does, and a stubbed gate proves nothing
 * about it.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifacts } from "../../../artifacts/store.ts";
import { memoryEffects } from "../../../core/effects.ts";
import { memoryJournal } from "../../../core/journal.ts";
import { journalKey, type StepResult } from "../../../core/step.ts";
import { resume, run } from "../../../core/workflow.ts";
import { openVcs, type Vcs } from "../../../vcs/index.ts";
import { deliverDefs, LeafInput, type DeliverDefs, type LeafId } from "../deliver/steps.ts";
import { openPipeline, readRoadmap, statusOf, stepUnderDelivery } from "../deliver/pipeline.ts";
import { roadmapGraph, seed as seedRoadmap, type State as RoadmapState } from "../roadmap/graph.ts";
import type { Roadmap } from "../roadmap/schema.ts";
import { roadmapDefs } from "../roadmap/steps.ts";
import { redEvidence } from "./evidence.ts";
import { createRunDir, designSource, openRunDir, REPO, RUNS, TARGET } from "./run-dir.ts";
import { REQUEST } from "./request.ts";

/* --------------------------------------------------------------- the copy */

/** A temp copy of `targets/todo`, tracked in a fresh VCS with the real gate. */
const openProject = () => {
  const root = mkdtempSync(join(tmpdir(), "dw-todo-"));
  cpSync(TARGET, root, { recursive: true });
  // `tsc` and `bun test` both need `@types/bun`; one symlink beats one install.
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));

  // The DEFAULT verifier: real `bunx tsc --noEmit`, real impact-scoped
  // `bun test`. Nothing is stubbed at the gate.
  const vcs = openVcs({ root });
  vcs.trackTree("src");
  vcs.trackTree("test");

  const symbolId = (path: string, name: string): string => {
    const file = vcs.registry.file(path);
    const symbol = file === undefined ? undefined : vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`the target has no ${path}::${name}`);
    return symbol.id;
  };

  return { root, vcs, symbolId, read: (p: string) => readFileSync(join(root, p), "utf8") };
};

/* ------------------------------------------------------------ the roadmap */

/**
 * The known-good roadmap: one row per stub, each activating that stub's two
 * pending acceptance tests and writing that stub's method body.
 *
 * `predictedTouches` carries VCS SYMBOL IDS rather than names, because that is
 * what the pipeline resolves to get the version the first `replace-symbol`
 * claims, and what `implement` has to name for a write to land at all. In the
 * real commands the ids reach the model through the design source, which is
 * `design.md` plus the symbol inventory.
 */
const roadmapFor = (symbolId: (path: string, name: string) => string): Roadmap => ({
  request: REQUEST,
  steps: [
    {
      id: "01-01",
      observation: "TodoStore.complete marks a todo done, and rejects an id the store does not hold.",
      dependencies: [],
      authority: "design.md § Behaviour → complete",
      acceptance: [
        {
          id: "01-01-AC-1",
          text: "complete(id) sets done and returns the todo.",
          oracleLocator: "test/todo.test.ts::complete marks the todo done and list narrowed to done returns it",
        },
        {
          id: "01-01-AC-2",
          text: "complete(id) throws UnknownTodoError for an unknown id.",
          oracleLocator: "test/todo.test.ts::complete throws UnknownTodoError for an id the store does not hold",
        },
      ],
      predictedTouches: [symbolId("src/todo.ts", "complete")],
    },
    {
      id: "01-02",
      observation: "TodoStore.remove drops a todo, and rejects an id the store does not hold.",
      dependencies: ["01-01"],
      authority: "design.md § Behaviour → remove",
      acceptance: [
        {
          id: "01-02-AC-1",
          text: "remove(id) drops the todo from the list.",
          oracleLocator: "test/todo.test.ts::remove drops the todo so list no longer returns it",
        },
        {
          id: "01-02-AC-2",
          text: "remove(id) throws UnknownTodoError for an unknown id.",
          oracleLocator: "test/todo.test.ts::remove throws UnknownTodoError for an id the store does not hold",
        },
      ],
      predictedTouches: [symbolId("src/todo.ts", "remove")],
    },
  ],
});

/**
 * The bodies `implement` returns. A method symbol's span starts at its name, so
 * the first line carries no indentation and the rest carry their own.
 */
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

/* -------------------------------------------------------------- the leaves */

/** A model binding that fails the test if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T,>(): Promise<T> => {
    throw new Error(`model "${id}" was called; this suite spends zero model calls`);
  },
});

/** The decision each leaf of a happy run returns. */
const HAPPY: Partial<Record<LeafId, string>> = {
  "run-tests.red": "red-observed",
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  gates: "clean",
  commit: "committed",
};

/** Leaves that run BEFORE `implement` carries `wrote`, so they key differently. */
const BEFORE_THE_WRITE: readonly LeafId[] = ["run-tests.red", "implement"];

/** Seed one row's leaves at the exact keys `runStep` will compute. */
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
          // A classifying leaf must quote the evidence verbatim; the whole of
          // it is trivially verbatim, and the mechanical check is the point.
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
  test("both stubs are implemented, all four pending tests are activated, and the suite is green", async () => {
    const project = openProject();
    const artifacts = openArtifacts();
    const design = designSource(project.root, project.vcs);

    // The target as it ships: four active tests, four pending, two stubs.
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');
    // Call sites, not the word: the file's own header names the convention.
    expect(project.read("test/todo.test.ts").match(/^ {2}test\.skip\(/gm)).toHaveLength(4);

    // 1. The RED evidence, measured: the target's own suite with the markers
    //    stripped, in a scratch copy. The stubs fail, which is the point.
    const evidence = redEvidence(project.root);
    expect(evidence.exitCode).not.toBe(0);
    expect(evidence.output).toContain("4 pass");
    expect(evidence.output).toContain("4 fail");

    // 2. The roadmap, through the roadmap workflow's own persist.
    await persistRoadmap(roadmapFor(project.symbolId), design, memoryEffects({ store: artifacts }));
    const rows = readRoadmap(artifacts, REQUEST);
    expect(rows.map((r) => r.id)).toEqual(["01-01", "01-02"]);

    // 3. Every leaf of every row, at the key `runStep` will compute.
    const defs = deliverDefs({ worker: forbidden("worker"), validator: forbidden("validator") });
    const seeded: Record<string, StepResult<unknown>> = {};
    for (const row of rows) seedRow(seeded, defs, project.vcs, row, design, evidence.output);

    // 4. Two rows, one scheduler, one VCS, one journal, the real gate.
    const { scheduler } = openPipeline({
      artifacts,
      vcs: project.vcs,
      journal: memoryJournal(seeded),
      defs,
      roadmapId: REQUEST,
      design,
      evidence: evidence.output,
      concurrency: 1,
    });

    const statuses = await scheduler.run();

    expect(statuses.get("01-01")).toBe("accepted");
    expect(statuses.get("01-02")).toBe("accepted");
    expect(statusOf(artifacts, "01-01")).toBe("accepted");
    expect(statusOf(artifacts, "01-02")).toBe("accepted");

    // 5. All four pending tests were activated, for real, through the write
    //    path — and nothing else in the file changed shape.
    const tests = project.read("test/todo.test.ts");
    expect(tests.match(/^ {2}test\.skip\(/gm)).toBeNull();
    expect(tests).toContain('test("complete marks the todo done and list narrowed to done returns it"');
    expect(tests).toContain('test("remove throws UnknownTodoError for an id the store does not hold"');

    // 6. Both stub bodies were written, for real.
    const source = project.read("src/todo.ts");
    expect(source).not.toContain('throw new Error("not implemented")');
    expect(source).toContain("todo.done = true;");
    expect(source).toContain("this.#todos.splice(at, 1);");

    // 7. And the project's own suite passes. Run it; do not infer it.
    const suite = Bun.spawnSync(["bun", "test"], { cwd: project.root });
    expect(`${suite.stderr}`).toContain("8 pass");
    expect(`${suite.stderr}`).not.toContain("skip");
    expect(suite.exitCode).toBe(0);

    artifacts.close();
    project.vcs.close();
  }, 60_000);

  test("a run directory is a fresh checkout, and a second open sees what the first left", () => {
    // The plumbing the three commands share, and the only part of them that
    // is not exercised above: `todo:roadmap` creates the directory and parks,
    // `todo:review` and `todo:deliver` open it again in later processes. Each
    // open is its own VCS, its own stores and its own Mastra runtime over the
    // same five files.
    const name = `_test-${process.pid}`;
    const path = join(RUNS, name);
    try {
      expect(createRunDir(name)).toBe(path);
      // A fresh checkout: the template, copied, untouched.
      const first = openRunDir(name);
      expect(readFileSync(join(first.project, "src/todo.ts"), "utf8")).toContain(
        'throw new Error("not implemented")',
      );
      expect(first.vcs.registry.files().map((f) => f.path).sort()).toEqual([
        "src/todo.ts",
        "test/todo.test.ts",
      ]);
      first.save({ name, request: REQUEST, roadmapRunId: "run-abc", roadmapReason: "roadmap-ready" });
      first.close();

      // A second process: same files, same tracked symbols, same manifest.
      const second = openRunDir(name);
      expect(second.manifest).toMatchObject({ request: REQUEST, roadmapRunId: "run-abc" });
      expect(second.vcs.registry.files()).toHaveLength(2);
      expect(second.design).toContain("## Symbol inventory");
      second.close();

      // And a run directory is never reused: a second create refuses by name.
      expect(() => createRunDir(name)).toThrow(/already exists/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("the design source carries the symbol ids a write has to name", () => {
    // Without this the real run cannot work at all: `predictedTouches` and
    // `implement`'s `symbolId` are opaque VCS ids assigned at track time, so a
    // model that never saw the inventory names one that does not exist and
    // every write comes back `rejected: contract`.
    const project = openProject();
    const design = designSource(project.root, project.vcs);
    const completeId = project.symbolId("src/todo.ts", "complete");

    expect(design).toContain("## Symbol inventory");
    expect(design).toContain(completeId);
    // And the design document itself is still in there, which is the authority
    // `implement` is refuted against.
    expect(design).toContain("There is no other exported symbol");
    project.vcs.close();
  });
});
