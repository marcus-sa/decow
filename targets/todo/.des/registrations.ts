/**
 * The four graphs and the two pipelines, as this target registers them.
 *
 * This is the whole of what the server knows about the todo target: what each
 * graph is called, what a person supplies to start one, how to turn that into
 * the graph's seed state, and what its effects mean inside this run's own
 * checkout. Everything else the server derives.
 *
 * Its own module rather than `main.ts`, because `main.ts` ends in
 * `await serve(...)` and importing one to reach a registration would start a
 * server. The same trap `request.ts` documents, one layer up.
 *
 * TWO WAYS TO START THE SAME GRAPH, and the difference is what each is for. A
 * WORKFLOW registration runs one graph over one row, through the server, so a
 * person watches it: the trace lands on the run, the attempts land on the run,
 * and a suspension is answered in the UI. A PIPELINE runs the frontier — every
 * row whose dependencies are accepted — under the scheduler, with the resource
 * leases and the readiness precondition the scheduler owns. Starting one row
 * by hand does not escape that precondition: the seed refuses a row whose
 * oracle has not been measured red, by name, exactly as the scheduler's
 * `eligible` does.
 */

import { z } from "zod";
import { registration, type AnyWorkflowRegistration, type PipelineRegistration } from "@des/server";
import { vcsExecutor } from "@des/core/vcs/executor";
import { parseOracleLocator } from "@des/core/vcs/verify";
import {
  deliverSeed,
  openPipeline,
  oracleTests,
  readRoadmap,
  ROADMAP_STEPS_TABLE,
  statusOf,
  type RoadmapRow,
} from "../../../examples/nwave/deliver/pipeline.ts";
import type { State as DeliverState } from "../../../examples/nwave/deliver/graph.ts";
import { deliverGraph } from "../../../examples/nwave/deliver/graph.ts";
import {
  obligationsGraph,
  seed as seedObligations,
  type State as ObligationsState,
} from "../../../examples/nwave/distill/obligations/graph.ts";
import {
  oracleGraph,
  seed as seedOracle,
  type State as OracleState,
} from "../../../examples/nwave/distill/oracle/graph.ts";
import {
  gitIgnores,
  openOracles,
  testPathScope,
  valueUnderOracle,
} from "../../../examples/nwave/distill/pipeline.ts";
import { oracleIsRed, oracleStatusOf } from "../../../examples/nwave/distill/runs.ts";
import {
  roadmapGraph,
  seed as seedRoadmap,
  type State as RoadmapState,
} from "../../../examples/nwave/roadmap/graph.ts";
import type { Roadmap } from "../../../examples/nwave/roadmap/schema.ts";
import {
  todoDeliverDefs,
  todoObligationsDefs,
  todoOracleDefs,
  todoRoadmapDefs,
} from "./models.ts";
import type { Reporter } from "./report.ts";
import { REQUEST } from "./request.ts";
import { runSuite, type RunDir } from "./run-dir.ts";

/** The roadmap is keyed by the request it was authored for, as nWave keys one. */
export const ROADMAP_ID = REQUEST;

/** Every registration this target makes. */
export type TodoRegistrations = {
  workflows: AnyWorkflowRegistration[];
  pipelines: PipelineRegistration[];
};

/** The row this input names, or a refusal that says which id was not there. */
const rowOf = (dir: RunDir, rowId: string): RoadmapRow => {
  const row = rows(dir).find((r) => r.id === rowId);
  if (row === undefined) {
    throw new Error(
      `no row ${rowId} in the roadmap. Run the roadmap graph and approve it first; ` +
        `the rows it wrote are ${rows(dir).map((r) => r.id).join(", ") || "(none)"}.`,
    );
  }
  return row;
};

/**
 * The roadmap's rows, or none.
 *
 * Nothing is registered against a roadmap that does not exist yet: the first
 * thing this target does is author one, so every reader here has to survive
 * the state where it has not.
 */
const rows = (dir: RunDir): RoadmapRow[] => {
  try {
    return readRoadmap(dir.artifacts, ROADMAP_ID);
  } catch {
    return [];
  }
};

