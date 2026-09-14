/**
 * The three tables, and the one property that separates them.
 *
 * `runs` is UPDATED — it is where a run is now — and `run_events` and
 * `leaf_attempts` are APPENDED, so what a run was is never overwritten. That
 * split is the whole design: a status column a reader can trust, and a history
 * nothing can rewrite to agree with it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepAttempt } from "@des/core/step";
import { openRunDatabase } from "./store.ts";

const attempt = (over: Partial<StepAttempt> = {}): StepAttempt => ({
  stepId: "fixture.classify",
  version: 1,
  key: "fixture.classify@1:abc",
  attempt: 1,
  model: "fake-worker",
  decision: "ready",
  mechanical: [],
  violations: [],
  accepted: true,
  ...over,
});

describe("the run database", () => {
  test("a run row moves and its history does not", () => {
    const db = openRunDatabase();
    db.runs.insert({ runId: "r1", workflowId: "gate", input: { subject: "a" }, startedSeq: 0 });
    db.events.append({ runId: "r1", kind: "run-started", payload: { runId: "r1" } });
    db.events.append({ runId: "r1", kind: "node-entered", payload: { node: "classify" } });
    db.runs.update("r1", { status: "suspended", suspension: { reason: "a person decides" } });
    db.events.append({ runId: "r1", kind: "suspended", payload: { reason: "a person decides" } });
    db.runs.update("r1", { status: "accepted", terminal: { kind: "accepted" }, settledSeq: 4 });

    // The row is where the run ended up, and only that.
    const row = db.runs.get("r1");
    expect(row?.status).toBe("accepted");
    expect(row?.terminal).toEqual({ kind: "accepted" });
    // An update leaves everything it did not name alone, so the suspension the
    // run passed through is still readable beside the terminal it reached.
    expect(row?.suspension).toEqual({ reason: "a person decides" });

    // And the transitions it passed through are still in order, untouched.
    expect(db.events.of("r1").map((e) => e.kind)).toEqual([
      "run-started",
      "node-entered",
      "suspended",
    ]);
    db.close();
  });

  test("an event with no run is still an event, and is found by kind", () => {
    // `pipeline-step` is the one kind of the eight that may name no run: a step
    // the server has not started yet still has a status worth publishing.
    const db = openRunDatabase();
    db.events.append({ kind: "pipeline-step", payload: { pipelineId: "p", stepId: "a" } });
    db.events.append({ runId: "r1", kind: "pipeline-step", payload: { pipelineId: "p", stepId: "a" } });
    db.events.append({ runId: "r1", kind: "terminal", payload: { kind: "accepted" } });

    expect(db.events.byKind("pipeline-step").map((e) => e.runId)).toEqual([undefined, "r1"]);
    expect(db.events.of("r1")).toHaveLength(2);
    db.close();
  });

  test("attempts are appended in the order they were made, tokens and all", () => {
    const db = openRunDatabase();
    db.attempts.append(
      "r1",
      attempt({
        accepted: false,
        cause: "schema",
        error: "the endpoint answered a bare array",
        workerTokens: { input: 10, output: 1 },
      }),
    );
    db.attempts.append(
      "r1",
      attempt({
        attempt: 2,
        verdict: "pass",
        workerTokens: { input: 20, output: 2 },
        validatorTokens: { input: 30, output: 3 },
      }),
    );

    const rows = db.attempts.of("r1");
    expect(rows.map((r) => `${r.attempt}:${r.accepted}`)).toEqual(["1:false", "2:true"]);
    expect(rows[0]?.validatorTokens).toBeUndefined();
    // Why it did not stand, on the row that did not stand — and absent on the
    // one that did, because an attempt that was accepted has no cause.
    expect(rows[0]?.cause).toBe("schema");
    expect(rows[0]?.error).toBe("the endpoint answered a bare array");
    expect(rows[1]?.cause).toBeUndefined();
    expect(rows[1]?.validatorTokens).toEqual({ input: 30, output: 3 });
    expect(db.attempts.countOf("r1")).toBe(2);
    expect(db.attempts.countOf("r2")).toBe(0);
    db.close();
  });

  test("a second handle on the same file reads what the first wrote", () => {
    // The restart guarantee, at the level the restart is actually made of.
    const dir = mkdtempSync(join(tmpdir(), "dw-store-"));
    try {
      const path = join(dir, "runs.sqlite");
      const first = openRunDatabase({ path });
      first.runs.insert({ runId: "r1", workflowId: "gate", input: { subject: "a" }, startedSeq: 0 });
      first.events.append({ runId: "r1", kind: "node-entered", payload: { node: "classify" } });
      first.attempts.append("r1", attempt());
      first.close();

      const second = openRunDatabase({ path });
      expect(second.runs.get("r1")?.input).toEqual({ subject: "a" });
      expect(second.events.of("r1")).toHaveLength(1);
      expect(second.attempts.of("r1")).toHaveLength(1);
      // And the sequence continues rather than restarting, so "later" survives.
      expect(second.events.append({ runId: "r1", kind: "terminal", payload: {} })).toBe(2);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
