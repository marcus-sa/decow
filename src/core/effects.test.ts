import { describe, expect, test } from "bun:test";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./commands.ts";
import { commandEffect, commandOf, memoryEffects, type Effect } from "./effects.ts";

/** A `run-command` effect at the framework default budget. */
const command = (argv: readonly string[]): Extract<Effect, { type: "run-command" }> => ({
  type: "run-command",
  argv,
  timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
});

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

  test("a command that exits zero commits, and its output rides on the result", async () => {
    // `run-command` is NOT in the unwired list, deliberately: a command needs
    // no VCS behind it, and an executor that refused one would be pretending
    // it could not do a thing it can.
    const { execute } = memoryEffects();
    const [result] = await execute([command(["bash", "-c", "echo hello"])]);

    expect(result).toMatchObject({ outcome: "committed", version: 1 });
    expect(commandOf(result)?.stdout.trim()).toBe("hello");
    expect(commandOf(result)?.exitCode).toBe(0);
  });

  test("a non-zero exit is rejected BY COMMAND, with the output still attached", async () => {
    const { execute } = memoryEffects();
    const [result] = await execute([command(["bash", "-c", "echo bad >&2; exit 2"])]);

    expect(result).toMatchObject({ outcome: "rejected", by: "command" });
    expect(commandOf(result)?.exitCode).toBe(2);
    expect(commandOf(result)?.stderr.trim()).toBe("bad");
  });

  test("a command that cannot be spawned is infra-failed and carries nothing", async () => {
    // Nothing about it was observed, so nothing about it is claimed.
    const { execute } = memoryEffects();
    const [result] = await execute([command(["a-binary-that-does-not-exist-anywhere"])]);

    expect(result).toMatchObject({ outcome: "infra-failed" });
    expect(commandOf(result)).toBeUndefined();
  });

  test("a command killed at its budget is infra-failed and DOES carry what it printed", async () => {
    // It ran. The exit is absent because there is none to read, and the two
    // absences are different facts.
    const { execute } = memoryEffects();
    const [result] = await execute([
      { ...command(["bash", "-c", "echo started; sleep 30"]), timeoutMs: 150 },
    ]);

    expect(result).toMatchObject({ outcome: "infra-failed" });
    expect(commandOf(result)).toMatchObject({ timedOut: true, exitCode: null });
    expect(commandOf(result)?.stdout).toContain("started");
  });

  test("the version of a committed command is its ordinal, because a command claims none", async () => {
    const { execute } = memoryEffects();
    const results = await execute([command(["true"]), command(["true"])]);
    expect(results.map((r) => (r.outcome === "committed" ? r.version : -1))).toEqual([1, 2]);
  });

  test("a relative cwd resolves against the executor's base", async () => {
    const { execute } = memoryEffects({ cwd: "/" });
    const [result] = await execute([{ ...command(["pwd"]), cwd: "tmp" }]);
    expect(commandOf(result)?.stdout.trim()).toContain("tmp");
  });
});

describe("a declared command as an effect", () => {
  test("commandEffect carries only the fields the declaration named", () => {
    expect(commandEffect({ argv: ["a"], timeoutMs: 5 })).toEqual({
      type: "run-command",
      argv: ["a"],
      timeoutMs: 5,
    });
    expect(
      commandEffect({ argv: ["a"], timeoutMs: 5, env: { X: "1" }, resources: ["db"] }, "sub/dir"),
    ).toEqual({
      type: "run-command",
      argv: ["a"],
      cwd: "sub/dir",
      env: { X: "1" },
      resources: ["db"],
      timeoutMs: 5,
    });
  });

  test("a run-tests effect carrying `extra` is unchanged here: there is no impact graph", async () => {
    // The union rule lives where the floor lives. This executor has no impact
    // graph, so it cannot compute a floor, cannot tell an omission from a
    // selection, and must not pretend to: `extra` changes nothing and the
    // answer stays `infra-failed`. Enforcement is `vcsExecutor`'s.
    const { execute } = memoryEffects();
    const [result] = await execute([{ type: "run-tests", impacted: ["a"], extra: ["t-1"] }]);
    expect(result).toMatchObject({ outcome: "infra-failed" });
  });
});
