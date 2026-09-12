/**
 * The oracle-runs projection: what `des oracle` left behind, and what DELIVER
 * reads before it will run anything.
 *
 * Its own module rather than a section of `./pipeline.ts`, because two
 * consumers need it and they sit on opposite sides of one arrow. DISTILL's
 * composition WRITES these rows and reads the roadmap out of DELIVER's; DELIVER
 * READS these rows to decide whether a value may be delivered at all. Putting
 * the projection where both can reach it is what keeps that a line rather than
 * a cycle.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { ArtifactStore } from "../../../artifacts/store.ts";
import type { OracleVerdict } from "../../../core/effects.ts";
import type { RowStatus } from "../../../core/scheduler.ts";
import type { RunOutcome } from "../../../core/workflow.ts";

/** Where a finished oracle run is recorded. Append-only, one row per run. */
export const ORACLE_RUNS_TABLE = "oracle_runs";

/**
 * What a finished oracle run is persisted as.
 *
 * `verdict` is the measured one, widened by exactly one word: `blocked` is a
 * run that produced no measurement at all, because the author could not
 * express the value, the write was refused, or the validator was never
 * satisfied. Recording it as an absence rather than as a verdict is what keeps
 * "the oracle was measured green" and "the oracle was never measured" two
 * different facts.
 */
export type RecordedVerdict = OracleVerdict | "blocked";

export type OracleRun = {
  stepId: string;
  runId: string;
  verdict: RecordedVerdict;
  /** How many runs of this value came before it. The projection reads the last. */
  seq: number;
};

/** Every recorded oracle run of one value, oldest first. */
export const oracleRunsOf = (artifacts: ArtifactStore, stepId: string): OracleRun[] =>
  artifacts
    .list(ORACLE_RUNS_TABLE)
    .map((r) => r.row as OracleRun)
    .filter((r) => r.stepId === stepId)
    .sort((a, b) => a.seq - b.seq);

/**
 * Has this value's oracle been measured RED?
 *
 * The precondition DELIVER reads. `red` and only `red`: an unmeasured oracle
 * proves nothing, and a green one proves the wrong thing.
 */
export const oracleIsRed = (artifacts: ArtifactStore, stepId: string): boolean =>
  oracleRunsOf(artifacts, stepId).at(-1)?.verdict === "red";

/**
 * A value's status, derived from its latest oracle run.
 *
 * Every way of not reaching red is `suspended` rather than `rejected`, and
 * that is exact rather than convenient: every block in the oracle graph IS a
 * suspension, and the only route to its `reject` terminal is a person
 * answering `abandon`, which nothing in this composition does.
 */
export const oracleStatusOf = (artifacts: ArtifactStore, stepId: string): RowStatus => {
  const last = oracleRunsOf(artifacts, stepId).at(-1);
  if (last === undefined) return "pending";
  return last.verdict === "red" ? "accepted" : "suspended";
};

/** The verdict a finished run produced, or the absence of one. */
export const recordedVerdict = <S>(outcome: RunOutcome<S>, measured: RecordedVerdict): RecordedVerdict =>
  outcome.kind === "terminal" && outcome.terminal.kind === "accepted" ? measured : "blocked";

