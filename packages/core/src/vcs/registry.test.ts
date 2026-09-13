/**
 * Identity through change, and what happens when a change arrives with no
 * declaration behind it (ai-vcs.md § 3.2, § 4.3, § 9.1).
 *
 * The property under test is the one the whole design rests on: a symbol's id
 * survives a rename because a declared rename said so, and a symbol that
 * disappears without a declaration is a desync rather than a guess. The second
 * half is the conservative default § 9.1 chooses, and it is the reason the
 * registry never has to ask whether a deleted-and-recreated symbol "is the
 * same".
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openVcs, type Vcs } from "./index.ts";
import type { RegisteredSymbol } from "./registry.ts";
import { counterIds, manualClock, passingVerifier, tempProject } from "./testing.ts";
import type { Intent } from "./log.ts";

/** This file is `<root>/packages/core/src/vcs/registry.test.ts`. */
const PACKAGE = dirname(dirname(dirname(import.meta.path)));

const open = (files: Readonly<Record<string, string>>) => {
  const root = tempProject(files);
  const vcs = openVcs({
    root,
    verifier: passingVerifier(),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  return { root, vcs };
};

const intent = (expectedOutcome: Intent["expectedOutcome"]): Intent => ({
  taskId: "task-1",
  description: "rename the thing the design renamed",
  expectedOutcome,
});

/** Acquire, or fail the test with the refusal rather than a type error. */
const granted = (vcs: Vcs, symbolIds: string[], mode: "write" | "exclusive", outcome: Intent["expectedOutcome"]) => {
  const result = vcs.acquire({
    session: "session-a",
    symbolIds,
    mode,
    ttlMs: 5_000,
    intent: intent(outcome),
  });
  if (result.outcome !== "granted") throw new Error(`expected a lease, got ${JSON.stringify(result)}`);
  return result;
};

const TWO_FUNCTIONS = `export function alpha(): number {
  return 1;
}

export function bravo(): number {
  return 2;
}
`;

describe("identity registry", () => {
  test("a declared rename keeps the id, and the history spans both names", async () => {
    const { root, vcs } = open({ "a.ts": TWO_FUNCTIONS });
    const file = vcs.track("a.ts");
    const alpha = vcs.registry.symbolsOf(file.id).find((s) => s.name === "alpha");
    if (alpha === undefined) throw new Error("alpha was not inventoried");

    const lease = granted(vcs, [alpha.id], "write", { modified: [alpha.id] });
    const result = await vcs.renameSymbol({
      leaseId: lease.leaseId,
      symbolId: alpha.id,
      expectedVersion: alpha.version,
      newName: "zulu",
      intent: intent({ modified: [alpha.id] }),
    });
    expect(result).toMatchObject({ outcome: "committed", version: alpha.version + 1 });

    // Same id, new name. This is § 3.2: the path and the name are display
    // attributes, and the identifier is not derived from either.
    const renamed = vcs.registry.symbol(alpha.id);
    expect(renamed?.id).toBe(alpha.id);
    expect(renamed?.name).toBe("zulu");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toContain("export function zulu(): number");

    const history = vcs.log.history(alpha.id).map((e) => e.kind);
    expect(history).toEqual(["symbol-created", "symbol-renamed"]);
    vcs.close();
  });

  test("a declared delete tombstones, and the id stays queryable in history", async () => {
    const { root, vcs } = open({ "a.ts": TWO_FUNCTIONS });
    const file = vcs.track("a.ts");
    const bravo = vcs.registry.symbolsOf(file.id).find((s) => s.name === "bravo");
    if (bravo === undefined) throw new Error("bravo was not inventoried");
    const created = vcs.log.history(bravo.id)[0];

    const lease = granted(vcs, [bravo.id], "exclusive", { tombstoned: [bravo.id] });
    const result = await vcs.deleteSymbol({
      leaseId: lease.leaseId,
      symbolId: bravo.id,
      expectedVersion: bravo.version,
      intent: intent({ tombstoned: [bravo.id] }),
    });
    expect(result.outcome).toBe("committed");

    // § 4.3: tombstoned, never removed, so a historical event referencing it
    // stays interpretable.
    expect(vcs.registry.symbol(bravo.id)?.tombstoned).toBe(true);
    expect(vcs.registry.symbolsOf(file.id).map((s) => s.name)).toEqual(["alpha"]);
    expect(vcs.log.history(bravo.id).map((e) => e.kind)).toEqual(["symbol-created", "symbol-deleted"]);

    // Time travel: the body as of the create, and nothing as of now.
    expect(vcs.log.at(bravo.id, created?.seq ?? 0)).toContain("export function bravo");
    expect(vcs.log.at(bravo.id, 1_000)).toBeUndefined();
    expect(readFileSync(join(root, "a.ts"), "utf8")).not.toContain("bravo");
    vcs.close();
  });

  test("an out-of-band edit desyncs the file and refuses new leases on its symbols", () => {
    const { root, vcs } = open({ "a.ts": TWO_FUNCTIONS });
    const file = vcs.track("a.ts");
    const alpha = vcs.registry.symbolsOf(file.id).find((s) => s.name === "alpha");
    if (alpha === undefined) throw new Error("alpha was not inventoried");

    // A person in an editor, a git pull, a codegen step: no agent, therefore
    // no declared intent (§ 9.1).
    writeFileSync(join(root, "a.ts"), "export function alpha(): number {\n  return 1;\n}\n", "utf8");

    const divergence = vcs.reinventory("a.ts");
    expect(divergence?.vanished).toEqual(["function::bravo"]);
    expect(divergence?.appeared).toEqual([]);
    expect(vcs.registry.desynced(file.id)).toBe(true);

    const refused = vcs.acquire({
      session: "session-a",
      symbolIds: [alpha.id],
      mode: "write",
      ttlMs: 5_000,
      intent: intent({ modified: [alpha.id] }),
    });
    expect(refused).toEqual({ outcome: "desync", fileIds: [file.id] });
    vcs.close();
  });

  test("importExternal adopts the change under the channel's name and no task", () => {
    const { root, vcs } = open({ "a.ts": TWO_FUNCTIONS });
    const file = vcs.track("a.ts");
    const bravo = vcs.registry.symbolsOf(file.id).find((s) => s.name === "bravo");
    if (bravo === undefined) throw new Error("bravo was not inventoried");

    writeFileSync(join(root, "a.ts"), "export function alpha(): number {\n  return 1;\n}\n", "utf8");
    vcs.reinventory("a.ts");
    const report = vcs.importExternal(file.id, "human-editor");

    expect(report.tombstoned.map((s) => s.id)).toEqual([bravo.id]);
    expect(vcs.registry.desynced(file.id)).toBe(false);

    // The attribution is honest in both directions: the channel is named, and
    // there is no task id, so an external change can never be mistaken for an
    // agent action in the log (§ 9.1).
    const deletion = vcs.log.history(bravo.id).at(-1);
    expect(deletion?.kind).toBe("symbol-deleted");
    expect(deletion?.sourceChannel).toBe("human-editor");
    expect(deletion?.taskId).toBeUndefined();
    expect(vcs.log.byTask("task-1")).toEqual([]);

    // A new lease is available again, on the file as the channel left it.
    const alpha = vcs.registry.symbolsOf(file.id)[0];
    expect(alpha?.name).toBe("alpha");
    vcs.close();
  });

  test("rejectExternal restores the registry's content and keeps every id", () => {
    const { root, vcs } = open({ "a.ts": TWO_FUNCTIONS });
    const file = vcs.track("a.ts");
    const before = vcs.registry.symbolsOf(file.id).map((s) => `${s.id}:${s.name}`);

    writeFileSync(join(root, "a.ts"), "export function alpha(): number {\n  return 1;\n}\n", "utf8");
    vcs.reinventory("a.ts");
    vcs.rejectExternal(file.id);

    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(TWO_FUNCTIONS);
    expect(vcs.registry.desynced(file.id)).toBe(false);
    expect(vcs.registry.symbolsOf(file.id).map((s) => `${s.id}:${s.name}`)).toEqual(before);
    expect(vcs.log.all().at(-1)?.kind).toBe("external-rejected");
    vcs.close();
  });
});

describe("dogfooding this repo", () => {
  test("src/ inventories, the framework's own constructors are in it, and the ids hold", () => {
    const vcs = openVcs({ root: PACKAGE, verifier: passingVerifier(), clock: manualClock(1_000), ids: counterIds() });
    const files = vcs.trackTree("src");
    expect(files.length).toBeGreaterThan(20);

    const named = new Map<string, RegisteredSymbol>(
      files.flatMap((file) =>
        vcs.registry.symbolsOf(file.id).map((s): [string, RegisteredSymbol] => [`${file.path}#${s.name}`, s]),
      ),
    );
    for (const key of [
      "src/core/workflow.ts#leaf",
      "src/core/workflow.ts#branch",
      "src/core/workflow.ts#loop",
      "src/core/step.ts#runStep",
      "src/core/step.ts#stepOutput",
    ]) {
      expect(named.get(key)?.id).toBeString();
    }

    // A second inventory of content nobody touched finds no divergence and
    // leaves every id where it was. Identity persisting through *no* change is
    // the floor under identity persisting through a declared one.
    const ids = [...named].map(([key, symbol]) => `${key}=${symbol.id}`);
    for (const file of files) expect(vcs.reinventory(file.path)).toBeUndefined();
    const again = new Map<string, RegisteredSymbol>(
      files.flatMap((file) =>
        vcs.registry.symbolsOf(file.id).map((s): [string, RegisteredSymbol] => [`${file.path}#${s.name}`, s]),
      ),
    );
    expect([...again].map(([key, symbol]) => `${key}=${symbol.id}`)).toEqual(ids);
    vcs.close();
  });
});
