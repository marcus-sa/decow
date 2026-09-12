/**
 * The seam, end to end, through the real Mastra runner.
 *
 * The design document's own words for what this covers: "The first integration
 * test is not the VCS's own phase one. It is: the runner executes an
 * `Effect[]` through the VCS with lease, verify, and log, and gets back a
 * typed result a branch can route on. That one path exercises every seam."
 *
 * So the graph here is deliberately the smallest one that has the shape of
 * DELIVER's `implement`: one leaf that emits a `replace-symbol`, and a branch
 * that routes the write outcome. The leaf's model is a stub journal hit, so no
 * model is called; the verifier's stages are injected, so no compiler runs.
 * Everything between the effect and the file on disk is real.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EffectResult } from "../core/effects.ts";
import { stepOutput, type StepDef } from "../core/step.ts";
import { branch, leaf, run, type Node, type Workflow } from "../core/workflow.ts";
import { ok, stubJournal } from "../harness/stub-journal.ts";
import { vcsExecutor } from "./executor.ts";
import { openVcs, type Vcs } from "./index.ts";
import { counterIds, failingStage, manualClock, passingVerifier, tempProject } from "./testing.ts";
import type { Verifier } from "./verify.ts";

const SOURCE = `export function alpha(): number {
  return 1;
}
`;
const NEW_BODY = "export function alpha(): number {\n  return 42;\n}";

/* --------------------------------------------------------------- the step */

const Input = z.object({ symbolId: z.string(), criteria: z.string() });
type Input = z.infer<typeof Input>;

const Output = stepOutput(["written"] as const, { body: z.string() });
type Output = z.infer<typeof Output>;

/** A model binding that fails the test if anything reaches a model. */
const forbidden = {
  id: "forbidden",
  generate: async <T,>(): Promise<T> => {
    throw new Error("a model was called; this suite spends zero model calls");
  },
};

const implementDef: StepDef<Input, Output> = {
  id: "implement",
  version: 1,
  input: Input,
  output: Output,
  requirements: [],
  worker: {
    model: forbidden,
    system: "Make the acceptance test pass with the minimal change.",
    prompt: (input) => input.criteria,
  },
  validator: { model: forbidden },
  maxAttempts: 1,
};

/* -------------------------------------------------------------- the graph */

type WriteVerdict = EffectResult["outcome"] | "exhausted";

type State = {
  symbolId: string;
  criteria: string;
  expectedVersion: number;
  write?: EffectResult["outcome"];
  version?: number;
  rejectedBy?: string;
};

const writeVerdict = (s: State): WriteVerdict => s.write ?? "exhausted";

const graph = (journal: ReturnType<typeof stubJournal>): Workflow<State> => ({
  start: "implement",
  nodes: {
    implement: leaf<State, Input, Output>({
      def: implementDef,
      journal,
      input: (s) => ({ symbolId: s.symbolId, criteria: s.criteria }),
      absorb: (s) => s,
      effects: (s, r) =>
        r.decision === "ok"
          ? [
              {
                type: "replace-symbol",
                symbolId: s.symbolId,
                expectedVersion: s.expectedVersion,
                body: r.output.payload.body,
              },
            ]
          : [],
      absorbEffects: (s, results) => {
        const landed = results.find((r) => r.effect.type === "replace-symbol");
        if (landed === undefined) return s;
        if (landed.outcome === "committed") return { ...s, write: "committed", version: landed.version };
        if (landed.outcome === "conflict") return { ...s, write: "conflict", version: landed.currentVersion };
        if (landed.outcome === "rejected") return { ...s, write: "rejected", rejectedBy: landed.by };
        return { ...s, write: "infra-failed" };
      },
      next: "write.verdict",
    }),

    // The whole point of a typed effect result: a lease conflict is an edge to
    // a rebase node, and a rejected write is an edge to a person. Neither is
    // an exception crossing the graph boundary.
    "write.verdict": branch<State, WriteVerdict>(writeVerdict, {
      committed: "accept",
      conflict: "rebase",
      rejected: "reject",
      "infra-failed": "reject",
      exhausted: "reject",
    }),

    rebase: {
      type: "step",
      run: async (s) => ({ state: { ...s, expectedVersion: s.version ?? s.expectedVersion }, effects: [] }),
      absorb: (s) => s,
      next: "reject",
    } satisfies Node<State>,

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: [s.write] }) },
  },
});

