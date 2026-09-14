/**
 * The one stub mechanism, tested where it lives.
 *
 * Four claims, and each is a property the rest of the suite leans on: an
 * answer is validated against the leaf's OWN schema, the worker's answers are
 * per attempt and the last one repeats, a step with no script refuses by name,
 * and the validator half always passes so a scripted worker's decision is the
 * decision under test.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { memoryJournal } from "../core/journal.ts";
import {
  runStep,
  stepOutput,
  type StepAttempt,
  type StepDef,
  type StepObservation,
} from "../core/step.ts";
import type { Requirement } from "../core/requirement.ts";
import { noReplayJournal } from "./no-replay.ts";
import { says, scriptedBinding, throws } from "./scripted-binding.ts";

const Input = z.object({ text: z.string() });
type Input = z.infer<typeof Input>;

const Output = stepOutput(["yes", "no"] as const, { anchor: z.string() });
type Output = z.infer<typeof Output>;

/** The one mechanical check, so the retry path has something to refuse on. */
const anchorVerbatim: Requirement<{ input: Input; output: Output }> = {
  id: "test.anchor-verbatim",
  sourceId: "test",
  text: "The anchor must be a verbatim substring of the input.",
  decisions: ["yes", "no"],
  check: ({ input, output }) =>
    input.text.includes(output.payload.anchor)
      ? null
      : { requirementId: "test.anchor-verbatim", evidence: output.payload.anchor },
};

const def = (model: ReturnType<typeof scriptedBinding>): StepDef<Input, Output> => ({
  id: "fixture.answer",
  version: 1,
  input: Input,
  output: Output,
  requirements: [anchorVerbatim],
  worker: { model, system: "answer", prompt: (i) => i.text },
  validator: { model },
  maxAttempts: 2,
});

const fire = async (model: ReturnType<typeof scriptedBinding>, text = "the quick brown fox") => {
  const attempts: StepAttempt[] = [];
  const result = await runStep(def(model), { text }, noReplayJournal(), (o) => {
    if (o.phase === "attempt") attempts.push(o.attempt);
  });
  return { result, attempts };
};

describe("scriptedBinding", () => {
  test("an answer runs the whole step: the schema, the check, and the validator", async () => {
    const { result, attempts } = await fire(
      scriptedBinding({ "fixture.answer": says("yes", { anchor: "quick brown" }) }),
    );

    expect(result).toEqual({ decision: "ok", output: { decision: "yes", payload: { anchor: "quick brown" } } });
    // One attempt, refuted by a real validator call and passed by it. A seeded
    // journal would have reported none, because nothing would have been called.
    expect(attempts.map((a) => `${a.attempt}:${a.verdict}:${a.accepted}`)).toEqual(["1:pass:true"]);
  });

  test("a payload the leaf could not have produced is refused at the binding", async () => {
    // The step's own schema, not a looser one: `anchor` is required, so an
    // answer without it never becomes an output the graph could carry.
    const { result } = await fire(scriptedBinding({ "fixture.answer": says("yes") }));

    expect(result.decision).toBe("validator-exhausted");
    if (result.decision !== "validator-exhausted") return;
    expect(result.trail.every((a) => a.error?.includes("anchor"))).toBe(true);
  });

  test("answers are per attempt, and the last one repeats", async () => {
    // The first answer breaks the mechanical check and the second satisfies
    // it, which is the retry-with-feedback path a real worker takes.
    const { result, attempts } = await fire(
      scriptedBinding({
        "fixture.answer": [
          { decision: "yes", payload: { anchor: "NOT IN THE INPUT" } },
          { decision: "no", payload: { anchor: "quick brown" } },
        ],
      }),
    );

    expect(result.decision === "ok" && result.output.decision).toBe("no");
    expect(attempts.map((a) => `${a.attempt}:${a.accepted}`)).toEqual(["1:false", "2:true"]);
    expect(attempts[0]?.mechanical.map((v) => v.requirementId)).toEqual(["test.anchor-verbatim"]);
  });

  test("one answer serves every attempt, so a refused leaf exhausts on its own answer", async () => {
    const { result, attempts } = await fire(
      scriptedBinding({ "fixture.answer": says("yes", { anchor: "NOT IN THE INPUT" }) }),
    );

    expect(result.decision).toBe("validator-exhausted");
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.mechanical.length === 1)).toBe(true);
  });

  test("`throws` exhausts the leaf, with the reason on every attempt", async () => {
    const { result, attempts } = await fire(
      scriptedBinding({ "fixture.answer": throws("the worker had nothing to say") }),
    );

    expect(result.decision).toBe("validator-exhausted");
    expect(attempts.every((a) => a.error?.includes("nothing to say"))).toBe(true);
    // No decision and no verdict: the call never produced an output to judge.
    expect(attempts.every((a) => a.decision === undefined && a.verdict === undefined)).toBe(true);
  });

  test("a step with no script refuses by name, and names what was scripted", async () => {
    const { result } = await fire(scriptedBinding({ "fixture.other": says("yes") }));

    expect(result.decision).toBe("validator-exhausted");
    if (result.decision !== "validator-exhausted") return;
    // `runStep` catches a provider throw by design, so the leaf exhausts
    // rather than crashing — and the message is where a reader finds out why.
    expect(result.trail[0]?.error).toContain('no script for step "fixture.answer"');
    expect(result.trail[0]?.error).toContain("fixture.other");
  });

  test("the function form is handed the call, so one script can serve two subjects", async () => {
    // Which subject a call is about is on the prompt, exactly where the model
    // it stands in for would read it.
    const binding = scriptedBinding(({ prompt }) =>
      says("yes", { anchor: prompt.includes("fox") ? "fox" : "dog" }),
    );

    const fox = await fire(binding, "the quick brown fox");
    const dog = await fire(binding, "the lazy dog");
    expect(fox.result.decision === "ok" && fox.result.output.payload.anchor).toBe("fox");
    expect(dog.result.decision === "ok" && dog.result.output.payload.anchor).toBe("dog");
  });

  test("a journal hit still short-circuits it, because replay is production's", async () => {
    // The binding is a stub for the MODEL, not for the journal. A real journal
    // replays exactly as it would in a run directory.
    const binding = scriptedBinding({ "fixture.answer": says("yes", { anchor: "quick brown" }) });
    const journal = memoryJournal();
    const calls: StepAttempt[] = [];

    const collect = (o: StepObservation): void => {
      if (o.phase === "attempt") calls.push(o.attempt);
    };
    await runStep(def(binding), { text: "the quick brown fox" }, journal, collect);
    await runStep(def(binding), { text: "the quick brown fox" }, journal, collect);

    expect(calls).toHaveLength(1);
  });
});
