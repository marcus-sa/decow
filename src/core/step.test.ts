/**
 * runStep against an injected fake model binding. No agent is constructed, no
 * key is read, no socket is opened.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { memoryJournal, sqliteJournal } from "./journal.ts";
import type { Requirement } from "./requirement.ts";
import {
  canonicalJson,
  journalKey,
  runStep,
  stepOutput,
  type ModelBinding,
  type StepDef,
  type Verdict,
} from "./step.ts";

const Input = z.object({ text: z.string() });
type Input = z.infer<typeof Input>;

const Output = stepOutput(["yes", "no"] as const, { anchor: z.string() });
type Output = z.infer<typeof Output>;

type Ctx = { input: Input; output: Output };

const anchorVerbatim: Requirement<Ctx> = {
  id: "test.anchor-verbatim",
  sourceId: "test.source",
  text: "The anchor must be a verbatim substring of the input.",
  decisions: ["yes", "no"],
  check: ({ input, output }) =>
    input.text.includes(output.payload.anchor)
      ? null
      : { requirementId: "test.anchor-verbatim", evidence: output.payload.anchor },
};

/**
 * A scripted model. `worker` yields queued outputs in order; `validator`
 * yields queued verdicts in order. Every prompt it sees is recorded.
 */
const scripted = (script: { outputs: Output[]; verdicts: Verdict[] }) => {
  const prompts: { model: string; system: string; prompt: string }[] = [];
  let outputIndex = 0;
  let verdictIndex = 0;

  const binding = (id: string, take: () => unknown): ModelBinding => ({
    id,
    generate: async <T,>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T> => {
      prompts.push({ model: id, system: req.system, prompt: req.prompt });
      return take() as T;
    },
  });

  return {
    prompts,
    worker: binding("fake-worker", () => script.outputs[outputIndex++] ?? script.outputs.at(-1)),
    escalate: binding("fake-escalate", () => script.outputs[outputIndex++] ?? script.outputs.at(-1)),
    validator: binding("fake-validator", () => script.verdicts[verdictIndex++] ?? script.verdicts.at(-1)),
  };
};

const def = (models: { worker: ModelBinding; validator: ModelBinding; escalateTo?: ModelBinding }) =>
  ({
    id: "test.step",
    version: 1,
    input: Input,
    output: Output,
    requirements: [anchorVerbatim],
    worker: {
      model: models.worker,
      system: "You answer yes or no.",
      prompt: (i: Input) => `Question about: ${i.text}`,
    },
    validator: { model: models.validator },
    maxAttempts: 2,
    escalateTo: models.escalateTo,
  }) satisfies StepDef<Input, Output>;

const PASS: Verdict = { verdict: "pass", violations: [] };
const out = (decision: "yes" | "no", anchor: string): Output => ({ decision, payload: { anchor } });

