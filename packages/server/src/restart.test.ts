/**
 * A run outlives the process that started it.
 *
 * This is the claim the three tables exist for. With runs, traces, attempts
 * and the step-to-run mapping in maps, a restarted server shows no prior run,
 * a delivered pipeline step reads `pending` again, and a suspension nobody has
 * answered yet cannot be answered at all — the engine's snapshot is on disk
 * and the server has forgotten which graph it is of.
 *
 * So the test is the whole loop through the real `serve()`, twice, over ONE
 * directory: start a run, park it for a person, stop the server, start a second
 * one on the same `runs.sqlite` and the same libSQL snapshot file, read the
 * parked run back, answer it, and reach `accepted`.
 *
 * It is a real `serve()` rather than a registry, because `serve` is what sets
 * the module-scope slot and what stops. The UI need not be built: `uiHandler`
 * answers 503 when it is not, which is a response and not a failure to start.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifacts } from "@des/core/artifacts";
import { memoryEffects } from "@des/core/effects";
import { sqliteJournal } from "@des/core/journal";
import { serve, type Server } from "./index.ts";
import { getPipeline, getRun, listRuns, resumeRun, runPipeline, startRun } from "./api.ts";
import { registration } from "./registration.ts";
import { openRunDatabase } from "./store.ts";
import { ARTIFACT_TABLE, gateGraph, gateModels, GateInput, gateSeed } from "./fixture.ts";

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory that holds both durable things a run needs. */
const runDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dw-restart-"));
  dirs.push(dir);
  return dir;
};

/**
 * One server over one directory. Every call opens its OWN handles — a second
 * `openRunDatabase` on the same file, a second libSQL runtime on the same
 * snapshot — because that is what a restart is.
 */
const boot = async (dir: string): Promise<Server> => {
  const store = openRunDatabase({ path: join(dir, "runs.sqlite") });
  const artifacts = openArtifacts({ path: join(dir, "artifacts.sqlite") });
  const gate = registration({
    id: "gate",
    title: "a leaf, a person, and a step",
    input: GateInput,
    // `needs-a-person` every time, so the run parks and a person is what
    // continues it.
    graph: (ctx) => gateGraph(ctx.journal, gateModels("needs-a-person", "alph"), ctx.observe),
    seed: gateSeed,
    executor: () => memoryEffects({ store: artifacts }).execute,
    // A real journal on a real file, so the second process replays what the
    // first decided rather than calling the binding again.
    journal: sqliteJournal(join(dir, "journal.sqlite")),
  });

  const server = await serve({
    port: 0,
    workflows: [gate],
    pipelines: [
      {
        id: "gates",
        title: "one step, one gate",
        steps: () => [
          { id: "step-1", dependencies: [], workflowId: "gate", input: { subject: "alphabet" } },
        ],
      },
    ],
    artifacts,
    store,
    runtimeUrl: `file:${join(dir, "mastra.sqlite")}`,
  });
  servers.push(server);
  return server;
};

describe("a restarted server", () => {
  test("shows the runs its predecessor started, and answers the suspension it left", async () => {
    const dir = runDirectory();

    /* ---- the first process ------------------------------------------- */

    const first = await boot(dir);
    const { runId } = startRun(first.registry, "gate", { subject: "alphabet" });
    await first.registry.idle();

    const parked = getRun(first.registry, runId);
    expect(parked.status).toBe("suspended");
    expect(parked.suspension?.node).toBe("ask");
    expect(parked.trace.map((entry) => entry.node)).toEqual(["classify", "classify.route", "ask"]);
    // The leaf ran for real — worker, mechanical check, validator — because it
    // is stubbed at the BINDING, so there is an attempt row to survive rather
    // than only a status.
    expect(parked.attempts.map((a) => `${a.stepId}:${a.attempt}:${a.accepted}`)).toEqual([
      "fixture.classify:1:true",
    ]);

    const engineRunId = parked.engineRunId;
    expect(engineRunId).toBeDefined();
    await first.stop();

    /* ---- the second ---------------------------------------------------- */

    const second = await boot(dir);
    expect(second.registry).not.toBe(first.registry);

    // Every prior run is there, with everything the first process recorded.
    expect(listRuns(second.registry).map((r) => `${r.runId}:${r.status}`)).toEqual([
      `${runId}:suspended`,
    ]);
    const reread = getRun(second.registry, runId);
    expect(reread.engineRunId).toBe(engineRunId as string);
    expect(reread.input).toEqual({ subject: "alphabet" });
    expect(reread.trace.map((entry) => entry.node)).toEqual(["classify", "classify.route", "ask"]);
    expect(reread.attempts.map((a) => a.stepId)).toEqual(["fixture.classify"]);
    // And the closed enum a person answers from, read off the parked node.
    expect(reread.suspension?.resume?.options).toEqual(["approve", "reject"]);

    // The answer goes to the SAME run, in a process that never started it.
    resumeRun(second.registry, runId, { decision: "approve" });
    await second.registry.idle();

    const done = getRun(second.registry, runId);
    expect(done.status).toBe("accepted");
    expect(done.trace.map((entry) => entry.node)).toEqual([
      "classify",
      "classify.route",
      "ask",
      "ask.route",
      "persist",
      "accept",
    ]);
    // The effect the second half asked for landed in the artifact store the
    // second process opened on the same file.
    expect(second.registry.artifacts?.read(ARTIFACT_TABLE, "alphabet")?.row).toEqual({
      subject: "alphabet",
      anchor: "alph",
    });
  }, 30_000);

  test("a pipeline step that was delivered stays delivered", async () => {
    // The step-to-run mapping is read off the `pipeline-step` events rather
    // than held in a map, which is what stops a restarted server running a
    // step a second time. Without it `statusOf` reads `pending` and the
    // frontier re-delivers everything the last process finished.
    const dir = runDirectory();

    const first = await boot(dir);
    runPipeline(first.registry, "gates");
    await first.registry.idle();

    const before = await getPipeline(first.registry, "gates");
    expect(before.steps.map((step) => step.status)).toEqual(["suspended"]);
    const stepRun = before.steps[0]?.runId;
    expect(stepRun).toBeDefined();
    resumeRun(first.registry, stepRun as string, { decision: "approve" });
    await first.registry.idle();
    expect((await getPipeline(first.registry, "gates")).steps[0]?.status).toBe("accepted");
    await first.stop();

    const second = await boot(dir);
    const after = await getPipeline(second.registry, "gates");
    expect(after.steps.map((step) => step.status)).toEqual(["accepted"]);
    expect(after.steps[0]?.runId).toBe(stepRun as string);

    // Driving it again starts nothing: the step is accepted, so the frontier
    // is empty and no second run exists.
    runPipeline(second.registry, "gates");
    await second.registry.idle();
    expect(listRuns(second.registry)).toHaveLength(1);
  }, 30_000);
});
