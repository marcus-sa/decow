/**
 * The HTTP surface, driven end to end on a real port.
 *
 * Port 0, so the OS picks one and two of these can run at once. No model: the
 * one leaf in the fixture answers from a stub journal, and its bindings throw
 * if anything reaches them. What is asserted is the thing a UI depends on —
 * that a run announces itself, reports the nodes it enters as it enters them,
 * parks with the closed enum a person has to choose from, refuses an answer
 * outside that enum by naming it, and continues the SAME run to a terminal.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openArtifacts } from "@des/core/artifacts";
import { memoryEffects } from "@des/core/effects";
import { openScheduler, type RowStatus } from "@des/core/scheduler";
import { run, type Workflow } from "@des/core/workflow";
import { serve, type Server } from "./index.ts";
import { registration, type PipelineRegistration } from "./registration.ts";
import type { ServerEvent } from "./events.ts";
import {
  ARTIFACT_TABLE,
  GateInput,
  gateGraph,
  gateJournal,
  gateSeed,
  type ClassifyDecision,
  type GateState,
} from "./fixture.ts";

let open: Server | undefined;
afterEach(async () => {
  await open?.stop();
  open = undefined;
});

/** A server over the gate graph, with a real artifact store behind it. */
const gateServer = async (decision: ClassifyDecision, subject: string) => {
  const artifacts = openArtifacts();
  const effects = memoryEffects({ store: artifacts });
  let minted = 0;
  const server = await serve({
    port: 0,
    mintId: () => `run-${(minted += 1)}`,
    artifacts,
    workflows: [
      registration<GateState, { subject: string }>({
        id: "gate",
        title: "A leaf, a person, and a row",
        input: GateInput,
        journal: gateJournal(decision, subject.slice(0, 4)),
        graph: (ctx) => gateGraph(ctx.journal, ctx.observe as never),
        seed: gateSeed,
        executor: () => effects.execute,
      }),
    ],
  });
  open = server;
  return { server, artifacts };
};

/**
 * A live reader of `/api/events`.
 *
 * Subscribed BEFORE anything is started, because the bus holds nothing: a
 * reader that arrives late reads the run's record for where it got to, and a
 * test that wants every event has to be there first.
 */
const listen = async (url: string) => {
  const response = await fetch(`${url}/api/events`);
  const body = response.body;
  if (body === null) throw new Error("the event stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen: ServerEvent[] = [];
  let buffer = "";

  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) seen.push(JSON.parse(data.slice(6)) as ServerEvent);
      }
    }
  })();

  /** Wait until an event the predicate accepts has arrived. */
  const until = async (accept: (event: ServerEvent) => boolean, what: string): Promise<ServerEvent> => {
    const deadline = 10_000;
    const started = performance.now();
    for (;;) {
      const hit = seen.find(accept);
      if (hit !== undefined) return hit;
      if (performance.now() - started > deadline) {
        throw new Error(`no ${what} within ${deadline}ms; saw ${seen.map((e) => e.type).join(", ")}`);
      }
      await Bun.sleep(5);
    }
  };

  return {
    seen,
    until,
    close: async () => {
      await reader.cancel();
      await pump;
    },
  };
};

