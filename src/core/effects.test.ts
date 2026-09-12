import { describe, expect, test } from "bun:test";
import { memoryEffects, type Effect } from "./effects.ts";

const upsert = (id: string, expectedVersion: number, row: unknown): Effect => ({
  type: "upsert-artifact",
  table: "requirements",
  id,
  expectedVersion,
  row,
});

describe("memoryEffects", () => {
  test("a first write at version 0 commits at version 1", async () => {
    const { execute, artifacts } = memoryEffects();
    const [r] = await execute([upsert("r-1", 0, { text: "a" })]);
    expect(r).toMatchObject({ outcome: "committed", version: 1 });
    expect(artifacts.get("requirements/r-1")).toEqual({ version: 1, row: { text: "a" } });
  });

  test("a stale expectedVersion is a conflict, not an exception, and does not write", async () => {
    const { execute, artifacts } = memoryEffects();
    await execute([upsert("r-1", 0, { text: "a" })]);
    const [r] = await execute([upsert("r-1", 0, { text: "clobber" })]);

    expect(r).toMatchObject({ outcome: "conflict", currentVersion: 1 });
    expect(artifacts.get("requirements/r-1")).toEqual({ version: 1, row: { text: "a" } });
  });

  test("the same id in a different table is a different row", async () => {
    const { execute } = memoryEffects();
    await execute([upsert("r-1", 0, { text: "a" })]);
    const [r] = await execute([
      { type: "upsert-artifact", table: "steps", id: "r-1", expectedVersion: 0, row: { text: "b" } },
    ]);
    expect(r).toMatchObject({ outcome: "committed", version: 1 });
  });

  test("append-trail commits and accumulates in order", async () => {
    const { execute, trail } = memoryEffects();
    const results = await execute([
      { type: "append-trail", line: "one" },
      { type: "append-trail", line: "two" },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["committed", "committed"]);
    expect(trail).toEqual(["one", "two"]);
  });

  test("unwired effects come back infra-failed, never rejected", async () => {
    // `rejected` means "your change was wrong". No executor is wired for these
    // two, which is an infrastructure fact and must not burn a retry budget.
    const { execute } = memoryEffects();
    const results = await execute([
      { type: "replace-symbol", symbolId: "s", expectedVersion: 0, body: "" },
      { type: "run-tests", impacted: ["a"] },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["infra-failed", "infra-failed"]);
  });
});
