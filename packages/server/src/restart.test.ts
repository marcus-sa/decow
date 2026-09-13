/**
 * A run outlives the process that started it.
 *
 * This is the claim the three tables exist for, and it is the one the previous
 * cut could not make: runs, traces, attempts and the row-to-run mapping lived
 * in maps, so a restarted server showed no prior run, a delivered pipeline row
 * read `pending` again, and a suspension nobody had answered yet could not be
 * answered at all — the engine's snapshot was on disk and the server had
 * forgotten which graph it was of.
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
import { serve, type Server } from "./index.ts";
import { getPipeline, getRun, listRuns, resumeRun, runPipeline, startRun } from "./api.ts";
import { registration } from "./registration.ts";
import { openRunDatabase } from "./store.ts";
import { ARTIFACT_TABLE, gateGraph, gateJournal, GateInput, gateSeed } from "./fixture.ts";

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
    title: "a leaf, a person, and a row",
    input: GateInput,
    // `needs-a-person` every time, so the run parks and a person is what
    // continues it.
    graph: (ctx) => gateGraph(ctx.journal, ctx.observe),
    seed: gateSeed,
    executor: () => memoryEffects({ store: artifacts }).execute,
    journal: gateJournal("needs-a-person", "alph"),
  });

  const server = await serve({
    port: 0,
    workflows: [gate],
    pipelines: [
      {
        id: "gates",
        title: "one row, one gate",
        rows: () => [
          { id: "row-1", dependencies: [], workflowId: "gate", input: { subject: "alphabet" } },
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
    // A journal HIT reports no attempt, because no model was called — which
    // is what makes a count of attempt rows a count of INFERENCE.
    expect(parked.attempts).toEqual([]);

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

  test("a pipeline row that was delivered stays delivered", async () => {
    // The row-to-run mapping is read off the `pipeline-row` events rather than
    // held in a map, which is what stops a restarted server running a row a
    // second time. Without it `statusOf` reads `pending` and the frontier
    // re-delivers everything the previous process finished.
    const dir = runDirectory();

    const first = await boot(dir);
    runPipeline(first.registry, "gates");
    await first.registry.idle();

    const before = await getPipeline(first.registry, "gates");
    expect(before.rows.map((row) => row.status)).toEqual(["suspended"]);
    const rowRun = before.rows[0]?.runId;
    expect(rowRun).toBeDefined();
    resumeRun(first.registry, rowRun as string, { decision: "approve" });
    await first.registry.idle();
    expect((await getPipeline(first.registry, "gates")).rows[0]?.status).toBe("accepted");
    await first.stop();

    const second = await boot(dir);
    const after = await getPipeline(second.registry, "gates");
    expect(after.rows.map((row) => row.status)).toEqual(["accepted"]);
    expect(after.rows[0]?.runId).toBe(rowRun as string);

    // Driving it again starts nothing: the row is accepted, so the frontier
    // is empty and no second run exists.
    runPipeline(second.registry, "gates");
    await second.registry.idle();
    expect(listRuns(second.registry)).toHaveLength(1);
  }, 30_000);
});
