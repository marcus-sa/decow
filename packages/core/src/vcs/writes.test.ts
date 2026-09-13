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
import { existsSync, readFileSync } from "node:fs";
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

/**
 * `writeFile`: the operation that can produce a file.
 *
 * The three symbol operations all resolve a symbol id first, so a file that
 * does not exist is unreachable from any of them. This one is the author's:
 * it holds a path scope instead of a version, and the only structural question
 * it asks is whether an identity the file already held has vanished.
 */
describe("the write path, whole files", () => {
  const ORACLE = `import { expect, test } from "bun:test";
import { alpha } from "./a.ts";

test("alpha returns 42", () => {
  expect(alpha()).toBe(42);
});
`;

  const pathLease = (vcs: Vcs, paths: string[], created: string[]) => {
    const result = vcs.acquire({
      session: "session-author",
      paths,
      mode: "write",
      ttlMs: 5_000,
      intent: { taskId: "task-1", description: "author the oracle", expectedOutcome: { created } },
    });
    if (result.outcome !== "granted") throw new Error(`expected a lease, got ${JSON.stringify(result)}`);
    return result.leaseId;
  };

  test("a file that does not exist is created, tracked, and its symbols get ids", async () => {
    const { root, vcs } = open();
    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);

    const result = await vcs.writeFile({
      leaseId,
      path: "test/a.test.ts",
      body: ORACLE,
      intent: { taskId: "task-1", description: "author the oracle", expectedOutcome: { created: ["test/a.test.ts"] } },
    });
    vcs.release(leaseId);

    expect(result).toMatchObject({ outcome: "committed", verification: "passed" });
    expect(readFileSync(join(root, "test/a.test.ts"), "utf8")).toBe(ORACLE);

    const file = vcs.registry.file("test/a.test.ts");
    expect(file).toBeDefined();
    const symbols = vcs.registry.symbolsOf(file?.id ?? "");
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual(["test:alpha returns 42"]);

    // The creation is attributed to the TASK, not to the inventory channel:
    // an agent wrote this file and the log says which one.
    const events = vcs.log.byTask("task-1");
    const created = events.find((e) => e.kind === "file-created");
    expect(created).toMatchObject({ taskId: "task-1", detail: "test/a.test.ts" });
    expect(created?.sourceChannel).toBeUndefined();
    expect(events.filter((e) => e.kind === "symbol-created")).toHaveLength(1);
    // Children first, the transaction last (§ 4.4).
    const transaction = events.find((e) => e.kind === "transaction");
    expect(transaction?.children?.length).toBe(2);
    expect((transaction?.seq ?? 0) > (created?.seq ?? 0)).toBe(true);
    vcs.close();
  });

  test("the impact graph sees the new file's imports, so the oracle covers the symbol", async () => {
    const { vcs, id } = open();
    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
    await vcs.writeFile({
      leaseId,
      path: "test/a.test.ts",
      body: ORACLE.replace('from "./a.ts"', 'from "../a.ts"'),
      intent: { taskId: "task-1", description: "author", expectedOutcome: { created: ["test/a.test.ts"] } },
    });
    vcs.release(leaseId);

    expect(vcs.impact.impactedTests([id("alpha")]).map((t) => t.name)).toEqual(["alpha returns 42"]);
    vcs.close();
  });

  test("a rewrite that keeps every identity commits; one that drops one is a contract violation", async () => {
    const { root, vcs } = open();
    const write = async (body: string) => {
      const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
      const result = await vcs.writeFile({
        leaseId,
        path: "test/a.test.ts",
        body,
        intent: { taskId: "task-2", description: "rewrite", expectedOutcome: { created: ["test/a.test.ts"] } },
      });
      vcs.release(leaseId);
      return result;
    };

    expect((await write(ORACLE)).outcome).toBe("committed");
    // Adding is the author's business.
    const added = ORACLE + '\ntest("alpha is a number", () => {\n  expect(typeof alpha()).toBe("number");\n});\n';
    expect((await write(added)).outcome).toBe("committed");

    // Removing is not: the registry never infers a delete from an absence.
    const dropped = await write('import { expect, test } from "bun:test";\n');
    expect(dropped).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(dropped.outcome === "rejected" && dropped.detail).toContain("test::alpha returns 42");
    // And the bytes are back.
    expect(readFileSync(join(root, "test/a.test.ts"), "utf8")).toBe(added);
    vcs.close();
  });

  test("a file that does not parse is rejected structurally and removed again", async () => {
    const { root, vcs } = open();
    const leaseId = pathLease(vcs, ["test"], ["test/broken.test.ts"]);
    const result = await vcs.writeFile({
      leaseId,
      path: "test/broken.test.ts",
      body: "test(\"unclosed\" => {\n",
      intent: { taskId: "task-3", description: "author", expectedOutcome: { created: ["test/broken.test.ts"] } },
    });
    vcs.release(leaseId);

    expect(result).toMatchObject({ outcome: "rejected", by: "structural" });
    // The file it created is gone: a rollback of a creation is a removal.
    expect(existsSync(join(root, "test/broken.test.ts"))).toBe(false);
    expect(vcs.registry.file("test/broken.test.ts")).toBeUndefined();
    vcs.close();
  });

  test("a failing typecheck rolls a rewrite back byte for byte", async () => {
    const failing = { typecheck: failingStage("typecheck", "TS2322") };
    const root = tempProject({ "a.ts": SOURCE, "test/a.test.ts": ORACLE });
    const vcs = openVcs({
      root,
      verifier: passingVerifier(failing),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    vcs.track("a.ts");
    vcs.track("test/a.test.ts");

    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
    const result = await vcs.writeFile({
      leaseId,
      path: "test/a.test.ts",
      // The same test, asserting differently: the identity is unchanged, so
      // the write reaches the typecheck stage rather than stopping short of it.
      body: ORACLE.replace("toBe(42)", "toBe(43)"),
      intent: { taskId: "task-4", description: "rewrite", expectedOutcome: { created: ["test/a.test.ts"] } },
    });
    vcs.release(leaseId);

    expect(result).toMatchObject({ outcome: "rejected", by: "typecheck" });
    expect(readFileSync(join(root, "test/a.test.ts"), "utf8")).toBe(ORACLE);
    vcs.close();
  });

  test("the tests stage never runs, so an oracle can be authored red", async () => {
    // The property this operation exists for. A stage that ran the suite would
    // refuse every oracle for being red, which is what an oracle IS before its
    // production code exists.
    const ran: string[] = [];
    const { vcs } = open({
      tests: async (ctx) => {
        ran.push(...ctx.targets.map((t) => t.id));
        return { status: "failed", by: "tests", detail: "the oracle is red" };
      },
    });
    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
    const result = await vcs.writeFile({
      leaseId,
      path: "test/a.test.ts",
      body: ORACLE,
      intent: { taskId: "task-5", description: "author", expectedOutcome: { created: ["test/a.test.ts"] } },
    });
    vcs.release(leaseId);

    expect(result.outcome).toBe("committed");
    expect(ran).toEqual([]);
    vcs.close();
  });

  test("a lease whose scope does not cover the path refuses before anything is written", async () => {
    const { root, vcs } = open();
    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
    const result = await vcs.writeFile({
      leaseId,
      path: "src/smuggled.ts",
      body: "export const x = 1;\n",
      intent: { taskId: "task-6", description: "smuggle", expectedOutcome: { created: ["src/smuggled.ts"] } },
    });
    vcs.release(leaseId);

    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(existsSync(join(root, "src/smuggled.ts"))).toBe(false);
    vcs.close();
  });

  test("a write the intent did not declare is refused, even inside the scope", async () => {
    const { root, vcs } = open();
    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
    const result = await vcs.writeFile({
      leaseId,
      path: "test/b.test.ts",
      body: ORACLE,
      intent: { taskId: "task-7", description: "undeclared", expectedOutcome: { created: ["test/a.test.ts"] } },
    });
    vcs.release(leaseId);

    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    expect(existsSync(join(root, "test/b.test.ts"))).toBe(false);
    vcs.close();
  });

  test("release accepts the symbols a path-scoped write created, which it could not have named", async () => {
    // The symbols in a file that did not exist have no ids to declare, so the
    // lease declared the PATH and release reads the coverage rather than the
    // id list. Without this every authored oracle would release as a
    // contract violation.
    const { vcs } = open();
    const leaseId = pathLease(vcs, ["test"], ["test/a.test.ts"]);
    await vcs.writeFile({
      leaseId,
      path: "test/a.test.ts",
      body: ORACLE,
      intent: { taskId: "task-8", description: "author", expectedOutcome: { created: ["test/a.test.ts"] } },
    });
    expect(vcs.release(leaseId).outcome).toBe("released");
    vcs.close();
  });
});

/**
 * Known-red targets: the generalisation of the batch filter.
 *
 * The tests stage asks whether the change broke something ELSE. A test that
 * was red before the write ran is not an answer to that — and in a module with
 * two undelivered values it is the normal case, because a value is only ready
 * to be delivered once its own oracle has been measured red.
 */
describe("the write path, known-red targets", () => {
  const LIB = "export const alpha = (): number => 1;\nexport const bravo = (): number => 1;\n";
  const ALPHA_TEST = `import { expect, test } from "bun:test";
import { alpha } from "./lib.ts";

test("alpha returns 42", () => {
  expect(alpha()).toBe(42);
});
`;
  const BRAVO_TEST = `import { expect, test } from "bun:test";
import { bravo } from "./lib.ts";

test("bravo returns 7", () => {
  expect(bravo()).toBe(7);
});
`;

  const openPair = () => {
    const root = tempProject({ "lib.ts": LIB, "alpha.test.ts": ALPHA_TEST, "bravo.test.ts": BRAVO_TEST });
    const ran: string[] = [];
    const vcs = openVcs({
      root,
      verifier: passingVerifier({
        tests: async (ctx) => {
          ran.push(...ctx.targets.map((t) => t.name));
          // Every oracle in this fixture is red against the stubs, so a stage
          // that ran one would refuse.
          return ctx.targets.length === 0
            ? { status: "passed" }
            : { status: "failed", by: "tests", detail: "red", failed: ctx.targets.map((t) => t.id) };
        },
      }),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    const lib = vcs.track("lib.ts");
    vcs.track("alpha.test.ts");
    vcs.track("bravo.test.ts");
    const testId = (path: string) => vcs.registry.symbolsOf(vcs.registry.file(path)?.id ?? "")[0]?.id ?? "";
    const symbolId = (name: string) =>
      vcs.registry.symbolsOf(lib.id).find((s) => s.name === name)?.id ?? "";
    return { root, vcs, ran, testId, symbolId };
  };

  test("a sibling's red oracle does not refuse this write, and this one's still does", async () => {
    const { vcs, ran, testId, symbolId } = openPair();
    const alpha = symbolId("alpha");
    const leaseId = lease(vcs, [alpha]);

    const result = await vcs.replaceSymbolBody({
      leaseId,
      symbolId: alpha,
      expectedVersion: 1,
      body: "export const alpha = (): number => 42;",
      intent: intent({ modified: [alpha] }),
      knownRed: [testId("bravo.test.ts")],
    });
    vcs.release(leaseId);

    // `bravo`'s oracle was left out; `alpha`'s own was run, and it is what
    // refused — which is the behaviour that catches a wrong implementation.
    expect(ran).toEqual(["alpha returns 42"]);
    expect(result).toMatchObject({ outcome: "rejected", by: "tests" });
    vcs.close();
  });

  test("runTests leaves a known-red target out of the run AND out of the floor", async () => {
    // Both sides, or the caller refuses itself for omitting a test it was told
    // to leave out.
    const { vcs, ran, testId, symbolId } = openPair();
    const alpha = symbolId("alpha");

    const result = await vcs.runTests({
      symbolIds: [alpha],
      wrote: [alpha],
      knownRed: [testId("alpha.test.ts"), testId("bravo.test.ts")],
      intent: intent({ modified: [] }),
    });

    // Nothing ran, and nothing was reported omitted: an empty run passes.
    expect(ran).toEqual([]);
    expect(result.outcome).toBe("committed");
    vcs.close();
  });

  test("without it, the floor still refuses a union that drops an impacted test", async () => {
    // The union rule is unchanged. `knownRed` is a fact about the world the
    // caller was handed, not a selection it made.
    const { vcs, symbolId } = openPair();
    const alpha = symbolId("alpha");
    const result = await vcs.runTests({
      symbolIds: [],
      wrote: [alpha],
      intent: intent({ modified: [] }),
    });
    expect(result).toMatchObject({ outcome: "rejected", by: "contract" });
    vcs.close();
  });
});
