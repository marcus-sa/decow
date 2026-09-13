/**
 * The artifact store: versions, the conflict that is a decision rather than an
 * exception, the append-only log, and the time-travel read that log buys.
 *
 * Plus the two executors' routing, which is the reason the store exists: an
 * `upsert-artifact` effect that landed in a `Map` under one executor and came
 * back `infra-failed` under the other would leave a roadmap dying with the
 * process that authored it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryEffects } from "../core/effects.ts";
import { vcsExecutor } from "../vcs/executor.ts";
import { openVcs } from "../vcs/index.ts";
import { counterIds, manualClock, passingVerifier, tempProject } from "../vcs/testing.ts";
import { openArtifacts } from "./store.ts";

const TABLE = "roadmap_steps";
const ROW = { id: "01-01", observation: "a deploy reaches Running" };

describe("the artifact store", () => {
  test("a first write at expectedVersion 0 commits at version 1", () => {
    const store = openArtifacts();
    expect(store.read(TABLE, "01-01")).toBeUndefined();

    expect(store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: ROW })).toEqual({
      outcome: "committed",
      version: 1,
    });
    expect(store.read(TABLE, "01-01")).toEqual({ version: 1, row: ROW });
    store.close();
  });

  test("a write at the current version commits at the next one", () => {
    const store = openArtifacts();
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: ROW });
    const second = { ...ROW, observation: "a deploy reaches Running through the driver" };

    expect(store.upsert({ table: TABLE, id: "01-01", expectedVersion: 1, row: second })).toEqual({
      outcome: "committed",
      version: 2,
    });
    expect(store.read(TABLE, "01-01")?.row).toEqual(second);
    store.close();
  });

  test("a stale expectedVersion is a conflict carrying the version the world moved to", () => {
    const store = openArtifacts();
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: ROW });

    // The rebase input, exactly as `replace-symbol`'s conflict carries it.
    expect(store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: ROW })).toEqual({
      outcome: "conflict",
      currentVersion: 1,
    });
    // And the conflicting write changed nothing.
    expect(store.read(TABLE, "01-01")).toEqual({ version: 1, row: ROW });
    expect(store.events()).toHaveLength(1);
    store.close();
  });

  test("a version ahead of the current one is a conflict too, not a gap", () => {
    const store = openArtifacts();
    expect(store.upsert({ table: TABLE, id: "01-01", expectedVersion: 7, row: ROW })).toEqual({
      outcome: "conflict",
      currentVersion: 0,
    });
    store.close();
  });

  test("the same id in two tables is two rows", () => {
    const store = openArtifacts();
    store.upsert({ table: "roadmaps", id: "01-01", expectedVersion: 0, row: { a: 1 } });
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: { a: 2 } });

    expect(store.read("roadmaps", "01-01")?.row).toEqual({ a: 1 });
    expect(store.read(TABLE, "01-01")?.row).toEqual({ a: 2 });
    store.close();
  });

  test("list is one table's live rows, by id", () => {
    const store = openArtifacts();
    for (const id of ["01-03", "01-01", "01-02"]) {
      store.upsert({ table: TABLE, id, expectedVersion: 0, row: { id } });
    }
    store.upsert({ table: "roadmaps", id: "r", expectedVersion: 0, row: {} });

    expect(store.list(TABLE).map((r) => r.id)).toEqual(["01-01", "01-02", "01-03"]);
    expect(store.list(TABLE).every((r) => r.version === 1)).toBe(true);
    expect(store.list("nothing-here")).toEqual([]);
    store.close();
  });

  test("every accepted upsert appends one event, in order, with the version it produced", () => {
    const store = openArtifacts();
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: { n: 1 } });
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 1, row: { n: 2 } });
    store.upsert({ table: "roadmaps", id: "r", expectedVersion: 0, row: { n: 3 } });

    expect(store.events().map((e) => [e.table, e.id, e.version])).toEqual([
      [TABLE, "01-01", 1],
      [TABLE, "01-01", 2],
      ["roadmaps", "r", 1],
    ]);
    expect(store.events().map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(store.events(TABLE)).toHaveLength(2);
    store.close();
  });

  test("at reads the body a row held at a version, which is what the log is for", () => {
    const store = openArtifacts();
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: { n: 1 } });
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 1, row: { n: 2 } });
    store.upsert({ table: TABLE, id: "01-01", expectedVersion: 2, row: { n: 3 } });

    expect(store.at(TABLE, "01-01", 1)).toEqual({ n: 1 });
    expect(store.at(TABLE, "01-01", 2)).toEqual({ n: 2 });
    expect(store.at(TABLE, "01-01", 3)).toEqual({ n: 3 });
    // The current row is the latest; time travel does not move it.
    expect(store.read(TABLE, "01-01")).toEqual({ version: 3, row: { n: 3 } });
    expect(store.at(TABLE, "01-01", 4)).toBeUndefined();
    store.close();
  });

  test("rows outlive the process when the store has a path", () => {
    // The whole point: a roadmap that dies with the process is not a roadmap.
    const path = join(mkdtempSync(join(tmpdir(), "dw-artifacts-")), "artifacts.sqlite");
    const first = openArtifacts({ path });
    first.upsert({ table: TABLE, id: "01-01", expectedVersion: 0, row: ROW });
    first.close();

    const second = openArtifacts({ path });
    expect(second.read(TABLE, "01-01")).toEqual({ version: 1, row: ROW });
    // And so does the log, so a reopened store can still answer "what changed".
    expect(second.events()).toHaveLength(1);
    // A second writer picks up where the first left off rather than colliding.
    expect(second.upsert({ table: TABLE, id: "01-01", expectedVersion: 1, row: ROW })).toEqual({
      outcome: "committed",
      version: 2,
    });
    second.close();
  });
});

describe("both effect executors route upsert-artifact to the store", () => {
  const effect = (id: string, expectedVersion: number) =>
    ({ type: "upsert-artifact", table: TABLE, id, expectedVersion, row: { id } }) as const;

  test("memoryEffects writes through to an injected store", async () => {
    const store = openArtifacts();
    const effects = memoryEffects({ store });

    const [result] = await effects.execute([effect("01-01", 0)]);
    expect(result).toMatchObject({ outcome: "committed", version: 1 });
    expect(store.read(TABLE, "01-01")).toEqual({ version: 1, row: { id: "01-01" } });
    // The Map-shaped view is a projection over the store, so it still reads.
    expect([...effects.artifacts.keys()]).toEqual([`${TABLE}/01-01`]);
    store.close();
  });

  test("memoryEffects with no store still writes rows, to one of its own", async () => {
    const effects = memoryEffects();
    await effects.execute([effect("01-01", 0)]);
    expect(effects.store.read(TABLE, "01-01")?.version).toBe(1);
    expect([...effects.artifacts.values()]).toEqual([{ version: 1, row: { id: "01-01" } }]);
    effects.store.close();
  });

  test("memoryEffects routes a stale version to conflict, not to an exception", async () => {
    const effects = memoryEffects();
    await effects.execute([effect("01-01", 0)]);
    const [result] = await effects.execute([effect("01-01", 0)]);
    expect(result).toMatchObject({ outcome: "conflict", currentVersion: 1 });
    effects.store.close();
  });

  test("vcsExecutor writes artifact rows to the store it was handed", async () => {
    const vcs = openVcs({
      root: tempProject({ "a.ts": "export const a = 1;\n" }),
      verifier: passingVerifier(),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    const store = openArtifacts();
    const execute = vcsExecutor({
      vcs,
      session: "session-artifacts",
      intent: { taskId: "01-01", description: "persist the roadmap" },
      artifacts: store,
    });

    const [committed] = await execute([effect("01-01", 0)]);
    expect(committed).toMatchObject({ outcome: "committed", version: 1 });
    expect(store.read(TABLE, "01-01")).toEqual({ version: 1, row: { id: "01-01" } });

    // The same optimistic check `replace-symbol` gets, one column over.
    const [conflicted] = await execute([effect("01-01", 0)]);
    expect(conflicted).toMatchObject({ outcome: "conflict", currentVersion: 1 });

    store.close();
    vcs.close();
  });

  test("vcsExecutor with no store is still infra-failed, because it has nowhere to write", async () => {
    const vcs = openVcs({
      root: tempProject({ "a.ts": "export const a = 1;\n" }),
      verifier: passingVerifier(),
      clock: manualClock(1_000),
      ids: counterIds(),
    });
    const execute = vcsExecutor({
      vcs,
      session: "session-artifacts",
      intent: { taskId: "01-01", description: "persist the roadmap" },
    });

    // An executor that cannot write must not report that it did.
    const [result] = await execute([effect("01-01", 0)]);
    expect(result).toMatchObject({ outcome: "infra-failed" });
    vcs.close();
  });
});
