/**
 * The composition: roadmap rows in, oracles on disk and measured red out.
 *
 * DISTILL is two disjoint steps and this file is where they join. The first
 * runs ONCE per roadmap and fills in the acceptance facts. The second runs
 * once per VALUE, authors that value's oracle, and lets software measure it —
 * in dependency order, through the same scheduler DELIVER uses, because a
 * value whose oracle depends on a sibling's support needs the sibling first.
 *
 * STATE IS A PROJECTION, the same stance `deliver/pipeline.ts` takes. The
 * scheduler persists nothing of its own: each finished oracle run appends an
 * `oracle_runs` row, and a value's status is read back as the latest of those.
 * A run in flight has no row yet, so it reads `pending` and is simply run
 * again.
 *
 * That projection is also DELIVER's readiness precondition. A row with no
 * recorded `red` oracle never becomes ready there, which is where "no edge
 * bypasses RED" lives now that the step cycle has no RED node.
 */

import type { ArtifactStore } from "../../../artifacts/store.ts";
import type { WorkflowRuntime } from "../../../core/compile.ts";
import { measurementOf } from "../../../core/effects.ts";
import type { Journal } from "../../../core/journal.ts";
import { openScheduler, type SchedulerRow } from "../../../core/scheduler.ts";
import type { StepObserver } from "../../../core/step.ts";
import { resume, run, type RunOutcome } from "../../../core/workflow.ts";
import { vcsExecutor } from "../../../vcs/executor.ts";
import type { Vcs } from "../../../vcs/index.ts";
import { readRoadmap, ROADMAP_STEPS_TABLE, type RoadmapRow } from "../deliver/pipeline.ts";
import {
  oracleRunsOf,
  oracleStatusOf,
  ORACLE_RUNS_TABLE,
  recordedVerdict,
  type OracleRun,
  type RecordedVerdict,
} from "./runs.ts";
import type { Roadmap } from "../roadmap/schema.ts";
import {
  obligationsGraph,
  seed as seedObligations,
  type State as ObligationsState,
} from "./obligations/graph.ts";
import type { ObligationsDefs } from "./obligations/steps.ts";
import { oracleGraph, seed as seedOracle, type State as OracleState } from "./oracle/graph.ts";
import type { OracleDefs, ValueUnderOracle } from "./oracle/steps.ts";

/* ------------------------------------------------------- the test-path scope */

/**
 * The line `design.md` declares its test-path scope on.
 *
 * A path is test substrate because of WHERE IT SITS, so something has to say
 * where that is, and the design source is the only thing that can: the author
 * writes there, the executor walls the oracle there, and the manifest
 * validator refuses a support outside it. Reading it off one declared line
 * keeps the three in agreement with one edit.
 */
const TEST_PATH_LINE = /^-\s*Test path scope:\s*(.+)$/m;

/**
 * The test paths `design.md` declares, or a refusal by name.
 *
 * Refusing is the point. A default of `test/` would silently work for every
 * project whose substrate lives there and silently mis-scope every project
 * whose does not, and the failure would surface two waves later as an oracle
 * refused for writing where it may not.
 */
export const testPathScope = (design: string): string[] => {
  const match = TEST_PATH_LINE.exec(design);
  if (match?.[1] === undefined) {
    throw new Error(
      "distill: the design source declares no test path scope. Add a line reading " +
        "`- Test path scope: \\`test/\\`` naming where this project's test substrate lives.",
    );
  }
  return match[1]
    .split(",")
    .map((path) => path.trim().replace(/^`|`$/g, "").replace(/\/$/, ""))
    .filter((path) => path.length > 0);
};

/* ------------------------------------------------ DISTILL, first half */

export type ObligationsOptions = {
  artifacts: ArtifactStore;
  vcs: Vcs;
  journal: Journal;
  defs: ObligationsDefs;
  /** The roadmap whose rows are being filled in, by its own row id. */
  roadmapId: string;
  /** `design.md` plus whatever else the design source carries. */
  design: string;
  observe?: StepObserver;
  runtime?: WorkflowRuntime;
};

/**
 * Run the obligations graph once over one roadmap.
 *
 * The versions come from the artifact store rather than from the graph: the
 * rows already exist — ROADMAP wrote them — and DISTILL fills in three empty
 * fields on each, so the upsert is optimistic against what is there.
 */
