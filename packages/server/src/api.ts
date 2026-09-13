/**
 * Everything the UI can ask for, as plain functions over the registry.
 *
 * These ARE the server functions. `@des/ui` wraps each one in
 * `createServerFn`, which gives it a validator, an RPC boundary and a typed
 * client stub — and nothing else: the body is what is written here, so the
 * behaviour a person sees in a browser is the behaviour a unit test in this
 * package drives directly, with no HTTP in between.
 *
 * Every one of them is a projection of something that already exists: the
 * authored graph, a run's record, the artifact store's rows, a pipeline's
 * declared steps. The ones that are not — starting a run, answering a
 * suspension, and reading or driving a pipeline — take a value the
 * registration's own schema validates, and a value that does not parse is
 * refused HERE, with the closed set it should have come from, rather than
 * three frames into a compiled step.
 */

import type { StepStatus } from "@des/core/scheduler";
import { z } from "zod";
import { asJson, type Json } from "./json.ts";
import { continueAfterResume, ownerOf, runIdOf, start, tree, type PipelineTree } from "./pipelines.ts";
import type { GraphProjection, ResumeOptions } from "./projection.ts";
import type { AnyPipelineRegistration, AnyWorkflowRegistration, Choice } from "./registration.ts";
import type { Registry } from "./registry.ts";
import type { RunRecord, RunSummary } from "./runs.ts";

/** One registration, as a client reads it. */
export type DescribedWorkflow = {
  id: string;
  title: string;
  /** The authored graph: the ids in the source, never the compiler's. */
  graph: GraphProjection;
  /**
   * The JSON Schema of the input a person supplies.
   *
   * The REGISTRATION's rather than the graph's — a graph says nothing about
   * what precedes it — so it travels beside the projection rather than inside
   * it, and it travels as JSON Schema because a browser cannot hold a zod type.
   */
  input: Json;
};

/** One pipeline, as a client reads it before it has an input to drive one with. */
export type ListedPipeline = {
  id: string;
  title: string;
  /**
   * The JSON Schema of the input a person supplies.
   *
   * It rides here rather than on `getPipeline` because `getPipeline` PARSES an
   * input before it will answer, and the moment a person needs the schema is
   * the moment before they have one. It travels as JSON Schema because a
   * browser cannot hold a zod type.
   */
  input: Json;
  /**
   * The options for every input field that declared them, resolved now.
   *
   * A field absent from this record has no closed list and is rendered from
   * the schema alone. The record is EMPTY for a pipeline that declared none,
   * which is the ordinary case.
   */
  choices: Record<string, Choice[]>;
};

/**
 * A registration's input, parsed by its own schema, or a refusal naming every
 * issue.
 *
 * One function for both kinds, because "what a person supplies before this
 * starts" is one question: a value the steps could not be derived from must
 * not become a drive, exactly as a value the graph could not seed from must
 * not become a run.
 */
