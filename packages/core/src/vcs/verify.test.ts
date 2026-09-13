/**
 * The verification stages, driven without a process.
 *
 * Every stage is a composition of `run-command` over a consumer's declared
 * `Commands`, which means the seam a test needs is one function: the executor
 * the stage hands its effect to. `scriptedCommands` is that function, and with
 * it the whole pipeline is assertable in microseconds — including the two
 * stages that otherwise need a compiler and a test runner on disk.
 *
 * What this file pins, and `real-tools.test.ts` then confirms against the real
 * tools once:
 *
 *   which command each stage composes, from the declaration and nothing else
 *   what each stage says about an exit of zero, an exit of anything else, and
 *   a command that could not be run at all
 *   how the JUnit report a test command wrote becomes a verdict, a rejection
 *   and a set of failing ids
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Commands } from "../core/commands.ts";
import type { EffectResult } from "../core/effects.ts";
import { exitedWith, scriptedCommands, type ScriptedRun } from "./testing.ts";
import {
  lintStage,
  testsStage,
  typecheckStage,
  measureStage,
  type RunCommandEffect,
  type StageContext,
  type TestStageContext,
} from "./verify.ts";

/** A consumer's declaration, with every command distinguishable by its argv. */
const COMMANDS: Commands = {
  typecheck: () => ["check-types", "--all"],
  lint: ({ paths }) => ["lint-it", ...paths],
  tests: ({ file, selector, junit }) => ({
    argv: ["run-tests", file, ...(selector === undefined ? [] : ["--only", selector]), junit],
    timeoutMs: 5_000,
  }),
  oracle: ({ file, selector, junit }) => [
    "run-oracle",
    file,
    ...(selector === undefined ? [] : ["--only", selector]),
    junit,
  ],
};

const FILE_CTX: StageContext = {
  root: "/repo",
  path: "src/todo.ts",
  source: "export const x = 1;\n",
  symbolIds: ["sym-1"],
};

/** The junit path a test or oracle command was handed. Always the last argv. */
const junitOf = (effect: RunCommandEffect): string => effect.argv.at(-1) as string;

/** A scripted run that writes a JUnit document where the command was told to. */
const writesReport = (body: string, exitCode: number): ScriptedRun => (effect) => {
  writeFileSync(junitOf(effect), body, "utf8");
  return exitedWith(effect, exitCode);
};

const report = (spec: { tests: number; failures: number; errors?: number; cases: string }) =>
  `<testsuites tests="${spec.tests}" failures="${spec.failures}" errors="${spec.errors ?? 0}" skipped="0">` +
  spec.cases +
  `</testsuites>`;

const TARGETS: TestStageContext = {
  root: "/repo",
  symbolIds: ["sym-1"],
  targets: [
    { id: "test-1", path: "test/todo.test.ts", name: "complete marks it done" },
    { id: "test-2", path: "test/todo.test.ts", name: "remove drops it" },
  ],
};

describe("the typecheck stage", () => {
  test("composes the declared typecheck command and nothing else", async () => {
    const { run, calls } = scriptedCommands((effect) => exitedWith(effect, 0));
    expect(await typecheckStage(COMMANDS, run)(FILE_CTX)).toEqual({ status: "passed" });
    expect(calls.map((c) => c.argv)).toEqual([["check-types", "--all"]]);
  });

  test("a non-zero exit is rejected by TYPECHECK, with the output as the detail", async () => {
    // The stage reports its OWN name rather than the effect's `command`,
    // because a stage is exactly the thing that interprets a non-zero exit.
    const { run } = scriptedCommands((effect) => exitedWith(effect, 2, "TS2322: not assignable"));
    const outcome = await typecheckStage(COMMANDS, run)(FILE_CTX);
    expect(outcome).toMatchObject({ status: "failed", by: "typecheck" });
    expect(outcome.status === "failed" && outcome.detail).toContain("TS2322");
  });

  test("a command that could not be run is infra-failed, never a rejection", async () => {
    const { run } = scriptedCommands((effect) => ({ effect, outcome: "infra-failed" }));
    expect(await typecheckStage(COMMANDS, run)(FILE_CTX)).toMatchObject({ status: "infra-failed" });
  });
});

