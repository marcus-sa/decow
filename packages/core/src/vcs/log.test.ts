/**
 * The event log's four capabilities (ai-vcs.md § 4.4).
 *
 * The document's claim is that an append-only log keyed to stable symbol
 * identity gives four things a commit graph makes awkward: a total order,
 * atomic-commit semantics through a parent appended after its children,
 * time-travel reads, and provenance by task id. These tests are that claim,
 * one test each, driven through the write path rather than by appending rows
 * by hand.
 */

import { describe, expect, test } from "bun:test";
import { openVcs, type Vcs } from "./index.ts";
import type { Intent } from "./log.ts";
import { counterIds, manualClock, passingVerifier, tempProject } from "./testing.ts";

const SOURCE = `export function alpha(): number {
  return 1;
}

export function bravo(): number {
  return 2;
}
`;

const open = () => {
  const vcs = openVcs({
    root: tempProject({ "a.ts": SOURCE }),
    verifier: passingVerifier(),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  const file = vcs.track("a.ts");
  const id = (name: string) => {
    const symbol = vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`fixture has no symbol named ${name}`);
    return symbol.id;
  };
  return { vcs, id };
};

const intent = (taskId: string, symbolId: string): Intent => ({
  taskId,
  description: "rewrite a function body",
  expectedOutcome: { modified: [symbolId] },
});

/** One body replacement under its own lease, as a task would issue it. */
const write = async (vcs: Vcs, taskId: string, symbolId: string, body: string) => {
  const acquired = vcs.acquire({
    session: `session-${taskId}`,
    symbolIds: [symbolId],
    mode: "write",
    ttlMs: 5_000,
    intent: intent(taskId, symbolId),
  });
  if (acquired.outcome !== "granted") throw new Error(`expected a lease, got ${JSON.stringify(acquired)}`);
  const version = vcs.registry.symbol(symbolId)?.version ?? 0;
  const result = await vcs.replaceSymbolBody({
    leaseId: acquired.leaseId,
    symbolId,
    expectedVersion: version,
    body,
    intent: intent(taskId, symbolId),
  });
  vcs.release(acquired.leaseId);
  if (result.outcome !== "committed") throw new Error(`expected a commit, got ${JSON.stringify(result)}`);
  return result;
};

const V2 = "export function alpha(): number {\n  return 2;\n}";
const V3 = "export function alpha(): number {\n  return 3;\n}";

describe("the event log", () => {
  test("the order is total, and it is the log's own rather than a clock reading", async () => {
    const { vcs, id } = open();
    await write(vcs, "task-1", id("alpha"), V2);
    await write(vcs, "task-2", id("bravo"), "export function bravo(): number {\n  return 9;\n}");

    const seqs = vcs.log.all().map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(6);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    vcs.close();
  });

  test("a transaction's children all precede it, which is the atomic-commit semantics", async () => {
    const { vcs, id } = open();
    // Editing a method would give a multi-child transaction; a top-level
    // function gives one child, and the ordering property is the same either
    // way: seeing the parent means every child already landed.
    const result = await write(vcs, "task-1", id("alpha"), V2);
    const parent = vcs.log.all().find((e) => e.seq === result.seq);

    expect(parent?.kind).toBe("transaction");
    expect(parent?.children).not.toBeUndefined();
    for (const child of parent?.children ?? []) expect(child).toBeLessThan(result.seq);
    vcs.close();
  });

  test("history is one symbol's events, oldest first, and nothing else's", async () => {
    const { vcs, id } = open();
    await write(vcs, "task-1", id("alpha"), V2);
    await write(vcs, "task-2", id("bravo"), "export function bravo(): number {\n  return 9;\n}");

    expect(vcs.log.history(id("alpha")).map((e) => e.kind)).toEqual(["symbol-created", "symbol-modified"]);
    expect(vcs.log.history(id("alpha")).every((e) => e.symbolId === id("alpha"))).toBe(true);
    vcs.close();
  });

  test("at() is a time-travel read: the body as of a sequence number", async () => {
    const { vcs, id } = open();
    const alpha = id("alpha");
    const created = vcs.log.history(alpha)[0]?.seq ?? 0;
    const second = await write(vcs, "task-1", alpha, V2);
    const third = await write(vcs, "task-2", alpha, V3);

    expect(vcs.log.at(alpha, created)).toBe("export function alpha(): number {\n  return 1;\n}");
    expect(vcs.log.at(alpha, second.seq)).toBe(V2);
    expect(vcs.log.at(alpha, third.seq)).toBe(V3);
    // Before the symbol existed there is nothing to read.
    expect(vcs.log.at(alpha, created - 1)).toBeUndefined();
    vcs.close();
  });

  test("byTask is provenance: every event a task produced, across every symbol", async () => {
    const { vcs, id } = open();
    await write(vcs, "task-1", id("alpha"), V2);
    await write(vcs, "task-1", id("bravo"), "export function bravo(): number {\n  return 9;\n}");
    await write(vcs, "task-2", id("alpha"), V3);

    const one = vcs.log.byTask("task-1");
    expect(new Set(one.map((e) => e.symbolId).filter((s) => s !== undefined))).toEqual(
      new Set([id("alpha"), id("bravo")]),
    );
    expect(one.map((e) => e.kind)).toEqual([
      "lease-acquired",
      "symbol-modified",
      "transaction",
      "lease-released",
      "lease-acquired",
      "symbol-modified",
      "transaction",
      "lease-released",
    ]);

    // The other task's events are not in it, and the first observation of the
    // file belongs to no task at all.
    expect(vcs.log.byTask("task-2").length).toBe(4);
    expect(vcs.log.all().filter((e) => e.kind === "symbol-created").every((e) => e.taskId === undefined)).toBe(
      true,
    );
    vcs.close();
  });

  test("every write carries a verification status, queryable from the log", async () => {
    const { vcs, id } = open();
    await write(vcs, "task-1", id("alpha"), V2);
    const statuses = vcs.log
      .byTask("task-1")
      .filter((e) => e.kind === "symbol-modified" || e.kind === "transaction")
      .map((e) => e.verification);
    expect(statuses).toEqual(["passed", "passed"]);
    vcs.close();
  });
});
