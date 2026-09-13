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
import type { Commands } from "../core/commands.ts";
import type { EffectResult } from "../core/effects.ts";
import type { Clock, IdGen } from "./registry.ts";
import {
  alwaysPasses,
  type CommandExecutor,
  type OracleVerdict,
  type RunCommandEffect,
  type StageOutcome,
  type Verifier,
} from "./verify.ts";

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
  lint: alwaysPasses,
  tests: alwaysPasses,
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
  argv: ["measure", ctx.file, ...(ctx.selector === undefined ? [] : [ctx.selector])],
});

/**
 * The four commands a bun project declares, with biome as its linter.
 *
 * The same shape `targets/todo/commands.ts` declares, kept here so a VCS test
 * that wants the REAL stages does not have to reach into a target directory
 * for them. The JUnit flags were measured against bun 1.3.12, not assumed:
 * `--reporter=junit --reporter-outfile=<path>` writes a `<testsuites>`
 * document, and a run whose file never parses writes none at all.
 */
export const bunCommands: Commands = {
  typecheck: () => ["bunx", "tsc", "--noEmit"],
  lint: ({ paths }) => ["bunx", "biome", "check", ...paths],
  tests: ({ file, selector, junit }) => [
    "bun",
    "test",
    file,
    ...(selector === undefined ? [] : ["-t", selector]),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ],
  oracle: ({ file, selector, junit }) => [
    "bun",
    "test",
    file,
    ...(selector === undefined ? [] : ["-t", selector]),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ],
};

/** One scripted answer to one `run-command` effect. */
export type ScriptedRun = (effect: RunCommandEffect) => EffectResult;

/**
 * A command executor that answers from a script and never spawns.
 *
 * This is the seam the whole verification pipeline now hangs off: every stage
 * composes a declared command into a `run-command` effect and hands it to an
 * executor, so a test that supplies this one drives typecheck, lint, tests and
 * the oracle measurement without a process. `calls` is what ran, in order, for
 * a test whose claim is about which command was composed.
 */
export const scriptedCommands = (answer: ScriptedRun) => {
  const calls: RunCommandEffect[] = [];
  const run: CommandExecutor = async (effect) => {
    calls.push(effect);
    return answer(effect);
  };
  return { run, calls };
};

/** A command that exited zero, said nothing, and took no time. */
export const exitedWith = (effect: RunCommandEffect, exitCode: number, stdout = ""): EffectResult => {
  const command = { exitCode, stdout, stderr: "", durationMs: 0, timedOut: false };
  return exitCode === 0
    ? { effect, outcome: "committed", version: 0, command }
    : { effect, outcome: "rejected", by: "command", command };
};

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
