/**
 * The default verification stages, actually run (ai-vcs.md § 6.1).
 *
 * Every other test in this module injects its stages, which is what keeps the
 * write path assertable in milliseconds. That seam is only honest if the
 * production stages behind it work, so this file runs them for real once:
 * `bunx tsc --noEmit` and `bun test <file> -t <name>` against a two-file
 * project on disk, with three writes that differ only in which gate they
 * should trip.
 *
 * The project is a temp directory whose `node_modules` is a symlink to this
 * repo's, so `bunx tsc` resolves the same TypeScript the repo compiles with
 * and nothing is fetched. Measured at roughly two seconds for the whole file,
 * so it is not gated behind an environment variable.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { openVcs, type Vcs } from "./index.ts";
import type { Intent } from "./log.ts";
import { counterIds, manualClock, tempProject } from "./testing.ts";
import { defaultVerifier } from "./verify.ts";

/** This file is `<root>/src/vcs/real-tools.test.ts`. */
const REPO = dirname(dirname(dirname(import.meta.path)));

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      lib: ["ESNext"],
      target: "ESNext",
      module: "Preserve",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: ["bun"],
    },
  },
  null,
  2,
)}\n`;

const LIB = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const LIB_TEST = `import { expect, test } from "bun:test";
import { add } from "./lib.ts";

test("add sums its arguments", () => {
  expect(add(1, 2)).toBe(3);
});
`;

const open = () => {
  const root = tempProject({ "tsconfig.json": TSCONFIG, "lib.ts": LIB, "lib.test.ts": LIB_TEST });
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));

  const vcs = openVcs({ root, verifier: defaultVerifier(), clock: manualClock(1_000), ids: counterIds() });
  // Tracked in dependency order, so the test file's import edge resolves.
  const lib = vcs.track("lib.ts");
  vcs.track("lib.test.ts");
  const add = vcs.registry.symbolsOf(lib.id).find((s) => s.name === "add");
  if (add === undefined) throw new Error("the fixture's `add` was not inventoried");

  return { root, vcs, addId: add.id, read: () => readFileSync(join(root, "lib.ts"), "utf8") };
};

const intent = (symbolId: string): Intent => ({
  taskId: "task-real",
  description: "rewrite add",
  expectedOutcome: { modified: [symbolId] },
});

const write = async (vcs: Vcs, symbolId: string, body: string) => {
  const acquired = vcs.acquire({
    session: "session-real",
    symbolIds: [symbolId],
    mode: "write",
    ttlMs: 60_000,
    intent: intent(symbolId),
  });
  if (acquired.outcome !== "granted") throw new Error(`expected a lease, got ${JSON.stringify(acquired)}`);
  const version = vcs.registry.symbol(symbolId)?.version ?? 0;
  const result = await vcs.replaceSymbolBody({
    leaseId: acquired.leaseId,
    symbolId,
    expectedVersion: version,
    body,
    intent: intent(symbolId),
  });
  vcs.release(acquired.leaseId);
  return result;
};

describe("the default verification stages, run for real", () => {
  test("the impact graph really selects the test that imports the symbol", () => {
    const { vcs, addId } = open();
    expect(vcs.impact.impactedTests([addId])).toEqual([
      { id: expect.any(String), path: "lib.test.ts", name: "add sums its arguments" },
    ]);
    vcs.close();
  });

  test("a change that typechecks and passes its impacted test commits", async () => {
    const { vcs, addId, read } = open();
    const result = await write(
      vcs,
      addId,
      "export function add(a: number, b: number): number {\n  const total = a + b;\n  return total;\n}",
    );

    expect(result).toMatchObject({ outcome: "committed", version: 2, verification: "passed" });
    expect(read()).toContain("const total = a + b;");
    vcs.close();
  });

  test("a change that does not typecheck is rejected by tsc, and rolled back", async () => {
    const { vcs, addId, read } = open();
    const result = await write(
      vcs,
      addId,
      'export function add(a: number, b: number): number {\n  return "not a number";\n}',
    );

    expect(result).toMatchObject({ outcome: "rejected", by: "typecheck" });
    expect(result.outcome === "rejected" && result.detail).toContain("TS2322");
    expect(read()).toBe(LIB);
    vcs.close();
  });

  test("a change that typechecks but breaks its impacted test is rejected by bun test", async () => {
    const { vcs, addId, read } = open();
    const result = await write(
      vcs,
      addId,
      "export function add(a: number, b: number): number {\n  return a - b;\n}",
    );

    // The two stages are distinguishable on purpose: the same edit passed the
    // cheaper gate and failed the expensive one, which is the ordering § 6.1
    // exists for.
    expect(result).toMatchObject({ outcome: "rejected", by: "tests" });
    expect(result.outcome === "rejected" && result.detail).toContain("lib.test.ts :: add sums its arguments");
    expect(read()).toBe(LIB);
    vcs.close();
  });
});
