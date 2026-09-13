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

/** This file is `<repo>/packages/core/src/harness/no-nondeterminism.test.ts`. */
const SRC = dirname(dirname(import.meta.path));

/**
 * The repository root. Every scanned path is reported relative to it, so a
 * failure names `packages/core/src/core/compile.ts` rather than a path that
 * only means something inside one package.
 */
const REPO = dirname(dirname(dirname(SRC)));

/** `<repo>/examples`, where a consumer's waves live. */
const EXAMPLES = join(REPO, "examples");

/** `<repo>/targets`, where a consumer declares its own commands. */
const TARGETS = join(REPO, "targets");

/** Literal source fragments that introduce nondeterminism into a decision. */
const BANNED = ["Date.now", "Math.random", "new Date(", "randomUUID"] as const;

/**
 * The agent-native VCS takes its clock and its id generator as constructor
 * arguments so that a lease TTL is a function call rather than a wait and an
 * event log is comparable across runs. `@des/core`'s own `vcs/defaults.ts` is
 * the one file allowed to supply the real ones, so it is the one file excluded.
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
 * clock would make the oracle a different roadmap on every run. DISTILL's
 * `manifest.ts` is the same shape one wave over: `validate-manifest` is a pure
 * function of the proposal and the roadmap.
 *
 * The scheduler is scanned for the same reason the compiler is: it decides
 * which steps run, and a frontier that depended on when it was computed would
 * make a feature's delivery order a function of the clock.
 *
 * A TARGET's `commands.ts` is scanned too, and it is the one scanned file that
 * is not this repository's. It is consumer code rather than steps, and it is
 * read on every write: a declaration that built a temp path out of a clock, or
 * a seed out of an RNG, would make the same write produce a different command
 * on every run, which is the property this whole scan exists to hold. The glob
 * is `targets/*` rather than `targets/todo` so a second target is scanned the
 * day it lands.
 *
 * The examples are a second root rather than a subdirectory of the first:
 * `examples/` sits beside `packages/` at the repository root, because a
 * consumer's waves are not the framework. The globs are relative to that root,
 * and they
 * are deliberately NOT narrowed to `nwave/**`: a second consumer's example set
 * must be scanned the day it lands, not the day somebody remembers to add a
 * glob for it.
 */
const scanned = async (): Promise<string[]> => {
  const files = new Set<string>([
    join(SRC, "core/workflow.ts"),
    join(SRC, "core/compile.ts"),
    join(SRC, "core/scheduler.ts"),
  ]);
  const roots: readonly (readonly [string, readonly string[]])[] = [
    [
      EXAMPLES,
      [
        "**/graph.ts",
        "**/manifest.ts",
        "**/steps.ts",
        "**/shape.ts",
        "**/disjointness.ts",
        "**/schema.ts",
        "**/fixture.ts",
        "**/oracle.ts",
        "**/pipeline.ts",
      ],
    ],
    [SRC, ["artifacts/**/*.ts", "vcs/**/*.ts"]],
  ];
  for (const [cwd, patterns] of roots) {
    for (const pattern of patterns) {
      for await (const match of new Glob(pattern).scan({ cwd, absolute: true })) {
        if (match.endsWith(".test.ts") || EXEMPT.has(match)) continue;
        files.add(match);
      }
    }
  }
  for await (const match of new Glob("*/commands.ts").scan({ cwd: TARGETS, absolute: true })) {
    files.add(match);
  }
  return [...files].sort();
};

/** Strip line and block comments so a banned name in prose is not a hit. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("no nondeterminism inside the graph", () => {
  test("the scanned set is non-empty and includes the runner and every graph", async () => {
    const files = (await scanned()).map((f) => relative(REPO, f));
    expect(files).toContain("packages/core/src/core/workflow.ts");
    expect(files).toContain("packages/core/src/core/compile.ts");
    expect(files).toContain("examples/nwave/deliver/graph.ts");
    expect(files).toContain("examples/nwave/distill/manifest.ts");
    expect(files).toContain("examples/nwave/distill/obligations/graph.ts");
    expect(files).toContain("examples/nwave/distill/oracle/graph.ts");
    expect(files).toContain("examples/nwave/distill/pipeline.ts");
    expect(files).toContain("examples/nwave/roadmap/graph.ts");
    expect(files).toContain("examples/nwave/roadmap/shape.ts");
    expect(files).toContain("examples/nwave/roadmap/disjointness.ts");
    expect(files).toContain("packages/core/src/core/scheduler.ts");
    expect(files).toContain("examples/nwave/deliver/pipeline.ts");
    expect(files).toContain("packages/core/src/artifacts/store.ts");
    expect(files).toContain("packages/core/src/vcs/registry.ts");
    expect(files).toContain("packages/core/src/vcs/leases.ts");
    expect(files).toContain("packages/core/src/vcs/writes.ts");
    expect(files).toContain("packages/core/src/vcs/executor.ts");
    expect(files).toContain("packages/core/src/vcs/structural/typescript.ts");
    expect(files).not.toContain("packages/core/src/vcs/defaults.ts");
    // The consumer's own declaration of how its project is built and tested.
    expect(files).toContain("targets/todo/commands.ts");
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  test("no scanned file reads a clock or an RNG", async () => {
    const offenders: string[] = [];
    for (const file of await scanned()) {
      const lines = stripComments(await Bun.file(file).text()).split("\n");
      lines.forEach((line, i) => {
        for (const banned of BANNED) {
          if (line.includes(banned)) {
            offenders.push(`${relative(REPO, file)}:${i + 1} uses ${banned}: ${line.trim()}`);
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

  test("a target's declared commands are scanned, and a clock in one would fail", async () => {
    // The one scanned file that is not this repository's. It is read on every
    // write, so a declaration built out of a clock would make the same write
    // produce a different command on every run.
    const declared = await Bun.file(join(TARGETS, "todo", "commands.ts")).text();
    expect(BANNED.some((b) => stripComments(declared).includes(b))).toBe(false);
    expect((await scanned()).some((f) => f.endsWith("targets/todo/commands.ts"))).toBe(true);
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
