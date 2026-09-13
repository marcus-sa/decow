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
 * The batch is the unit. A step's `Effect[]` may name several symbols and
 * several paths, and § 5.3 says an acquire names the complete set it will
 * need, so the executor takes ONE write lease covering every `replace-symbol`
 * target AND every `write-file` path in the batch, applies the writes, and
 * releases. That is the design document's "fanout over writes needs leases per
 * symbol, not per step", and it is also why holding a lease and asking for
 * more is refused: the executor never needs to.
 *
 * Ahead of all of it sits the PROTECTED scope. A write landing under one is
 * refused before a lease is asked for, because the oracle is not the crafter's
 * and RED to GREEN is bought by production.
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
 * `measure-oracle` is the one effect whose desired answer is a FAILURE, so its
 * mapping is not the identity: `green` is `committed`, because it is the only
 * verdict where the world accepted what it was handed, and the other three are
 * rejections carrying the verdict that names which. The measurement itself
 * rides on `measured`, which is what a pure branch reads to get all four
 * answers off one field. A runner that never started is `infra-failed` and
 * carries no measurement at all — nothing about the oracle was observed, so
 * nothing about it is claimed, and in particular its author is not blamed.
 *
 * `run-command` is answered directly, through the framework's own single
 * process runner (`src/core/commands.ts`) rather than through the write path:
 * a command takes no lease, claims no version and writes no symbol, so there
 * is nothing for the write path to do with it. It is still on the event log,
 * as a trail line carrying the argv and the exit, because every effect this
 * executor performs is.
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
import { executeCommand, type Effect, type EffectResult } from "../core/effects.ts";
import { scopeCovers } from "./leases.ts";
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
  /**
   * Repository-relative scopes this executor may not write, at all, in any
   * shape. `rejected { by: "contract" }` before a lease is asked for.
   *
   * This is `_crafter_owns` as an executor rule. Every path a task declares is
   * the crafter's EXCEPT the oracle: RED to GREEN must be bought by production,
   * never by editing the test that measures it. Expressing it here rather than
   * in the graph is what makes it hold for every write the graph could emit,
   * including one a model proposed that the graph merely passed along.
   */
  protected?: readonly string[];
  /**
   * Tests already failing for a reason this task did not cause: the oracles of
   * every value that is not delivered yet. Excluded from the write gate's
   * impact-scoped set, because "did you break something else" is not a
   * question a test that was red before you started can answer.
   */
  knownRed?: readonly string[];
};

type ReplaceSymbol = Extract<Effect, { type: "replace-symbol" }>;
type WriteFile = Extract<Effect, { type: "write-file" }>;

const isReplaceSymbol = (effect: Effect): effect is ReplaceSymbol => effect.type === "replace-symbol";
const isWriteFile = (effect: Effect): effect is WriteFile => effect.type === "write-file";

