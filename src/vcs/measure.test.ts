/**
 * Measuring one oracle, both halves.
 *
 * The pure half — the locator's command, bun's own summary lines, and the
 * verdict rule over them — is unit-tested. The half that matters is that the
 * rule is right about the runner it is reading, so the second describe runs
 * `bun test` for real against five files that differ only in HOW they fail.
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
import { counterIds, manualClock, tempProject } from "./testing.ts";
import { bunCounts, defaultVerifier, oracleArgv, oracleVerdict } from "./verify.ts";

/** This file is `<root>/src/vcs/measure.test.ts`. */
const REPO = dirname(dirname(dirname(import.meta.path)));

describe("the oracle locator's command", () => {
  test("path::selector runs that one test; a bare path runs the file", () => {
    expect(oracleArgv("test/todo.test.ts::complete marks the todo done")).toEqual([
      "bun",
      "test",
      "test/todo.test.ts",
      "-t",
      "complete marks the todo done",
    ]);
    expect(oracleArgv("test/todo.test.ts")).toEqual(["bun", "test", "test/todo.test.ts"]);
    // An empty selector is a path with a separator stuck on it, not a filter
    // that matches everything by a different name.
    expect(oracleArgv("test/todo.test.ts::")).toEqual(["bun", "test", "test/todo.test.ts"]);
  });
});

describe("bun's own summary, read", () => {
  test("pass and fail are required; error is optional and defaults to none", () => {
    expect(bunCounts(" 1 pass\n 0 fail\n")).toEqual({ passed: 1, failed: 0, errored: 0 });
    expect(bunCounts(" 0 pass\n 1 fail\n 1 error\n")).toEqual({ passed: 0, failed: 1, errored: 1 });
  });

  test("no summary at all is undefined, not zero", () => {
    // The difference matters: "nothing ran" and "nothing failed" are opposite
    // claims, and the verdict rule branches on which one this is.
    expect(bunCounts('error: regex "no such test" matched 0 tests.')).toBeUndefined();
    expect(bunCounts("")).toBeUndefined();
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
 * The five shapes, against the real runner. Every expectation here was
 * measured against bun 1.3.12 before the rule above was written.
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
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    const vcs = openVcs({ root, verifier: defaultVerifier(), clock: manualClock(1_000), ids: counterIds() });
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
    // real failure, and charging it to the crafter would burn a paid turn on
    // an oracle nobody could satisfy.
    const measured = await measure("missing.test.ts");
    expect(measured).toMatchObject({ verdict: "broken", axis: "counts" });
    expect(measured.counts?.errored).toBeGreaterThan(0);
  }, 30_000);

  test("an oracle that does not parse is broken", async () => {
    const measured = await measure("unparsed.test.ts");
    expect(measured.verdict).toBe("broken");
  }, 30_000);

  test("a selector naming no test is broken, because nothing was measured", async () => {
    const measured = await measure("green.test.ts::no such test");
    expect(measured).toMatchObject({ verdict: "broken", axis: "no-summary", exitCode: 1 });
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
    // and in particular the defect is not the author's.
    const vcs = open();
    const result = await vcs.measureOracle({
      oracle: "green.test.ts::green",
      argv: ["a-runner-that-does-not-exist"],
      intent,
    });
    expect(result.outcome).toBe("infra-failed");
    const logged = vcs.log.byTask("task-oracle").filter((e) => e.kind === "oracle-measured");
    expect(logged[0]).toMatchObject({ category: "infrastructure" });
    vcs.close();
  }, 30_000);
});
