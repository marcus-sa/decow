/**
 * Measuring one oracle, both halves.
 *
 * The pure half — the locator, split, and the verdict rule over an exit status
 * and a set of counts — is unit-tested. The half that matters is that the rule
 * is right about the runner it is reading, so the second describe runs the
 * DECLARED oracle command for real against five files that differ only in HOW
 * they fail.
 *
 * That is the whole reason this is measured rather than inferred: an oracle
 * that errored in its own scaffolding exits 1, the identical status a genuine
 * assertion failure returns. Exit status alone therefore admits exactly the
 * artefact the measurement exists to refuse.
 */

import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { openVcs } from "./index.ts";
import { bunCommands, counterIds, manualClock, tempProject } from "./testing.ts";
import { defaultVerifier, oracleContext, oracleVerdict, parseOracleLocator } from "./verify.ts";

/** This file is `<root>/packages/core/src/vcs/measure.test.ts`. */
const PACKAGE = dirname(dirname(dirname(import.meta.path)));

/** The workspace root, where bun hoists `node_modules` for every package. */
const ROOT = dirname(dirname(PACKAGE));

describe("the oracle locator, split", () => {
  test("path::selector names one test; a bare path names the file", () => {
    expect(parseOracleLocator("test/todo.test.ts::complete marks the todo done")).toEqual({
      path: "test/todo.test.ts",
      selector: "complete marks the todo done",
    });
    expect(parseOracleLocator("test/todo.test.ts")).toEqual({ path: "test/todo.test.ts" });
    // An empty selector is a path with a separator stuck on it, not a filter
    // that matches everything by a different name.
    expect(parseOracleLocator("test/todo.test.ts::")).toEqual({ path: "test/todo.test.ts" });
  });

  test("the locator becomes the arguments a DECLARED oracle command takes", () => {
    // The framework hands over the file and the selector; what runs them is
    // the consumer's declaration. Nothing here builds an argv.
    expect(oracleContext("/repo", "test/todo.test.ts::marks it done")).toEqual({
      root: "/repo",
      file: "test/todo.test.ts",
      selector: "marks it done",
    });
    expect(oracleContext("/repo", "test/todo.test.ts")).toEqual({
      root: "/repo",
      file: "test/todo.test.ts",
    });
  });
});

describe("the verdict rule", () => {
  const verdict = (exit: number | undefined, counts?: { passed: number; failed: number; errored: number }) =>
    oracleVerdict(exit, counts);

  test("a runner that never produced a status, or crashed, is broken", () => {
    expect(verdict(undefined)).toEqual({ verdict: "broken", axis: "exit-status" });
    expect(verdict(2, { passed: 0, failed: 0, errored: 0 })).toEqual({ verdict: "broken", axis: "exit-status" });
  });

  test("a completed run with no summary is broken rather than red", () => {
    // bun always summarises a suite it RAN, so an absent summary is evidence
    // it ran nothing — a selector that matched no test, most often. Calling
    // that `red` would report an assertion failure nobody observed.
    expect(verdict(1, undefined)).toEqual({ verdict: "broken", axis: "no-summary" });
  });

  test("exit zero is green, an error is broken, a failure is red", () => {
    expect(verdict(0, { passed: 1, failed: 0, errored: 0 })).toEqual({ verdict: "green", axis: "counts" });
    expect(verdict(1, { passed: 0, failed: 1, errored: 1 })).toEqual({ verdict: "broken", axis: "counts" });
    expect(verdict(1, { passed: 0, failed: 1, errored: 0 })).toEqual({ verdict: "red", axis: "counts" });
  });

  test("a non-zero exit whose own summary records nothing wrong is indeterminate", () => {
    // The fourth state is not decoration. Answering `red` here would be a
    // silent-wrong pass into a paid craft turn.
    expect(verdict(1, { passed: 1, failed: 0, errored: 0 })).toEqual({
      verdict: "indeterminate",
      axis: "counts",
    });
  });
});

/**
 * The five shapes, against the real runner. Every expectation here is measured
 * against bun 1.3.12 rather than assumed.
 */
