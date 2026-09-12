/**
 * The write path (ai-vcs.md § 5.4, § 6.1).
 *
 * Verification runs inside the write, cheapest stage first, and a failure puts
 * the file's bytes back exactly as they were. That rollback is the property
 * worth testing hardest: a gate that rejects a change and leaves it half
 * applied is worse than no gate.
 *
 * Every stage is injected here, so "typecheck failed" is an input rather than
 * a compiler run. The default stages that really do spawn `bunx tsc` and
 * `bun test` are exercised once, in `./real-tools.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openVcs, type Vcs } from "./index.ts";
import type { Intent } from "./log.ts";
import { counterIds, failingStage, manualClock, passingVerifier, tempProject } from "./testing.ts";
import type { Verifier } from "./verify.ts";

const SOURCE = `export function alpha(): number {
  return 1;
}

export class Bravo {
  charlie(): void {}
}
`;

const NEW_BODY = "export function alpha(): number {\n  return 42;\n}";

const open = (verifier: Partial<Verifier> = {}) => {
  const root = tempProject({ "a.ts": SOURCE });
  const vcs = openVcs({
    root,
    verifier: passingVerifier(verifier),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  const file = vcs.track("a.ts");
  const id = (name: string) => {
    const symbol = vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`fixture has no symbol named ${name}`);
    return symbol.id;
  };
  const read = () => readFileSync(join(root, "a.ts"), "utf8");
  return { root, vcs, file, id, read };
};

const intent = (expectedOutcome: Intent["expectedOutcome"]): Intent => ({
  taskId: "task-1",
  parentTaskId: "task-0",
  description: "make alpha return 42",
  expectedOutcome,
});

const lease = (vcs: Vcs, symbolIds: string[], mode: "write" | "exclusive" = "write") => {
  const result = vcs.acquire({
    session: "session-a",
    symbolIds,
    mode,
    ttlMs: 5_000,
    intent: intent(mode === "exclusive" ? { tombstoned: symbolIds } : { modified: symbolIds }),
  });
  if (result.outcome !== "granted") throw new Error(`expected a lease, got ${JSON.stringify(result)}`);
  return result.leaseId;
};

/** A body replacement under a fresh lease, at whatever version the symbol is. */
const replace = async (fixture: ReturnType<typeof open>, name: string, body: string, version?: number) => {
  const symbolId = fixture.id(name);
  const current = fixture.vcs.registry.symbol(symbolId)?.version ?? 0;
  return await fixture.vcs.replaceSymbolBody({
    leaseId: lease(fixture.vcs, [symbolId]),
    symbolId,
    expectedVersion: version ?? current,
    body,
    intent: intent({ modified: [symbolId] }),
  });
};

