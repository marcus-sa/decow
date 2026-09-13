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
 * server.
 *
 * A ROADMAP IS AN ARGUMENT, not a constant. `roadmap` is started with the
 * request a person typed; every other registration is started with the ID of a
 * roadmap that already exists. That id IS the request text: the roadmap graph
 * persists its `roadmaps` row under `roadmapId(roadmap) = roadmap.request`, as
 * nWave keys a handover by the request it was authored for, so "which roadmap"
 * and "for what" are one string and there is nothing to keep in step. A
 * roadmap id the artifact store does not hold is refused by name.
 *
 * TWO WAYS TO START THE SAME GRAPH, and they are the same graph. A WORKFLOW
 * registration is one run over one step, started by a person. A PIPELINE is a
 * declaration of WHICH steps and in what order, and the server starts each one
 * as a run of the very same registration — same seed, same executor, same
 * journal. So a step's run is watchable, its trace lands on it, and its
 * suspension is answered in the dialog that answers any other run.
 *
 * Nothing escapes the precondition by picking a door: the standalone `deliver`
 * seed refuses a step whose oracle has not been measured red, by name, and the
 * pipeline declares the same fact as its `readiness`.
 */

import { z } from "zod";
import {
  pipeline,
  registration,
  type AnyPipelineRegistration,
  type AnyWorkflowRegistration,
} from "@des/server";
import { vcsExecutor } from "@des/core/vcs/executor";
import { parseOracleLocator } from "@des/core/vcs/verify";
import {
  declaredResources,
  deliverSeed,
  knownRedTests,
  readRoadmap,
  recordStepRun,
  ROADMAP_STEPS_TABLE,
  type RoadmapStep,
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
 * The longest request this target will author a roadmap for.
 *
 * Bounded because the text is also the row id it is stored under, and because
 * a request is a request: the DESIGN SOURCE is where the detail lives, and a
 * thousand characters is more than any decomposable one needs.
 */
export const REQUEST_MAX_CHARACTERS = 1000;

/** What a person supplies to author a roadmap. */
export const RoadmapRequest = z.object({
  request: z
    .string()
    .min(1)
    .max(REQUEST_MAX_CHARACTERS)
    .describe("What the roadmap is authored for. Also the id it is stored under."),
});
export type RoadmapRequest = z.infer<typeof RoadmapRequest>;

/** Which roadmap a graph or a pipeline is about. */
export const NamesRoadmap = z.object({
  roadmapId: z.string().min(1).max(REQUEST_MAX_CHARACTERS).describe("Which roadmap to work from"),
});
export type NamesRoadmap = z.infer<typeof NamesRoadmap>;

/** Which roadmap, and which of its steps. */
export const NamesStep = NamesRoadmap.extend({
  stepId: z.string().min(1).describe("Which roadmap step"),
});
export type NamesStep = z.infer<typeof NamesStep>;

/** Every registration this target makes. */
export type TodoRegistrations = {
  workflows: AnyWorkflowRegistration[];
  pipelines: AnyPipelineRegistration[];
};

export type RegistrationOptions = {
  /**
   * Which binding runs which leaf. THE ONLY THING A CALLER INJECTS.
   *
   * Production passes `todoModels()`; a test passes scripted ones. Nothing
   * else is injectable — an override letting a test compute the journal key
   * `runStep` computes, against runner output carrying its own timings, would
   * be the composition shaped by its tests. A leaf is stubbed at this seam, so
   * what the suite actually printed is what every run quotes.
   */
  models: Models;
};

/**
 * The steps of the roadmap this id names.
 *
 * `readRoadmap` refuses an id the artifact store does not hold, by name, and
 * that refusal is kept rather than swallowed: an input naming a roadmap nobody
 * authored is a thing a person can act on, and an empty step list is a thing
 * they would read as "this roadmap has no work in it".
 *
 * Nothing is registered against a roadmap: every reader here takes the id from
 * the input it is given, so the server boots in the state where none exists.
 */
const steps = (dir: RunDir, roadmapId: string): RoadmapStep[] =>
  readRoadmap(dir.artifacts, roadmapId);

/** The step this input names, or a refusal that says which id was not there. */
const stepOf = (dir: RunDir, roadmapId: string, stepId: string): RoadmapStep => {
  const found = steps(dir, roadmapId);
  const step = found.find((r) => r.id === stepId);
  if (step === undefined) {
    throw new Error(
      `no step ${stepId} in roadmap ${roadmapId}. Its steps are ` +
        `${found.map((r) => r.id).join(", ") || "(none)"}.`,
    );
  }
  return step;
};

export const todoRegistrations = (
  dir: RunDir,
  options: RegistrationOptions,
): TodoRegistrations => {
  const models = options.models;

  /** One executor per run, so the event log's task id is the run's own. */
  const executorFor = (session: string, description: string) =>
    vcsExecutor({
      vcs: dir.vcs,
      session,
      intent: { taskId: session, description },
      artifacts: dir.artifacts,
    });

  /* ------------------------------------------------------------- ROADMAP */

  const roadmap = registration<RoadmapState, RoadmapRequest>({
    id: "roadmap",
    title: "ROADMAP — decompose a request into steps a person approves",
    // The request a person supplies. The DESIGN SOURCE and the symbol
    // inventory are the run directory's, because they are facts about the
    // target rather than about what is being asked of it.
    input: RoadmapRequest,
    journal: dir.journal,
    graph: (ctx) => roadmapGraph(ctx.journal, todoRoadmapDefs(models), ctx.observe),
    seed: (input) => seedRoadmap(input.request, dir.design),
    executor: () => executorFor(`roadmap:${dir.name}`, "author the roadmap"),
    runtime: dir.runtime,
  });

  /* -------------------------------------------- DISTILL, the facts */

  const obligations = registration<ObligationsState, NamesRoadmap>({
    id: "obligations",
    title: "DISTILL — state what each value must be observed to do",
    input: NamesRoadmap,
    journal: dir.journal,
    graph: (ctx) =>
      obligationsGraph(
        ctx.journal,
        todoObligationsDefs(models),
        (path) => gitIgnores(dir.vcs.root, path),
        ctx.observe,
      ),
    seed: (input) => {
      const roadmapSteps = steps(dir, input.roadmapId);
      if (roadmapSteps.length === 0) {
        throw new Error(
          `roadmap ${input.roadmapId} has no steps, so there is nothing to state facts about`,
        );
      }
      const stored: Roadmap = {
        // The id IS the request: `persist` wrote the row under it.
        request: input.roadmapId,
        steps: roadmapSteps.map((step) => ({
          id: step.id,
          observation: step.observation,
          dependencies: step.dependencies,
          authority: step.authority,
          predictedTouches: step.predictedTouches,
          acceptance: step.acceptance,
          ...(step.oracle === undefined ? {} : { oracle: step.oracle }),
          supports: step.supports,
        })),
      };
      return seedObligations({
        roadmap: stored,
        design: dir.design,
        testPaths: testPathScope(dir.design),
        versions: Object.fromEntries(
          roadmapSteps.map((step) => [
            step.id,
            dir.artifacts.read(ROADMAP_STEPS_TABLE, step.id)?.version ?? 0,
          ]),
        ),
      });
    },
    executor: ({ input }) =>
      executorFor(`distill:${input.roadmapId}`, "state the acceptance facts"),
    runtime: dir.runtime,
  });

  /* ------------------------------------------- DISTILL, the oracle */

  const oracle = registration<OracleState, NamesStep>({
    id: "oracle",
    title: "DISTILL — author one value's oracle, and let software measure it",
    input: NamesStep,
    journal: dir.journal,
    graph: (ctx) => oracleGraph(ctx.journal, todoOracleDefs(models), ctx.observe),
    seed: (input) =>
      seedOracle({
        value: valueUnderOracle(stepOf(dir, input.roadmapId, input.stepId)),
        design: dir.design,
        testPaths: testPathScope(dir.design),
      }),
    // No protected scope here, and that is the asymmetry the arrangement rests
    // on: this is the one turn that owns the oracle.
    // The SESSION is the run's, so two runs hold two leases rather than
    // colliding on the one a session may hold; the TASK is the step's, so the
    // event log's answer to "who wrote this oracle" joins the journal's answer
    // to "what did this turn decide" on the step id both of them carry.
    executor: ({ runId, input }) =>
      vcsExecutor({
        vcs: dir.vcs,
        session: runId,
        intent: {
          taskId: stepOf(dir, input.roadmapId, input.stepId).id,
          parentTaskId: input.roadmapId,
          description: "author the oracle",
        },
        artifacts: dir.artifacts,
      }),
    runtime: dir.runtime,
  });

  /* -------------------------------------------------------------- DELIVER */

  const deliver = registration<DeliverState, NamesStep>({
    id: "deliver",
    title: "DELIVER — run the step cycle over one step whose oracle is red",
    input: NamesStep,
    journal: dir.journal,
    graph: (ctx) => deliverGraph(ctx.journal, todoDeliverDefs(models), dir.commands, ctx.observe),
    seed: (input) => {
      const step = stepOf(dir, input.roadmapId, input.stepId);
      // "No edge bypasses RED" is a readiness precondition rather than an edge,
      // and it holds for a step started by hand exactly as it holds for one the
      // scheduler started: an unmeasured oracle proves nothing and a green one
      // proves the wrong thing.
      if (!oracleIsRed(dir.artifacts, step.id)) {
        throw new Error(
          `${step.id} has no oracle measured red, so nothing may deliver it. ` +
            "Run the oracle graph for it first.",
        );
      }
      return deliverSeed({
        vcs: dir.vcs,
        step,
        // The red a crafter is looking at is the red the suite prints NOW, in
        // this run's own checkout: the step before it may have turned a sibling
        // green. So it is measured per run rather than supplied.
        design: dir.design,
        evidence: runSuite(dir.project).output,
      });
    },
    /**
     * The crafter's executor, with this step's own oracle WALLED OFF.
     *
     * `_crafter_owns` as an executor rule rather than a graph edge: RED to
     * GREEN is bought by production and never by editing the test that
     * measures it, and expressing that here is what makes it hold for every
     * write the graph could emit — including one a model proposed and the
     * graph merely passed along.
     *
     * `knownRed` is the other half: every OTHER undelivered value's oracle is
     * red by construction, and refusing this step's correct write for one of
     * them would make a module with two undelivered values undeliverable.
     */
    executor: ({ runId, input }) => {
      const step = stepOf(dir, input.roadmapId, input.stepId);
      return vcsExecutor({
        vcs: dir.vcs,
        session: runId,
        intent: { taskId: step.id, parentTaskId: input.roadmapId, description: step.observation },
        artifacts: dir.artifacts,
        knownRed: knownRedTests(dir.artifacts, dir.vcs, steps(dir, input.roadmapId), step.id),
        ...(step.oracle === undefined ? {} : { protected: [parseOracleLocator(step.oracle).path] }),
      });
    },
    runtime: dir.runtime,
  });

  /* ------------------------------------------------------------ pipelines */

  /**
   * The two compositions, as DATA.
   *
   * Neither runs anything. A pipeline declares its steps — each one naming a
   * registered graph and the input one run of it takes — plus whether a step
   * may run at all and what to persist when one finishes. The SERVER drives
   * the frontier and starts each ready step as an ordinary run, which is what
   * gives a step a run id, a live trace, events and a suspension a person
   * answers in the same dialog they answer a standalone run in.
   *
   * Both name a ROADMAP, and the steps are re-read per request and per drive
   * rather than captured at boot, because they are written by a graph this same
   * server runs: a step set captured at boot would be a step set over a roadmap
   * that did not exist yet.
   */

  /** One step per roadmap step, pointed at the graph that delivers it. */
  const stepsFor = (workflowId: string) => (input: NamesRoadmap) =>
    steps(dir, input.roadmapId).map((step) => ({
      id: step.id,
      description: step.observation,
      dependencies: step.dependencies,
      workflowId,
      // What one run of that graph takes: which roadmap, and which of its
      // steps. The same input a person starting one by hand supplies.
      input: { roadmapId: input.roadmapId, stepId: step.id },
    }));

  /** DISTILL's second half, over every value in dependency order. */
  const oracles = pipeline<NamesRoadmap>({
    id: "oracles",
    title: "DISTILL — one oracle per value, authored and measured",
    input: NamesRoadmap,
    steps: stepsFor("oracle"),
    record: (stepId, outcome) => {
      recordOracleRun(dir.artifacts, stepId, outcome);
    },
    concurrency: 1,
  });

  /** DELIVER, once per step whose oracle came back red. */
  const delivery = pipeline<NamesRoadmap>({
    id: "delivery",
    title: "DELIVER — the step cycle, once per red-oracled step",
    input: NamesRoadmap,
    steps: stepsFor("deliver"),
    // "No edge bypasses RED", as the readiness precondition it is. A step with
    // no oracle measured red never becomes ready and blocks its dependents,
    // exactly as the standalone `deliver` seed refuses one by name. It is a
    // fact about the step rather than about the roadmap, because a step id is
    // what an `oracle_runs` row carries.
    readiness: (stepId) => oracleIsRed(dir.artifacts, stepId),
    record: (stepId, outcome) => {
      recordStepRun(dir.artifacts, stepId, outcome);
    },
    concurrency: 1,
    resourcesFor: (step, input) =>
      declaredResources(dir.vcs, dir.commands, stepOf(dir, input.roadmapId, step.id)),
  });

  return { workflows: [roadmap, obligations, oracle, deliver], pipelines: [oracles, delivery] };
};
