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
 * The batch is also what makes the `run-tests` union rule enforceable. A
 * `run-tests` effect carries the symbols it is scoped to plus the tests a leaf
 * chose above the impact floor; the executor hands the write path the symbols
 * the batch actually wrote, and the floor is recomputed from those rather than
 * trusted from the effect. So the workflow owns test selection above the
 * floor, the VCS owns the floor, and a selection that misses one of the
 * floor's tests comes back `rejected { by: "contract" }` naming the omitted
 * ids. The LLM may add tests; it can never subtract one.
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
 * `upsert-artifact` is the one effect this executor does not answer out of the
 * VCS. Artifact rows are the other half of the design's state layer and they
 * are not code, so they go to an `ArtifactStore` (`src/artifacts/store.ts`)
 * this executor is handed, under the same optimistic version check. Without
 * one it is still `infra-failed`.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import type { ArtifactStore } from "../artifacts/store.ts";
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
  /**
   * Where `upsert-artifact` lands. The VCS is the data plane for CODE and it
   * is not becoming the data plane for artifact rows: the store is a separate
   * module with its own database, and this executor routes to it rather than
   * answering `infra-failed` for a write it now has somewhere to put. Absent
   * store, `upsert-artifact` is still `infra-failed`, because an executor with
   * nowhere to write must not pretend otherwise.
   */
  artifacts?: ArtifactStore;
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
    /**
     * The symbols this batch wrote. A `run-tests` effect in the same batch has
     * to cover the tests these imply, and the floor is recomputed from this
     * list inside the write path rather than read off the effect.
     */
    const wrote = [...new Set(writes.map((w) => w.symbolId))];

    if (writes.length > 0) {
      const symbolIds = wrote;
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
          // The union rule. `impacted` plus `extra` is what runs; `wrote` is
          // what the run must cover. The workflow owns the selection above the
          // floor, the VCS owns the floor, and the LLM may add a test but can
          // never subtract one.
          const result = await vcs.runTests({
            symbolIds: effect.impacted,
            ...(effect.extra === undefined ? {} : { extra: effect.extra }),
            wrote,
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
        case "upsert-artifact": {
          // The other half of the design's state layer. It is not the VCS's —
          // the VCS is the data plane for code — so it is a store this
          // executor was handed, and the optimistic version check is the same
          // one `replace-symbol` gets one column over.
          const store = options.artifacts;
          if (store === undefined) {
            out.push({ effect, outcome: "infra-failed" });
            break;
          }
          const written = store.upsert({
            table: effect.table,
            id: effect.id,
            expectedVersion: effect.expectedVersion,
            row: effect.row,
          });
          out.push(
            written.outcome === "committed"
              ? { effect, outcome: "committed", version: written.version }
              : { effect, outcome: "conflict", currentVersion: written.currentVersion },
          );
          break;
        }
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