describe("replaceSymbolBody", () => {
  test("a clean write commits at version + 1 and lands the bytes", async () => {
    const fixture = open();
    const result = await replace(fixture, "alpha", NEW_BODY);

    expect(result).toMatchObject({ outcome: "committed", version: 2, verification: "passed" });
    expect(fixture.read()).toBe(`${NEW_BODY}\n\nexport class Bravo {\n  charlie(): void {}\n}\n`);
    expect(fixture.vcs.registry.symbol(fixture.id("alpha"))?.version).toBe(2);
    fixture.vcs.close();
  });

  test("the commit appends the child event first and the transaction after it", async () => {
    const fixture = open();
    const result = await replace(fixture, "alpha", NEW_BODY);
    if (result.outcome !== "committed") throw new Error("the write should commit");

    const parent = fixture.vcs.log.all().find((e) => e.seq === result.seq);
    expect(parent?.kind).toBe("transaction");
    expect(parent?.taskId).toBe("task-1");
    expect(parent?.parentTaskId).toBe("task-0");
    // § 4.4: the parent lands last, so seeing it means every child is in.
    expect(parent?.children?.length).toBe(1);
    expect((parent?.children ?? []).every((child) => child < result.seq)).toBe(true);

    const child = fixture.vcs.log.history(fixture.id("alpha")).at(-1);
    expect(child).toMatchObject({ kind: "symbol-modified", version: 2, verification: "passed" });
    expect(child?.body).toBe(NEW_BODY);
    fixture.vcs.close();
  });

  test("a stale expected version is a conflict carrying the current one, and writes nothing", async () => {
    const fixture = open();
    const symbolId = fixture.id("alpha");
    const result = await fixture.vcs.replaceSymbolBody({
      leaseId: lease(fixture.vcs, [symbolId]),
      symbolId,
      expectedVersion: 7,
      body: NEW_BODY,
      intent: intent({ modified: [symbolId] }),
    });
    expect(result).toEqual({ outcome: "conflict", currentVersion: 1 });
    expect(fixture.read()).toBe(SOURCE);
    fixture.vcs.close();
  });

  test("a body that removes the symbol it claims to edit is a contract violation", async () => {
    const fixture = open();
    const result = await replace(fixture, "alpha", "// alpha is gone now");

    // An edit declares no identity change. Removing the symbol is a different
    // operation, and § 4.5 says the system validates the declaration against
    // the observation rather than reinterpreting it.
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(fixture.read()).toBe(SOURCE);
    expect(fixture.vcs.registry.symbol(fixture.id("alpha"))?.version).toBe(1);

    const failure = fixture.vcs.log.all().at(-1);
    expect(failure).toMatchObject({ kind: "write-failed", category: "contract", verification: "failed" });
    fixture.vcs.close();
  });

  test("a body that renames the symbol is the same violation, not a silent rename", async () => {
    const fixture = open();
    const result = await replace(fixture, "alpha", "export function zulu(): number {\n  return 1;\n}");
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(fixture.read()).toBe(SOURCE);
    fixture.vcs.close();
  });

  test("a body that does not parse is rejected by the structural stage, not by typecheck", async () => {
    const fixture = open();
    const result = await replace(fixture, "alpha", "export function alpha(: number {");
    expect(result).toMatchObject({ outcome: "rejected", by: "structural" });
    expect(fixture.read()).toBe(SOURCE);
    fixture.vcs.close();
  });

  test("a failing typecheck stage rejects, and the file is byte-identical to before", async () => {
    const fixture = open({ typecheck: failingStage("typecheck", "TS2322: Type 'number' is not assignable") });
    const result = await replace(fixture, "alpha", NEW_BODY);

    expect(result).toMatchObject({ outcome: "rejected", by: "typecheck" });
    expect(fixture.read()).toBe(SOURCE);
    expect(fixture.vcs.registry.symbol(fixture.id("alpha"))?.version).toBe(1);
    expect(fixture.vcs.log.all().at(-1)).toMatchObject({
      kind: "write-failed",
      category: "verification",
      detail: "TS2322: Type 'number' is not assignable",
    });
    fixture.vcs.close();
  });

  test("a failing tests stage rejects with the quality signal rather than the contract one", async () => {
    const fixture = open({ tests: failingStage("tests", "1 failing: alpha returns 42") });
    const result = await replace(fixture, "alpha", NEW_BODY);
    expect(result).toMatchObject({ outcome: "rejected", by: "tests" });
    expect(fixture.read()).toBe(SOURCE);
    fixture.vcs.close();
  });

  test("a stage that breaks is infra-failed, so a flaky harness cannot look like a bad change", async () => {
    const fixture = open({
      typecheck: async () => ({ status: "infra-failed", detail: "tsc could not be run" }),
    });
    const result = await replace(fixture, "alpha", NEW_BODY);
    expect(result).toMatchObject({ outcome: "infra-failed" });
    expect(fixture.read()).toBe(SOURCE);
    expect(fixture.vcs.log.all().at(-1)).toMatchObject({ category: "infrastructure" });
    fixture.vcs.close();
  });

  test("an advisory stage does not block, and the write records itself as advisory", async () => {
    const fixture = open({ tests: async () => ({ status: "advisory", detail: "known flaky" }) });
    const result = await replace(fixture, "alpha", NEW_BODY);

    // § 6.4: a check that cannot decide is recorded, not escalated into a
    // rejection the agent has no way to answer.
    expect(result).toMatchObject({ outcome: "committed", verification: "advisory" });
    expect(fixture.vcs.log.history(fixture.id("alpha")).at(-1)?.verification).toBe("advisory");
    fixture.vcs.close();
  });

  test("editing a method bumps the class as well, because the class's text changed", async () => {
    const fixture = open();
    const result = await replace(fixture, "charlie", "charlie(): void {\n    return;\n  }");
    expect(result.outcome).toBe("committed");

    expect(fixture.vcs.registry.symbol(fixture.id("charlie"))?.version).toBe(2);
    expect(fixture.vcs.registry.symbol(fixture.id("Bravo"))?.version).toBe(2);
    fixture.vcs.close();
  });
});