describe("the lint stage", () => {
  test("composes the declared lint command over the file the write touched", async () => {
    // Scoped to the write rather than the project: this stage runs INSIDE the
    // write path and the question it answers is whether THESE bytes broke a
    // rule.
    const { run, calls } = scriptedCommands((effect) => exitedWith(effect, 0));
    expect(await lintStage(COMMANDS, run)(FILE_CTX)).toEqual({ status: "passed" });
    expect(calls.map((c) => c.argv)).toEqual([["lint-it", "src/todo.ts"]]);
  });

  test("a non-zero exit is rejected by LINT", async () => {
    const { run } = scriptedCommands((effect) => exitedWith(effect, 1, "noDoubleEquals"));
    const outcome = await lintStage(COMMANDS, run)(FILE_CTX);
    expect(outcome).toMatchObject({ status: "failed", by: "lint" });
    expect(outcome.status === "failed" && outcome.detail).toContain("noDoubleEquals");
  });

  test("a linter that could not be run is infra-failed", async () => {
    const { run } = scriptedCommands((effect) => ({ effect, outcome: "infra-failed" }));
    expect(await lintStage(COMMANDS, run)(FILE_CTX)).toMatchObject({ status: "infra-failed" });
  });
});

describe("the tests stage", () => {
  test("an empty target set passes without running anything", async () => {
    // The impact graph said nothing depends on the change, and running the
    // whole suite to disprove that is the cost § 6.2 exists to avoid.
    const { run, calls } = scriptedCommands((effect) => exitedWith(effect, 0));
    expect(await testsStage(COMMANDS, run)({ ...TARGETS, targets: [] })).toEqual({
      status: "passed",
    });
    expect(calls).toEqual([]);
  });

  test("one declared command per impacted test, each with its own junit path", async () => {
    const { run, calls } = scriptedCommands(
      writesReport(report({ tests: 1, failures: 0, cases: `<testcase name="x" />` }), 0),
    );
    expect(await testsStage(COMMANDS, run)(TARGETS)).toEqual({ status: "passed" });

    expect(calls.map((c) => c.argv.slice(0, 4))).toEqual([
      ["run-tests", "test/todo.test.ts", "--only", "complete marks it done"],
      ["run-tests", "test/todo.test.ts", "--only", "remove drops it"],
    ]);
    // Two runs, two reports: one cannot read the other's.
    expect(new Set(calls.map(junitOf)).size).toBe(2);
    // And the declared timeout travelled with the declaration.
    expect(calls.every((c) => c.timeoutMs === 5_000)).toBe(true);
  });

  test("a failing case names the target that failed, out of the REPORT", async () => {
    const { run, calls } = scriptedCommands(
      writesReport(
        report({
          tests: 1,
          failures: 1,
          cases: `<testcase name="complete marks it done"><failure /></testcase>`,
        }),
        1,
      ),
    );
    const outcome = await testsStage(COMMANDS, run)(TARGETS);

    expect(outcome).toMatchObject({ status: "failed", by: "tests", failed: ["test-1"] });
    // It stopped at the first target that did not pass: one answer settles
    // "did this break something else".
    expect(calls).toHaveLength(1);
  });

  test("a runner that wrote no report at all is broken, and still names the target", async () => {
    // No document means it ran nothing, which the verdict rule reads as
    // `broken` on its `no-summary` axis. Nothing in the report can name the
    // failing case, so the target that RAN is the honest fallback.
    const { run } = scriptedCommands((effect) => exitedWith(effect, 1, "could not resolve ./nowhere"));
    const outcome = await testsStage(COMMANDS, run)(TARGETS);
    expect(outcome).toMatchObject({ status: "failed", by: "tests", failed: ["test-1"] });
  });

  test("a non-zero exit whose report records nothing wrong is ADVISORY, not a refusal", async () => {
    // § 6.4: the check could not decide. It is recorded and it does not block,
    // because answering `failed` there would refuse a write on no evidence.
    const { run } = scriptedCommands(
      writesReport(report({ tests: 0, failures: 0, cases: "" }), 1),
    );
    expect(await testsStage(COMMANDS, run)(TARGETS)).toMatchObject({ status: "advisory" });
  });

  test("a test command that could not be run is infra-failed", async () => {
    const { run } = scriptedCommands((effect) => ({ effect, outcome: "infra-failed" }));
    expect(await testsStage(COMMANDS, run)(TARGETS)).toMatchObject({ status: "infra-failed" });
  });
});

