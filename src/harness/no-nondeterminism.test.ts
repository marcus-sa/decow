/**
 * No nondeterminism inside the graph.
 *
 * The runner and every decision function must be pure over their inputs. A
 * wall-clock read or an RNG call inside `mergeVerdict` would make the path a
 * model takes depend on when it ran, which is the property the whole design
 * exists to remove. This is the mechanical enforcement of that rule.
 *
 * Leaf model calls are exempt by construction: they live behind a ModelBinding
 * and their outputs are journaled, so replay never re-infers.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { dirname, join, relative } from "node:path";

/** This file is `<src>/harness/no-nondeterminism.test.ts`. */
const SRC = dirname(dirname(import.meta.path));

/** Literal source fragments that introduce nondeterminism into a decision. */
const BANNED = ["Date.now", "Math.random", "new Date(", "randomUUID"] as const;

/**
 * The agent-native VCS takes its clock and its id generator as constructor
 * arguments so that a lease TTL is a function call rather than a wait and an
 * event log is comparable across runs. `src/vcs/defaults.ts` is the one file
 * allowed to supply the real ones, so it is the one file excluded.
 */
const EXEMPT = new Set([join(SRC, "vcs/defaults.ts")]);

/**
 * Files the graph's control flow depends on: the contract, the compiler that
 * turns it into a Mastra workflow, every graph definition, every file that
 * defines a decision function or a mechanical check a branch can observe, and
 * the whole of the VCS module, whose determinism rests on the same rule one
 * layer down.
 *
 * The roadmap example puts two decision functions in their own files, because
 * `validate-shape` and `measure-disjointness` are pure functions rather than
 * leaves. A clock read in either would make the shape of a roadmap depend on
 * when it was authored, so they are scanned like any branch's `on`. Its
 * schemas and its hand-written fixtures are scanned too: a fixture that read a
 * clock would make the oracle a different roadmap on every run.
 */
const scanned = async (): Promise<string[]> => {
  const files = new Set<string>([join(SRC, "core/workflow.ts"), join(SRC, "core/compile.ts")]);
  for (const pattern of [
    "examples/**/graph.ts",
    "examples/**/classify.ts",
    "examples/**/steps.ts",
    "examples/**/shape.ts",
    "examples/**/disjointness.ts",
    "examples/**/schema.ts",
    "examples/**/fixture.ts",
    "vcs/**/*.ts",
  ]) {
    for await (const match of new Glob(pattern).scan({ cwd: SRC, absolute: true })) {
      if (match.endsWith(".test.ts") || EXEMPT.has(match)) continue;
      files.add(match);
    }
  }
  return [...files].sort();
};

/** Strip line and block comments so a banned name in prose is not a hit. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("no nondeterminism inside the graph", () => {
  test("the scanned set is non-empty and includes the runner and every graph", async () => {
    const files = (await scanned()).map((f) => relative(SRC, f));
    expect(files).toContain("core/workflow.ts");
    expect(files).toContain("core/compile.ts");
    expect(files).toContain("examples/distill/graph.ts");
    expect(files).toContain("examples/deliver/graph.ts");
    expect(files).toContain("examples/roadmap/graph.ts");
    expect(files).toContain("examples/roadmap/shape.ts");
    expect(files).toContain("examples/roadmap/disjointness.ts");
    expect(files).toContain("vcs/registry.ts");
    expect(files).toContain("vcs/leases.ts");
    expect(files).toContain("vcs/writes.ts");
    expect(files).toContain("vcs/executor.ts");
    expect(files).toContain("vcs/structural/typescript.ts");
    expect(files).not.toContain("vcs/defaults.ts");
    expect(files.length).toBeGreaterThanOrEqual(22);
  });

  test("no scanned file reads a clock or an RNG", async () => {
    const offenders: string[] = [];
    for (const file of await scanned()) {
      const lines = stripComments(await Bun.file(file).text()).split("\n");
      lines.forEach((line, i) => {
        for (const banned of BANNED) {
          if (line.includes(banned)) {
            offenders.push(`${relative(SRC, file)}:${i + 1} uses ${banned}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the one exempt file is the one that supplies the real clock and ids", async () => {
    // The exemption earns its keep only if something is actually behind it: a
    // defaults file that read no clock would mean the injection seam is
    // decorative and the production path is getting its time from elsewhere.
    const source = await Bun.file(join(SRC, "vcs/defaults.ts")).text();
    expect(source).toContain("Date.now");
    expect(source).toContain("randomUUID");
  });

  test("the scanner would catch a planted violation", async () => {
    // Guards the guard: if `stripComments` or the matcher regressed, this fails.
    const planted = stripComments(`
      // Date.now in a comment is fine
      const t = Date.now();
    `);
    expect(BANNED.some((b) => planted.includes(b))).toBe(true);
    expect(stripComments("// Date.now\nconst x = 1;").includes("Date.now")).toBe(false);
  });
});