export const todoRegistrations = (dir: RunDir, report: Reporter): TodoRegistrations => {
  const models = { onUsage: report.onUsage };

  /**
   * The run report's own sink, per graph.
   *
   * The server records every attempt on the run it belongs to; this is the
   * other reader — one JSON line per model call in the run directory, which is
   * what outlives the process. A standalone run is labelled with the GRAPH
   * that ran, because a registration's observer is built before the input that
   * names a row is; the pipelines label theirs with the row, because they know
   * it.
   */
  const observeAs = (graph: string) => report.observerFor(graph);

  /** One executor per run, so the event log's task id is the run's own. */
  const executorFor = (session: string, description: string) => () =>
    vcsExecutor({
      vcs: dir.vcs,
      session,
      intent: { taskId: session, description },
      artifacts: dir.artifacts,
    });

  /* ------------------------------------------------------------- ROADMAP */

  const roadmap = registration<RoadmapState, { request: string }>({
    id: "roadmap",
    title: "ROADMAP — decompose the request into rows a person approves",
    input: z.object({
      request: z
        .string()
        .min(1)
        .default(REQUEST)
        .describe("What the roadmap is authored for. Also the row id it is stored under."),
    }),
    journal: dir.journal,
    graph: (ctx) => roadmapGraph(ctx.journal, todoRoadmapDefs(models), ctx.observe),
    seed: (input) => seedRoadmap(input.request, dir.design),
    executor: executorFor(`roadmap:${dir.name}`, "author the roadmap"),
    observe: observeAs("roadmap"),
    runtime: dir.runtime,
  });

  /* -------------------------------------------- DISTILL, the facts */

  const obligations = registration<ObligationsState, Record<string, never>>({
    id: "obligations",
    title: "DISTILL — state what each value must be observed to do",
    input: z.object({}),
    journal: dir.journal,
    graph: (ctx) =>
      obligationsGraph(
        ctx.journal,
        todoObligationsDefs(models),
        (path) => gitIgnores(dir.vcs.root, path),
        ctx.observe,
      ),
    seed: () => {
      const roadmapRows = rows(dir);
      if (roadmapRows.length === 0) {
        throw new Error("there is no approved roadmap yet, so there is nothing to state facts about");
      }
      const stored: Roadmap = {
        request: ROADMAP_ID,
        steps: roadmapRows.map((row) => ({
          id: row.id,
          observation: row.observation,
          dependencies: row.dependencies,
          authority: row.authority,
          predictedTouches: row.predictedTouches,
          acceptance: row.acceptance,
          ...(row.oracle === undefined ? {} : { oracle: row.oracle }),
          supports: row.supports,
        })),
      };
      return seedObligations({
        roadmap: stored,
        design: dir.design,
        testPaths: testPathScope(dir.design),
        versions: Object.fromEntries(
          roadmapRows.map((row) => [
            row.id,
            dir.artifacts.read(ROADMAP_STEPS_TABLE, row.id)?.version ?? 0,
          ]),
        ),
      });
    },
    executor: executorFor(`distill:${ROADMAP_ID}`, "state the acceptance facts"),
    observe: observeAs("obligations"),
    runtime: dir.runtime,
  });

  /* ------------------------------------------- DISTILL, the oracle */

  const oracle = registration<OracleState, { rowId: string }>({
    id: "oracle",
    title: "DISTILL — author one value's oracle, and let software measure it",
    input: z.object({ rowId: z.string().min(1).describe("Which roadmap row to write the oracle for") }),
    journal: dir.journal,
    graph: (ctx) => oracleGraph(ctx.journal, todoOracleDefs(models), ctx.observe),
    seed: (input) =>
      seedOracle({
        value: valueUnderOracle(rowOf(dir, input.rowId)),
        design: dir.design,
        testPaths: testPathScope(dir.design),
      }),
    // No protected scope here, and that is the asymmetry the arrangement rests
    // on: this is the one turn that owns the oracle.
    executor: ({ runId }) =>
      vcsExecutor({
        vcs: dir.vcs,
        session: runId,
        intent: { taskId: runId, parentTaskId: ROADMAP_ID, description: "author the oracle" },
        artifacts: dir.artifacts,
      }),
    observe: observeAs("oracle"),
    runtime: dir.runtime,
  });

  /* -------------------------------------------------------------- DELIVER */

  const deliver = registration<DeliverState, { rowId: string }>({
    id: "deliver",
    title: "DELIVER — run the step cycle over one row whose oracle is red",
    input: z.object({ rowId: z.string().min(1).describe("Which roadmap row to deliver") }),
    journal: dir.journal,
    graph: (ctx) => deliverGraph(ctx.journal, todoDeliverDefs(models), dir.commands, ctx.observe),
    seed: (input) => {
      const row = rowOf(dir, input.rowId);
      // "No edge bypasses RED" is a readiness precondition rather than an edge,
      // and it holds for a row started by hand exactly as it holds for one the
      // scheduler started: an unmeasured oracle proves nothing and a green one
      // proves the wrong thing.
      if (!oracleIsRed(dir.artifacts, row.id)) {
        throw new Error(
          `${row.id} has no oracle measured red, so nothing may deliver it. ` +
            "Run the oracle graph for it first.",
        );
      }
      return deliverSeed({
        vcs: dir.vcs,
        row,
        design: dir.design,
        evidence: runSuite(dir.project).output,
      });
    },
    /**
     * The crafter's executor, with this row's own oracle WALLED OFF.
     *
     * `_crafter_owns` as an executor rule rather than a graph edge: RED to
     * GREEN is bought by production and never by editing the test that
     * measures it, and expressing that here is what makes it hold for every
     * write the graph could emit — including one a model proposed and the
     * graph merely passed along.
     *
     * `knownRed` is the other half: every OTHER undelivered value's oracle is
     * red by construction, and refusing this row's correct write for one of
     * them would make a module with two undelivered values undeliverable.
     */
    executor: ({ runId, input }) => {
      const row = rowOf(dir, input.rowId);
      return vcsExecutor({
        vcs: dir.vcs,
        session: runId,
        intent: { taskId: runId, parentTaskId: ROADMAP_ID, description: row.observation },
        artifacts: dir.artifacts,
        knownRed: rows(dir)
          .filter((other) => other.id !== row.id && statusOf(dir.artifacts, other.id) !== "accepted")
          .flatMap((other) => oracleTests(dir.vcs, other.oracle)),
        ...(row.oracle === undefined ? {} : { protected: [parseOracleLocator(row.oracle).path] }),
      });
    },
    observe: observeAs("deliver"),
    runtime: dir.runtime,
  });

  /* ------------------------------------------------------------ pipelines */

  /**
   * DISTILL's second half, over every value in dependency order.
   *
   * Built per call rather than once, because the rows it schedules are written
   * by a graph this same server runs: a composition captured at boot would be
   * a composition over a roadmap that did not exist yet.
   */
  const oraclesPipeline = () =>
    openOracles({
      artifacts: dir.artifacts,
      vcs: dir.vcs,
      journal: dir.journal,
      defs: todoOracleDefs(models),
      roadmapId: ROADMAP_ID,
      design: dir.design,
      concurrency: 1,
      observe: report.observerFor,
      runtime: dir.runtime,
    });

  const oracles: PipelineRegistration = {
    id: "oracles",
    title: "DISTILL — one oracle per value, authored and measured",
    rows: () =>
      rows(dir).map((row) => ({
        id: row.id,
        description: row.observation,
        dependencies: row.dependencies,
        workflowId: "oracle",
      })),
    status: (rowId) => oracleStatusOf(dir.artifacts, rowId),
    run: async () => {
      await oraclesPipeline().scheduler.run();
    },
    resume: async (rowId, answer) => {
      await oraclesPipeline().scheduler.resume(rowId, answer);
    },
  };

  const deliveryPipeline = () =>
    openPipeline({
      artifacts: dir.artifacts,
      vcs: dir.vcs,
      commands: dir.commands,
      journal: dir.journal,
      defs: todoDeliverDefs(models),
      roadmapId: ROADMAP_ID,
      design: dir.design,
      evidence: runSuite(dir.project).output,
      concurrency: 1,
      observe: report.observerFor,
      runtime: dir.runtime,
    });

  /** DELIVER, once per row whose oracle came back red. */
  const delivery: PipelineRegistration = {
    id: "delivery",
    title: "DELIVER — the step cycle, once per red-oracled row",
    rows: () =>
      rows(dir).map((row) => ({
        id: row.id,
        description: row.observation,
        dependencies: row.dependencies,
        workflowId: "deliver",
      })),
    status: (rowId) => statusOf(dir.artifacts, rowId),
    run: async () => {
      const { scheduler, unoracled } = deliveryPipeline();
      const missing = unoracled();
      if (missing.length > 0) {
        throw new Error(
          `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no oracle measured red, ` +
            "so nothing may deliver them. Run the oracles pipeline first.",
        );
      }
      await scheduler.run();
    },
    resume: async (rowId, answer) => {
      await deliveryPipeline().resumeParked(rowId, answer);
    },
  };

  return { workflows: [roadmap, obligations, oracle, deliver], pipelines: [oracles, delivery] };
};
