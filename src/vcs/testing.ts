/**
 * Fixtures for driving the VCS without a clock, an RNG, or a compiler.
 *
 * The module's dependencies are injected precisely so that a test can hold all
 * three still: a counter id generator makes every id in an assertion readable,
 * a manual clock makes lease expiry a function call rather than a wait, and a
 * verifier whose stages are supplied per test makes "typecheck failed" an
 * input rather than a four-second subprocess.
 *
 * This is the VCS's counterpart to `src/harness/stub-journal.ts`: committed,
 * not a test file, and imported only by tests.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Clock, IdGen } from "./registry.ts";
import { alwaysPasses, type OracleVerdict, type StageOutcome, type Verifier } from "./verify.ts";

/** Ids of the form `sym-1`, `lease-2`, counted per prefix. */
export const counterIds = (): IdGen => {
  const counts = new Map<string, number>();
  return (prefix) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}-${next}`;
  };
};

export type ManualClock = Clock & { advance: (ms: number) => void; set: (ms: number) => void };

/** A clock that only moves when a test moves it. Starts at 0. */
export const manualClock = (start = 0): ManualClock => {
  let now = start;
  const clock = (() => now) as ManualClock;
  clock.advance = (ms) => {
    now += ms;
  };
  clock.set = (ms) => {
    now = ms;
  };
  return clock;
};

/** Every stage passes. The baseline a test overrides one stage of. */
export const passingVerifier = (overrides: Partial<Verifier> = {}): Verifier => ({
  typecheck: alwaysPasses,
  tests: alwaysPasses,
  policy: alwaysPasses,
  // Not a stage, so "passes" is not its neutral answer. The neutral answer is
  // "the runner never started", which is what a fixture that never measures an
  // oracle should produce: an infrastructure failure, charged to nobody.
  measure: neverMeasures,
  ...overrides,
});

/** An oracle measurement that never happened. The neutral fixture answer. */
export const neverMeasures = async (): Promise<undefined> => undefined;

/** An oracle that measured this verdict, for a test that needs one. */
export const measuresAs = (
  verdict: OracleVerdict,
  output = `measured ${verdict}`,
): Verifier["measure"] => async (ctx) => ({
  verdict,
  axis: "counts",
  output,
  exitCode: verdict === "green" ? 0 : 1,
  argv: ctx.argv,
});

/** A stage that always fails, for asserting rollback and the failure category. */
export const failingStage = (by: "typecheck" | "tests" | "contract", detail: string) => async (): Promise<StageOutcome> => ({
  status: "failed",
  by,
  detail,
});

/** A temporary project on disk, seeded with files at root-relative paths. */
export const tempProject = (files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), "dw-vcs-"));
  for (const [path, source] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  return root;
};
