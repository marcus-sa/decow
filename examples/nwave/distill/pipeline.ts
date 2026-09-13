/**
 * DISTILL's consumer-shaped halves: what a value's oracle graph is seeded
 * with, where the test-path scope is declared, and what a finished oracle run
 * is persisted as.
 *
 * DISTILL is two disjoint steps. The first runs ONCE per roadmap and fills in
 * the acceptance facts; the second runs once per VALUE, authors that value's
 * oracle, and lets software measure it. Both are registered GRAPHS now, and
 * the second is registered as a pipeline over them — so the ordering, the
 * concurrency and the leases are the server's, and what is left here is the
 * projection each of them reads and writes.
 *
 * STATE IS A PROJECTION, the same stance `deliver/pipeline.ts` takes. Each
 * finished oracle run appends an `oracle_runs` row, and a value's status is
 * read back as the latest of those. That projection is also DELIVER's
 * readiness precondition: a step with no recorded `red` oracle never becomes
 * ready, which is where "no edge bypasses RED" lives now that the step cycle
 * has no RED node.
 */

import type { ArtifactStore } from "@des/core/artifacts";
import { measurementOf } from "@des/core/effects";
import type { RunOutcome } from "@des/core/workflow";
import type { RoadmapStep } from "../deliver/pipeline.ts";
import {
  oracleRunsOf,
  ORACLE_RUNS_TABLE,
  recordedVerdict,
  type OracleRun,
} from "./runs.ts";
import type { State as OracleState } from "./oracle/graph.ts";
import type { ValueUnderOracle } from "./oracle/steps.ts";

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

/** One roadmap step as the oracle graph's input. */
export const valueUnderOracle = (step: RoadmapStep): ValueUnderOracle => {
  if (step.oracle === undefined) {
    throw new Error(
      `distill: step ${step.id} declares no oracle. Run the obligations graph before authoring one.`,
    );
  }
  return {
    stepId: step.id,
    observation: step.observation,
    acceptance: step.acceptance,
    oracle: step.oracle,
    supports: step.supports,
    authority: step.authority,
  };
};

/**
 * Append one `oracle_runs` row for a finished oracle run.
 *
 * The verdict comes off the run's own terminal STATE, which is where the graph
 * put it — a measurement is a fact software produced, not a leaf's decision. A
 * parked run reached no terminal, so it has no state to read and no verdict to
 * record: that is `blocked`, and it is an absence rather than a fifth verdict,
 * which is what keeps "measured green" and "never measured" two different
 * facts.
 *
 * A duplicate is refused BY NAME, for the reason `recordStepRun`'s is.
 */
export const recordOracleRun = (
  artifacts: ArtifactStore,
  stepId: string,
  outcome: RunOutcome<unknown>,
): OracleRun => {
  const measured =
    outcome.kind === "terminal"
      ? measurementOf((outcome.terminal.state as OracleState).measured)?.verdict
      : undefined;
  const seq = oracleRunsOf(artifacts, stepId).length;
  const row: OracleRun = {
    stepId,
    runId: outcome.runId,
    verdict: recordedVerdict(outcome, measured ?? "blocked"),
    seq,
  };
  const written = artifacts.upsert({
    table: ORACLE_RUNS_TABLE,
    id: `${stepId}#${seq}`,
    expectedVersion: 0,
    row,
  });
  if (written.outcome !== "committed") {
    throw new Error(
      `distill: oracle run ${seq} of ${stepId} is already recorded — two things are driving one roadmap`,
    );
  }
  return row;
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
