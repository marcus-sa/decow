/**
 * The report, and the seam it reads from.
 *
 * Two claims, and the first is the one that matters: `runStep`'s observer sees
 * every attempt, with the attempt number, the mechanical violations that
 * refused one, and the validator's verdict on another — facts that exist
 * nowhere else, because the journal records only what a step DECIDED and the
 * exhaustion trail only exists when the validator was never satisfied. A
 * successful step that took two attempts leaves no other trace at all.
 *
 * The second is that the table adds up: `calls` counts attempts, `decided`
 * counts (row, step) pairs, and the gap between them is what the validator and
 * the mechanical checks cost in inference.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { memoryJournal } from "../../../src/core/journal.ts";
import type { Requirement } from "../../../src/core/requirement.ts";
import { runStep, stepOutput, type ModelBinding, type StepAttempt, type StepDef } from "../../../src/core/step.ts";
import { openReport, readReport, readTokens, renderTable, summarize, type ReportLine } from "./report.ts";

/* ------------------------------------------------------------ the fixtures */

const Output = stepOutput(["yes", "no"], { anchor: z.string() });
type Output = z.infer<typeof Output>;

/** A worker that answers from a script, one answer per call. */
const scripted = (id: string, answers: readonly Output[]): ModelBinding => {
  let at = 0;
  return {
    id,
    generate: async <T,>(): Promise<T> => {
      const answer = answers[Math.min(at, answers.length - 1)];
      at += 1;
      return answer as T;
    },
  };
};

/** A validator that passes or fails from a script. */
const judge = (id: string, verdicts: readonly ("pass" | "fail")[]): ModelBinding => {
  let at = 0;
  return {
    id,
    generate: async <T,>(): Promise<T> => {
      const verdict = verdicts[Math.min(at, verdicts.length - 1)] ?? "pass";
      at += 1;
      return {
        verdict,
        violations: verdict === "fail" ? [{ requirementId: "r.anchored", evidence: "no anchor" }] : [],
      } as T;
    },
  };
};

const anchored: Requirement<{ input: { text: string }; output: Output }> = {
  id: "r.anchored",
  sourceId: "test",
  text: "The anchor must be a verbatim quote from the input.",
  decisions: ["yes", "no"],
  check: ({ input, output }) =>
    input.text.includes(output.payload.anchor)
      ? null
      : { requirementId: "r.anchored", evidence: output.payload.anchor },
};

const def = (worker: ModelBinding, validator: ModelBinding): StepDef<{ text: string }, Output> => ({
  id: "test.classify",
  version: 1,
  input: z.object({ text: z.string() }),
  output: Output,
  requirements: [anchored],
  worker: { model: worker, system: "classify", prompt: (i) => i.text },
  validator: { model: validator },
  maxAttempts: 2,
});

describe("the observer sees every attempt", () => {
  test("a mechanical refusal, then an accepted retry, are two records", async () => {
    const seen: StepAttempt[] = [];
    const result = await runStep(
      def(
        scripted("worker", [
          { decision: "yes", payload: { anchor: "not in the input" } },
          { decision: "yes", payload: { anchor: "the cat" } },
        ]),
        judge("validator", ["pass"]),
      ),
      { text: "the cat sat on the mat" },
      memoryJournal(),
      (attempt) => seen.push(attempt),
    );

    expect(result.decision).toBe("ok");
    expect(seen).toHaveLength(2);

    // Attempt 1: the mechanical check refused it, so no validator was spent.
    expect(seen[0]).toMatchObject({
      stepId: "test.classify",
      attempt: 1,
      model: "worker",
      decision: "yes",
      accepted: false,
    });
    expect(seen[0]?.mechanical.map((v) => v.requirementId)).toEqual(["r.anchored"]);
    expect(seen[0]?.verdict).toBeUndefined();

    // Attempt 2: past the checks, the validator passed it, it was journaled.
    expect(seen[1]).toMatchObject({ attempt: 2, verdict: "pass", accepted: true });
    expect(seen[1]?.mechanical).toEqual([]);
    // Both records name the same journal key, because it is the same input.
    expect(seen[0]?.key).toBe(seen[1]?.key as string);
  });

  test("a validator refusal is a record with the verdict and the violations", async () => {
    const seen: StepAttempt[] = [];
    const result = await runStep(
      def(scripted("worker", [{ decision: "no", payload: { anchor: "the cat" } }]), judge("validator", ["fail"])),
      { text: "the cat sat on the mat" },
      memoryJournal(),
      (attempt) => seen.push(attempt),
    );

    expect(result.decision).toBe("validator-exhausted");
    expect(seen).toHaveLength(2);
    expect(seen.every((a) => a.verdict === "fail" && !a.accepted)).toBe(true);
    expect(seen[0]?.violations.map((v) => v.requirementId)).toEqual(["r.anchored"]);
  });

  test("a journal hit reports nothing, because no model was called", async () => {
    const seen: StepAttempt[] = [];
    const worker = scripted("worker", [{ decision: "yes", payload: { anchor: "the cat" } }]);
    const validator = judge("validator", ["pass"]);
    const journal = memoryJournal();

    await runStep(def(worker, validator), { text: "the cat sat" }, journal, (a) => seen.push(a));
    expect(seen).toHaveLength(1);

    // The same input again. Replay beats re-inference, and a replay is not a
    // call — counting it would make every rate in the table a fiction.
    await runStep(def(worker, validator), { text: "the cat sat" }, journal, (a) => seen.push(a));
    expect(seen).toHaveLength(1);
  });
});

