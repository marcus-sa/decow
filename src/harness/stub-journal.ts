/**
 * A journal pre-seeded with StepResults, keyed by step id. It stands in for
 * the models: every `runStep` call is a hit, so the whole graph is enumerable
 * with zero model calls, no API key, and no network.
 *
 * Keys are `<step id>@<version>:<input hash>`, so the stub can answer by step
 * id alone without knowing the input.
 */

import { stepIdFromKey, type Journal } from "../core/journal.ts";
import type { Attempt, StepResult } from "../core/step.ts";

export type StubJournalOptions = {
  /**
   * What a lookup for an unseeded step id does.
   *
   * - "throw" (default): fail loudly. In an enumeration test a miss means a
   *   real model call, which is exactly what the harness exists to prevent.
   * - "undefined": normal journal semantics; the caller falls through to the
   *   model. Use when a test deliberately exercises a cache miss.
   */
  onMiss?: "throw" | "undefined";
};

export type StubJournal = Journal & {
  /** Step ids looked up, in order, including misses. */
  readonly reads: readonly string[];
  /** Keys written back by `runStep`, in order. */
  readonly writes: readonly string[];
};

export const stubJournal = (
  seed: Record<string, StepResult<unknown>>,
  options: StubJournalOptions = {},
): StubJournal => {
  const onMiss = options.onMiss ?? "throw";
  const reads: string[] = [];
  const writes: string[] = [];

  return {
    reads,
    writes,
    async get<O>(key: string) {
      const stepId = stepIdFromKey(key);
      reads.push(stepId);
      const hit = seed[stepId];
      if (hit !== undefined) return hit as O;
      if (onMiss === "throw") {
        throw new Error(
          `stub journal miss for step "${stepId}" — a model would be called. ` +
            `Seeded steps: ${Object.keys(seed).join(", ") || "(none)"}`,
        );
      }
      return undefined;
    },
    async put<O>(key: string, _value: O) {
      writes.push(key);
    },
  };
};

/** Shorthand for the common seed: a step that succeeded with this output. */
export const ok = <O>(output: O): StepResult<O> => ({ decision: "ok", output });

/** Shorthand for the other seed: a step whose validator was never satisfied. */
export const exhausted = <O>(trail: Attempt<O>[] = []): StepResult<O> => ({
  decision: "validator-exhausted",
  trail,
});
