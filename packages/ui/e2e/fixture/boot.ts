/**
 * The server the browser tests drive. Four graphs, two pipelines, no model.
 *
 * `bun run packages/ui/e2e/fixture/boot.ts` — Playwright starts it, waits for
 * the port, and stops it afterwards.
 *
 * EVERY LEAF IS A JOURNAL HIT. The journal is seeded at the exact keys
 * `runStep` computes, and the model bindings under them throw by name when a
 * key misses — so a browser test that reaches a model fails rather than
 * spending one. Nothing here has a credential and nothing here needs one.
 *
 * WHAT IS PRE-BAKED, AND WHY. The delivery pipeline is what the last test
 * drives, and a row is only deliverable once its oracle has been measured red
 * — so the delivery roadmap, its acceptance facts and its two oracles are
 * driven to that state before the browser opens, through the SAME registry the
 * browser then talks to. The oracle measurement is real: `bun test` runs
 * inside the copied project and the verdict is the runner's.
 *
 * WHAT IS NOT. The roadmap the browser authors for itself, which is the point
 * of the third test: the run starts from the form, parks at `human-review`,
 * and a person's `approve` is what persists it.
 *
 * The project is a COPY of `targets/todo` in a temp directory, thrown away
 * with the process. Nothing under `runs/` is touched.
 */

import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifacts } from "@des/core/artifacts";
import { openWorkflowRuntime } from "@des/core/compile";
import { memoryJournal, type Journal } from "@des/core/journal";
import { journalKey, type StepDef, type StepResult } from "@des/core/step";
import { openVcs } from "@des/core/vcs";
import {
  getPipeline,
  openRunDatabase,
  resumeRun,
  runPipeline,
  serve,
  startRun,
  type Registry,
} from "@des/server";
import { deliverDefs, LeafInput, type LeafId } from "../../../../examples/nwave/deliver/steps.ts";
import { stepUnderDelivery, type RoadmapRow } from "../../../../examples/nwave/deliver/pipeline.ts";
import { obligationsDefs, ProposeInput } from "../../../../examples/nwave/distill/obligations/steps.ts";
import { AuthorInput, oracleDefs } from "../../../../examples/nwave/distill/oracle/steps.ts";
import { readRoadmap } from "../../../../examples/nwave/deliver/pipeline.ts";
import { DecomposeInput, roadmapDefs, SlicesInput } from "../../../../examples/nwave/roadmap/steps.ts";
import type { Roadmap } from "../../../../examples/nwave/roadmap/schema.ts";
import { REQUEST } from "../../../../targets/todo/.des/request.ts";
import { todoRegistrations } from "../../../../targets/todo/.des/registrations.ts";
import {
  designSource,
  loadCommands,
  REPO,
  TARGET,
  type RunDir,
} from "../../../../targets/todo/.des/run-dir.ts";
import { BROWSER_REQUEST, BROWSER_ROADMAP } from "./roadmaps.ts";

/** A binding that fails the boot if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T>(): Promise<T> => {
    throw new Error(`model "${id}" was called; the browser tests spend zero model calls`);
  },
});

const models = { worker: forbidden("worker"), validator: forbidden("validator") };

/** The verbatim runner output a DELIVER leaf quotes. Fixed, so a key matches. */
const EVIDENCE = "2 fail\n0 pass";

/* ---------------------------------------------------------- the two values */

const OBSERVATIONS = {
  complete: "TodoStore.complete marks a todo done and rejects an id the store does not hold.",
  remove: "TodoStore.remove drops a todo from the list and rejects an id the store does not hold.",
} as const;

const ORACLES = {
  "01-01": "test/complete.test.ts::complete marks the todo done and rejects an unknown id",
  "01-02": "test/remove.test.ts::remove drops the todo and rejects an unknown id",
} as const;

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

/** The delivery roadmap, as ROADMAP proposes it: no facts, no oracle. */
const deliveryRoadmap = (symbolId: (path: string, name: string) => string): Roadmap => ({
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

/* ------------------------------------------------------------ the checkout */

const openProject = async () => {
  const root = mkdtempSync(join(tmpdir(), "dw-e2e-"));
  cpSync(TARGET, root, { recursive: true, filter: (source) => !source.endsWith("/.des") });
  // `tsc`, `biome` and `bun test` all resolve out of here.
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));

  const commands = await loadCommands(root);
  const vcs = openVcs({ root, commands });
  vcs.trackTree("src");

  const symbolId = (path: string, name: string): string => {
    const file = vcs.registry.file(path);
    const symbol = file === undefined ? undefined : vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`the copy has no ${path}::${name}`);
    return symbol.id;
  };

  return { root, vcs, commands, symbolId };
};

/* ------------------------------------------------------------- the journal */

/** One seeded decision, at the key `runStep` will compute for it. */
const seed = async (
  journal: Journal,
  def: StepDef<never, never>,
  input: unknown,
  result: StepResult<unknown>,
): Promise<void> => {
  await journal.put(journalKey(def as unknown as StepDef<unknown, unknown>, input), result);
};

/** The two roadmap leaves, for one request and one proposal. */
const seedRoadmapLeaves = async (
  journal: Journal,
  design: string,
  request: string,
  roadmap: Roadmap,
): Promise<void> => {
  const defs = roadmapDefs(models);
  await seed(
    journal,
    defs.decompose as never,
    DecomposeInput.parse({ request, design, defects: [], notSlices: [] }),
    {
      decision: "ok",
      output: { decision: "proposed", payload: { roadmap, rationale: "one row per value" } },
    } as StepResult<unknown>,
  );
  await seed(journal, defs["validate-slices"] as never, SlicesInput.parse({ roadmap, design }), {
    decision: "ok",
    output: {
      decision: "is-slice",
      payload: {
        verdicts: roadmap.steps.map((s) => ({
          stepId: s.id,
          verdict: "is-slice",
          anchor: s.observation,
        })),
        rationale: "each one is reachable through the store's own public surface",
      },
    },
  } as StepResult<unknown>);
};