/* ------------------------------------------------------------- the fixture */

const TASK = { taskId: "task-executor", parentTaskId: "roadmap-02-03", description: "make alpha return 42" };

const open = (verifier: Partial<Verifier> = {}) => {
  const root = tempProject({ "a.ts": SOURCE });
  const vcs = openVcs({
    root,
    verifier: passingVerifier(verifier),
    clock: manualClock(1_000),
    ids: counterIds(),
  });
  const file = vcs.track("a.ts");
  const symbolId = vcs.registry.symbolsOf(file.id)[0]?.id ?? "";
  const inventoryEvents = vcs.log.all().length;
  const read = () => readFileSync(join(root, "a.ts"), "utf8");
  return { root, vcs, symbolId, inventoryEvents, read };
};

const journal = () => stubJournal({ implement: ok({ decision: "written", payload: { body: NEW_BODY } }) });

const drive = (vcs: Vcs, symbolId: string, expectedVersion: number) =>
  run<State>(
    graph(journal()),
    { symbolId, criteria: "alpha returns 42", expectedVersion },
    vcsExecutor({ vcs, session: "session-executor", intent: TASK }),
  );

describe("the VCS as the framework's effect executor", () => {
  test("a leaf's replace-symbol commits, and absorbEffects sees the version", async () => {
    const { vcs, symbolId, read } = open();
    const outcome = await drive(vcs, symbolId, 1);

    expect(outcome.kind).toBe("terminal");
    if (outcome.kind !== "terminal") throw new Error("unreachable");
    expect(outcome.terminal.kind).toBe("accepted");
    expect(outcome.terminal.state.write).toBe("committed");
    expect(outcome.terminal.state.version).toBe(2);
    expect(outcome.trace).toEqual(["implement", "write.verdict", "accept"]);

    // The write went all the way to the file, under a lease, through the gate.
    expect(read()).toBe(`${NEW_BODY}\n`);
    expect(vcs.registry.symbol(symbolId)?.version).toBe(2);
    vcs.close();
  });

  test("a stale expected version comes back as a conflict the branch routes", async () => {
    const { vcs, symbolId, read } = open();
    await drive(vcs, symbolId, 1);

    // The world moved to version 2. A second run still claiming 1 is the
    // rebase-and-retry edge, not an error.
    const outcome = await drive(vcs, symbolId, 1);
    if (outcome.kind !== "terminal") throw new Error("expected a terminal");
    expect(outcome.terminal.state.write).toBe("conflict");
    expect(outcome.terminal.state.version).toBe(2);
    expect(outcome.trace).toEqual(["implement", "write.verdict", "rebase", "reject"]);

    // And the conflicting run changed nothing.
    expect(read()).toBe(`${NEW_BODY}\n`);
    vcs.close();
  });

  test("a failing typecheck stage is rejected: typecheck, and the file is rolled back", async () => {
    const { vcs, symbolId, read } = open({
      typecheck: failingStage("typecheck", "TS2322: Type 'string' is not assignable to type 'number'"),
    });
    const outcome = await drive(vcs, symbolId, 1);

    if (outcome.kind !== "terminal") throw new Error("expected a terminal");
    expect(outcome.terminal.kind).toBe("rejected");
    expect(outcome.terminal.state.write).toBe("rejected");
    expect(outcome.terminal.state.rejectedBy).toBe("typecheck");
    expect(outcome.trace).toEqual(["implement", "write.verdict", "reject"]);

    expect(read()).toBe(SOURCE);
    expect(vcs.registry.symbol(symbolId)?.version).toBe(1);
    vcs.close();
  });

  test("every event the executor produced carries its task id", async () => {
    const { vcs, symbolId, inventoryEvents } = open();
    await drive(vcs, symbolId, 1);

    const produced = vcs.log.all().slice(inventoryEvents);
    expect(produced.map((e) => e.kind)).toEqual([
      "lease-acquired",
      "symbol-modified",
      "transaction",
      "lease-released",
    ]);
    // The provenance link the design asks for: the journal answers what each
    // step decided, the VCS log answers what changed, and the task id is what
    // joins them.
    expect(produced.every((e) => e.taskId === "task-executor")).toBe(true);
    expect(produced.every((e) => e.parentTaskId === "roadmap-02-03")).toBe(true);
    expect(vcs.log.byTask("task-executor").length).toBe(produced.length);
    vcs.close();
  });

  test("one lease covers the whole batch, and it is released before the run ends", async () => {
    const { vcs, symbolId } = open();
    await drive(vcs, symbolId, 1);

    const acquired = vcs.log.all().filter((e) => e.kind === "lease-acquired");
    expect(acquired.length).toBe(1);
    expect(vcs.leases.live()).toEqual([]);
    vcs.close();
  });

  test("a run-tests effect runs the impacted subset and commits at the event's seq", async () => {
    const { vcs, symbolId } = open();
    const execute = vcsExecutor({ vcs, session: "session-executor", intent: TASK });
    const [result] = await execute([{ type: "run-tests", impacted: [symbolId] }]);

    expect(result).toMatchObject({ outcome: "committed" });
    expect(vcs.log.all().at(-1)).toMatchObject({ kind: "tests-run", taskId: "task-executor" });
    vcs.close();
  });

  test("a failing tests stage makes run-tests rejected: tests", async () => {
    const { vcs, symbolId } = open({ tests: failingStage("tests", "1 failing") });
    const execute = vcsExecutor({ vcs, session: "session-executor", intent: TASK });
    const [result] = await execute([{ type: "run-tests", impacted: [symbolId] }]);
    expect(result).toMatchObject({ outcome: "rejected", by: "tests" });
    vcs.close();
  });

  test("an append-trail effect becomes provenance, and upsert-artifact stays unwired", async () => {
    const { vcs } = open();
    const execute = vcsExecutor({ vcs, session: "session-executor", intent: TASK });
    const results = await execute([
      { type: "append-trail", line: '{"leaf":"implement","trail":[]}' },
      { type: "upsert-artifact", table: "requirements", id: "r-1", expectedVersion: 0, row: {} },
    ]);

    expect(results[0]).toMatchObject({ outcome: "committed" });
    expect(vcs.log.all().at(-1)).toMatchObject({
      kind: "trail",
      taskId: "task-executor",
      detail: '{"leaf":"implement","trail":[]}',
    });
    // The VCS is the data plane for code. Artifact rows are the other half of
    // the state layer and no executor is wired for them, which is an
    // infrastructure fact rather than a rejection.
    expect(results[1]).toMatchObject({ outcome: "infra-failed" });
    vcs.close();
  });

  test("a desynced file is infra-failed, not rejected, because the agent did not cause it", async () => {
    const { vcs, symbolId, root } = open();
    writeFileSync(join(root, "a.ts"), "export function alpha(): number {\n  return 0;\n}\n", "utf8");
    vcs.reinventory("a.ts");

    const outcome = await drive(vcs, symbolId, 1);
    if (outcome.kind !== "terminal") throw new Error("expected a terminal");
    expect(outcome.terminal.state.write).toBe("infra-failed");
    expect(outcome.trace).toEqual(["implement", "write.verdict", "reject"]);
    vcs.close();
  });
});