describe("runStep", () => {
  test("a mechanical-check rejection feeds back into the next attempt", async () => {
    const models = scripted({
      outputs: [out("yes", "NOT IN THE INPUT"), out("yes", "quick brown")],
      verdicts: [PASS],
    });
    const result = await runStep(
      def(models),
      { text: "the quick brown fox" },
      memoryJournal(),
    );

    expect(result.decision).toBe("ok");

    const workerPrompts = models.prompts.filter((p) => p.model === "fake-worker");
    expect(workerPrompts).toHaveLength(2);
    // The first attempt carried no feedback.
    expect(workerPrompts[0]!.prompt).not.toContain("Your previous attempt violated");
    // The second carried the mechanical violation verbatim.
    expect(workerPrompts[1]!.prompt).toContain("Your previous attempt violated");
    expect(workerPrompts[1]!.prompt).toContain('test.anchor-verbatim: "NOT IN THE INPUT"');
  });

  test("a mechanical-check rejection does not spend the validator", async () => {
    const models = scripted({
      outputs: [out("yes", "NOT IN THE INPUT"), out("yes", "quick brown")],
      verdicts: [PASS],
    });
    await runStep(def(models), { text: "the quick brown fox" }, memoryJournal());

    // One validator call total: the first attempt never reached it.
    expect(models.prompts.filter((p) => p.model === "fake-validator")).toHaveLength(1);
  });

  test("validator-cited ids outside the requirement set are dropped", async () => {
    const models = scripted({
      outputs: [out("yes", "quick brown")],
      verdicts: [
        {
          verdict: "pass",
          violations: [
            { requirementId: "not.a.real.requirement", evidence: "invented" },
            { requirementId: "also.invented", evidence: "noise" },
          ],
        },
      ],
    });
    const result = await runStep(def(models), { text: "the quick brown fox" }, memoryJournal());

    // A "pass" with only invented ids is a pass: invented ids are noise, not rejections.
    expect(result.decision).toBe("ok");
    expect(models.prompts.filter((p) => p.model === "fake-worker")).toHaveLength(1);
  });

  test("a known cited id on a failing verdict is kept in the trail", async () => {
    const models = scripted({
      outputs: [out("yes", "quick brown")],
      verdicts: [
        {
          verdict: "fail",
          violations: [
            { requirementId: "invented.id", evidence: "dropped" },
            { requirementId: "test.anchor-verbatim", evidence: "kept" },
          ],
        },
      ],
    });
    const result = await runStep(def(models), { text: "the quick brown fox" }, memoryJournal());

    expect(result.decision).toBe("validator-exhausted");
    if (result.decision !== "validator-exhausted") return;
    for (const attempt of result.trail) {
      expect(attempt.violations.map((v) => v.requirementId)).toEqual(["test.anchor-verbatim"]);
    }
  });

  test("exhaustion returns validator-exhausted with the full trail", async () => {
    const models = scripted({
      outputs: [out("yes", "quick"), out("no", "brown"), out("yes", "fox")],
      verdicts: [
        { verdict: "fail", violations: [{ requirementId: "test.anchor-verbatim", evidence: "a" }] },
        { verdict: "fail", violations: [{ requirementId: "test.anchor-verbatim", evidence: "b" }] },
        { verdict: "fail", violations: [{ requirementId: "test.anchor-verbatim", evidence: "c" }] },
      ],
    });
    const result = await runStep(
      def({ worker: models.worker, validator: models.validator, escalateTo: models.escalate }),
      { text: "the quick brown fox" },
      memoryJournal(),
    );

    expect(result.decision).toBe("validator-exhausted");
    if (result.decision !== "validator-exhausted") return;
    // maxAttempts (2) worker attempts plus one escalation.
    expect(result.trail).toHaveLength(3);
    expect(result.trail.map((a) => a.model)).toEqual([
      "fake-worker",
      "fake-worker",
      "fake-escalate",
    ]);
    expect(result.trail.map((a) => a.output?.payload.anchor)).toEqual(["quick", "brown", "fox"]);
    expect(result.trail.flatMap((a) => a.violations.map((v) => v.evidence))).toEqual(["a", "b", "c"]);
  });

  test("a thrown model call becomes a trail entry, not an exception", async () => {
    const exploding: ModelBinding = {
      id: "exploding",
      generate: async () => {
        throw new Error("provider 503");
      },
    };
    const models = scripted({ outputs: [], verdicts: [] });
    const result = await runStep(
      def({ worker: exploding, validator: models.validator }),
      { text: "the quick brown fox" },
      memoryJournal(),
    );

    expect(result.decision).toBe("validator-exhausted");
    if (result.decision !== "validator-exhausted") return;
    expect(result.trail).toHaveLength(2);
    expect(result.trail.every((a) => a.error?.includes("provider 503"))).toBe(true);
    expect(models.prompts).toHaveLength(0);
  });

  test("a journal hit never calls the model", async () => {
    const models = scripted({ outputs: [out("yes", "quick brown")], verdicts: [PASS] });
    const journal = memoryJournal();
    const input = { text: "the quick brown fox" };

    const first = await runStep(def(models), input, journal);
    expect(first.decision).toBe("ok");
    const callsAfterFirst = models.prompts.length;
    expect(callsAfterFirst).toBe(2); // one worker, one validator

    const second = await runStep(def(models), input, journal);
    expect(second).toEqual(first);
    expect(models.prompts).toHaveLength(callsAfterFirst);
  });

  test("the journal key ignores input key order but not input values", async () => {
    const d = def(scripted({ outputs: [], verdicts: [] }));
    expect(journalKey(d, { a: 1, b: 2 })).toBe(journalKey(d, { b: 2, a: 1 }));
    expect(journalKey(d, { a: 1, b: 2 })).not.toBe(journalKey(d, { a: 1, b: 3 }));
    // Nested keys participate too.
    expect(journalKey(d, { a: { x: 1, y: 2 } })).toBe(journalKey(d, { a: { y: 2, x: 1 } }));
    expect(journalKey(d, { a: { x: 1 } })).not.toBe(journalKey(d, { a: { x: 2 } }));
  });

  test("the journal key carries the step id and version in plain text", async () => {
    const d = def(scripted({ outputs: [], verdicts: [] }));
    expect(journalKey(d, { text: "x" }).startsWith("test.step@1:")).toBe(true);
    expect(journalKey({ ...d, version: 2 }, { text: "x" }).startsWith("test.step@2:")).toBe(true);
  });

  test("canonicalJson is stable under key order and handles arrays and null", () => {
    expect(canonicalJson({ b: [1, { d: 4, c: 3 }], a: null })).toBe(
      '{"a":null,"b":[1,{"c":3,"d":4}]}',
    );
  });

  test("a sqlite journal replays across handles", async () => {
    const models = scripted({ outputs: [out("yes", "quick brown")], verdicts: [PASS] });
    const path = `/tmp/dw-journal-${Bun.hash(String(process.pid)).toString(16)}.sqlite`;
    await Bun.file(path).delete().catch(() => {});

    const first = sqliteJournal(path);
    const a = await runStep(def(models), { text: "the quick brown fox" }, first);
    first.close();
    expect(a.decision).toBe("ok");
    const calls = models.prompts.length;

    const second = sqliteJournal(path);
    const b = await runStep(def(models), { text: "the quick brown fox" }, second);
    second.close();

    expect(b).toEqual(a);
    expect(models.prompts).toHaveLength(calls);
    await Bun.file(path).delete().catch(() => {});
  });
});