export const runObligations = async (
  options: ObligationsOptions,
): Promise<RunOutcome<ObligationsState>> => {
  const rows = readRoadmap(options.artifacts, options.roadmapId);
  const roadmap: Roadmap = {
    request: options.roadmapId,
    steps: rows.map((row) => ({
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
  const versions = Object.fromEntries(
    rows.map((row) => [row.id, options.artifacts.read(ROADMAP_STEPS_TABLE, row.id)?.version ?? 0]),
  );

  return await run<ObligationsState>(
    obligationsGraph(
      options.journal,
      options.defs,
      (path) => gitIgnores(options.vcs.root, path),
      options.observe,
    ),
    seedObligations({ roadmap, design: options.design, testPaths: testPathScope(options.design), versions }),
    vcsExecutor({
      vcs: options.vcs,
      session: `distill:${options.roadmapId}`,
      intent: { taskId: options.roadmapId, description: "state the acceptance facts" },
      artifacts: options.artifacts,
    }),
    options.runtime,
  );
};

/**
 * Does this repository ignore that path?
 *
 * `git check-ignore` is the only thing that can answer it, and the VCS has no
 * opinion: its registry tracks what it was told to track and says nothing
 * about what git would hide. A repository with no git in it answers `false` —
 * an unanswered ignore question is not a defect, and refusing every support in
 * a checkout without git would be inventing one.
 */
export const gitIgnores = (root: string, path: string): boolean => {
  const check = Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: root });
  return check.exitCode === 0;
};

/* ----------------------------------------------- DISTILL, second half */

export type OraclesOptions = {
  artifacts: ArtifactStore;
  vcs: Vcs;
  journal: Journal;
  defs: OracleDefs;
  roadmapId: string;
  design: string;
  /** How many values may be in flight. One by default: see the deliver command. */
  concurrency?: number;
  observe?: (rowId: string) => StepObserver;
  onRun?: (rowId: string, outcome: RunOutcome<OracleState>, verdict: RecordedVerdict) => void;
  runtime?: WorkflowRuntime;
};

/** One roadmap row as the oracle graph's input. */
export const valueUnderOracle = (row: RoadmapRow): ValueUnderOracle => {
  if (row.oracle === undefined) {
    throw new Error(
      `distill: row ${row.id} declares no oracle. Run the obligations graph before authoring one.`,
    );
  }
  return {
    stepId: row.id,
    observation: row.observation,
    acceptance: row.acceptance,
    oracle: row.oracle,
    supports: row.supports,
    authority: row.authority,
  };
};

/**
 * The scheduler, composed over one roadmap's oracles.
 *
 * Every value runs as its own VCS SESSION and under its own TASK id, both the
 * row id, exactly as DELIVER's rows do — so two values in flight hold two
 * leases, and the event log's answer to "who wrote this oracle" joins the
 * journal's answer to "what did this turn decide" on one key.
 *
 * There is no protected scope here, and that is the asymmetry the whole
 * arrangement rests on: this is the ONE turn that owns the oracle. DELIVER's
 * executor is the one that walls it.
 */
export const openOracles = (options: OraclesOptions) => {
  const { artifacts, vcs, journal, defs, design } = options;
  const rows = readRoadmap(artifacts, options.roadmapId);
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const testPaths = testPathScope(design);

  const rowFor = (id: string): RoadmapRow => {
    const row = byId.get(id);
    if (row === undefined) throw new Error(`distill: no row ${id}`);
    return row;
  };

  const executorFor = (row: RoadmapRow) =>
    vcsExecutor({
      vcs,
      session: row.id,
      intent: { taskId: row.id, parentTaskId: options.roadmapId, description: row.observation },
      artifacts,
    });

  const graphFor = (rowId: string) => oracleGraph(journal, defs, options.observe?.(rowId));

  const scheduler = openScheduler<OracleState>({
    rows: rows.map((row): SchedulerRow => ({ id: row.id, dependencies: row.dependencies })),
    concurrency: options.concurrency ?? 1,

    runOne: async (r) => {
      const row = rowFor(r.id);
      return await run<OracleState>(
        graphFor(row.id),
        seedOracle({ value: valueUnderOracle(row), design, testPaths }),
        executorFor(row),
        options.runtime,
      );
    },

    resumeOne: async (r, runId, answer) => {
      const row = rowFor(r.id);
      return await resume<OracleState>(graphFor(row.id), runId, answer, executorFor(row), options.runtime);
    },

    statusOf: async (id) => oracleStatusOf(artifacts, id),

    record: async (id, outcome) => {
      // The verdict comes off the run's own state, which is where the graph
      // put it. A parked run reached no terminal, so it has no state to read
      // and no verdict to record — that is `blocked`, and it is an absence
      // rather than a fifth verdict.
      const measured =
        outcome.kind === "terminal"
          ? measurementOf(outcome.terminal.state.measured)?.verdict
          : undefined;
      const verdict = recordedVerdict(outcome, measured ?? "blocked");
      options.onRun?.(id, outcome, verdict);
      const seq = oracleRunsOf(artifacts, id).length;
      const written = artifacts.upsert({
        table: ORACLE_RUNS_TABLE,
        id: `${id}#${seq}`,
        expectedVersion: 0,
        row: { stepId: id, runId: outcome.runId, verdict, seq } satisfies OracleRun,
      });
      if (written.outcome !== "committed") {
        throw new Error(
          `distill: oracle run ${seq} of ${id} is already recorded — two schedulers are driving one roadmap`,
        );
      }
    },
  });

  return { scheduler, rows };
};

/** Re-exported so a consumer composing this reads one module. */
export {
  oracleIsRed,
  oracleRunsOf,
  oracleStatusOf,
  ORACLE_RUNS_TABLE,
  type OracleRun,
  type RecordedVerdict,
} from "./runs.ts";
