/**
 * Everything the UI can ask for, driven directly.
 *
 * These are the bodies `@des/ui` wraps in `createServerFn`, so driving them
 * here is driving what a browser reaches, minus the RPC. No model: the one
 * leaf in the fixture answers from a scripted binding.
 *
 * What is asserted is the thing a UI depends on — that a run announces itself,
 * reports the nodes it enters as it enters them, parks with the closed enum a
 * person has to choose from, refuses an answer outside that enum by NAMING it,
 * and continues the SAME run to a terminal — plus the pipeline half: that a
 * pipeline's steps are ordinary runs of registered graphs, driven by the
 * server's own scheduler, each with a run id, a trace and a suspension a
 * person answers in the same place.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { openArtifacts } from "@des/core/artifacts";
import { memoryEffects } from "@des/core/effects";
import { memoryJournal } from "@des/core/journal";
import type { RunOutcome } from "@des/core/workflow";
import {
  exportRun,
  getPipeline,
  getRun,
  getWorkflow,
  listPipelines,
  listRuns,
  listWorkflows,
  readArtifacts,
  RefusedAnswer,
  resumeStep,
  resumeRun,
  runPipeline,
  startRun,
} from "./api.ts";
import type { ServerEvent } from "./events.ts";
import {
  ARTIFACT_TABLE,
  busyGraph,
  GateInput,
  gateGraph,
  gateModels,
  gateSeed,
  overlapTracker,
  type BusyState,
  type ClassifyDecision,
  type GateState,
} from "./fixture.ts";
import { openRegistry, type Registry } from "./registry.ts";
import { pipeline, registration, type PipelineStep } from "./registration.ts";

/* ------------------------------------------------------------- the registry */

/** A registry over the gate graph, with a real artifact store behind it. */
const gateRegistry = (decision: ClassifyDecision, subject: string) => {
  const artifacts = openArtifacts();
  const effects = memoryEffects({ store: artifacts });
  let minted = 0;
  const registry = openRegistry({
    mintId: () => `run-${(minted += 1)}`,
    artifacts,
    workflows: [
      registration<GateState, { subject: string }>({
        id: "gate",
        title: "A leaf, a person, and a step",
        input: GateInput,
        journal: memoryJournal(),
        graph: (ctx) =>
          gateGraph(ctx.journal, gateModels(decision, subject.slice(0, 4)), ctx.observe as never),
        seed: gateSeed,
        executor: () => effects.execute,
      }),
    ],
  });
  return { registry, artifacts };
};

/** Every event the bus published, from before anything started. */
const listen = (registry: Registry) => {
  const seen: ServerEvent[] = [];
  const stop = registry.events.subscribe((event) => seen.push(event));
  return { seen, stop };
};

