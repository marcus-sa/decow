/**
 * How this project is typechecked, linted, tested, and how one oracle is run.
 *
 * The framework knows the four JOBS. It does not know that this project is a
 * bun project, that its linter is biome, or that its test runner writes a
 * JUnit report behind `--reporter=junit`. Those are declarations, and this is
 * where a consumer makes them.
 *
 * Every one of the four is read by the framework and by nothing else:
 *
 *   typecheck  the write path's second stage, over the whole project
 *   lint       the write path's third stage, over the files a write touched,
 *              and the DELIVER cycle's quality gate
 *   tests      the write path's fourth stage, once per impacted test
 *   oracle     the DISTILL measurement, which executes one test and reads
 *              `green | red | broken | indeterminate` off its JUnit report
 *
 * The JUnit flags were MEASURED against bun 1.3.12, not assumed:
 * `--reporter=junit --reporter-outfile=<path>` writes a `<testsuites>`
 * document with `tests`, `failures` and `skipped` counts and one `<testcase>`
 * per test. A run whose file does not parse, or whose import does not resolve,
 * writes no document at all, which is what the framework reads as "it ran
 * nothing" rather than "nothing failed".
 *
 * `biome check` exits 0 on warnings and non-zero on errors, so the gate keys
 * on the exit status exactly as it does for every other declared command.
 */

import type { Commands } from "../../src/core/commands.ts";

export const commands: Commands = {
  typecheck: () => ["bunx", "tsc", "--noEmit"],
  lint: ({ paths }) => ["bunx", "biome", "check", ...paths],
  tests: ({ file, selector, junit }) => [
    "bun",
    "test",
    file,
    ...(selector ? ["-t", selector] : []),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ],
  oracle: ({ file, selector, junit }) => [
    "bun",
    "test",
    file,
    ...(selector ? ["-t", selector] : []),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ],
};
