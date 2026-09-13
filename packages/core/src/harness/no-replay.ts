/**
 * A journal that answers nothing and keeps nothing. The one piece of
 * journal-level control the path walker needs and a binding cannot give it.
 *
 * `enumeratePaths` re-runs a workflow once per path, forcing a different
 * combination of choices each time, and a leaf inside a bounded loop is asked
 * more than once per run. A REAL journal would replay the first answer on the
 * second ask — which is exactly right in production and wrong here, because the
 * second ask is a choice point and replaying it deletes every path below it.
 * The walk is enumerating what the graph does with each answer, so replay is
 * the one thing that must be off.
 *
 * It replaced `stubJournal`, which seeded `StepResult`s per step id so a leaf
 * never reached a model at all. Nothing seeds a journal any more: a leaf is
 * stubbed at the binding (`./scripted-binding.ts`), which is the seam
 * production has, so everything between the seam and the decision — the output
 * schema, the mechanical checks, the validator — runs for real on every path.
 * What survived is the half that was never about seeding.
 *
 * It is NOT a way to stub a leaf. A run over this journal calls whatever
 * bindings its steps were built with, every time.
 */

import type { Journal } from "../core/journal.ts";

export type NoReplayJournal = Journal & {
  /** Keys `runStep` would have written, in order. Nothing is kept. */
  readonly writes: readonly string[];
};

export const noReplayJournal = (): NoReplayJournal => {
  const writes: string[] = [];
  return {
    writes,
    async get<O>(): Promise<O | undefined> {
      return undefined;
    },
    async put<O>(key: string, _value: O): Promise<void> {
      writes.push(key);
    },
  };
};
