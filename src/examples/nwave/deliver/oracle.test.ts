/**
 * The oracle, both halves.
 *
 * The pure half — locator parsing, the pending-marker convention, resolving a
 * list of obligations — is unit-tested. The half that matters is the claim
 * underneath the convention: `test.skip("x")` and `test("x")` are the SAME
 * symbol, so stripping a marker is a body edit rather than a rename. That is
 * asserted against a real tree-sitter inventory of a real temp project, and
 * then end to end through the VCS write path, because if it were false the
 * activation would be refused as a contract violation and the whole node would
 * be unusable.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openVcs } from "../../../vcs/index.ts";
import { identityKey } from "../../../vcs/structural/parser.ts";
import { treeSitterTypeScript } from "../../../vcs/structural/typescript.ts";
import { counterIds, manualClock, passingVerifier, tempProject } from "../../../vcs/testing.ts";
import {
  parseLocator,
  pendingMarker,
  resolveObligations,
  stripPendingMarker,
  type OracleIndex,
} from "./oracle.ts";
import { vcsOracleIndex } from "./pipeline.ts";

const ALPHA = `export function alpha(): number {
  return 1;
}
`;

const ALPHA_TEST = `import { expect, test } from "bun:test";
import { alpha } from "./alpha.ts";

test.skip("alpha returns 42", () => {
  expect(alpha()).toBe(42);
});
`;

const BRAVO_TEST = `import { expect, test } from "bun:test";

describe("bravo", () => {
  test.todo("bravo returns 7", () => {
    expect(1).toBe(7);
  });
});
`;

const PROJECT = {
  "src/alpha.ts": ALPHA,
  "src/alpha.test.ts": ALPHA_TEST,
  "src/bravo.test.ts": BRAVO_TEST,
};

const open = () => {
  const root = tempProject(PROJECT);
  const vcs = openVcs({
    root,
    verifier: passingVerifier(),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  vcs.trackTree("src");
  return { root, vcs, index: vcsOracleIndex(vcs), read: (p: string) => readFileSync(join(root, p), "utf8") };
};

describe("the pending-marker convention", () => {
  test("a modifier is the only difference, so the identity is the same symbol", () => {
    // The claim the whole node rests on. Identity is (kind, container, name);
    // a modifier is none of those, so the strip is a body edit and NOT a
    // rename — which is what lets it through a write path that refuses an
    // undeclared identity change.
    const parser = treeSitterTypeScript();
    const pending = parser.symbols(ALPHA_TEST).map(identityKey);
    const active = parser.symbols(ALPHA_TEST.replace("test.skip(", "test(")).map(identityKey);

    expect(pending).toEqual(["test::alpha returns 42"]);
    expect(active).toEqual(pending);
  });

  test("every marker form strips to its active form and nothing else changes", () => {
    expect(stripPendingMarker('test.skip("a", () => {})')).toBe('test("a", () => {})');
    expect(stripPendingMarker('test.todo("a", () => {})')).toBe('test("a", () => {})');
    expect(stripPendingMarker('it.skip("a", () => {})')).toBe('it("a", () => {})');
    expect(stripPendingMarker('it.todo("a", () => {})')).toBe('it("a", () => {})');
  });

  test("an already-active test has nothing to strip, which is not the same as unchanged", () => {
    // `undefined` rather than the body back: a write that replaces a body
    // with itself spends a lease and a verification pass to change nothing.
    expect(stripPendingMarker('test("a", () => {})')).toBeUndefined();
    expect(pendingMarker('test("a", () => {})')).toBeUndefined();
    expect(pendingMarker('test.skip("a", () => {})')).toBe("test.skip(");
  });

  test("only the leading call is rewritten", () => {
    // A `test.skip` deeper in the body is some other test's marker, or a
    // string, and neither is this one's.
    const body = 'test.skip("a", () => {\n  expect("test.skip(").toBe("test.skip(");\n})';
    expect(stripPendingMarker(body)).toBe(
      'test("a", () => {\n  expect("test.skip(").toBe("test.skip(");\n})',
    );
  });

  test("leading whitespace does not hide a marker", () => {
    expect(stripPendingMarker('  test.skip("a", () => {})')).toBe('  test("a", () => {})');
  });
});

describe("locators", () => {
  test("path::name splits; a bare name is a name", () => {
    expect(parseLocator("src/alpha.test.ts::alpha returns 42")).toEqual({
      path: "src/alpha.test.ts",
      name: "alpha returns 42",
    });
    expect(parseLocator("alpha returns 42")).toEqual({ name: "alpha returns 42" });
  });
});

describe("the VCS-backed inventory", () => {
  test("a path::name locator resolves to the test symbol, its version and its body", async () => {
    const { vcs, index } = open();
    const located = await index.locate("src/alpha.test.ts::alpha returns 42");

    expect(located).toMatchObject({ version: 1 });
    expect(located?.body.startsWith("test.skip(")).toBe(true);
    // The id is the registry's, so it survives a rename or a move of the file.
    expect(vcs.registry.symbol(located?.id ?? "")?.kind).toBe("test");
    vcs.close();
  });

  test("a bare name resolves when it is unambiguous", async () => {
    const { vcs, index } = open();
    expect(await index.locate("alpha returns 42")).toMatchObject({ version: 1 });
    vcs.close();
  });

  test("a describe-nested test resolves by its own name", async () => {
    const { vcs, index } = open();
    const located = await index.locate("src/bravo.test.ts::bravo returns 7");
    expect(located?.body.startsWith("test.todo(")).toBe(true);
    vcs.close();
  });

  test("a locator naming nothing resolves to nothing", async () => {
    const { vcs, index } = open();
    expect(await index.locate("src/alpha.test.ts::a test nobody wrote")).toBeUndefined();
    expect(await index.locate("src/nowhere.test.ts::alpha returns 42")).toBeUndefined();
    expect(await index.locate("a test nobody wrote")).toBeUndefined();
    vcs.close();
  });

  test("an ambiguous bare name resolves to nothing rather than to the first", async () => {
    // Guessing would activate a test the roadmap did not mean.
    const root = tempProject({
      "src/a.test.ts": 'test.skip("same name", () => {});\n',
      "src/b.test.ts": 'test.skip("same name", () => {});\n',
    });
    const vcs = openVcs({ root, verifier: passingVerifier(), clock: manualClock(1), ids: counterIds() });
    vcs.trackTree("src");

    expect(await vcsOracleIndex(vcs).locate("same name")).toBeUndefined();
    // Qualified, it is not ambiguous at all.
    expect(await vcsOracleIndex(vcs).locate("src/a.test.ts::same name")).toMatchObject({ version: 1 });
    vcs.close();
  });

  test("a non-test symbol of the right name is not an acceptance test", async () => {
    const { vcs, index } = open();
    expect(await index.locate("src/alpha.ts::alpha")).toBeUndefined();
    vcs.close();
  });
});

describe("resolving a step's obligations", () => {
  const index: OracleIndex = {
    locate: async (locator) =>
      locator === "found" ? { id: "t-1", version: 1, body: 'test.skip("x", () => {})' } : undefined,
  };

  test("all found is every obligation located, in order", async () => {
    expect(
      await resolveObligations(index, [
        { id: "AC-1", oracleLocator: "found" },
        { id: "AC-2", oracleLocator: "found" },
      ]),
    ).toMatchObject([
      { obligationId: "AC-1", outcome: "located" },
      { obligationId: "AC-2", outcome: "located" },
    ]);
  });

  test("an obligation with no locator is missing by definition", async () => {
    // The normal state of a roadmap authored before its tests were written.
    expect(await resolveObligations(index, [{ id: "AC-1" }])).toEqual([
      { obligationId: "AC-1", outcome: "missing" },
    ]);
    expect(await resolveObligations(index, [{ id: "AC-1", oracleLocator: "  " }])).toEqual([
      { obligationId: "AC-1", outcome: "missing" },
    ]);
  });

  test("a locator that resolves to nothing is missing, and says which locator", async () => {
    expect(await resolveObligations(index, [{ id: "AC-1", oracleLocator: "nowhere" }])).toEqual([
      { obligationId: "AC-1", outcome: "missing", locator: "nowhere" },
    ]);
  });
});

describe("activation through the real write path", () => {
  test("stripping a marker commits: it is a body edit, not a rename", async () => {
    const { vcs, index, read } = open();
    const located = await index.locate("src/alpha.test.ts::alpha returns 42");
    if (located === undefined) throw new Error("the fixture's acceptance test was not located");

    const intent = {
      taskId: "02-03",
      description: "activate the acceptance test",
      expectedOutcome: { modified: [located.id] },
    };
    const acquired = vcs.acquire({
      session: "session-oracle",
      symbolIds: [located.id],
      mode: "write",
      ttlMs: 60_000,
      intent,
    });
    if (acquired.outcome !== "granted") throw new Error(`expected a lease, got ${acquired.outcome}`);

    const result = await vcs.replaceSymbolBody({
      leaseId: acquired.leaseId,
      symbolId: located.id,
      expectedVersion: located.version,
      body: stripPendingMarker(located.body) as string,
      intent,
    });
    vcs.release(acquired.leaseId);

    // The whole claim: the structural stage saw no identity delta, because
    // there was none.
    expect(result).toMatchObject({ outcome: "committed", version: 2 });
    expect(read("src/alpha.test.ts")).toContain('test("alpha returns 42"');
    expect(read("src/alpha.test.ts")).not.toContain("test.skip(");
    // And the symbol kept its id, so the run that activated it and the run
    // that later reads it are talking about the same test.
    expect(vcs.registry.symbol(located.id)?.name).toBe("alpha returns 42");
    vcs.close();
  });

  test("the activated test is the one the impact graph hands the next run", async () => {
    const { vcs, index } = open();
    const located = await index.locate("src/alpha.test.ts::alpha returns 42");
    if (located === undefined) throw new Error("the fixture's acceptance test was not located");
    const alpha = vcs.registry
      .symbolsOf(vcs.registry.file("src/alpha.ts")?.id ?? "")
      .find((s) => s.name === "alpha");

    // The production symbol's impacted set holds the acceptance test, which is
    // what makes `run-tests` scoped to the write actually run it.
    expect(vcs.impact.impactedTests([alpha?.id ?? ""]).map((t) => t.id)).toEqual([located.id]);
    vcs.close();
  });
});