describe("the oracle measurement", () => {
  const MEASURE = { root: "/repo", file: "test/todo.test.ts", selector: "marks it done" };

  test("composes the declared ORACLE command, and reports the argv it ran", async () => {
    // A reader has to be able to run it by hand, so the command travels with
    // the verdict.
    const { run, calls } = scriptedCommands(
      writesReport(
        report({ tests: 1, failures: 1, cases: `<testcase name="marks it done"><failure /></testcase>` }),
        1,
      ),
    );
    const measured = await measureStage(COMMANDS, run)(MEASURE);

    expect(measured).toMatchObject({ verdict: "red", axis: "counts", exitCode: 1 });
    expect(measured?.counts).toEqual({ passed: 0, failed: 1, errored: 0 });
    expect(measured?.argv.slice(0, 4)).toEqual([
      "run-oracle",
      "test/todo.test.ts",
      "--only",
      "marks it done",
    ]);
    expect(calls).toHaveLength(1);
  });

  test("exit zero is green, which before any production code is a person's problem", async () => {
    const { run } = scriptedCommands(
      writesReport(report({ tests: 1, failures: 0, cases: `<testcase name="x" />` }), 0),
    );
    expect(await measureStage(COMMANDS, run)(MEASURE)).toMatchObject({ verdict: "green" });
  });

  test("an error in the oracle's own scaffolding is broken, not red", async () => {
    const { run } = scriptedCommands(
      writesReport(
        report({ tests: 1, failures: 0, errors: 1, cases: `<testcase name="x"><error /></testcase>` }),
        1,
      ),
    );
    expect(await measureStage(COMMANDS, run)(MEASURE)).toMatchObject({
      verdict: "broken",
      axis: "counts",
    });
  });

  test("no report at all is broken on the no-summary axis", async () => {
    const { run } = scriptedCommands((effect) => exitedWith(effect, 1, "SyntaxError"));
    expect(await measureStage(COMMANDS, run)(MEASURE)).toMatchObject({
      verdict: "broken",
      axis: "no-summary",
    });
  });

  test("a runner that never started is undefined: nothing is claimed about the oracle", async () => {
    // And in particular the defect is not charged to its author.
    const { run } = scriptedCommands(
      (effect): EffectResult => ({ effect, outcome: "infra-failed" }),
    );
    expect(await measureStage(COMMANDS, run)(MEASURE)).toBeUndefined();
  });

  test("a runner killed at its budget is undefined too: it produced no exit to read", async () => {
    const { run } = scriptedCommands(
      (effect): EffectResult => ({
        effect,
        outcome: "infra-failed",
        command: { exitCode: null, stdout: "started", stderr: "", durationMs: 5, timedOut: true },
      }),
    );
    expect(await measureStage(COMMANDS, run)(MEASURE)).toBeUndefined();
  });

  test("a bare path measures the whole file, with no selector in the command", async () => {
    const { run, calls } = scriptedCommands(
      writesReport(report({ tests: 1, failures: 0, cases: `<testcase name="x" />` }), 0),
    );
    await measureStage(COMMANDS, run)({ root: "/repo", file: "test/todo.test.ts" });
    expect(calls[0]?.argv.slice(0, 2)).toEqual(["run-oracle", "test/todo.test.ts"]);
    expect(calls[0]?.argv).not.toContain("--only");
  });
});