describe("the report", () => {
  test("one line per leaf call, with the row it belongs to", () => {
    const dir = mkdtempSync(join(tmpdir(), "dw-report-"));
    const path = join(dir, "report.jsonl");
    try {
      const report = openReport({ path, run: "first" });

      report.onUsage({ promptTokens: 100, completionTokens: 20 });
      report.onUsage({ inputTokens: { total: 40 }, outputTokens: { total: 5 } });
      report.observerFor("01-01")({
        stepId: "deliver.implement",
        version: 1,
        key: "deliver.implement@1:abc",
        attempt: 1,
        model: "anthropic/claude-sonnet-5",
        decision: "written",
        mechanical: [],
        verdict: "pass",
        violations: [],
        accepted: true,
      });

      const lines = readReport(path);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        run: "first",
        row: "01-01",
        step: "deliver.implement",
        attempt: 1,
        decision: "written",
        accepted: true,
        // Both usage shapes in the dependency graph are read.
        workerTokens: { input: 100, output: 20 },
        validatorTokens: { input: 40, output: 5 },
      });
      // Written as it goes: the file holds the line before anything closed.
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unrecognised usage shape yields no tokens rather than zero", () => {
    // "The provider did not say" and "the call cost nothing" are different
    // claims, and a report that conflated them would be lying about the
    // cheapest thing it measures.
    expect(readTokens(undefined)).toEqual({});
    expect(readTokens({ tokens: 12 })).toEqual({});
    expect(readTokens({ promptTokens: 7 })).toEqual({ input: 7 });
    expect(readTokens({ inputTokens: 9, outputTokens: 3 })).toEqual({ input: 9, output: 3 });
  });

  test("calls count attempts and decided counts decisions, so the gap is the cost", () => {
    const line = (over: Partial<ReportLine>): ReportLine => ({
      run: "first",
      row: "01-01",
      step: "deliver.gates",
      attempt: 1,
      model: "haiku",
      accepted: false,
      violations: [],
      mechanical: [],
      ...over,
    });

    const summary = summarize([
      // One decision, two attempts: the first was refused mechanically.
      line({ mechanical: [{ requirementId: "r.anchored", evidence: "x" }] }),
      line({ attempt: 2, verdict: "pass", accepted: true, workerTokens: { input: 10, output: 2 } }),
      // A second row, accepted first try.
      line({ row: "01-02", verdict: "pass", accepted: true }),
      // A third that never got there.
      line({ row: "01-03", verdict: "fail", violations: [{ requirementId: "r.anchored", evidence: "y" }] }),
      line({ row: "01-03", attempt: 2, verdict: "fail", violations: [{ requirementId: "r.anchored", evidence: "y" }] }),
    ]);

    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      step: "deliver.gates",
      calls: 5,
      decisions: 3,
      firstAttempt: 1,
      exhausted: 1,
      validatorRejections: 2,
      mechanicalFailures: 1,
      input: 10,
      output: 2,
    });

    const table = renderTable(summary);
    expect(table).toContain("deliver.gates");
    expect(table).toContain("1/3");
    expect(table).toContain("TOTAL");
  });

  test("an empty report is said so rather than rendered as zeroes", () => {
    expect(summarize([])).toEqual([]);
    expect(renderTable([])).toBe("(no leaf calls recorded)");
  });
});
