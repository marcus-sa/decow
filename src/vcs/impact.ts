/**
 * The test impact graph (ai-vcs.md § 6.2, § 6.3).
 *
 * Running the whole suite on every write is what makes synchronous
 * verification intractable, so the pipeline runs only the tests that could be
 * affected by the symbols a write touched.
 *
 * This is § 6.3's third bootstrap mode, and only that: the static graph alone,
 * with no coverage refinement. The edge that is stored is the module import
 * edge; a test is impacted by a symbol when the test's file can reach the
 * symbol's file through imports, or is that file. Coverage instrumentation,
 * which is what would catch dynamic dispatch and injection, is not built.
 *
 * The approximation is stated rather than hidden, as § 6.2 asks. It
 * over-approximates, because importing a module does not mean exercising every
 * symbol in it, and it under-approximates for anything that crosses a module
 * boundary without an import: a fixture file, an environment variable, a
 * subprocess. The write path treats the result as the primary signal and not
 * as an exhaustive one.
 *
 * Test identity is free (§ 6.2 "Test identity"): a test is a symbol of kind
 * `test`, so it already has a stable id that survives renaming and moving the
 * file it lives in.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import type { Database } from "bun:sqlite";
import { dirname, posix } from "node:path";
import type { Registry } from "./registry.ts";
import type { TestTarget } from "./verify.ts";

export type ImpactGraph = {
  /**
   * Record the files one file imports. Only the graph is stored; the reverse
   * index from a symbol to its tests is projected at query time, so adding a
   * file never invalidates a materialised index.
   */
  observe(fileId: string, path: string, imports: readonly string[]): void;
  /** Tests whose outcome a change to these symbols could affect. */
  impactedTests(symbolIds: readonly string[]): TestTarget[];
  /**
   * Resolve test ids to runnable targets, in the order given, without
   * duplicates. This is how a selection a workflow made *above* the impact
   * floor becomes something the tests stage can run: `extra` on a `run-tests`
   * effect is test ids, and a test is a symbol of kind `test`, so its id is
   * already stable (§ 6.2 "Test identity").
   *
   * An id naming no live test is dropped rather than refused. `extra` may only
   * ADD to the floor, so an id that names nothing adds nothing and cannot
   * shrink the run; what actually ran is recorded on the `tests-run` event, so
   * the drop is visible in provenance rather than silent.
   */
  testsById(ids: readonly string[]): TestTarget[];
  /** The stored module edges, for inspection and for tests. */
  edges(): { from: string; to: string }[];
};

/**
 * Resolve a module specifier against the importing file's root-relative path.
 * Bare specifiers (`zod`, `bun:sqlite`) resolve to nothing: a package is not a
 * tracked file, so a change inside one cannot be attributed to a symbol.
 */
export const resolveSpecifier = (fromPath: string, specifier: string): string[] => {
  if (!specifier.startsWith(".")) return [];
  const base = posix.normalize(posix.join(dirname(fromPath), specifier));
  if (base.endsWith(".ts") || base.endsWith(".tsx")) return [base];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
};

export const openImpactGraph = (db: Database, registry: Registry): ImpactGraph => {
  db.run(`CREATE TABLE IF NOT EXISTS impact_edges (
    from_file_id  TEXT NOT NULL,
    to_file_id    TEXT NOT NULL,
    PRIMARY KEY (from_file_id, to_file_id)
  )`);

  const q = {
    clear: db.query<unknown, [string]>("DELETE FROM impact_edges WHERE from_file_id = ?"),
    insert: db.query<unknown, [string, string]>(
      "INSERT OR IGNORE INTO impact_edges (from_file_id, to_file_id) VALUES (?, ?)",
    ),
    out: db.query<{ to_file_id: string }, [string]>(
      "SELECT to_file_id FROM impact_edges WHERE from_file_id = ?",
    ),
    all: db.query<{ from_file_id: string; to_file_id: string }, []>(
      "SELECT * FROM impact_edges ORDER BY from_file_id, to_file_id",
    ),
  };

  /** The files `start` can reach through imports, including itself. */
  const reachable = (start: string): Set<string> => {
    const seen = new Set([start]);
    const stack = [start];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      for (const row of q.out.all(next)) {
        if (seen.has(row.to_file_id)) continue;
        seen.add(row.to_file_id);
        stack.push(row.to_file_id);
      }
    }
    return seen;
  };

  return {
    observe(fileId, path, imports) {
      q.clear.run(fileId);
      for (const specifier of imports) {
        for (const candidate of resolveSpecifier(path, specifier)) {
          const target = registry.file(candidate);
          if (target !== undefined) q.insert.run(fileId, target.id);
        }
      }
    },

    impactedTests(symbolIds) {
      const wanted = new Set<string>();
      for (const id of symbolIds) {
        const symbol = registry.symbol(id);
        if (symbol !== undefined) wanted.add(symbol.fileId);
      }
      if (wanted.size === 0) return [];

      const targets: TestTarget[] = [];
      for (const file of registry.files()) {
        const tests = registry.symbolsOf(file.id).filter((s) => s.kind === "test");
        if (tests.length === 0) continue;
        const seen = reachable(file.id);
        if (![...wanted].some((f) => seen.has(f))) continue;
        for (const test of tests) targets.push({ id: test.id, path: file.path, name: test.name });
      }
      return targets;
    },

    testsById(ids) {
      const targets: TestTarget[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const symbol = registry.symbol(id);
        if (symbol === undefined || symbol.tombstoned || symbol.kind !== "test") continue;
        const file = registry.fileById(symbol.fileId);
        if (file === undefined) continue;
        targets.push({ id: symbol.id, path: file.path, name: symbol.name });
      }
      return targets;
    },

    edges: () => q.all.all().map((r) => ({ from: r.from_file_id, to: r.to_file_id })),
  };
};