describe("the HTTP surface", () => {
  test("every registered graph is listed with its authored projection", async () => {
    const { server } = await gateServer("ready", "ship the cut");
    const listed = (await (await fetch(`${server.url}/api/workflows`)).json()) as {
      id: string;
      title: string;
      graph: { start: string; nodes: { id: string; kind: string }[]; defects: string[] };
    }[];

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("gate");
    expect(listed[0]?.graph.start).toBe("classify");
    expect(listed[0]?.graph.defects).toEqual([]);
    expect(listed[0]?.graph.nodes.find((n) => n.id === "classify")?.kind).toBe("leaf");
  });

  test("a run announces itself, reports the nodes it enters, and reaches a terminal", async () => {
    const { server, artifacts } = await gateServer("ready", "ship the cut");
    const events = await listen(server.url);

    const started = (await (
      await fetch(`${server.url}/api/workflows/gate/runs`, {
        method: "POST",
        body: JSON.stringify({ subject: "ship the cut" }),
      })
    ).json()) as { runId: string };
    expect(started.runId).toBe("run-1");

    await events.until((e) => e.type === "terminal", "terminal");
    await server.runner.idle();

    const types = events.seen.map((e) => e.type);
    expect(types[0]).toBe("run-started");
    expect(types).toContain("node-entered");
    expect(types).toContain("node-left");
    expect(types.at(-1)).toBe("terminal");

    // The nodes reported are the ones the author wrote, in the order the run
    // reached them — which is the trace, arriving one event at a time.
    const entered = events.seen
      .filter((e): e is Extract<ServerEvent, { type: "node-entered" }> => e.type === "node-entered")
      .map((e) => e.node);
    expect(entered).toEqual(["classify", "classify.route", "persist", "accept"]);

    const record = (await (await fetch(`${server.url}/api/runs/run-1`)).json()) as {
      status: string;
      trace: { node: string; iteration: number }[];
      attempts: { stepId: string }[];
    };
    expect(record.status).toBe("accepted");
    expect(record.trace.map((t) => t.node)).toEqual(entered);
    expect(record.trace.every((t) => t.iteration === 1)).toBe(true);
    // Every leaf answered from the journal, so no model was called and no
    // attempt was made. Counting a replay as a call would make the number a
    // fiction.
    expect(record.attempts).toEqual([]);

    // And the step's one effect landed in the store the executor was built on.
    expect(artifacts.read(ARTIFACT_TABLE, "ship the cut")?.row).toEqual({
      subject: "ship the cut",
      anchor: "ship",
    });

    await events.close();
  });

  test("a suspension parks with its answer space, and the wrong answer is refused by name", async () => {
    const { server } = await gateServer("needs-a-person", "ship the cut");
    const events = await listen(server.url);

    await fetch(`${server.url}/api/workflows/gate/runs`, {
      method: "POST",
      body: JSON.stringify({ subject: "ship the cut" }),
    });
    await events.until((e) => e.type === "suspended", "suspension");

    const parked = (await (await fetch(`${server.url}/api/runs/run-1`)).json()) as {
      status: string;
      suspension: { node: string; reason: string; trail: unknown[]; resume: { options: string[] } };
    };
    expect(parked.status).toBe("suspended");
    expect(parked.suspension.node).toBe("ask");
    expect(parked.suspension.reason).toBe("a person decides");
    expect(parked.suspension.resume.options).toEqual(["approve", "reject"]);

    // An answer outside the closed enum is refused HERE, with the enum, rather
    // than three frames into a compiled step.
    const refused = await fetch(`${server.url}/api/runs/run-1/resume`, {
      method: "POST",
      body: JSON.stringify({ decision: "maybe" }),
    });
    expect(refused.status).toBe(400);
    const complaint = (await refused.json()) as { error: string; options: string[]; field: string };
    expect(complaint.error).toContain("approve, reject");
    expect(complaint.options).toEqual(["approve", "reject"]);
    expect(complaint.field).toBe("decision");

    // Refusing it changed nothing: the run is still parked on the same node.
    const still = (await (await fetch(`${server.url}/api/runs/run-1`)).json()) as { status: string };
    expect(still.status).toBe("suspended");

    await events.close();
  });

  test("an answer from the enum continues the SAME run to accepted", async () => {
    const { server, artifacts } = await gateServer("needs-a-person", "ship the cut");
    const events = await listen(server.url);

    await fetch(`${server.url}/api/workflows/gate/runs`, {
      method: "POST",
      body: JSON.stringify({ subject: "ship the cut" }),
    });
    await events.until((e) => e.type === "suspended", "suspension");

    const answered = await fetch(`${server.url}/api/runs/run-1/resume`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", notes: "looks right" }),
    });
    expect(answered.status).toBe(200);

    await events.until((e) => e.type === "terminal", "terminal");
    await server.runner.idle();

    const record = (await (await fetch(`${server.url}/api/runs/run-1`)).json()) as {
      status: string;
      trace: { node: string }[];
    };
    expect(record.status).toBe("accepted");
    // One run, spanning both halves: the trace carries what happened before the
    // person and what happened after.
    expect(record.trace.map((t) => t.node)).toEqual([
      "classify",
      "classify.route",
      "ask",
      "ask.route",
      "persist",
      "accept",
    ]);
    expect(events.seen.map((e) => e.type)).toContain("resumed");
    expect(artifacts.read(ARTIFACT_TABLE, "ship the cut")).toBeDefined();

    await events.close();
  });

  test("a run that is not parked has nothing to answer, and says so", async () => {
    const { server } = await gateServer("ready", "ship the cut");
    await fetch(`${server.url}/api/workflows/gate/runs`, {
      method: "POST",
      body: JSON.stringify({ subject: "ship the cut" }),
    });
    await server.runner.idle();

    const refused = await fetch(`${server.url}/api/runs/run-1/resume`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("accepted");
  });

  test("input that does not parse is refused before a run exists", async () => {
    const { server } = await gateServer("ready", "ship the cut");
    const refused = await fetch(`${server.url}/api/workflows/gate/runs`, {
      method: "POST",
      body: JSON.stringify({ subject: "" }),
    });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    expect((await (await fetch(`${server.url}/api/runs`)).json()) as unknown[]).toEqual([]);
  });

  test("artifact rows are readable by table, by id, and at a past version", async () => {
    const { server, artifacts } = await gateServer("ready", "ship the cut");
    artifacts.upsert({ table: "notes", id: "n1", expectedVersion: 0, row: { text: "first" } });
    artifacts.upsert({ table: "notes", id: "n1", expectedVersion: 1, row: { text: "second" } });

    const listed = (await (await fetch(`${server.url}/api/artifacts/notes`)).json()) as {
      rows: { id: string; version: number; row: unknown }[];
    };
    expect(listed.rows).toEqual([{ id: "n1", version: 2, row: { text: "second" } }]);

    const latest = (await (await fetch(`${server.url}/api/artifacts/notes/n1`)).json()) as {
      version: number;
      row: { text: string };
    };
    expect(latest).toMatchObject({ version: 2, row: { text: "second" } });

    const past = (await (await fetch(`${server.url}/api/artifacts/notes/n1?version=1`)).json()) as {
      row: { text: string };
    };
    expect(past.row).toEqual({ text: "first" });

    expect((await fetch(`${server.url}/api/artifacts/notes/nope`)).status).toBe(404);
  });

  test("an unknown workflow, run, and route are each refused by name", async () => {
    const { server } = await gateServer("ready", "x");
    expect((await fetch(`${server.url}/api/workflows/nope/runs`, { method: "POST", body: "{}" })).status).toBe(404);
    expect((await fetch(`${server.url}/api/runs/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
  });
});

/* ---------------------------------------------------------- the pipeline */

/** Two rows, B after A, each one a run of a graph that accepts immediately. */
const twoRows = (): PipelineRegistration => {
  const statuses = new Map<string, RowStatus>();
  const runIds = new Map<string, string>();
  const rows = [
    { id: "a", dependencies: [] as string[], description: "the first row" },
    { id: "b", dependencies: ["a"], description: "the row that waits" },
  ];

  const trivial: Workflow<{ row: string }> = {
    start: "accept",
    nodes: { accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) } },
  };
  const effects = memoryEffects();

  const scheduler = openScheduler<{ row: string }>({
    rows,
    concurrency: 1,
    runOne: async (row) => await run(trivial, { row: row.id }, effects.execute),
    resumeOne: async () => {
      throw new Error("this pipeline parks for nobody");
    },
    statusOf: async (id) => statuses.get(id) ?? "pending",
    record: async (id, outcome) => {
      statuses.set(id, outcome.kind === "suspended" ? "suspended" : outcome.terminal.kind);
      runIds.set(id, outcome.runId);
    },
  });

  return {
    id: "two-rows",
    title: "A roadmap of two",
    rows: () => rows.map((row) => ({ ...row, workflowId: "gate", runId: runIds.get(row.id) })),
    status: (id) => statuses.get(id) ?? "pending",
    run: async () => {
      await scheduler.run();
    },
    resume: async (id, answer) => {
      await scheduler.resume(id, answer);
    },
  };
};

describe("a registered pipeline", () => {
  test("its run tree is rows plus the status each one projects", async () => {
    const server = await serve({
      port: 0,
      workflows: [],
      pipelines: [twoRows()],
      pipelinePollMs: 10,
    });
    open = server;
    const events = await listen(server.url);

    const before = (await (await fetch(`${server.url}/api/pipelines/two-rows`)).json()) as {
      rows: { id: string; status: string; dependencies: string[] }[];
    };
    expect(before.rows.map((r) => [r.id, r.status])).toEqual([
      ["a", "pending"],
      ["b", "pending"],
    ]);
    expect(before.rows[1]?.dependencies).toEqual(["a"]);

    const started = await fetch(`${server.url}/api/pipelines/two-rows/run`, { method: "POST" });
    expect(started.status).toBe(200);

    await events.until(
      (e) => e.type === "pipeline-row" && e.rowId === "b" && e.status === "accepted",
      "b accepted",
    );

    const after = (await (await fetch(`${server.url}/api/pipelines/two-rows`)).json()) as {
      rows: { id: string; status: string; runId?: string }[];
    };
    expect(after.rows.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    // Each row's run drills into a run of its own, which is what the tree is
    // for: the id is on the row.
    expect(after.rows.every((r) => typeof r.runId === "string")).toBe(true);

    await events.close();
  });

  test("an unknown pipeline is refused by name", async () => {
    const server = await serve({ port: 0, workflows: [], pipelines: [twoRows()] });
    open = server;
    expect((await fetch(`${server.url}/api/pipelines/nope`)).status).toBe(404);
  });
});