const parsed = <T>(id: string, schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `the input for ${id} does not parse: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
};

/**
 * An answer the parked node would refuse, refused before it reaches one.
 *
 * The message names the closed enum, because that is the whole of what a
 * person needs: the thing they typed is not one of these three words. The
 * fields are beside it for a caller that wants to re-render the buttons.
 */
export class RefusedAnswer extends Error {
  readonly field?: string;
  readonly options?: string[];

  constructor(message: string, resume?: ResumeOptions) {
    super(message);
    this.name = "RefusedAnswer";
    if (resume?.field !== undefined) this.field = resume.field;
    if (resume?.options !== undefined) this.options = [...resume.options];
  }
}

const described = (registry: Registry, registration: AnyWorkflowRegistration): DescribedWorkflow => ({
  id: registration.id,
  title: registration.title,
  graph: registry.projections.get(registration.id) as GraphProjection,
  input: asJson(z.toJSONSchema(registration.input, { target: "draft-07", unrepresentable: "any" })),
});

const workflowOf = (registry: Registry, id: string): AnyWorkflowRegistration => {
  const registration = registry.workflowById.get(id);
  if (registration === undefined) throw new Error(`no workflow ${id} is registered`);
  return registration;
};

const pipelineOf = (registry: Registry, id: string): AnyPipelineRegistration => {
  const pipeline = registry.pipelineById.get(id);
  if (pipeline === undefined) throw new Error(`no pipeline ${id} is registered`);
  return pipeline;
};

/* ------------------------------------------------------------- the graphs */

export const listWorkflows = (registry: Registry): DescribedWorkflow[] =>
  registry.workflows.map((registration) => described(registry, registration));

export const getWorkflow = (registry: Registry, id: string): DescribedWorkflow =>
  described(registry, workflowOf(registry, id));

/* ---------------------------------------------------------------- the runs */

/**
 * Start a run. The input is parsed by the registration's own schema, so a
 * value the graph could not seed from never becomes a run.
 */
export const startRun = (registry: Registry, id: string, input: unknown): { runId: string } => {
  const registration = workflowOf(registry, id);
  return { runId: registry.runner.start(id, parsed(id, registration.input, input)).runId };
};

export const listRuns = (registry: Registry): RunSummary[] => registry.runs.list();

export const getRun = (registry: Registry, runId: string): RunRecord => {
  const record = registry.runs.get(runId);
  if (record === undefined) throw new Error(`no run ${runId}`);
  return record;
};

/**
 * Answer a suspension, and continue the SAME run.
 *
 * The answer is parsed by the parked node's own `resumeSchema`, which is the
 * same value the UI read its buttons off — so what a person is offered is by
 * construction what the node accepts, and anything else is refused with the
 * enum named.
 */
export const resumeRun = (
  registry: Registry,
  runId: string,
  answer: unknown,
): { runId: string; status: StepStatus | "running" } => {
  const record = registry.runs.get(runId);
  if (record === undefined) throw new Error(`no run ${runId}`);
  if (record.status !== "suspended") {
    throw new Error(`run ${runId} is ${record.status}, so there is nothing to answer`);
  }

  const graph = registry.runner.graphOf(runId);
  const node = record.suspension?.node;
  const parked = graph === undefined || node === undefined ? undefined : graph.nodes[node];
  if (parked?.type !== "suspend") {
    throw new Error(`run ${runId} is parked on a node this server cannot name`);
  }

  const parsed = parked.resumeSchema.safeParse(answer);
  if (!parsed.success) {
    const resume = record.suspension?.resume;
    throw new RefusedAnswer(
      resume?.options === undefined
        ? `the answer for ${runId} does not parse`
        : `the answer for ${runId} must be one of ${resume.options.join(", ")}`,
      resume,
    );
  }

  const settled = registry.runner.resume(runId, parsed.data);
  if (settled === undefined) throw new Error(`run ${runId} has no engine run to continue`);

  const owner = ownerOf(registry, runId);
  if (owner !== undefined) continueAfterResume(registry, owner, settled);

  return { runId, status: "running" };
};

/**
 * One run's rows, as JSON lines.
 *
 * A second writer beside the rows — a file written as the run happens — cannot
 * attribute its token columns, because a queue drained in call order cannot
 * say which leaf spent what. The rows can: `runStep` attributes each call to
 * the attempt that made it. So this is a READ, and it emits the one thing a
 * file is better at — a stream a person can grep.
 *
 * Three kinds, in one document: the run, then its attempts, then its events.
 */
export const exportRun = (registry: Registry, runId: string): string => {
  const record = getRun(registry, runId);
  const { trace: _trace, attempts: _attempts, ...run } = record;
  return [
    { kind: "run", ...run },
    ...record.attempts.map((attempt) => ({ kind: "leaf-attempt", runId, ...attempt })),
    ...registry.runs.db.events.of(runId).map(({ kind, ...event }) => ({ kind: "event", event: kind, ...event })),
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
};

/* ----------------------------------------------------------- the artifacts */

export type ArtifactRead =
  | { table: string; rows: { id: string; version: number; row: Json }[] }
  | { table: string; id: string; version: number; row: Json };

/**
 * The rows one table holds, one of them, or the body one held at a past
 * version. A server with no artifact store registered says so.
 */
export const readArtifacts = (
  registry: Registry,
  args: { table: string; id?: string; version?: number },
): ArtifactRead => {
  const store = registry.artifacts;
  if (store === undefined) {
    throw new Error("this server registered no artifact store, so there are no rows to read");
  }
  const { table, id, version } = args;
  if (id === undefined) {
    // An artifact row body is JSON text in the store it came out of.
    return { table, rows: store.list(table).map((r) => ({ ...r, row: asJson(r.row) })) };
  }
  if (version !== undefined) {
    const at = store.at(table, id, version);
    if (at === undefined) throw new Error(`no ${table}/${id} at version ${version}`);
    return { table, id, version, row: asJson(at) };
  }
  const row = store.read(table, id);
  if (row === undefined) throw new Error(`no ${table}/${id}`);
  return { table, id, version: row.version, row: asJson(row.row) };
};

/* ----------------------------------------------------------- the pipelines */

/**
 * Every field's options, asked for NOW.
 *
 * The declared functions are the consumer's and they are called on every read,
 * which is what makes a value written a moment ago pickable. They run
 * concurrently because they are independent: one field's options are never a
 * function of another's.
 */
const choicesOf = async (
  pipeline: AnyPipelineRegistration,
): Promise<Record<string, Choice[]>> => {
  const declared = Object.entries(pipeline.choices ?? {});
  const read = await Promise.all(
    declared.map(async ([field, options]): Promise<[string, Choice[]]> => [
      field,
      [...(await options())],
    ]),
  );
  return Object.fromEntries(read);
};

export const listPipelines = async (registry: Registry): Promise<ListedPipeline[]> =>
  await Promise.all(
    registry.pipelines.map(async (pipeline) => ({
      id: pipeline.id,
      title: pipeline.title,
      input: asJson(
        z.toJSONSchema(pipeline.input, { target: "draft-07", unrepresentable: "any" }),
      ),
      choices: await choicesOf(pipeline),
    })),
  );

/**
 * One pipeline's steps, for the input it names them under.
 *
 * The input is parsed here rather than inside the steps hook, so a tree read
 * and a drive are refused by the same schema and a consumer's hook only ever
 * sees a value that parsed.
 */
export const getPipeline = async (
  registry: Registry,
  id: string,
  input: unknown,
): Promise<PipelineTree> => {
  const registration = pipelineOf(registry, id);
  return await tree(registry, registration, parsed(id, registration.input, input));
};

/**
 * Drive the frontier. `started: false` means one was already going, which is
 * not an error: two people pressing the same button want one pipeline.
 */
export const runPipeline = (
  registry: Registry,
  id: string,
  input: unknown,
): { id: string; started: boolean } => {
  const registration = pipelineOf(registry, id);
  return {
    id,
    ...start(registry, registration, asJson(parsed(id, registration.input, input))),
  };
};

/**
 * Answer a parked step. It is the step's own RUN that is resumed — the same run
 * the tree links to and the run page draws — and the frontier is re-evaluated
 * when it settles.
 */
export const resumeStep = (
  registry: Registry,
  id: string,
  stepId: string,
  answer: unknown,
): { runId: string } => {
  const pipeline = pipelineOf(registry, id);
  const runId = runIdOf(registry, pipeline.id, stepId);
  if (runId === undefined) {
    throw new Error(`step ${stepId} of pipeline ${id} has no run, so there is nothing to answer`);
  }
  resumeRun(registry, runId, answer);
  return { runId };
};
