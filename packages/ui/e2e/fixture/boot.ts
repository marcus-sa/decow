/**
 * The server the browser tests drive. Four graphs, two pipelines, no model.
 *
 * `bun run packages/ui/e2e/fixture/boot.ts` — Playwright starts it, waits for
 * the port, and stops it afterwards.
 *
 * EVERY LEAF IS SCRIPTED AT THE BINDING. `todoRegistrations` takes exactly one
 * thing — `models` — and this supplies scripted ones, so the output schema,
 * the mechanical checks and the validator all run for real while no model is
 * called and none could be. A leaf with no script refuses by name. Nothing
 * here has a credential and nothing here needs one.
 *
 * WHAT IS PRE-BAKED, AND WHY. The delivery pipeline is what the last test
 * drives, and a step is only deliverable once its oracle has been measured red
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
import type { ModelBinding } from "@des/core/step";
import { scriptedBinding, type ScriptedAnswer } from "@des/core/harness/scripted-binding";
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
import { leafStepId, type LeafId } from "../../../../examples/nwave/deliver/steps.ts";
import { readRoadmap } from "../../../../examples/nwave/deliver/pipeline.ts";
import type { Roadmap } from "../../../../examples/nwave/roadmap/schema.ts";
import { todoRegistrations } from "../../../../targets/todo/.des/registrations.ts";
import type { Models } from "../../../../targets/todo/.des/models.ts";
import {
  designSource,
  loadCommands,
  REPO,
  TARGET,
  type RunDir,
} from "../../../../targets/todo/.des/run-dir.ts";
import { BROWSER_REQUEST, BROWSER_ROADMAP, DELIVERY_REQUEST } from "./roadmaps.ts";

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
  request: DELIVERY_REQUEST,
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

  // The composition's declaration, loaded from `.des/` exactly as a run
  // directory loads it. The copy carries none; it is only where they run.
  const commands = await loadCommands();
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

/* -------------------------------------------------------------- the script */

/** The decision each DELIVER leaf of a happy run returns. */
const HAPPY: Partial<Record<LeafId, string>> = {
  implement: "written",
  "select-tests": "no-extra",
  refactor: "refactored",
  commit: "committed",
};

/** Which method each step rewrites, so `implement` can name a real symbol. */
const METHODS: Record<string, string> = { "01-01": "complete", "01-02": "remove" };

const STEP_IDS = ["01-01", "01-02"] as const;

/** The step a prompt is about. Every leaf's prompt names it; a model reads it too. */
const stepIn = (prompt: string): string => STEP_IDS.find((id) => prompt.includes(id)) ?? "01-01";

/** Per-step verdict rows that satisfy `validate-slices`'s own checks. */
const verdictsFor = (roadmap: Roadmap) =>
  roadmap.steps.map((step) => ({ stepId: step.id, verdict: "is-slice", anchor: step.observation }));

/**
 * The five roles, all answered by ONE scripted binding — the whole of what
 * this fixture injects into the composition.
 *
 * Which subject a call is about is on the PROMPT, exactly where the model it
 * stands in for would read it: the two roadmaps by their request, the two
 * delivery steps by their step id. Nothing here computes a journal key, and
 * nothing in `.des/` exists so that it could.
 */
const scriptedModels = (symbolFor: (stepId: string) => string): Models => {
  const binding: ModelBinding = scriptedBinding(({ step, prompt }): ScriptedAnswer[] | undefined => {
    if (step.id === "roadmap.decompose") {
      const roadmap = prompt.includes(BROWSER_REQUEST) ? BROWSER_ROADMAP : DELIVERY_ROADMAP();
      return [{ decision: "proposed", payload: { roadmap, rationale: "one step per value" } }];
    }
    if (step.id === "roadmap.validate-slices") {
      const roadmap = prompt.includes(BROWSER_REQUEST) ? BROWSER_ROADMAP : DELIVERY_ROADMAP();
      return [
        {
          decision: "is-slice",
          payload: {
            verdicts: verdictsFor(roadmap),
            rationale: "each one is reachable through the store's own public surface",
          },
        },
      ];
    }
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
    return [
      {
        decision,
        payload: {
          anchor: "",
          rationale: "stubbed",
          symbolId: symbolFor(stepId),
          body: BODIES[stepId] ?? "",
          gap: "",
          extra: [],
        },
      },
    ];
  });

  return {
    decompose: binding,
    authorOracle: binding,
    implement: binding,
    other: binding,
    validator: binding,
  };
};

/** The delivery roadmap, resolved once the project's symbols are known. */
let DELIVERY_ROADMAP: () => Roadmap = () => ({ request: DELIVERY_REQUEST, steps: [] });

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
  DELIVERY_ROADMAP = () => deliveryRoadmap(project.symbolId);
  const { workflows, pipelines } = todoRegistrations(dir, {
    models: scriptedModels((stepId) => project.symbolId("src/todo.ts", METHODS[stepId] ?? "")),
  });

  const server = await serve({ port, workflows, pipelines, artifacts, store });
  const registry = server.registry;

  // ---- pre-bake, through the server's own registry ------------------------

  // The roadmap's id is the request it is authored for, so everything after
  // this names it with the same string a person would pick off the list.
  const parked = await runToAccepted(registry, "roadmap", { request: DELIVERY_REQUEST });
  resumeRun(registry, parked, { decision: "approve" });
  await registry.idle();

  await runToAccepted(registry, "obligations", { roadmapId: DELIVERY_REQUEST });

  runPipeline(registry, "oracles", { roadmapId: DELIVERY_REQUEST });
  await registry.idle();

  const oracles = await getPipeline(registry, "oracles", { roadmapId: DELIVERY_REQUEST });
  if (!oracles.steps.every((step) => step.status === "accepted")) {
    throw new Error(`boot: an oracle was not measured red: ${JSON.stringify(oracles.steps)}`);
  }

  // The oracles are on disk now, so the impact graph can see them.
  project.vcs.trackTree("test");

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
