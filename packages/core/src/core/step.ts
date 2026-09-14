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
import { refuseUnlessStrict } from "./strict-schema.ts";

/**
 * Which call a binding is being asked to make.
 *
 * A binding is shared across steps — one worker binding answers every leaf a
 * consumer points at it — so `generate` alone cannot say which step it is
 * answering for. This says. Two things need it and neither is optional: a
 * scripted binding has to refuse a step it has no script for BY NAME, and an
 * attempt's cost has to be attributable to the step that spent it.
 *
 * `attempt` is the same number on both calls of one attempt, so a worker call
 * and the validator call that refutes it are one pair rather than two events.
 */
export type StepCall = {
  /** The `StepDef` id. */
  id: string;
  /** The `StepDef` version, so a prompt change is visible to a binding too. */
  version: number;
  role: "worker" | "validator";
  /** 1-based. An escalation is the last worker attempt. */
  attempt: number;
};

/**
 * One call, as a binding receives it.
 *
 * `onUsage` is supplied by `runStep` and is closed over the attempt being
 * made, which is what makes token attribution EXACT rather than order-based:
 * the binding reports what one call cost, and the caller already knows which
 * call it was. Nothing queues, so nothing interleaves, so concurrency costs
 * the numbers nothing.
 */
export type GenerateRequest<T> = {
  step: StepCall;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Where THIS call reports what the provider said it cost. */
  onUsage?: (usage: unknown) => void;
};

/**
 * The seam between a step and a model. Production binds this to a Mastra
 * Agent; tests bind `scriptedBinding`, so the test suite never constructs an
 * agent, reads an API key, or opens a socket.
 *
 * Replaces the design's `LanguageModel` slot from the Vercel AI SDK.
 */
export type ModelBinding = {
  /** Reported verbatim as `Attempt.model`. */
  id: string;
  generate<T>(req: GenerateRequest<T>): Promise<T>;
};

/** Input and output token counts, when the provider layer reported them. */
export type Tokens = { input?: number; output?: number };

/**
 * Token counts out of whichever usage shape the provider layer returned.
 *
 * There are two live shapes in this dependency graph and they disagree:
 * `@mastra/core`'s `TokenUsage` is flat (`promptTokens` / `completionTokens`),
 * and the AI SDK's `LanguageModelUsage` nests (`inputTokens.total` /
 * `outputTokens.total`); an older AI SDK shape has `inputTokens` as a plain
 * number. All three are read here, and anything else yields an EMPTY object
 * rather than a zero — "the provider did not say" and "the call cost nothing"
 * are different claims and a record that conflated them would be lying about
 * the cheapest thing it measures.
 */