/** The write path's result, as an effect result. Identity on every field. */
const asEffectResult = (effect: Effect, result: WriteResult): EffectResult => {
  switch (result.outcome) {
    case "committed":
      return { effect, outcome: "committed", version: result.version };
    case "conflict":
      return { effect, outcome: "conflict", currentVersion: result.currentVersion };
    case "rejected":
      return {
        effect,
        outcome: "rejected",
        by: result.by,
        // The failing test ids, when the stage named them. A graph routes on
        // whether they are its own acceptance tests, which is the difference
        // between "still red" and "broke something else".
        ...(result.failed === undefined ? {} : { detail: { failed: result.failed } }),
      };
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

  /** The path a write targets, for the protected-scope check. */
  const targetPath = (effect: ReplaceSymbol | WriteFile): string | undefined => {
    if (effect.type === "write-file") return effect.path;
    const symbol = vcs.registry.symbol(effect.symbolId);
    return symbol === undefined ? undefined : vcs.registry.fileById(symbol.fileId)?.path;
  };

  /** The protected scope this write lands in, if any. */
  const protectedBy = (effect: ReplaceSymbol | WriteFile): string | undefined => {
    const path = targetPath(effect);
    if (path === undefined) return undefined;
    return (options.protected ?? []).find((scope) => scopeCovers(scope, path));
  };

  return async (effects) => {
    const results = new Map<Effect, EffectResult>();

    // The wall, before the lease. A write into a protected scope is refused
    // whatever else is true of it — a lease it could have held, a version it
    // got right, a body that would have typechecked. The oracle is not the
    // crafter's, and the refusal says so rather than letting the write race a
    // stage that might have passed it.
    const refuseProtected = (effect: ReplaceSymbol | WriteFile): boolean => {
      const scope = protectedBy(effect);
      if (scope === undefined) return false;
      results.set(effect, { effect, outcome: "rejected", by: "contract" });
      vcs.appendTrail(
        JSON.stringify({ refused: targetPath(effect), scope, why: "the oracle is not the crafter's" }),
        intentFor({}),
      );
      return true;
    };

    const writes = effects.filter(isReplaceSymbol).filter((w) => !refuseProtected(w));
    const files = effects.filter(isWriteFile).filter((w) => !refuseProtected(w));

    /**
     * The symbols this batch wrote. A `run-tests` effect in the same batch has
     * to cover the tests these imply, and the floor is recomputed from this
     * list inside the write path rather than read off the effect.
     */
    const wrote = [...new Set(writes.map((w) => w.symbolId))];

    if (writes.length > 0 || files.length > 0) {
      const symbolIds = wrote;
      /**
       * One scope per path the batch writes. A caller that wanted a wider
       * territorial claim would have to say which, and nothing here has a
       * reason to: the batch already names every path it will touch, which is
       * exactly what § 5.3 asks an acquire to do.
       */
      const paths = [...new Set(files.map((f) => f.path))];
      // The first effect naming a symbol owns that symbol's expected version;
      // a batch that names one symbol twice with two versions is a graph bug,
      // and the second write will come back `conflict` on its own.
      const expectedVersions: Record<string, number> = {};
      for (const write of writes) expectedVersions[write.symbolId] ??= write.expectedVersion;

      const acquired = vcs.acquire({
        session,
        symbolIds,
        paths,
        mode: "write",
        ttlMs: BATCH_TTL_MS,
        intent: intentFor({ modified: symbolIds, created: paths }),
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
            ...(options.knownRed === undefined ? {} : { knownRed: options.knownRed }),
          });
          results.set(write, asEffectResult(write, result));
        }
        for (const file of files) {
          const result = await vcs.writeFile({
            leaseId: acquired.leaseId,
            path: file.path,
            body: file.body,
            intent: intentFor({ created: [file.path] }),
          });
          results.set(file, asEffectResult(file, result));
        }
        vcs.release(acquired.leaseId);
      } else {
        // Nothing was granted, so nothing was written. Every write in the
        // batch gets the lease layer's answer, which is what the graph routes.
        for (const write of [...writes, ...files]) {
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
            ...(options.knownRed === undefined ? {} : { knownRed: options.knownRed }),
            intent: intentFor({ modified: [] }),
          });
          out.push(asEffectResult(effect, result));
          break;
        }
        case "run-command": {
          // A declared command, run in the repository this executor owns. The
          // same runner the verifier's own stages go through, so a `tsc` the
          // write path asks for and a lint a graph asks for are one code path
          // with one timeout, one environment overlay and one output cap.
          //
          // The command is on the event log like every other effect this
          // executor performs, as a trail line carrying the argv and the exit.
          // A command claims no version, so the version it comes back with is
          // that event's own sequence number, which is the answer `run-tests`
          // gives one case over and for the same reason.
          const result = await executeCommand(effect, vcs.root, () => 0);
          const seq = vcs.appendTrail(
            JSON.stringify({
              ran: effect.argv,
              outcome: result.outcome,
              exit: result.outcome === "conflict" ? undefined : result.command?.exitCode ?? null,
              timedOut: result.outcome === "conflict" ? undefined : result.command?.timedOut ?? false,
            }),
            intentFor({}),
          );
          out.push(result.outcome === "committed" ? { ...result, version: seq } : result);
          break;
        }
        case "measure-oracle": {
          // The one effect whose DESIRED answer is a failure. `green` is the
          // only verdict that maps onto `committed`, because it is the only
          // one where the world accepted what it was handed; the other three
          // are rejections carrying the verdict that names which. The
          // measurement itself rides on `measured`, so a pure branch reads all
          // four answers off one field.
          const measured = await vcs.measureOracle({
            oracle: effect.oracle,
            intent: intentFor({}),
          });
          if (measured.outcome === "infra-failed") {
            // The runner never started. Not a verdict about the oracle, and
            // the graph must not charge it to the oracle's author.
            out.push({ effect, outcome: "infra-failed" });
            break;
          }
          out.push(
            measured.measurement.verdict === "green"
              ? { effect, outcome: "committed", version: measured.seq, measured: measured.measurement }
              : { effect, outcome: "rejected", by: "tests", measured: measured.measurement },
          );
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
        case "write-file":
          throw new Error(`vcs executor bug: write-file on ${effect.path} produced no result`);
      }
    }
    return out;
  };
};

/** The lease layer's refusal, as the effect result for one write in the batch. */
const notAcquired = (
  effect: ReplaceSymbol | WriteFile,
  acquired: Exclude<ReturnType<Vcs["acquire"]>, { outcome: "granted" }>,
): EffectResult => {
  // A whole-file write claims no version, so a lease outcome that is ABOUT a
  // version has none to report back. It is still a conflict — somebody else
  // holds the scope — and the graph routes it the same way.
  const version = effect.type === "write-file" ? 0 : effect.expectedVersion;
  switch (acquired.outcome) {
    case "stale":
      return {
        effect,
        outcome: "conflict",
        currentVersion: effect.type === "write-file" ? version : acquired.versions[effect.symbolId] ?? version,
      };
    case "conflict":
      return { effect, outcome: "conflict", currentVersion: version };
    case "contract-violation":
      return { effect, outcome: "rejected", by: "contract" };
    case "desync":
      return { effect, outcome: "infra-failed" };
  }
};
