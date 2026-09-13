/**
 * Every call this UI makes, as a server function.
 *
 * There is no fetch to `/api` in this application and no hand-written JSON
 * route behind one. A route's loader calls one of these and gets a typed value
 * back; a button calls one and the write happens in this process. What runs is
 * `@des/server`'s own `api.ts` — these wrappers add a validator, the RPC
 * boundary and a client stub, and nothing else, which is why a unit test over
 * those bodies is a test of what a browser reaches.
 *
 * THE REGISTRY IS READ AT CALL TIME, never captured. `serve()` sets it before
 * the handler is mounted, and a server function that closed over it at module
 * scope would close over whichever registry happened to exist when the bundle
 * was first imported.
 *
 * The one thing that is NOT here is the event stream: a server function is
 * request/response, and `/api/events` is a server ROUTE for that reason
 * (`../routes/api.events.ts`).
 */

import { createServerFn } from "@tanstack/react-start";
import {
  getPipeline as readPipeline,
  getRegistry,
  getRun as readRun,
  getWorkflow as readWorkflow,
  listPipelines as readPipelines,
  listRuns as readRuns,
  listWorkflows as readWorkflows,
  readArtifacts as readArtifactRows,
  resumeRun as answerRun,
  resumeStep as answerStep,
  runPipeline as drivePipeline,
  startRun as beginRun,
} from "@des/server";
import { z } from "zod";

/* -------------------------------------------------------------- the graphs */

/** Every registered graph, with its authored projection and its input schema. */
export const listWorkflows = createServerFn({ method: "GET" }).handler(() =>
  readWorkflows(getRegistry()),
);

const ById = z.object({ id: z.string() });

export const getWorkflow = createServerFn({ method: "GET" })
  .validator(ById)
  .handler(({ data }) => readWorkflow(getRegistry(), data.id));

/* ---------------------------------------------------------------- the runs */

/**
 * Start a run. The input is whatever the form collected; the registration's
 * own schema is what decides whether it is a run at all, so the validator here
 * only says "an object arrived".
 */
export const startRun = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), input: z.unknown() }))
  .handler(({ data }) => beginRun(getRegistry(), data.id, data.input));

export const listRuns = createServerFn({ method: "GET" }).handler(() => readRuns(getRegistry()));

export const getRun = createServerFn({ method: "GET" })
  .validator(z.object({ runId: z.string() }))
  .handler(({ data }) => readRun(getRegistry(), data.runId));

/**
 * Answer a suspension. An answer outside the parked node's closed enum comes
 * back as an error naming the enum, which is what the dialog shows.
 */
export const resumeRun = createServerFn({ method: "POST" })
  .validator(z.object({ runId: z.string(), answer: z.unknown() }))
  .handler(({ data }) => answerRun(getRegistry(), data.runId, data.answer));

/* ----------------------------------------------------------- the artifacts */

export const readArtifacts = createServerFn({ method: "GET" })
  .validator(
    z.object({ table: z.string(), id: z.string().optional(), version: z.number().optional() }),
  )
  .handler(({ data }) => readArtifactRows(getRegistry(), data));

/* ----------------------------------------------------------- the pipelines */

export const listPipelines = createServerFn({ method: "GET" }).handler(() =>
  readPipelines(getRegistry()),
);

/**
 * One pipeline's steps, for the input it names them under.
 *
 * Like `startRun`, the validator here only says "an id and something arrived":
 * the pipeline registration's own schema is what decides whether the value
 * names a composition at all.
 */
export const getPipeline = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string(), input: z.unknown() }))
  .handler(async ({ data }) => await readPipeline(getRegistry(), data.id, data.input));

export const runPipeline = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), input: z.unknown() }))
  .handler(({ data }) => drivePipeline(getRegistry(), data.id, data.input));

/** Answer a parked step. It is the step's own run that continues. */
export const resumeStep = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string(), stepId: z.string(), answer: z.unknown() }))
  .handler(({ data }) => answerStep(getRegistry(), data.id, data.stepId, data.answer));
