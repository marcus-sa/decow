/**
 * The seam between the framework and the VCS.
 *
 * The framework is the control plane: what happens, in what order, validated
 * how. The VCS is the data plane for code: how a write lands, under what
 * concurrency, with what provenance. This file is the whole of the join, and
 * it is one function.
 *
 * It imports the `Effect` and `EffectResult` types from `src/core/effects.ts`
 * and nothing else from the framework. `src/core` imports nothing from here.
 * The dependency runs one way, which is what lets either half be read without
 * the other.
 *
 * The batch is the unit. A step's `Effect[]` may name several symbols, and §
 * 5.3 says an acquire names the complete set it will need, so the executor
 * takes ONE write lease covering every `replace-symbol` target in the batch,
 * applies the writes, and releases. That is the design document's "fanout over
 * writes needs leases per symbol, not per step", and it is also why holding a
 * lease and asking for more is refused: the executor never needs to.
 *
 * The session and the task intent are fixed per executor instance, because
 * `EffectExecutor` is `(effects) => Promise<EffectResult[]>` and extending
 * that signature to carry provenance would put the framework's control plane
 * inside the VCS's argument list. One executor per task is the answer.
 *
 * The outcome mapping is the identity function on `outcome` and on `by`: the
 * write path's result union was built to be `EffectResult`'s. What the mapping
 * does add is the lease layer's own answers:
 *
 *   acquire stale               -> conflict, with the version the world moved to
 *   acquire conflict            -> conflict, with the current version
 *   acquire contract-violation  -> rejected: contract
 *   acquire desync              -> infra-failed, because a file changed by a
 *                                  channel outside the system is not the
 *                                  agent's error and must not burn its budget
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import type { Effect, EffectResult } from "../core/effects.ts";
import type { Intent } from "./log.ts";
import type { Vcs } from "./index.ts";
import type { WriteResult } from "./writes.ts";

/** How long a batch's lease lives before a heartbeat is needed. */
export const BATCH_TTL_MS = 60_000;

export type VcsExecutorOptions = {
  vcs: Vcs;
  /** The agent session this executor writes as. One lease at a time (§ 5.3). */
  session: string;
  /** The task every event this executor produces is attributed to (§ 4.5). */
  intent: { taskId: string; parentTaskId?: string; description: string };
};

type ReplaceSymbol = Extract<Effect, { type: "replace-symbol" }>;

const isReplaceSymbol = (effect: Effect): effect is ReplaceSymbol => effect.type === "replace-symbol";

/** The write path's result, as an effect result. Identity on every field. */
const asEffectResult = (effect: Effect, result: WriteResult): EffectResult => {
  switch (result.outcome) {
    case "committed":
      return { effect, outcome: "committed", version: result.version };
    case "conflict":
      return { effect, outcome: "conflict", currentVersion: result.currentVersion };
    case "rejected":
      return { effect, outcome: "rejected", by: result.by };
    case "infra-failed":
      return { effect, outcome: "infra-failed" };
  }
};

export const vcsExecutor = (
  options: VcsExecutorOptions,
): ((effects: Effect[]) => Promise<EffectResult[]>) => {
  const { vcs, session } = options;

  /** The per-call intent (§ 4.5), with the outcome this call declares. */
  const intentFor = (expectedOutcome: Intent["expectedOutcome"]): Intent => ({
    ...options.intent,
    expectedOutcome,
  });

  return async (effects) => {
    const results = new Map<Effect, EffectResult>();
    const writes = effects.filter(isReplaceSymbol);

    if (writes.length > 0) {
      const symbolIds = [...new Set(writes.map((w) => w.symbolId))];
      // The first effect naming a symbol owns that symbol's expected version;
      // a batch that names one symbol twice with two versions is a graph bug,
      // and the second write will come back `conflict` on its own.
      const expectedVersions: Record<string, number> = {};
      for (const write of writes) expectedVersions[write.symbolId] ??= write.expectedVersion;

      const acquired = vcs.acquire({
        session,
        symbolIds,
        mode: "write",
        ttlMs: BATCH_TTL_MS,
        intent: intentFor({ modified: symbolIds }),
        expectedVersions,
      });

      if (acquired.outcome === "granted") {
        for (const write of writes) {
          const result = await vcs.replaceSymbolBody({
            leaseId: acquired.leaseId,
            symbolId: write.symbolId,
            expectedVersion: write.expectedVersion,
            body: write.body,
            intent: intentFor({ modified: [write.symbolId] }),
          });
          results.set(write, asEffectResult(write, result));
        }
        vcs.release(acquired.leaseId);
      } else {
        // Nothing was granted, so nothing was written. Every write in the
        // batch gets the lease layer's answer, which is what the graph routes.
        for (const write of writes) {
          results.set(write, notAcquired(write, acquired));
        }
      }
    }

    const out: EffectResult[] = [];
    for (const effect of effects) {
      const already = results.get(effect);
      if (already !== undefined) {
        out.push(already);
        continue;
      }
      switch (effect.type) {
        case "run-tests": {
          const result = await vcs.runTests({
            symbolIds: effect.impacted,
            intent: intentFor({ modified: [] }),
          });
          out.push(asEffectResult(effect, result));
          break;
        }
        case "append-trail":
          out.push({
            effect,
            outcome: "committed",
            version: vcs.appendTrail(effect.line, intentFor({})),
          });
          break;
        case "upsert-artifact":
          // The VCS is the data plane for code. Artifact rows are the other
          // half of the design's state layer and no executor is wired for
          // them, which is an infrastructure fact rather than a rejection.
          out.push({ effect, outcome: "infra-failed" });
          break;
        case "replace-symbol":
          throw new Error(`vcs executor bug: replace-symbol on ${effect.symbolId} produced no result`);
      }
    }
    return out;
  };
};

/** The lease layer's refusal, as the effect result for one write in the batch. */
const notAcquired = (
  effect: ReplaceSymbol,
  acquired: Exclude<ReturnType<Vcs["acquire"]>, { outcome: "granted" }>,
): EffectResult => {
  switch (acquired.outcome) {
    case "stale":
      return {
        effect,
        outcome: "conflict",
        currentVersion: acquired.versions[effect.symbolId] ?? effect.expectedVersion,
      };
    case "conflict":
      return { effect, outcome: "conflict", currentVersion: effect.expectedVersion };
    case "contract-violation":
      return { effect, outcome: "rejected", by: "contract" };
    case "desync":
      return { effect, outcome: "infra-failed" };
  }
};