/** DISTILL's one obligations leaf, over the roadmap as ROADMAP left it. */
const seedObligations = async (journal: Journal, rows: RoadmapRow[], design: string): Promise<void> => {
  const defs = obligationsDefs(models);
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
  await seed(journal, defs["propose-obligations"] as never, input, {
    decision: "ok",
    output: { decision: "proposed", payload: { values: MANIFEST, rationale: "stubbed" } },
  } as StepResult<unknown>);
};

/** DISTILL's author leaf, once per value. */
const seedAuthors = async (journal: Journal, rows: RoadmapRow[], design: string): Promise<void> => {
  const defs = oracleDefs(models);
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
    await seed(journal, defs["author-oracle"] as never, input, {
      decision: "ok",
      output: {
        decision: "authored",
        payload: {
          files: [{ path, body: ORACLE_BODIES[path] as string }],
          reason: "every obligation is falsified by one of the two assertions",
        },
      },
    } as StepResult<unknown>);
  }
};

/** The four DELIVER leaves a happy run reaches, per row. */
const HAPPY: Partial<Record<LeafId, string>> = {
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  commit: "committed",
};

const seedDeliver = async (
  journal: Journal,
  rows: RoadmapRow[],
  design: string,
  impactedOf: (symbolId: string) => string[],
): Promise<void> => {
  const defs = deliverDefs(models);
  for (const row of rows) {
    const step = stepUnderDelivery(row, design);
    const symbolId = row.predictedTouches[0] as string;
    const impacted = impactedOf(symbolId);
    for (const [leaf, decision] of Object.entries(HAPPY) as [LeafId, string][]) {
      // `implement` is the only leaf that runs BEFORE `wrote` is in state, so
      // it keys differently from the three after it.
      const wrote = leaf === "implement" ? undefined : symbolId;
      const input = LeafInput.parse({
        step,
        evidence: EVIDENCE,
        impacted,
        ...(wrote === undefined ? {} : { wrote }),
      });
      await seed(journal, defs[leaf] as never, input, {
        decision: "ok",
        output: {
          decision,
          payload: {
            anchor: EVIDENCE,
            rationale: "stubbed",
            symbolId,
            body: BODIES[row.id] as string,
            gap: "",
            extra: [] as string[],
          },
        },
      } as StepResult<unknown>);
    }
  }
};

/* ------------------------------------------------------------- the pre-bake */

/** Run one graph to its terminal, refusing anything that is not accepted. */
const runToAccepted = async (registry: Registry, id: string, input: unknown): Promise<string> => {
  const { runId } = startRun(registry, id, input);
  await registry.idle();
  const record = registry.runs.get(runId);
  if (record?.status === "suspended") return runId;
  if (record?.status !== "accepted") {
    throw new Error(`boot: ${id} ended ${String(record?.status)}: ${record?.error ?? ""}`);
  }
  return runId;
};

const main = async (): Promise<void> => {
  const port = Number(process.env["DES_E2E_PORT"] ?? 7331);
  const project = await openProject();
  const artifacts = openArtifacts();
  const rows = memoryJournal();
  const journal: Journal & { close: () => void } = { ...rows, close: () => {} };
  const design = designSource(project.root, project.vcs);

  const store = openRunDatabase();
  const dir: RunDir = {
    name: "e2e",
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
  const { workflows, pipelines } = todoRegistrations(dir, { evidence: () => EVIDENCE });

  const server = await serve({ port, workflows, pipelines, artifacts, store });
  const registry = server.registry;

  // ---- pre-bake, through the server's own registry ------------------------

  await seedRoadmapLeaves(journal, design, REQUEST, deliveryRoadmap(project.symbolId));
  const parked = await runToAccepted(registry, "roadmap", { request: REQUEST });
  resumeRun(registry, parked, { decision: "approve" });
  await registry.idle();

  const proposed = readRoadmap(artifacts, REQUEST);
  await seedObligations(journal, proposed, design);
  await runToAccepted(registry, "obligations", {});

  const enriched = readRoadmap(artifacts, REQUEST);
  await seedAuthors(journal, enriched, design);
  runPipeline(registry, "oracles");
  await registry.idle();

  const oracles = await getPipeline(registry, "oracles");
  if (!oracles.rows.every((row) => row.status === "accepted")) {
    throw new Error(`boot: an oracle was not measured red: ${JSON.stringify(oracles.rows)}`);
  }

  // The oracles are on disk now, so the impact graph can see them.
  project.vcs.trackTree("test");
  await seedDeliver(journal, readRoadmap(artifacts, REQUEST), design, (symbolId) =>
    project.vcs.impact.impactedTests([symbolId]).map((t) => t.id),
  );

  // ---- what the browser authors for itself --------------------------------

  await seedRoadmapLeaves(journal, design, BROWSER_REQUEST, BROWSER_ROADMAP);

  console.log(`e2e server ready on ${server.url}`);
  console.log(`project: ${project.root}`);

  const stop = async (): Promise<void> => {
    await server.stop();
    artifacts.close();
    project.vcs.close();
    rmSync(project.root, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
};

await main();
