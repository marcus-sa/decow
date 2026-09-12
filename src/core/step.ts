/**
 * A step is one small-model call with a strict output schema, followed by a
 * second small model that tries to refute the output against the step's
 * requirements. The validator is mandatory by type: you cannot construct a
 * StepDef without one.
 *
 * `runStep` does not throw on any decision outcome. It returns a StepResult,
 * and the graph routes on `decision`. See README "Deviations from the design"
 * for the one class of exception that is still allowed out (graph bugs).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { filterKnown } from "../checks/id-in-set.ts";
import type { Requirement, Violation } from "./requirement.ts";

/**
 * The seam between a step and a model. Production binds this to a Mastra
 * Agent (see src/examples/distill/smoke.ts); tests bind a fake, so the test
 * suite never constructs an agent, reads an API key, or opens a socket.
 *
 * Replaces the design's `LanguageModel` slot from the Vercel AI SDK.
 */
export type ModelBinding = {
  /** Reported verbatim as `Attempt.model`. */
  id: string;
  generate<T>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T>;
};

/**
 * The fixed output shape. `decision` is the only field the graph reads;
 * `payload` is free text the graph carries but never branches on.
 */
export const stepOutput = <D extends readonly [string, ...string[]], P extends z.ZodRawShape>(
  decision: D,
  payload: P,
) => z.object({ decision: z.enum(decision), payload: z.object(payload) });

export const Verdict = z.object({
  verdict: z.enum(["pass", "fail"]),
  violations: z.array(
    z.object({
      requirementId: z.string(),
      evidence: z.string().describe("Verbatim quote from the output that breaks the rule"),
    }),
  ),
});
export type Verdict = z.infer<typeof Verdict>;

export type StepDef<I, O> = {
  id: string;
  /** Bump on prompt change; it is part of the journal key. */
  version: number;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  requirements: Requirement<{ input: I; output: O }>[];
  worker: { model: ModelBinding; system: string; prompt: (input: I) => string };
  /** A different model family refutes more independently. */
  validator: { model: ModelBinding };
  maxAttempts: number;
  escalateTo?: ModelBinding;
};

export type Attempt<O> = {
  model: string;
  /** Absent when the model call itself failed before producing an output. */
  output?: O;
  violations: Violation[];
  /** Set when the provider call threw. Kept so the trail stays complete. */
  error?: string;
};

export type StepResult<O> =
  | { decision: "ok"; output: O }
  | { decision: "validator-exhausted"; trail: Attempt<O>[] };

const VALIDATOR_SYSTEM =
  "You are an adversarial reviewer. Your job is to REFUTE the output against the requirements. " +
  "Default to 'fail' when a requirement is dodged, paraphrased, or unaddressed. " +
  "Cite requirement ids only from the list you were given.";

/**
 * Canonical JSON: object keys sorted recursively, so key order in the caller's
 * object cannot change the journal key.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
};

/** Keyed by (step id, step version, input hash). */
export const journalKey = (def: Pick<StepDef<never, never>, "id" | "version">, input: unknown): string =>
  `${def.id}@${def.version}:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;

const feedbackSuffix = (violations: Violation[]): string =>
  violations.length === 0
    ? ""
    : `\n\nYour previous attempt violated:\n${violations
        .map((v) => `- ${v.requirementId}: "${v.evidence}"`)
        .join("\n")}`;

export async function runStep<I, O>(
  def: StepDef<I, O>,
  raw: unknown,
  journal: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> },
): Promise<StepResult<O>> {
  const input = def.input.parse(raw); // guardrail 1: typed input
  const key = journalKey(def, input);
  const replayed = await journal.get<StepResult<O>>(key); // guardrail 2: replay beats re-inference
  if (replayed !== undefined) return replayed;

  const trail: Attempt<O>[] = [];
  const models: ModelBinding[] = [
    ...Array.from({ length: def.maxAttempts }, () => def.worker.model),
    ...(def.escalateTo ? [def.escalateTo] : []),
  ];

  for (const model of models) {
    const feedback = trail.at(-1)?.violations ?? [];

    let output: O;
    try {
      // guardrail 3: the output space is the schema
      output = await model.generate({
        system: def.worker.system,
        prompt: def.worker.prompt(input) + feedbackSuffix(feedback),
        schema: def.output,
      });
    } catch (err) {
      trail.push({ model: model.id, violations: [], error: String(err) });
      continue;
    }

    // guardrail 4: mechanical checks before spending a second model call
    const mechanical = def.requirements
      .map((r) => r.check?.({ input, output }) ?? null)
      .filter((v): v is Violation => v !== null);
    if (mechanical.length) {
      trail.push({ model: model.id, output, violations: mechanical });
      continue;
    }

    // guardrail 5: an independent model tries to refute the output
    let verdict: Verdict;
    try {
      verdict = await def.validator.model.generate({
        system: VALIDATOR_SYSTEM,
        prompt: canonicalJson({
          requirements: def.requirements.map(({ id, text }) => ({ id, text })),
          input,
          output,
        }),
        schema: Verdict,
      });
    } catch (err) {
      trail.push({ model: model.id, output, violations: [], error: String(err) });
      continue;
    }

    // guardrail 6: the validator is itself mechanically validated.
    // Invented requirement ids are noise, not rejections.
    const known = new Set(def.requirements.map((r) => r.id));
    const violations = filterKnown(verdict.violations, known, (v) => v.requirementId);

    if (verdict.verdict === "pass" && violations.length === 0) {
      const result: StepResult<O> = { decision: "ok", output };
      await journal.put(key, result);
      return result;
    }
    trail.push({ model: model.id, output, violations });
  }

  return { decision: "validator-exhausted", trail };
}
