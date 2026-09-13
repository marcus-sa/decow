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
 * server. `REQUEST` lives here for the same reason: three things read it and
 * one of them is a test.
 *
 * TWO WAYS TO START THE SAME GRAPH, and they are the same graph. A WORKFLOW
 * registration is one run over one row, started by a person. A PIPELINE is a
 * declaration of WHICH rows and in what order, and the server starts each one
 * as a run of the very same registration — same seed, same executor, same
 * journal. So a row's run is watchable, its trace lands on it, and its
 * suspension is answered in the dialog that answers any other run.
 *
 * Nothing escapes the precondition by picking a door: the standalone `deliver`
 * seed refuses a row whose oracle has not been measured red, by name, and the
 * pipeline declares the same fact as its `readiness`.
 */

import { z } from "zod";
import { registration, type AnyWorkflowRegistration, type PipelineRegistration } from "@des/server";
import { vcsExecutor } from "@des/core/vcs/executor";
import { parseOracleLocator } from "@des/core/vcs/verify";
import {
  declaredResources,
  deliverSeed,
  knownRedTests,
  readRoadmap,
  recordStepRun,
  ROADMAP_STEPS_TABLE,
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
  recordOracleRun,
  testPathScope,
  valueUnderOracle,
} from "../../../examples/nwave/distill/pipeline.ts";
import { oracleIsRed } from "../../../examples/nwave/distill/runs.ts";
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
  type Models,
} from "./models.ts";
import { runSuite, type RunDir } from "./run-dir.ts";

/**
 * The request the roadmap is authored for.
 *
 * Fixed rather than an argument: a roadmap is authored FOR something, and what
 * the todo target needs is not a judgement call — two stubs, two values. It is
 * also the `roadmaps` row id, because nWave keys a handover by its request and
 * so does this.
 */
export const REQUEST =
  "Implement the stubbed behaviours `complete` and `remove` in src/todo.ts so the pending " +
  "acceptance tests in test/todo.test.ts pass.";

/** The roadmap is keyed by the request it was authored for, as nWave keys one. */
export const ROADMAP_ID = REQUEST;

/** Every registration this target makes. */
export type TodoRegistrations = {
  workflows: AnyWorkflowRegistration[];
  pipelines: PipelineRegistration[];
};

export type RegistrationOptions = {
  /**
   * Which binding runs which leaf. THE ONLY THING A CALLER INJECTS.
   *
   * Production passes `todoModels()`; a test passes scripted ones. There used
   * to be a second option here — an `evidence` override — and it existed so a
   * test could compute the journal key `runStep` would compute, against runner
   * output that carries its own timings. That was the composition shaped by
   * its tests, and it is gone: a leaf is stubbed at this seam, so what the
   * suite actually printed is what every run quotes.
   */
  models: Models;
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

export const todoRegistrations = (
  dir: RunDir,
  options: RegistrationOptions,
): TodoRegistrations => {
  const models = options.models;

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
    // The SESSION is the run's, so two runs hold two leases rather than
    // colliding on the one a session may hold; the TASK is the row's, so the
    // event log's answer to "who wrote this oracle" joins the journal's answer
    // to "what did this turn decide" on the row id both of them carry.
    executor: ({ runId, input }) =>
      vcsExecutor({
        vcs: dir.vcs,
        session: runId,
        intent: {
          taskId: rowOf(dir, input.rowId).id,
          parentTaskId: ROADMAP_ID,
          description: "author the oracle",
        },
        artifacts: dir.artifacts,
      }),
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
        // The red a crafter is looking at is the red the suite prints NOW, in
        // this run's own checkout: the row before it may have turned a sibling
        // green. So it is measured per run rather than supplied.
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
        intent: { taskId: row.id, parentTaskId: ROADMAP_ID, description: row.observation },
        artifacts: dir.artifacts,
        knownRed: knownRedTests(dir.artifacts, dir.vcs, rows(dir), row.id),
        ...(row.oracle === undefined ? {} : { protected: [parseOracleLocator(row.oracle).path] }),
      });
    },
    runtime: dir.runtime,
  });

  /* ------------------------------------------------------------ pipelines */

  /**
   * The two compositions, as DATA.
   *
   * Neither runs anything. A pipeline declares its rows — each one naming a
   * registered graph and the input one run of it takes — plus whether a row
   * may run at all and what to persist when one finishes. The SERVER drives
   * the frontier and starts each ready row as an ordinary run, which is what
   * gives a row a run id, a live trace, events and a suspension a person
   * answers in the same dialog they answer a standalone run in.
   *
   * The rows are re-read per request and per drive rather than captured at
   * boot, because they are written by a graph this same server runs: a row set
   * captured at boot would be a row set over a roadmap that did not exist yet.
   */

  /** One row per roadmap row, pointed at the graph that delivers it. */
  const rowsFor = (workflowId: string) => () =>
    rows(dir).map((row) => ({
      id: row.id,
      description: row.observation,
      dependencies: row.dependencies,
      workflowId,
      input: { rowId: row.id },
    }));

  /** DISTILL's second half, over every value in dependency order. */
  const oracles: PipelineRegistration = {
    id: "oracles",
    title: "DISTILL — one oracle per value, authored and measured",
    rows: rowsFor("oracle"),
    record: (rowId, outcome) => {
      recordOracleRun(dir.artifacts, rowId, outcome);
    },
    concurrency: 1,
  };

  /** DELIVER, once per row whose oracle came back red. */
  const delivery: PipelineRegistration = {
    id: "delivery",
    title: "DELIVER — the step cycle, once per red-oracled row",
    rows: rowsFor("deliver"),
    // "No edge bypasses RED", as the readiness precondition it is. A row with
    // no oracle measured red never becomes ready and blocks its dependents,
    // exactly as the standalone `deliver` seed refuses one by name.
    readiness: (rowId) => oracleIsRed(dir.artifacts, rowId),
    record: (rowId, outcome) => {
      recordStepRun(dir.artifacts, rowId, outcome);
    },
    concurrency: 1,
    resourcesFor: (row) => declaredResources(dir.vcs, dir.commands, rowOf(dir, row.id)),
  };

  return { workflows: [roadmap, obligations, oracle, deliver], pipelines: [oracles, delivery] };
};
