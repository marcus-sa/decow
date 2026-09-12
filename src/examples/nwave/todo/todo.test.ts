/**
 * The todo target's run-directory plumbing.
 *
 * The target ships with two stubbed methods and NO test file: the oracle is
 * authored by `des oracle`, not pre-written, so there is nothing here to
 * activate and nothing to strip. What this file covers is the plumbing the
 * commands share — a run directory is a fresh checkout of the template, a
 * second process sees what the first left, and the design source carries the
 * symbol ids a write has to name.
 *
 * The end-to-end path is `../distill/` plus `../deliver/`, driven from the
 * same run directory.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVcs } from "../../../vcs/index.ts";
import { createRunDir, designSource, openRunDir, REPO, RUNS, TARGET } from "./run-dir.ts";
import { REQUEST } from "./request.ts";

/** A temp copy of `targets/todo`, tracked in a fresh VCS with the real gate. */
const openProject = () => {
  const root = mkdtempSync(join(tmpdir(), "dw-todo-"));
  cpSync(TARGET, root, { recursive: true });
  // `tsc` and `bun test` both need `@types/bun`; one symlink beats one install.
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));

  const vcs = openVcs({ root });
  vcs.trackTree("src");

  const symbolId = (path: string, name: string): string => {
    const file = vcs.registry.file(path);
    const symbol = file === undefined ? undefined : vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`the target has no ${path}::${name}`);
    return symbol.id;
  };

  return { root, vcs, symbolId, read: (p: string) => readFileSync(join(root, p), "utf8") };
};

describe("the todo target's run directory", () => {
  test("the template ships two stubs and no test file at all", () => {
    const project = openProject();
    expect(project.read("src/todo.ts")).toContain('throw new Error("not implemented")');
    // There is no oracle to activate: authoring one is `des oracle`'s job, and
    // a pre-written test is the thing this cut deleted.
    expect(() => project.read("test/todo.test.ts")).toThrow();
    project.vcs.close();
  });

  test("a run directory is a fresh checkout, and a second open sees what the first left", () => {
    // The plumbing the three commands share, and the only part of them that
    // is not exercised above: `todo:roadmap` creates the directory and parks,
    // `todo:review` and `todo:deliver` open it again in later processes. Each
    // open is its own VCS, its own stores and its own Mastra runtime over the
    // same five files.
    const name = `_test-${process.pid}`;
    const path = join(RUNS, name);
    try {
      expect(createRunDir(name)).toBe(path);
      // A fresh checkout: the template, copied, untouched.
      const first = openRunDir(name);
      expect(readFileSync(join(first.project, "src/todo.ts"), "utf8")).toContain(
        'throw new Error("not implemented")',
      );
      // Only `src/` exists on a fresh checkout: the oracle is written into
      // `test/` by a later command, and tracking follows what is there.
      expect(first.vcs.registry.files().map((f) => f.path)).toEqual(["src/todo.ts"]);
      first.save({ name, request: REQUEST, roadmapRunId: "run-abc", roadmapReason: "roadmap-ready" });
      first.close();

      // A second process: same files, same tracked symbols, same manifest.
      const second = openRunDir(name);
      expect(second.manifest).toMatchObject({ request: REQUEST, roadmapRunId: "run-abc" });
      expect(second.vcs.registry.files()).toHaveLength(1);
      expect(second.design).toContain("## Symbol inventory");
      second.close();

      // And a run directory is never reused: a second create refuses by name.
      expect(() => createRunDir(name)).toThrow(/already exists/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("the design source carries the symbol ids a write has to name", () => {
    // Without this the real run cannot work at all: `predictedTouches` and
    // `implement`'s `symbolId` are opaque VCS ids assigned at track time, so a
    // model that never saw the inventory names one that does not exist and
    // every write comes back `rejected: contract`.
    const project = openProject();
    const design = designSource(project.root, project.vcs);
    const completeId = project.symbolId("src/todo.ts", "complete");

    expect(design).toContain("## Symbol inventory");
    expect(design).toContain(completeId);
    // And the design document itself is still in there, which is the authority
    // `implement` is refuted against.
    expect(design).toContain("There is no other exported symbol");
    project.vcs.close();
  });
});
