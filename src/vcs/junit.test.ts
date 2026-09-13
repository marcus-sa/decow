/**
 * The one JUnit reader, against the five shapes a run can leave behind.
 *
 * Four of them are documents. The fifth is the ABSENCE of one, and it is the
 * one that earns the module: a runner that could not load a test file writes
 * no report at all, and "no report" and "a report that counts nothing" are
 * opposite claims. The verdict rule branches on which, so this is where the
 * difference is pinned.
 *
 * The fixtures are bun 1.3.12's own output, copied verbatim from a run rather
 * than written from the spec.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countsOf, failingNames, parseJunit, readJunit } from "./junit.ts";

const PASS = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.004">
  <testsuite name="a.test.ts" file="a.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0">
    <testcase name="passes" classname="" time="0" file="a.test.ts" line="2" assertions="1" />
  </testsuite>
</testsuites>
`;

const ONE_FAILURE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="2" failures="1" skipped="0" time="0.004">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="2" failures="1" skipped="0" time="0">
    <testcase name="passes" classname="" time="0" file="a.test.ts" line="2" assertions="1" />
    <testcase name="fails" classname="" time="0" file="a.test.ts" line="3" assertions="1">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;

/**
 * An `<error>` rather than a `<failure>`. bun does not distinguish the two, so
 * this is another runner's document; the reader handles both because the
 * format does and because `errored` is what tells `broken` from `red`.
 */
const ONE_ERROR = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="pytest" tests="2" failures="0" errors="1" skipped="0" time="0.1">
  <testsuite name="suite" tests="2" failures="0" errors="1" skipped="0">
    <testcase name="passes" />
    <testcase name="explodes"><error message="fixture blew up" /></testcase>
  </testsuite>
</testsuites>
`;

const EMPTY = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="0" assertions="0" failures="0" skipped="0" time="0" />
`;

/** A selector that matched nothing: the tests exist and every one was skipped. */
const ALL_SKIPPED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2" assertions="0" failures="0" skipped="2" time="0.004">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2" assertions="0" failures="0" skipped="2" time="0">
    <testcase name="passes"><skipped /></testcase>
    <testcase name="fails"><skipped /></testcase>
  </testsuite>
</testsuites>
`;

describe("the JUnit reader", () => {
  test("a passing run", () => {
    expect(parseJunit(PASS)).toEqual({
      tests: 1,
      failures: 0,
      errors: 0,
      skipped: 0,
      cases: [{ name: "passes", status: "passed" }],
    });
  });

  test("one failure, named", () => {
    const report = parseJunit(ONE_FAILURE);
    expect(report).toMatchObject({ tests: 2, failures: 1, errors: 0 });
    expect(report?.cases).toEqual([
      { name: "passes", status: "passed" },
      { name: "fails", status: "failed" },
    ]);
    expect(failingNames(report?.cases ?? [])).toEqual(["fails"]);
  });

  test("one error, which is a different word from one failure", () => {
    // The distinction the whole verdict rule turns on: an oracle that broke in
    // its own scaffolding is not an oracle that failed its assertion.
    const report = parseJunit(ONE_ERROR);
    expect(report).toMatchObject({ tests: 2, failures: 0, errors: 1 });
    expect(report?.cases).toEqual([
      { name: "passes", status: "passed" },
      { name: "explodes", status: "errored" },
    ]);
    expect(countsOf(report!)).toEqual({ passed: 1, failed: 1, errored: 1 });
  });

  test("an empty suite is a report that counted nothing, not a missing report", () => {
    expect(parseJunit(EMPTY)).toEqual({ tests: 0, failures: 0, errors: 0, skipped: 0, cases: [] });
    expect(countsOf(parseJunit(EMPTY)!)).toEqual({ passed: 0, failed: 0, errored: 0 });
  });

  test("a skipped run counts no passes, which is what makes it indeterminate", () => {
    expect(countsOf(parseJunit(ALL_SKIPPED)!)).toEqual({ passed: 0, failed: 0, errored: 0 });
  });

  test("a suite with no wrapper is summed from its own elements", () => {
    const report = parseJunit(
      `<testsuite name="s" tests="3" failures="1" errors="0" skipped="0"><testcase name="x" /></testsuite>`,
    );
    expect(report).toMatchObject({ tests: 3, failures: 1 });
  });

  test("malformed XML is undefined, and never a throw", () => {
    // The path exists to read what a CRASHED runner left behind, so a reader
    // that could throw on a half-written file is the wrong reader.
    for (const junk of ["", "not xml at all", "<testsuites", "<html><body>nope</body></html>", "\\0\\0"]) {
      expect(() => parseJunit(junk)).not.toThrow();
      expect(parseJunit(junk)).toBeUndefined();
    }
  });

  test("a name carrying entities comes back unescaped", () => {
    const report = parseJunit(
      `<testsuites tests="1" failures="0"><testcase name="a &amp; b &lt;c&gt;" /></testsuites>`,
    );
    expect(report?.cases[0]?.name).toBe("a & b <c>");
  });
});

describe("reading a report off disk", () => {
  const write = (name: string, body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "dw-junit-test-"));
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    return path;
  };

  test("no file at all means no counts: the runner ran nothing", () => {
    // Which the verdict rule reads as `broken` on its `no-summary` axis. An
    // import that does not resolve lands here.
    expect(readJunit(join(tmpdir(), "dw-junit-there-is-no-such-file.xml"))).toEqual({
      cases: [],
    });
  });

  test("a file nobody can count means ZERO counts: nothing was established", () => {
    // Different from the line above, and the difference is the whole reason
    // the two are separate answers. A non-zero exit over these zeros is
    // `indeterminate`, not `broken`.
    expect(readJunit(write("junk.xml", "<not-a-report/>"))).toEqual({
      counts: { passed: 0, failed: 0, errored: 0 },
      cases: [],
    });
  });

  test("a readable file comes back as counts and cases", () => {
    expect(readJunit(write("ok.xml", ONE_FAILURE))).toEqual({
      counts: { passed: 1, failed: 1, errored: 0 },
      cases: [
        { name: "passes", status: "passed" },
        { name: "fails", status: "failed" },
      ],
    });
  });
});
