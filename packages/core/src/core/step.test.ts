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
  isSchemaFailure,
  journalKey,
  readTokens,
  runStep,
  SchemaFailure,
  stepOutput,
  type GenerateRequest,
  type ModelBinding,
  type StepAttempt,
  type StepCall,
  type StepObserver,
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
const scripted = (script: { outputs: Output[]; verdicts: Verdict[]; usage?: boolean }) => {
  const prompts: { model: string; system: string; prompt: string; step: StepCall }[] = [];
  let outputIndex = 0;
  let verdictIndex = 0;
  let calls = 0;

  const binding = (id: string, take: () => unknown): ModelBinding => ({
    id,
    generate: async <T,>(req: GenerateRequest<T>): Promise<T> => {
      prompts.push({ model: id, system: req.system, prompt: req.prompt, step: req.step });
      calls += 1;
      // A distinct count per call, so a test can tell which call's numbers
      // landed on which half of which attempt.
      if (script.usage === true) {
        req.onUsage?.({ promptTokens: calls * 10, completionTokens: calls });
      }
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

/**
 * An observer that only wants the settled attempts. The `started` phase is
 * the subject of its own tests, further down.
 */
const onAttempt =
  (take: (attempt: StepAttempt) => void): StepObserver =>
  (observation) => {
    if (observation.phase === "attempt") take(observation.attempt);
  };

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
    // A provider that fell over is TRANSPORT, so the budget was spent on it.
    expect(result.trail.map((a) => a.cause)).toEqual(["transport", "transport"]);
    expect(models.prompts).toHaveLength(0);
  });

  /**
   * A schema failure ends the step; a transport error keeps its attempts.
   *
   * The distinction is the whole of it. A model that answered outside the
   * output space will answer the same way again — same endpoint, same
   * question, same schema — so the attempt budget buys nothing and an
   * escalation buys a more expensive nothing. A socket that dropped is the
   * opposite, and that is what the budget is for.
   */
  describe("a schema failure ends the step", () => {
    const throwing = (id: string, error: () => unknown): ModelBinding => ({
      id,
      generate: async () => {
        throw error();
      },
    });

    /** A step with every retry a def can have: two attempts plus an escalation. */
    const withBudget = (worker: ModelBinding, validator: ModelBinding) =>
      def({ worker, validator, escalateTo: worker });

    test("the step ends after one attempt, with that attempt on the trail", async () => {
      const models = scripted({ outputs: [], verdicts: [] });
      const result = await runStep(
        withBudget(
          throwing("refusing", () => new SchemaFailure("the endpoint answered a bare array")),
          models.validator,
        ),
        { text: "the quick brown fox" },
        memoryJournal(),
      );

      expect(result.decision).toBe("validator-exhausted");
      if (result.decision !== "validator-exhausted") return;
      // One entry, not three: no second attempt and no escalation.
      expect(result.trail).toHaveLength(1);
      expect(result.trail[0]?.cause).toBe("schema");
      // Verbatim, so a person reads what the endpoint said rather than a
      // paraphrase of it.
      expect(result.trail[0]?.error).toContain("the endpoint answered a bare array");
      // And no validator was spent on an answer that never existed.
      expect(models.prompts).toHaveLength(0);
    });

    test("a transport error spends the whole budget instead", async () => {
      const models = scripted({ outputs: [], verdicts: [] });
      const result = await runStep(
        withBudget(
          throwing("dropping", () => new Error("socket hang up")),
          models.validator,
        ),
        { text: "the quick brown fox" },
        memoryJournal(),
      );

      expect(result.decision).toBe("validator-exhausted");
      if (result.decision !== "validator-exhausted") return;
      expect(result.trail).toHaveLength(3);
      expect(result.trail.map((a) => a.cause)).toEqual(["transport", "transport", "transport"]);
    });

    test("a bare zod error is a schema failure, whichever copy of zod raised it", async () => {
      // Matched by `name`, because two copies of zod in one module graph make
      // `instanceof` answer no for an error the other copy raised — which is a
      // real shape here: a binding re-parses with the STEP's schema, and the
      // step's schema came from the consumer's zod.
      const models = scripted({ outputs: [], verdicts: [] });
      const result = await runStep(
        withBudget(
          throwing("reparsing", () => z.object({ a: z.string() }).safeParse({}).error),
          models.validator,
        ),
        { text: "the quick brown fox" },
        memoryJournal(),
      );

      expect(result.decision === "validator-exhausted" && result.trail).toHaveLength(1);
    });

    test("Mastra's own refusal is recognised even from a binding that did not wrap it", async () => {
      const models = scripted({ outputs: [], verdicts: [] });
      const result = await runStep(
        withBudget(
          throwing(
            "mastra",
            () =>
              new Error(
                "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED: expected object, received array",
              ),
          ),
          models.validator,
        ),
        { text: "the quick brown fox" },
        memoryJournal(),
      );

      expect(result.decision === "validator-exhausted" && result.trail).toHaveLength(1);
    });

    test("a message that merely mentions a schema is transport", async () => {
      // `claudeCode` throws `produced no schema-conforming output in N
      // attempts` after spending its OWN budget, and that is a call reporting
      // it could not get an answer rather than this answer breaking a schema.
      expect(
        isSchemaFailure(new Error("claude-code:x produced no schema-conforming output in 2 attempts")),
      ).toBe(false);
      expect(isSchemaFailure(new SchemaFailure("outside the output space"))).toBe(true);
    });

    test("a validator that cannot answer Verdict ends the step too", async () => {
      const models = scripted({ outputs: [out("yes", "quick brown")], verdicts: [] });
      const result = await runStep(
        withBudget(
          models.worker,
          throwing("refusing", () => new SchemaFailure("the endpoint answered prose")),
        ),
        { text: "the quick brown fox" },
        memoryJournal(),
      );

      expect(result.decision).toBe("validator-exhausted");
      if (result.decision !== "validator-exhausted") return;
      expect(result.trail).toHaveLength(1);
      expect(result.trail[0]?.cause).toBe("schema");
      // The worker DID answer, so its output is on the trail beside the cause.
      expect(result.trail[0]?.output?.payload.anchor).toBe("quick brown");
    });

    test("a refusal nothing threw for is named validator, and keeps its attempts", async () => {
      const models = scripted({
        outputs: [out("yes", "NOT IN THE INPUT"), out("yes", "quick brown")],
        verdicts: [PASS],
      });
      const seen: StepAttempt[] = [];
      const result = await runStep(
        def(models),
        { text: "the quick brown fox" },
        memoryJournal(),
        onAttempt((a) => seen.push(a)),
      );

      expect(result.decision).toBe("ok");
      // The mechanical check refused the first; the second stood, and an
      // attempt that stood has no cause at all.
      expect(seen.map((a) => a.cause)).toEqual(["validator", undefined]);
    });
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

  test("a binding is told which call it is answering", async () => {
    // A binding is shared across steps, so `generate` alone cannot say which
    // one it is for. `step` says: the id, the version, which half of the pair,
    // and the attempt — the same number on both halves, so a worker call and
    // the validator that refuted it are one event rather than two.
    const models = scripted({
      outputs: [out("yes", "NOT IN THE INPUT"), out("yes", "quick brown")],
      verdicts: [PASS],
    });
    await runStep(def(models), { text: "the quick brown fox" }, memoryJournal());

    expect(models.prompts.map((p) => `${p.step.id}@${p.step.version} ${p.step.role} ${p.step.attempt}`)).toEqual([
      // attempt 1's worker was refused mechanically, so no validator ran for it
      "test.step@1 worker 1",
      "test.step@1 worker 2",
      "test.step@1 validator 2",
    ]);
  });

  test("what a call cost lands on the attempt that made it, both halves apart", async () => {
    // Attribution is EXACT rather than order-based: `runStep` hands each call
    // its own sink and already knows which call it was. Nothing queues, so two
    // runs in flight cannot swap each other's numbers.
    const attempts: StepAttempt[] = [];
    const models = scripted({
      outputs: [out("yes", "NOT IN THE INPUT"), out("yes", "quick brown")],
      verdicts: [PASS],
      usage: true,
    });
    await runStep(
      def(models),
      { text: "the quick brown fox" },
      memoryJournal(),
      onAttempt((a) => attempts.push(a)),
    );

    // Call 1 is attempt 1's worker; a mechanical check refused it, so attempt 1
    // spent no validator and has no validator tokens at all.
    expect(attempts[0]?.workerTokens).toEqual({ input: 10, output: 1 });
    expect(attempts[0]?.validatorTokens).toBeUndefined();
    // Calls 2 and 3 are attempt 2's worker and its validator.
    expect(attempts[1]?.workerTokens).toEqual({ input: 20, output: 2 });
    expect(attempts[1]?.validatorTokens).toEqual({ input: 30, output: 3 });
  });

  test("a usage shape nobody recognises is empty, never zero", () => {
    // "The provider did not say" and "the call cost nothing" are different
    // claims, and a record that conflated them would be lying about the
    // cheapest thing it measures.
    expect(readTokens({ promptTokens: 7, completionTokens: 2 })).toEqual({ input: 7, output: 2 });
    expect(readTokens({ inputTokens: { total: 7 }, outputTokens: { total: 2 } })).toEqual({
      input: 7,
      output: 2,
    });
    expect(readTokens({ inputTokens: 7, outputTokens: 2 })).toEqual({ input: 7, output: 2 });
    expect(readTokens({ somethingElse: 1 })).toEqual({});
    expect(readTokens(undefined)).toEqual({});
  });
});