describe("the graphs, and one run of one", () => {
  test("every registered graph is listed with its authored projection and its input schema", () => {
    const { registry } = gateRegistry("ready", "ship the cut");
    const listed = listWorkflows(registry);

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("gate");
    expect(listed[0]?.graph.start).toBe("classify");
    expect(listed[0]?.graph.defects).toEqual([]);
    expect(listed[0]?.graph.nodes.find((n) => n.id === "classify")?.kind).toBe("leaf");
    // The schema is the REGISTRATION's, and it travels as JSON Schema because
    // a browser cannot hold a zod type.
    expect(listed[0]?.input).toMatchObject({ properties: { subject: { type: "string" } } });
    expect(getWorkflow(registry, "gate").id).toBe("gate");
    expect(() => getWorkflow(registry, "nope")).toThrow(/no workflow nope/);
  });

  test("a run announces itself, reports the nodes it enters, and reaches a terminal", async () => {
    const { registry, artifacts } = gateRegistry("ready", "ship the cut");
    const events = listen(registry);

    const { runId } = startRun(registry, "gate", { subject: "ship the cut" });
    expect(runId).toBe("run-1");
    await registry.idle();

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

    const record = getRun(registry, "run-1");
    expect(record.status).toBe("accepted");
    expect(record.trace.map((t) => t.node)).toEqual(entered);
    expect(record.trace.every((t) => t.iteration === 1)).toBe(true);
    // The leaf ran for real against a scripted binding — worker, mechanical
    // check, validator — so the attempt seam reported one attempt, accepted.
    // A journal HIT would report none, because no model would be called.
    expect(record.attempts.map((a) => `${a.stepId}:${a.attempt}:${a.verdict}`)).toEqual([
      "fixture.classify:1:pass",
    ]);
    expect(record.attempts[0]?.accepted).toBe(true);

    // And the step's one effect landed in the store the executor was built on.
    expect(artifacts.read(ARTIFACT_TABLE, "ship the cut")?.row).toEqual({
      subject: "ship the cut",
      anchor: "ship",
    });

    expect(listRuns(registry).map((r) => r.runId)).toEqual(["run-1"]);
    events.stop();
  });

  test("a suspension parks with its answer space, and the wrong answer is refused by name", async () => {
    const { registry } = gateRegistry("needs-a-person", "ship the cut");
    startRun(registry, "gate", { subject: "ship the cut" });
    await registry.idle();

    const parked = getRun(registry, "run-1");
    expect(parked.status).toBe("suspended");
    expect(parked.suspension?.node).toBe("ask");
    expect(parked.suspension?.reason).toBe("a person decides");
    expect(parked.suspension?.resume?.options).toEqual(["approve", "reject"]);

    // An answer outside the closed enum is refused HERE, with the enum, rather
    // than three frames into a compiled step.
    let refused: unknown;
    try {
      resumeRun(registry, "run-1", { decision: "maybe" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(RefusedAnswer);
    expect((refused as RefusedAnswer).message).toContain("approve, reject");
    expect((refused as RefusedAnswer).options).toEqual(["approve", "reject"]);
    expect((refused as RefusedAnswer).field).toBe("decision");

    // Refusing it changed nothing: the run is still parked on the same node.
    expect(getRun(registry, "run-1").status).toBe("suspended");
  });

  test("an answer from the enum continues the SAME run to accepted", async () => {
    const { registry, artifacts } = gateRegistry("needs-a-person", "ship the cut");
    const events = listen(registry);
    startRun(registry, "gate", { subject: "ship the cut" });
    await registry.idle();

    expect(resumeRun(registry, "run-1", { decision: "approve", notes: "looks right" })).toEqual({
      runId: "run-1",
      status: "running",
    });
    await registry.idle();

    const record = getRun(registry, "run-1");
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
    events.stop();
  });

  test("one run exports as JSON lines: the run, its attempts, then its events", async () => {
    // A read of the rows rather than a second writer beside them. A file
    // written as a run happens cannot attribute its token columns; the rows
    // can, so the export is a projection of them.
    const { registry } = gateRegistry("ready", "ship the cut");
    startRun(registry, "gate", { subject: "ship the cut" });
    await registry.idle();

    const lines = exportRun(registry, "run-1")
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; event?: string });
    expect(lines[0]).toMatchObject({ kind: "run", runId: "run-1", status: "accepted" });
    // The run line carries the record WITHOUT the two projections, because
    // both are derivable from the lines after it.
    expect(lines[0]).not.toHaveProperty("trace");
    expect(lines[0]).not.toHaveProperty("attempts");
    expect(lines.slice(1).map((line) => line.event ?? line.kind)).toEqual([
      // Every attempt first, then every event, so the costly half of a run is
      // at the top of the document rather than scattered through it.
      "leaf-attempt",
      "run-started",
      "node-entered",
      "leaf-attempt",
      "node-left",
      "node-entered",
      "node-left",
      "node-entered",
      "node-left",
      "node-entered",
      "node-left",
      "terminal",
    ]);
  });

  test("a run that is not parked has nothing to answer, and says so", async () => {
    const { registry } = gateRegistry("ready", "ship the cut");
    startRun(registry, "gate", { subject: "ship the cut" });
    await registry.idle();
    expect(() => resumeRun(registry, "run-1", { decision: "approve" })).toThrow(/is accepted/);
  });

  test("input that does not parse is refused before a run exists", () => {
    const { registry } = gateRegistry("ready", "ship the cut");
    expect(() => startRun(registry, "gate", { subject: "" })).toThrow(/does not parse/);
    expect(listRuns(registry)).toEqual([]);
  });

  test("an unknown workflow and an unknown run are each refused by name", () => {
    const { registry } = gateRegistry("ready", "x");
    expect(() => startRun(registry, "nope", {})).toThrow(/no workflow nope/);
    expect(() => getRun(registry, "nope")).toThrow(/no run nope/);
  });
});

describe("the artifact rows", () => {
  test("readable by table, by id, and at a past version", () => {
    const { registry, artifacts } = gateRegistry("ready", "ship the cut");
    artifacts.upsert({ table: "notes", id: "n1", expectedVersion: 0, row: { text: "first" } });
    artifacts.upsert({ table: "notes", id: "n1", expectedVersion: 1, row: { text: "second" } });

    expect(readArtifacts(registry, { table: "notes" })).toEqual({
      table: "notes",
      rows: [{ id: "n1", version: 2, row: { text: "second" } }],
    });
    expect(readArtifacts(registry, { table: "notes", id: "n1" })).toMatchObject({
      version: 2,
      row: { text: "second" },
    });
    expect(readArtifacts(registry, { table: "notes", id: "n1", version: 1 })).toMatchObject({
      row: { text: "first" },
    });
    expect(() => readArtifacts(registry, { table: "notes", id: "nope" })).toThrow(/no notes\/nope/);
  });

  test("a server with no artifact store says so rather than answering with nothing", () => {
    const registry = openRegistry({ workflows: [] });
    expect(() => readArtifacts(registry, { table: "notes" })).toThrow(/registered no artifact store/);
  });
});

/* ---------------------------------------------------------- the pipelines */

/** What a pipeline recorded, in the order it recorded it. */
type Recorded = { stepId: string; kind: string; runId: string; tag?: string };

/**
 * Two steps, B after A, each one an ordinary run of the gate graph.
 *
 * The registration is DATA plus two hooks: the steps it declares, whether a step
 * may run, and what to do when one finishes. Nothing here runs anything.
 */
const twoSteps = (options: {
  decision?: ClassifyDecision;
  readiness?: (stepId: string) => boolean;
  recorded?: Recorded[];
} = {}) => {
  const artifacts = openArtifacts();
  const effects = memoryEffects({ store: artifacts });
  const recorded = options.recorded ?? [];
  let minted = 0;

  const steps: PipelineStep[] = [
    // Both subjects carry `alph`, because the leaf's anchor check is
    // mechanical and runs for real: one script answers two steps only when its
    // anchor is a verbatim substring of both.
    { id: "a", dependencies: [], description: "the first step", workflowId: "gate", input: { subject: "alpha" } },
    { id: "b", dependencies: ["a"], description: "the step that waits", workflowId: "gate", input: { subject: "alpha bravo" } },
  ];

  // These two steps are FIXED, so the input names nothing they are derived
  // from. It is a tag, so a test can tell one drive of this pipeline from
  // another — which is what the hooks being handed the input is for.
  const registered = pipeline({
    id: "two-steps",
    title: "A pipeline of two",
    input: z.object({ tag: z.string().optional() }),
    steps: () => steps,
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    record: (stepId, outcome: RunOutcome<unknown>, input) => {
      recorded.push({
        stepId,
        kind: outcome.kind === "suspended" ? "suspended" : outcome.terminal.kind,
        runId: outcome.runId,
        ...(input.tag === undefined ? {} : { tag: input.tag }),
      });
    },
    concurrency: 1,
  });

  const registry = openRegistry({
    mintId: () => `run-${(minted += 1)}`,
    artifacts,
    workflows: [
      registration<GateState, { subject: string }>({
        id: "gate",
        title: "A leaf, a person, and a step",
        input: GateInput,
        journal: memoryJournal(),
        graph: (ctx) =>
          gateGraph(ctx.journal, gateModels(options.decision ?? "ready", "alph"), ctx.observe as never),
        seed: gateSeed,
        executor: () => effects.execute,
      }),
    ],
    pipelines: [registered],
  });

  return { registry, artifacts, recorded, steps };
};

describe("a registered pipeline", () => {
  test("its steps are declarations, and its tree is those steps plus what the server knows", async () => {
    const { registry } = twoSteps();
    expect(listPipelines(registry)).toEqual([{ id: "two-steps", title: "A pipeline of two" }]);

    const before = await getPipeline(registry, "two-steps", {});
    expect(before.steps.map((r) => [r.id, r.status])).toEqual([
      ["a", "pending"],
      ["b", "pending"],
    ]);
    expect(before.steps[1]?.dependencies).toEqual(["a"]);
    expect(before.steps.every((r) => r.runId === undefined)).toBe(true);
    expect(() => getPipeline(registry, "nope", {})).toThrow(/no pipeline nope/);
    // And an input the pipeline's own schema refuses never reaches its steps.
    await expect(getPipeline(registry, "two-steps", "not an object")).rejects.toThrow(
      /does not parse/,
    );
  });

  test("every step runs through the runner, so every step has a run, a trace and events", async () => {
    const { registry, recorded } = twoSteps();
    const events = listen(registry);

    expect(runPipeline(registry, "two-steps", {})).toEqual({ id: "two-steps", started: true });
    await registry.idle();

    const after = await getPipeline(registry, "two-steps", {});
    expect(after.steps.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(after.error).toBeUndefined();

    // A step's run is an ordinary run: it is in the run list, it has a trace
    // through the authored nodes, and the step links to it by id.
    for (const step of after.steps) {
      expect(step.runId).toBeDefined();
      const record = getRun(registry, step.runId as string);
      expect(record.workflowId).toBe("gate");
      expect(record.status).toBe("accepted");
      expect(record.trace.map((t) => t.node)).toEqual([
        "classify",
        "classify.route",
        "persist",
        "accept",
      ]);
    }
    expect(listRuns(registry)).toHaveLength(2);

    // B ran after A, and only because A read `accepted`.
    expect(recorded.map((r) => `${r.stepId}:${r.kind}`)).toEqual(["a:accepted", "b:accepted"]);
    // The consumer's own record carries the run id, so its durable row and the
    // run a person watched are the same thing.
    expect(recorded[0]?.runId).toBeDefined();

    // And the steps were announced as they moved.
    const moved = events.seen.filter(
      (e): e is Extract<ServerEvent, { type: "pipeline-step" }> => e.type === "pipeline-step",
    );
    expect(moved.map((e) => `${e.stepId}:${e.status}`)).toEqual([
      "a:pending",
      "a:accepted",
      "b:pending",
      "b:accepted",
    ]);
    expect(moved.every((e) => e.runId !== undefined)).toBe(true);
    events.stop();
  });

  test("a second drive while one is going starts no second", async () => {
    const { registry } = twoSteps();
    expect(runPipeline(registry, "two-steps", {}).started).toBe(true);
    expect(runPipeline(registry, "two-steps", {}).started).toBe(false);
    await registry.idle();
    expect(listRuns(registry)).toHaveLength(2);
  });

  test("a parked step is answered on its own run, and the frontier moves when it settles", async () => {
    // The whole point of the move: the step's suspension IS a run's suspension,
    // so the dialog that answers a standalone run answers a step.
    const { registry, recorded } = twoSteps({ decision: "needs-a-person" });
    runPipeline(registry, "two-steps", {});
    await registry.idle();

    const parked = await getPipeline(registry, "two-steps", {});
    expect(parked.steps.map((r) => r.status)).toEqual(["suspended", "pending"]);
    const runId = parked.steps[0]?.runId as string;
    expect(getRun(registry, runId).suspension?.resume?.options).toEqual(["approve", "reject"]);

    // The answer is refused by name here too: one resume, one closed enum.
    expect(() => resumeStep(registry, "two-steps", "a", { decision: "maybe" })).toThrow(
      /must be one of approve, reject/,
    );

    expect(resumeStep(registry, "two-steps", "a", { decision: "approve" })).toEqual({ runId });
    await registry.idle();

    const after = await getPipeline(registry, "two-steps", {});
    expect(after.steps.map((r) => r.status)).toEqual(["accepted", "suspended"]);
    // A's run carries both halves, and B only started because A was accepted.
    expect(getRun(registry, runId).trace.map((t) => t.node)).toContain("ask");
    expect(recorded.map((r) => `${r.stepId}:${r.kind}`)).toEqual([
      "a:suspended",
      "a:accepted",
      "b:suspended",
    ]);
  });

  test("a step parked under one drive continues under that drive's own input", async () => {
    // The input rides on the event that ATTACHED the run, so answering a
    // suspension re-evaluates the frontier THAT drive computed rather than
    // whichever input the pipeline happened to be driven with most recently.
    const { registry, recorded } = twoSteps({ decision: "needs-a-person" });
    runPipeline(registry, "two-steps", { tag: "first" });
    await registry.idle();
    expect(recorded.map((r) => `${r.stepId}:${r.tag}`)).toEqual(["a:first"]);

    // A second drive, with a different input. `a` is parked and `b` waits on
    // it, so the frontier is empty and this starts nothing.
    runPipeline(registry, "two-steps", { tag: "second" });
    await registry.idle();
    expect(recorded).toHaveLength(1);

    resumeStep(registry, "two-steps", "a", { decision: "approve" });
    await registry.idle();

    // Both halves of `a`, and the `b` its acceptance let through, under the
    // input `a` was started with.
    expect(recorded.map((r) => `${r.stepId}:${r.tag}`)).toEqual([
      "a:first",
      "a:first",
      "b:first",
    ]);
  });

  test("a step nobody has cannot be answered, and says so", async () => {
    const { registry } = twoSteps();
    expect(() => resumeStep(registry, "two-steps", "a", { decision: "approve" })).toThrow(
      /has no run/,
    );
  });

  test("an ineligible step never becomes ready, and it blocks its dependents", async () => {
    // The precondition the frontier rule cannot express. A consumer's might be
    // "this step's oracle has been measured red"; here it is a flag, and the
    // shape is the same: nothing downstream of a step that may not run becomes
    // ready.
    const { registry } = twoSteps({ readiness: (stepId) => stepId !== "a" });
    runPipeline(registry, "two-steps", {});
    await registry.idle();

    const after = await getPipeline(registry, "two-steps", {});
    expect(after.steps.map((r) => r.status)).toEqual(["pending", "pending"]);
    // Nothing ran at all: the fixture's model bindings throw, so reaching a
    // leaf would have failed this.
    expect(listRuns(registry)).toEqual([]);
  });
});

describe("a declared resource serializes two steps", () => {
  /** Two independent steps of a graph slow enough for them to overlap. */
  const twoBusySteps = (resourcesFor?: (step: PipelineStep) => string[]) => {
    const track = overlapTracker();
    const effects = memoryEffects();
    const steps: PipelineStep[] = [
      { id: "a", dependencies: [], workflowId: "busy", input: { step: "a" } },
      { id: "b", dependencies: [], workflowId: "busy", input: { step: "b" } },
    ];
    const registry = openRegistry({
      workflows: [
        registration<BusyState, BusyState>({
          id: "busy",
          title: "One step, slowly",
          input: GateInput.pick({}).extend({ step: GateInput.shape.subject }),
          journal: memoryJournal(),
          graph: () => busyGraph(track),
          seed: (input) => input,
          executor: () => effects.execute,
        }),
      ],
      pipelines: [
        pipeline({
          id: "busy-steps",
          title: "Two steps that could overlap",
          input: z.object({}),
          steps: () => steps,
          concurrency: 2,
          ...(resourcesFor === undefined ? {} : { resourcesFor }),
        }),
      ],
    });
    return { registry, track };
  };

  test("two steps that name the same resource never overlap", async () => {
    const { registry, track } = twoBusySteps(() => ["shared-db"]);
    runPipeline(registry, "busy-steps", {});
    await registry.idle();

    const after = await getPipeline(registry, "busy-steps", {});
    expect(after.steps.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(track.peak()).toBe(1);
  });

  test("two steps that name nothing run together", async () => {
    // The control. Same steps, same concurrency, same lease manager; the only
    // difference is what the step says it needs.
    const { registry, track } = twoBusySteps();
    runPipeline(registry, "busy-steps", {});
    await registry.idle();

    const after = await getPipeline(registry, "busy-steps", {});
    expect(after.steps.map((r) => r.status)).toEqual(["accepted", "accepted"]);
    expect(track.peak()).toBe(2);
  });
});