export const readTokens = (usage: unknown): Tokens => {
  if (usage === null || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;

  const nested = (value: unknown): number | undefined => {
    if (typeof value === "number") return value;
    if (value !== null && typeof value === "object") {
      const total = (value as { total?: unknown }).total;
      if (typeof total === "number") return total;
    }
    return undefined;
  };

  const input = typeof u.promptTokens === "number" ? u.promptTokens : nested(u.inputTokens);
  const output = typeof u.completionTokens === "number" ? u.completionTokens : nested(u.outputTokens);

  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
};

/**
 * The fixed output shape. `decision` is the only field the graph reads;
 * `payload` is free text the graph carries but never branches on.
 *
 * REFUSED HERE IF IT COULD NOT BE ASKED FOR. A binding puts this schema to an
 * endpoint as `response_format: { type: "json_schema", strict: true }`, and a
 * schema outside strict mode's narrower language is not rejected as a schema:
 * the provider falls back to unconstrained JSON and answers with whatever it
 * felt like. So the defects are named at DEFINITION time, where the schema is,
 * rather than at the first call, three layers from the cause. See
 * `./strict-schema.ts` for the rules and where each comes from.
 */
export const stepOutput = <D extends readonly [string, ...string[]], P extends z.ZodRawShape>(
  decision: D,
  payload: P,
) =>
  refuseUnlessStrict(
    z.object({ decision: z.enum(decision), payload: z.object(payload) }),
    `a step output over [${decision.join(" | ")}]`,
  );

/**
 * The validator's own answer, and it goes to a model exactly as a step's
 * output does — so it is held to the same rule.
 */
export const Verdict = refuseUnlessStrict(
  z.object({
    verdict: z.enum(["pass", "fail"]),
    violations: z.array(
      z.object({
        requirementId: z.string(),
        evidence: z.string().describe("Verbatim quote from the output that breaks the rule"),
      }),
    ),
  }),
  "the validator's verdict schema",
);
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

/**
 * A step definition, checked.
 *
 * `stepOutput` catches the schemas it built; this catches the rest. A leaf may
 * assemble its output some other way — `deliver/steps.ts` picks one of four
 * shapes per leaf and casts the result — and the thing that reaches a model is
 * `def.output` whatever built it. So every definition goes through here, and a
 * leaf whose output could not be asked for strictly fails at import.
 *
 * Identity at run time. It exists to refuse, not to transform.
 */
export const stepDef = <I, O>(def: StepDef<I, O>): StepDef<I, O> => {
  refuseUnlessStrict(def.output, `${def.id}@${def.version}'s output schema`);
  return def;
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

/**
 * What one attempt of a step did, as it happened.
 *
 * The journal records what a step DECIDED; the exhaustion trail records why a
 * validator was never satisfied. Neither records what a SUCCESSFUL step cost:
 * how many attempts it took, which mechanical check refused the first one, what
 * the validator said about the second. Those facts exist only inside the loop
 * below, and a run report that claims a first-attempt acceptance rate needs
 * them. So there is a sink for them, and it is optional and never read back —
 * nothing in the framework branches on an observation.
 *
 * A journal HIT emits nothing: no model was called, so there is no attempt to
 * report, and counting a replay as a call would make every rate a fiction.
 */
export type StepAttempt = {
  stepId: string;
  version: number;
  /** The journal key this call was made under, so a record names its input. */
  key: string;
  /** 1-based. Counts worker calls; an escalation is the last of them. */
  attempt: number;
  /** The worker binding that produced the output. */
  model: string;
  /** What the worker decided. Absent when the call itself threw. */
  decision?: string;
  /** Mechanical-check violations. They run before a validator is spent. */
  mechanical: Violation[];
  /** The validator's verdict. Absent when a mechanical check refused first. */
  verdict?: Verdict["verdict"];
  /** Validator violations, already filtered to ids the step declares. */
  violations: Violation[];
  /** Set when a provider call threw. */
  error?: string;
  /** True when this attempt's output was the one accepted and journaled. */
  accepted: boolean;
  /**
   * What the worker call reported it cost, when the provider layer reported
   * anything. Absent means "nobody said", never "it was free".
   */
  workerTokens?: Tokens;
  /** What the validator call cost. Absent when no validator ran. */
  validatorTokens?: Tokens;
};

/** Where attempts are reported. Optional; the framework never reads one back. */
export type StepObserver = (attempt: StepAttempt) => void;

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
  /** Where each attempt is reported. Nothing here branches on it. */
  observe?: StepObserver,
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

  /** One attempt, reported. `attempt` is `trail.length + 1` at the call site. */
  const report = (attempt: Omit<StepAttempt, "stepId" | "version" | "key">): void =>
    observe?.({ stepId: def.id, version: def.version, key, ...attempt });

  for (const model of models) {
    const feedback = trail.at(-1)?.violations ?? [];
    const attempt = trail.length + 1;

    /**
     * What this attempt's two calls cost. Captured per call rather than
     * queued, so two runs in flight cannot swap each other's numbers.
     */
    let workerTokens: Tokens | undefined;
    let validatorTokens: Tokens | undefined;

    let output: O;
    try {
      // guardrail 3: the output space is the schema
      output = await model.generate({
        step: { id: def.id, version: def.version, role: "worker", attempt },
        system: def.worker.system,
        prompt: def.worker.prompt(input) + feedbackSuffix(feedback),
        schema: def.output,
        onUsage: (usage) => {
          workerTokens = readTokens(usage);
        },
      });
    } catch (err) {
      trail.push({ model: model.id, violations: [], error: String(err) });
      report({
        attempt,
        model: model.id,
        mechanical: [],
        violations: [],
        error: String(err),
        accepted: false,
        ...(workerTokens === undefined ? {} : { workerTokens }),
      });
      continue;
    }

    const decision = decisionOf(output);

    // guardrail 4: mechanical checks before spending a second model call
    const mechanical = def.requirements
      .map((r) => r.check?.({ input, output }) ?? null)
      .filter((v): v is Violation => v !== null);
    if (mechanical.length) {
      trail.push({ model: model.id, output, violations: mechanical });
      report({
        attempt,
        model: model.id,
        ...decision,
        mechanical,
        violations: [],
        accepted: false,
        ...(workerTokens === undefined ? {} : { workerTokens }),
      });
      continue;
    }

    // guardrail 5: an independent model tries to refute the output
    let verdict: Verdict;
    try {
      verdict = await def.validator.model.generate({
        step: { id: def.id, version: def.version, role: "validator", attempt },
        system: VALIDATOR_SYSTEM,
        prompt: canonicalJson({
          requirements: def.requirements.map(({ id, text }) => ({ id, text })),
          input,
          output,
        }),
        schema: Verdict,
        onUsage: (usage) => {
          validatorTokens = readTokens(usage);
        },
      });
    } catch (err) {
      trail.push({ model: model.id, output, violations: [], error: String(err) });
      report({
        attempt,
        model: model.id,
        ...decision,
        mechanical: [],
        violations: [],
        error: String(err),
        accepted: false,
        ...(workerTokens === undefined ? {} : { workerTokens }),
        ...(validatorTokens === undefined ? {} : { validatorTokens }),
      });
      continue;
    }

    // guardrail 6: the validator is itself mechanically validated.
    // Invented requirement ids are noise, not rejections.
    const known = new Set(def.requirements.map((r) => r.id));
    const violations = filterKnown(verdict.violations, known, (v) => v.requirementId);

    if (verdict.verdict === "pass" && violations.length === 0) {
      const result: StepResult<O> = { decision: "ok", output };
      await journal.put(key, result);
      report({
        attempt,
        model: model.id,
        ...decision,
        mechanical: [],
        verdict: verdict.verdict,
        violations,
        accepted: true,
        ...(workerTokens === undefined ? {} : { workerTokens }),
        ...(validatorTokens === undefined ? {} : { validatorTokens }),
      });
      return result;
    }
    trail.push({ model: model.id, output, violations });
    report({
      attempt,
      model: model.id,
      ...decision,
      mechanical: [],
      verdict: verdict.verdict,
      violations,
      accepted: false,
      ...(workerTokens === undefined ? {} : { workerTokens }),
      ...(validatorTokens === undefined ? {} : { validatorTokens }),
    });
  }

  return { decision: "validator-exhausted", trail };
}

/**
 * The `decision` field of a step output, for the attempt record.
 *
 * `O` is caller-defined, and the ONE thing every step output is guaranteed to
 * carry is `decision` — that is `stepOutput`'s whole contract and the only
 * field the graph reads. Reading it back off an already-parsed output is a
 * projection, not a re-validation; anything that is not a string is reported as
 * absent rather than coerced.
 */
const decisionOf = (output: unknown): { decision?: string } => {
  const value = (output as { decision?: unknown } | null)?.decision;
  return typeof value === "string" ? { decision: value } : {};
};