describe("the real runner", () => {
  const PROJECT = {
    "lib.ts": "export const answer = (): number => 1;\n",
    "green.test.ts": 'import { expect, test } from "bun:test";\n\ntest("green", () => {\n  expect(1).toBe(1);\n});\n',
    "red.test.ts":
      'import { expect, test } from "bun:test";\nimport { answer } from "./lib.ts";\n\n' +
      'test("red", () => {\n  expect(answer()).toBe(42);\n});\n',
    "missing.test.ts":
      'import { test } from "bun:test";\nimport { nowhere } from "./nowhere.ts";\n\n' +
      'console.log(nowhere);\ntest("never runs", () => {});\n',
    "unparsed.test.ts": 'import { test } from "bun:test";\ntest("unclosed"  => {\n',
  };

  const open = () => {
    const root = tempProject(PROJECT);
    symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"));
    const vcs = openVcs({
      root,
      verifier: defaultVerifier({ commands: bunCommands, root }),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    return vcs;
  };

  const intent = { taskId: "task-oracle", description: "measure the oracle", expectedOutcome: {} };
  const measure = async (oracle: string) => {
    const vcs = open();
    const result = await vcs.measureOracle({ oracle, intent });
    vcs.close();
    if (result.outcome !== "measured") throw new Error(`the runner did not start for ${oracle}`);
    return result.measurement;
  };

  test("a passing oracle is green", async () => {
    const measured = await measure("green.test.ts::green");
    expect(measured).toMatchObject({ verdict: "green", axis: "counts", exitCode: 0 });
    expect(measured.counts).toEqual({ passed: 1, failed: 0, errored: 0 });
  }, 30_000);

  test("an oracle that fails its assertion is red, which is the desired answer", async () => {
    const measured = await measure("red.test.ts::red");
    expect(measured).toMatchObject({ verdict: "red", axis: "counts", exitCode: 1 });
    // The output is verbatim, because it is what a person and a retry read.
    expect(measured.output).toContain("expect(received).toBe(expected)");
  }, 30_000);

  test("an oracle whose import does not resolve is broken, not red", async () => {
    // The incident this whole measurement exists for: same exit status as a
    // real failure, and charging it to the step would burn a paid turn on an
    // oracle nobody could satisfy.
    //
    // bun writes NO JUnit report for a file it could not load, so the axis is
    // `no-summary`: there is no report at all, which is evidence it ran
    // nothing rather than evidence that nothing failed.
    const measured = await measure("missing.test.ts");
    expect(measured).toMatchObject({ verdict: "broken", axis: "no-summary" });
    expect(measured.counts).toBeUndefined();
  }, 30_000);

  test("an oracle that does not parse is broken", async () => {
    const measured = await measure("unparsed.test.ts");
    expect(measured).toMatchObject({ verdict: "broken", axis: "no-summary" });
  }, 30_000);

  test("a selector naming no test is indeterminate: it failed, and nothing failed", async () => {
    // bun writes a report for a selector that matched nothing — two tests,
    // two skipped, no failure and no error — and exits non-zero anyway. That
    // is exactly what `indeterminate` is defined as, and answering `red`
    // there would be a silent-wrong pass into a paid craft turn.
    const measured = await measure("green.test.ts::no such test");
    expect(measured).toMatchObject({ verdict: "indeterminate", axis: "counts", exitCode: 1 });
    expect(measured.counts).toEqual({ passed: 0, failed: 0, errored: 0 });
  }, 30_000);

  test("every measurement is on the event log, including the red ones", async () => {
    // `red` is the ADMITTED answer and it is exactly the one a later reader
    // needs: it is what says the oracle failed before one production byte
    // existed. Recording only the refusing ones would discard it there.
    const vcs = open();
    await vcs.measureOracle({ oracle: "red.test.ts::red", intent });
    await vcs.measureOracle({ oracle: "green.test.ts::green", intent });

    const measured = vcs.log.byTask("task-oracle").filter((e) => e.kind === "oracle-measured");
    expect(measured.map((e) => JSON.parse(String(e.detail)).verdict)).toEqual(["red", "green"]);
    expect(measured.map((e) => e.verification)).toEqual(["failed", "passed"]);
    vcs.close();
  }, 30_000);

  test("a runner that cannot start is infra-failed rather than a verdict", async () => {
    // Nothing about the oracle was observed, so nothing about it is claimed —
    // and in particular the defect is not the author's. The effect names only
    // the oracle, so what makes the runner unstartable is the DECLARED command
    // naming a binary that is not there.
    const root = tempProject(PROJECT);
    const vcs = openVcs({
      root,
      verifier: defaultVerifier({
        commands: { ...bunCommands, oracle: () => ["a-runner-that-does-not-exist"] },
        root,
      }),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    const result = await vcs.measureOracle({ oracle: "green.test.ts::green", intent });
    expect(result.outcome).toBe("infra-failed");
    const logged = vcs.log.byTask("task-oracle").filter((e) => e.kind === "oracle-measured");
    expect(logged[0]).toMatchObject({ category: "infrastructure" });
    vcs.close();
  }, 30_000);
});
