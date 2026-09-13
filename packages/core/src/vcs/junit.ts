/**
 * One JUnit XML reader, for every place a verdict is read off a test run.
 *
 * The tests stage and the oracle measurement both ask "what did the runner
 * do". Scraping a runner's stdout for its own summary lines would make the
 * verdict a function of one runner's human output, leaving a consumer with any
 * other runner unmeasurable. A JUnit report is the interchange format every
 * test runner already writes, so the consumer's declared command names where
 * to put one and this module reads it.
 *
 * Deliberately regex over a tag stream rather than a real XML parser. The
 * shape is fixed and tiny — a `<testsuites>` element with four count
 * attributes, and one `<testcase>` per test with an optional status child —
 * and a dependency that could throw on a half-written file is exactly the
 * wrong thing on a path whose whole job is to read what a crashed runner left
 * behind. Nothing here throws.
 *
 * THE ABSENT / UNREADABLE SPLIT IS LOAD-BEARING, and it is what lets the
 * verdict rule stay unchanged:
 *
 *   no file at all      the runner never got as far as writing one, so it ran
 *                       nothing. Counts are `undefined`, and the verdict rule
 *                       reads that as `broken` on its `no-summary` axis. A
 *                       test file whose import does not resolve lands here
 *   a file it cannot    the runner wrote something no reader can count, so
 *   count               nothing was ESTABLISHED. Counts are zeros, and a
 *                       non-zero exit over them is `indeterminate`, which is
 *                       precisely "it failed and its own summary records
 *                       neither a failure nor an error"
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import { readFileSync } from "node:fs";

/** What one test case did. `errored` is JUnit's `<error>`, not `<failure>`. */
export const JUNIT_CASE_STATUSES = ["passed", "failed", "errored", "skipped"] as const;
export type JunitCaseStatus = (typeof JUNIT_CASE_STATUSES)[number];

/** One `<testcase>`, as much of it as a verdict depends on. */
export type JunitCase = { name: string; status: JunitCaseStatus };

/** One report. The counts are the document's own, not a recount of the cases. */
export type JunitReport = {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  cases: JunitCase[];
};

/**
 * The runner's own summary of one run, in the three numbers a verdict needs.
 *
 * `failed` is failures PLUS errors, because both are tests that did not pass;
 * `errored` is errors alone, because a test that broke in its own scaffolding
 * is a different defect with a different owner, and telling the two apart is
 * the whole reason the counts are read rather than the exit status.
 */
export type RunCounts = { passed: number; failed: number; errored: number };

/** One attribute off one tag. Absent, or unparseable as a number, is undefined. */
const attribute = (tag: string, name: string): number | undefined => {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
};

/** Undo the five entities a JUnit writer escapes a test name with. */
const unescape = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Every `<testcase>` in the document, with the status its body declares. */
const cases = (xml: string): JunitCase[] => {
  const found: JunitCase[] = [];
  // Either `<testcase … />` or `<testcase …> … </testcase>`; the second form
  // is the only one that can carry a status child.
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const attributes = match[1] ?? "";
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
    if (name === undefined) continue;
    const body = match[3] ?? "";
    const status: JunitCaseStatus = /<error\b/.test(body)
      ? "errored"
      : /<failure\b/.test(body)
        ? "failed"
        : /<skipped\b/.test(body)
          ? "skipped"
          : "passed";
    found.push({ name: unescape(name), status });
  }
  return found;
};

/**
 * The report a JUnit document holds, or `undefined` when it holds none.
 *
 * The counts come from `<testsuites>` when the document has one and from the
 * sum of its `<testsuite>` elements when it does not, because a runner that
 * writes a single suite may omit the wrapper. A document with neither is not a
 * JUnit report and this says so rather than guessing zeros.
 */
export const parseJunit = (xml: string): JunitReport | undefined => {
  const suites = /<testsuites\b[^>]*>/.exec(xml)?.[0];
  const found = cases(xml);

  if (suites !== undefined && attribute(suites, "tests") !== undefined) {
    return {
      tests: attribute(suites, "tests") ?? 0,
      failures: attribute(suites, "failures") ?? 0,
      errors: attribute(suites, "errors") ?? 0,
      skipped: attribute(suites, "skipped") ?? 0,
      cases: found,
    };
  }

  const perSuite = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((m) => m[0]);
  if (perSuite.length === 0) return undefined;
  const sum = (name: string): number =>
    perSuite.reduce((total, tag) => total + (attribute(tag, name) ?? 0), 0);
  if (perSuite.every((tag) => attribute(tag, "tests") === undefined)) return undefined;
  return {
    tests: sum("tests"),
    failures: sum("failures"),
    errors: sum("errors"),
    skipped: sum("skipped"),
    cases: found,
  };
};

/**
 * What one run's JUnit report at `path` says, in the two things a verdict and
 * a rejection need: the counts, and which cases did not pass.
 *
 * Absent counts and zero counts are different answers; see the header.
 */
export type JunitRead = { counts?: RunCounts; cases: readonly JunitCase[] };

export const readJunit = (path: string): JunitRead => {
  let xml: string;
  try {
    xml = readFileSync(path, "utf8");
  } catch {
    // The runner never wrote one, so it ran nothing.
    return { cases: [] };
  }
  const report = parseJunit(xml);
  if (report === undefined) {
    // It wrote something no reader can count. Nothing was established, which
    // a non-zero exit over these zeros reads as `indeterminate`.
    return { counts: { passed: 0, failed: 0, errored: 0 }, cases: [] };
  }
  return { counts: countsOf(report), cases: report.cases };
};

/** A report's counts, in the vocabulary the verdict rule is written over. */
export const countsOf = (report: JunitReport): RunCounts => ({
  passed: Math.max(0, report.tests - report.failures - report.errors - report.skipped),
  failed: report.failures + report.errors,
  errored: report.errors,
});

/** The names of every case that did not pass. What a rejection names. */
export const failingNames = (cases: readonly JunitCase[]): string[] =>
  cases.filter((c) => c.status === "failed" || c.status === "errored").map((c) => c.name);
