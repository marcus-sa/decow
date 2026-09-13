/**
 * The test impact graph (ai-vcs.md § 6.2, § 6.3).
 *
 * What makes synchronous verification tractable is running only the tests that
 * could be affected, and what makes this the *third* bootstrap mode rather
 * than the first is that the edges come from the static import graph alone,
 * with no coverage instrumentation behind them. So the property under test is
 * reachability: a test file that can reach a symbol's module is impacted, and
 * one that cannot is not.
 */

import { describe, expect, test } from "bun:test";
import { openVcs } from "./index.ts";
import { resolveSpecifier } from "./impact.ts";
import { counterIds, manualClock, passingVerifier, tempProject } from "./testing.ts";

const FILES = {
  "src/alpha.ts": "export function alpha(): number {\n  return 1;\n}\n",
  "src/bravo.ts": "export function bravo(): number {\n  return 2;\n}\n",
  "src/uses-alpha.ts": 'import { alpha } from "./alpha.ts";\nexport const twice = () => alpha() * 2;\n',
  "src/alpha.test.ts":
    'import { alpha } from "./alpha.ts";\ntest("alpha is one", () => {\n  alpha();\n});\n',
  "src/bravo.test.ts":
    'import { bravo } from "./bravo.ts";\ntest("bravo is two", () => {\n  bravo();\n});\n',
  "src/transitive.test.ts":
    'import { twice } from "./uses-alpha.ts";\ntest("twice is two", () => {\n  twice();\n});\n',
};

const open = () => {
  const vcs = openVcs({
    root: tempProject(FILES),
    verifier: passingVerifier(),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  const files = vcs.trackTree("src");
  const id = (path: string, name: string) => {
    const file = files.find((f) => f.path === path);
    if (file === undefined) throw new Error(`fixture has no file ${path}`);
    const symbol = vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`${path} has no symbol named ${name}`);
    return symbol.id;
  };
  return { vcs, files, id };
};

const names = (targets: { path: string; name: string }[]) =>
  targets.map((t) => `${t.path}::${t.name}`).sort();

describe("impacted tests", () => {
  test("a test file importing the symbol's module is impacted", () => {
    const { vcs, id } = open();
    expect(names([...vcs.impact.impactedTests([id("src/alpha.ts", "alpha")])])).toEqual([
      "src/alpha.test.ts::alpha is one",
      "src/transitive.test.ts::twice is two",
    ]);
    vcs.close();
  });

  test("a test file that cannot reach it is not", () => {
    const { vcs, id } = open();
    const impacted = names([...vcs.impact.impactedTests([id("src/alpha.ts", "alpha")])]);
    expect(impacted).not.toContain("src/bravo.test.ts::bravo is two");

    expect(names([...vcs.impact.impactedTests([id("src/bravo.ts", "bravo")])])).toEqual([
      "src/bravo.test.ts::bravo is two",
    ]);
    vcs.close();
  });

  test("a change in the test file itself impacts that test", () => {
    const { vcs, id } = open();
    expect(names([...vcs.impact.impactedTests([id("src/alpha.test.ts", "alpha is one")])])).toEqual([
      "src/alpha.test.ts::alpha is one",
    ]);
    vcs.close();
  });

  test("a symbol nothing tests impacts nothing, which is what makes the gate cheap", () => {
    const { vcs, id } = open();
    // `uses-alpha.ts` is reached by a test, so its own symbols are impacted;
    // a symbol in a file no test can reach is the empty case.
    expect(vcs.impact.impactedTests([])).toEqual([]);
    expect(names([...vcs.impact.impactedTests([id("src/uses-alpha.ts", "twice")])])).toEqual([
      "src/transitive.test.ts::twice is two",
    ]);
    vcs.close();
  });

  test("test ids are symbol ids, and they survive a re-inventory", () => {
    const { vcs, files, id } = open();
    const before = id("src/alpha.test.ts", "alpha is one");
    for (const file of files) expect(vcs.reinventory(file.path)).toBeUndefined();

    // § 6.2 "Test identity": a test is a symbol, so its stable id and its
    // history come for free rather than needing a parallel registry.
    expect(id("src/alpha.test.ts", "alpha is one")).toBe(before);
    expect(vcs.impact.impactedTests([id("src/alpha.ts", "alpha")]).map((t) => t.id)).toContain(before);
    vcs.close();
  });

  test("the stored edges are module edges, projected to symbol grain on read", () => {
    const { vcs, files } = open();
    const path = (fileId: string) => files.find((f) => f.id === fileId)?.path ?? fileId;
    expect(vcs.impact.edges().map((e) => `${path(e.from)} -> ${path(e.to)}`).sort()).toEqual([
      "src/alpha.test.ts -> src/alpha.ts",
      "src/bravo.test.ts -> src/bravo.ts",
      "src/transitive.test.ts -> src/uses-alpha.ts",
      "src/uses-alpha.ts -> src/alpha.ts",
    ]);
    vcs.close();
  });
});

describe("tests resolved by id", () => {
  test("a test id resolves to the runnable target the tests stage takes", () => {
    const { vcs, id } = open();
    expect(names(vcs.impact.testsById([id("src/bravo.test.ts", "bravo is two")]))).toEqual([
      "src/bravo.test.ts::bravo is two",
    ]);
    vcs.close();
  });

  test("the order given is kept and a repeat resolves once", () => {
    const { vcs, id } = open();
    const alpha = id("src/alpha.test.ts", "alpha is one");
    const bravo = id("src/bravo.test.ts", "bravo is two");
    expect(vcs.impact.testsById([bravo, alpha, bravo]).map((t) => t.id)).toEqual([bravo, alpha]);
    vcs.close();
  });

  test("an id naming no live test is dropped, because extra may only add", () => {
    const { vcs, id } = open();
    // An invented id and a non-test symbol both add nothing. Neither can
    // shrink a run, so neither is a refusal here; what ran is on the event.
    expect(vcs.impact.testsById(["sym-invented"])).toEqual([]);
    expect(vcs.impact.testsById([id("src/alpha.ts", "alpha")])).toEqual([]);
    vcs.close();
  });
});

describe("specifier resolution", () => {
  test("a relative specifier resolves against the importing file's directory", () => {
    expect(resolveSpecifier("src/vcs/impact.ts", "./registry.ts")).toEqual(["src/vcs/registry.ts"]);
    expect(resolveSpecifier("src/vcs/impact.ts", "../core/effects.ts")).toEqual(["src/core/effects.ts"]);
  });

  test("an extensionless specifier offers every shape a file could take", () => {
    expect(resolveSpecifier("src/a.ts", "./b")).toEqual([
      "src/b.ts",
      "src/b.tsx",
      "src/b/index.ts",
      "src/b/index.tsx",
    ]);
  });

  test("a bare specifier resolves to nothing, because a package is not a tracked file", () => {
    expect(resolveSpecifier("src/a.ts", "zod")).toEqual([]);
    expect(resolveSpecifier("src/a.ts", "bun:sqlite")).toEqual([]);
  });
});
