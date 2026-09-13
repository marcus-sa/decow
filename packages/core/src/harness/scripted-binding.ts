/**
 * The one way a test stubs a leaf: a `ModelBinding` that answers from a script.
 *
 * The alternative is seeding the journal, and it is not merely less
 * convenient. A seeded journal short-circuits `runStep` before any model is
 * reached, so a test using one exercises neither the output schema, nor the
 * mechanical checks, nor the validator — and, worse, the composition under
 * test has to grow a hook so the test can compute the journal key `runStep`
 * would compute. That is production shaped by its tests. A binding is the seam
 * production already has: the script goes in through `models`, the graph is
 * the graph, and everything between the seam and the decision runs for real.
 *
 * WHAT A SCRIPT SAYS. Per step id, the answers that step's WORKER gives, one
 * per attempt. An entry is either a decision plus its payload — validated
 * against the leaf's own output schema before it is returned, so a payload the
 * step could not have produced fails here rather than three frames later — or
 * an error the call throws.
 *
 * A step with fewer entries than attempts repeats its last one. So one entry
 * means "always this", and `[{ error }]` means every attempt throws, which is
 * how a test reaches `validator-exhausted`: the worker never produced an
 * output the validator could pass.
 *
 * THE VALIDATOR ALWAYS PASSES, and that is a position rather than a gap. The
 * scripted worker's answer IS the decision under test; a scripted validator
 * that refused it would be a second script saying the first one was wrong.
 * Refutation is `runStep`'s own contract and is tested where it lives, in
 * `src/core/step.test.ts`, against bindings written for that purpose.
 *
 * A STEP WITH NO SCRIPT REFUSES BY NAME, on every attempt, naming the step and
 * what was scripted. `runStep` catches a provider throw by design — that is
 * what keeps a decision outcome from escaping as an exception — so the leaf
 * exhausts rather than crashing, with the message on its trail and on the
 * attempt. Read it there when a leaf exhausts and you did not mean it to.
 */

import type { GenerateRequest, ModelBinding, StepCall } from "../core/step.ts";

/** One answer a scripted worker gives: a decision, or a call that throws. */
export type ScriptedAnswer =
  | { decision: string; payload?: Record<string, unknown> }
  | { error: string };

/** Per step id, the answers its worker gives, one per attempt. */
export type Script = Record<string, readonly ScriptedAnswer[]>;

/** What a script function is handed: the call, and what the worker was asked. */
export type ScriptedCall = { step: StepCall; system: string; prompt: string };

/**
 * A script, or a function that answers one call.
 *
 * The function form exists for the two things a step-id table cannot express.
 * The path walker needs it because which answer a leaf gives is the choice
 * being enumerated, so it cannot be fixed before the run starts. And a run
 * that drives ONE graph over several subjects needs it because the answer
 * depends on which subject — which is on the PROMPT, exactly where the model
 * it stands in for would read it.
 *
 * It is consulted ONCE per invocation — on attempt 1 — and the answers it
 * returns serve the retries, so a leaf that retries is one choice rather than
 * two.
 */
export type ScriptSource =
  | Script
  | ((call: ScriptedCall) => readonly ScriptedAnswer[] | undefined);

export type ScriptedBindingOptions = {
  /** Reported verbatim as `Attempt.model`. */
  id?: string;
};

/** What a scripted validator returns. There is only one. */
const PASS = { verdict: "pass", violations: [] };

export const scriptedBinding = (
  script: ScriptSource,
  options: ScriptedBindingOptions = {},
): ModelBinding => {
  const resolve =
    typeof script === "function" ? script : (call: ScriptedCall) => script[call.step.id];
  const named = typeof script === "function" ? "(a function)" : Object.keys(script).join(", ");
  /** The answers this invocation is serving, per step. Re-chosen at attempt 1. */
  const chosen = new Map<string, readonly ScriptedAnswer[]>();

  return {
    id: options.id ?? "scripted",

    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      if (req.step.role === "validator") return req.schema.parse(PASS);

      if (req.step.attempt === 1 || !chosen.has(req.step.id)) {
        const answers = resolve({ step: req.step, system: req.system, prompt: req.prompt });
        if (answers === undefined || answers.length === 0) {
          throw new Error(
            `scripted binding: no script for step "${req.step.id}" — a model would be called. ` +
              `Scripted steps: ${named || "(none)"}`,
          );
        }
        chosen.set(req.step.id, answers);
      }

      const answers = chosen.get(req.step.id) as readonly ScriptedAnswer[];
      // The last entry repeats, so one entry means "always this" and a script
      // never runs out mid-retry.
      const answer = (answers[req.step.attempt - 1] ?? answers.at(-1)) as ScriptedAnswer;
      if ("error" in answer) throw new Error(answer.error);
      // The step's OWN schema, so a payload the leaf could not have produced
      // is refused here rather than carried into the graph.
      return req.schema.parse({ decision: answer.decision, payload: answer.payload ?? {} });
    },
  };
};

/** Shorthand for the common entry: this decision, with this payload. */
export const says = (decision: string, payload: Record<string, unknown> = {}): ScriptedAnswer[] => [
  { decision, payload },
];

/**
 * Shorthand for the other one: every attempt throws, so the leaf exhausts.
 *
 * One entry, because the last repeats — a worker that cannot answer cannot
 * answer twice either.
 */
export const throws = (why = "the scripted worker refused"): ScriptedAnswer[] => [{ error: why }];