describe("the lease is load-bearing", () => {
  test("a read lease cannot write", async () => {
    const fixture = open();
    const symbolId = fixture.id("alpha");
    const read = fixture.vcs.acquire({
      session: "session-a",
      symbolIds: [symbolId],
      mode: "read",
      ttlMs: 5_000,
      intent: intent({}),
    });
    if (read.outcome !== "granted") throw new Error("the read acquire should hold");

    const result = await fixture.vcs.replaceSymbolBody({
      leaseId: read.leaseId,
      symbolId,
      expectedVersion: 1,
      body: NEW_BODY,
      intent: intent({ modified: [symbolId] }),
    });
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(fixture.read()).toBe(SOURCE);
    fixture.vcs.close();
  });

  test("a write needs a lease that covers the symbol", async () => {
    const fixture = open();
    const result = await fixture.vcs.replaceSymbolBody({
      leaseId: lease(fixture.vcs, [fixture.id("Bravo")]),
      symbolId: fixture.id("alpha"),
      expectedVersion: 1,
      body: NEW_BODY,
      intent: intent({ modified: [fixture.id("alpha")] }),
    });
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    fixture.vcs.close();
  });

  test("an expired lease cannot write", async () => {
    const root = tempProject({ "a.ts": SOURCE });
    const clock = manualClock(1_000);
    const vcs = openVcs({ root, verifier: passingVerifier(), clock, ids: counterIds() });
    const file = vcs.track("a.ts");
    const symbolId = vcs.registry.symbolsOf(file.id)[0]?.id ?? "";

    const leaseId = lease(vcs, [symbolId]);
    clock.advance(5_001);
    const result = await vcs.replaceSymbolBody({
      leaseId,
      symbolId,
      expectedVersion: 1,
      body: NEW_BODY,
      intent: intent({ modified: [symbolId] }),
    });
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    vcs.close();
  });

  test("release catches a lease that changed something its intent did not declare", async () => {
    const fixture = open();
    const alpha = fixture.id("alpha");
    const bravo = fixture.id("Bravo");

    // The lease covers both and declares only one, which § 5.1 permits: the
    // declaration is a subset of the request. Writing the undeclared one is
    // what § 5.4's release-time validation exists to catch.
    const acquired = fixture.vcs.acquire({
      session: "session-a",
      symbolIds: [alpha, bravo],
      mode: "write",
      ttlMs: 5_000,
      intent: intent({ modified: [alpha] }),
    });
    if (acquired.outcome !== "granted") throw new Error("the acquire should hold");

    const written = await fixture.vcs.replaceSymbolBody({
      leaseId: acquired.leaseId,
      symbolId: bravo,
      expectedVersion: 1,
      body: "export class Bravo {\n  charlie(): void {\n    return;\n  }\n}",
      intent: intent({ modified: [bravo] }),
    });
    expect(written.outcome).toBe("committed");

    // `charlie` is in the offending set too: rewriting the class rewrote the
    // method it holds, and neither is inside the closure of what was declared.
    const released = fixture.vcs.release(acquired.leaseId);
    expect(released).toMatchObject({
      outcome: "contract-violation",
      declared: [alpha],
      outside: [bravo, fixture.id("charlie")].sort(),
    });
    expect(fixture.vcs.log.all().at(-1)).toMatchObject({ kind: "release-failed", category: "contract" });
    fixture.vcs.close();
  });

  test("release is clean when the lease stayed inside the scope it declared", async () => {
    const fixture = open();
    const alpha = fixture.id("alpha");
    const acquired = fixture.vcs.acquire({
      session: "session-a",
      symbolIds: [alpha],
      mode: "write",
      ttlMs: 5_000,
      intent: intent({ modified: [alpha] }),
    });
    if (acquired.outcome !== "granted") throw new Error("the acquire should hold");
    await fixture.vcs.replaceSymbolBody({
      leaseId: acquired.leaseId,
      symbolId: alpha,
      expectedVersion: 1,
      body: NEW_BODY,
      intent: intent({ modified: [alpha] }),
    });
    expect(fixture.vcs.release(acquired.leaseId)).toMatchObject({ outcome: "released", touched: [alpha] });
    fixture.vcs.close();
  });
});

describe("deleteSymbol", () => {
  test("needs an exclusive lease, because § 5.2 reserves that mode for structure", async () => {
    const fixture = open();
    const symbolId = fixture.id("alpha");
    const result = await fixture.vcs.deleteSymbol({
      leaseId: lease(fixture.vcs, [symbolId], "write"),
      symbolId,
      expectedVersion: 1,
      intent: intent({ tombstoned: [symbolId] }),
    });
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(fixture.read()).toBe(SOURCE);
    fixture.vcs.close();
  });

  test("deleting a class tombstones what it held, because the declaration says so", async () => {
    const fixture = open();
    const bravo = fixture.id("Bravo");
    const charlie = fixture.id("charlie");
    const result = await fixture.vcs.deleteSymbol({
      leaseId: lease(fixture.vcs, [bravo], "exclusive"),
      symbolId: bravo,
      expectedVersion: 1,
      intent: intent({ tombstoned: [bravo] }),
    });
    expect(result.outcome).toBe("committed");
    expect(fixture.vcs.registry.symbol(bravo)?.tombstoned).toBe(true);
    expect(fixture.vcs.registry.symbol(charlie)?.tombstoned).toBe(true);
    fixture.vcs.close();
  });
});
