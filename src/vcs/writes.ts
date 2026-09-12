/**
 * The write path (ai-vcs.md § 5.4, § 6.1).
 *
 * Three SYMBOL operations, one shape. Every one of them checks the lease,
 * checks the version, edits the file, runs the verification pipeline over the
 * result, and then either commits the change with its events or restores the
 * file's bytes exactly and records why it did not:
 *
 *   1  resolve the lease: live, held in a mode that permits the operation, and
 *      covering this symbol
 *   2  confirm the intent declares this symbol (§ 4.5)
 *   3  optimistic version check; a mismatch is `conflict` with the current
 *      version, never an exception (§ 3.3)
 *   4  confirm the file on disk still matches the registry's last-known
 *      content, and mark it desynced if it does not (§ 9.1)
 *   5  splice, and write the new source
 *   6  structural stage: does it parse, and is the identity delta the declared
 *      one? A body that removes the symbol it claims to edit fails here, as a
 *      contract violation
 *   7  typecheck stage
 *   8  tests stage, over the impact-scoped subset MINUS any test this write is
 *      itself rewriting: the gate asks whether the change broke something
 *      else, and an acceptance test's first honest run fails by design
 *   9  policy stage
 *  10  commit: re-key the file, append the child event, then append the
 *      transaction event naming it, so the parent lands after its children
 *      (§ 4.4)
 *
 * Any failure between 5 and 9 restores the file byte for byte and appends a
 * `write-failed` event carrying which of § 5.4's three categories it was.
 *
 * A FOURTH operation, `writeFile`, is not that shape and cannot be: it writes a
 * file that may not exist, so it holds a path scope rather than a symbol id,
 * claims no version, and asks a weaker structural question. Its contract is
 * above it. A failed one restores the previous bytes, or removes the file it
 * created.
 *
 * The result union is deliberately the same shape as `EffectResult`'s, so the
 * executor maps one onto the other without interpreting anything.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImpactGraph } from "./impact.ts";
import type { EventLog, EventKind, Intent } from "./log.ts";
import { coveringScopes, type LeaseManager, type LeaseMode } from "./leases.ts";
import type { Registry, RegisteredSymbol } from "./registry.ts";
import { identityKey, type Parser } from "./structural/parser.ts";
import {
  categoryOf,
  structuralStage,
  wholeFileStage,
  type RejectedBy,
  type StageOutcome,
  type TestTarget,
  type VerificationStatus,
  type Verifier,
} from "./verify.ts";

export type WriteResult =
  | { outcome: "committed"; version: number; seq: number; verification: VerificationStatus }
  | { outcome: "conflict"; currentVersion: number }
  | {
      outcome: "rejected";
      by: RejectedBy;
      detail: string;
      /** Ids of the tests that failed, when the stage named them. */
      failed?: readonly string[];
    }
  | { outcome: "infra-failed"; detail: string };

export type WritePath = {
  replaceSymbolBody(spec: {
    leaseId: string;
    symbolId: string;
    expectedVersion: number;
    body: string;
    intent: Intent;
  }): Promise<WriteResult>;

  /**
   * A declared, id-preserving rename (§ 3.2). The symbol keeps its id and its
   * history; its identity key changes, and so does the container path of
   * everything it holds, because a method's container is its class's name.
   */
  renameSymbol(spec: {
    leaseId: string;
    symbolId: string;
    expectedVersion: number;
    newName: string;
    intent: Intent;
  }): Promise<WriteResult>;

  /**
   * A declared delete. Needs an exclusive lease, because § 5.2 reserves that
   * mode for structural operations that should not be observed in flight. The
   * symbol is tombstoned rather than removed, so its id stays queryable
   * (§ 4.3).
   */
  deleteSymbol(spec: {
    leaseId: string;
    symbolId: string;
    expectedVersion: number;
    intent: Intent;
  }): Promise<WriteResult>;

  /**
   * Write a whole file, which may or may not exist, under a PATH-SCOPE lease.
   *
   * The other three operations all resolve a symbol id first, so none of them
   * can produce a file that is not there. This one is what an author needs: the
   * claim is the lease's scope over a region of the tree, the intent declares
   * the path under `created`, and the structural stage asks only that no
   * identity the file already held has vanished.
   *
   * THE TESTS STAGE IS SKIPPED, and that is the point rather than an omission.
   * Every other write asks "did this break something else" before it commits,
   * and the honest answer for an oracle is that running it is a separate
   * measurement with its own verdict — `measureOracle` — whose whole job is to
   * observe a failure. Running the suite here would refuse every oracle for
   * being red, which is what an oracle IS before its production code exists.
   */
  writeFile(spec: {
    leaseId: string;
    /** Repository-relative. Covered by the lease's path scope. */
    path: string;
    body: string;
    intent: Intent;
  }): Promise<WriteResult>;

  /**
   * The tests stage on its own, over the impact-scoped subset of the suite.
   * This is what a `run-tests` effect asks for; it takes no lease because it
   * observes rather than writes. `version` on the result is the sequence
   * number of the event recording the run.
   *
   * The run set is `impactedTests(symbolIds) ∪ testsById(extra)`: the impact
   * graph owns the floor and the caller owns the selection above it. `wrote`
   * is what makes that a rule rather than a convention — the floor is
   * recomputed HERE from the symbols the caller says its batch wrote, and a
   * union that misses one of those tests is `rejected { by: "contract" }` with
   * the omitted ids, because a caller may add tests and may never subtract
   * one.
   */
  runTests(spec: {
    /** The symbols the run is scoped to, as the caller declared them. */
    symbolIds: readonly string[];
    /** Test ids chosen above the floor. Added, never subtracted. */
    extra?: readonly string[];
    /**
     * The symbols the caller's batch actually wrote. `impactedTests` of these
     * is the floor the union must cover. Absent or empty means nothing was
     * written, so there is no floor and nothing could have been subtracted.
     */
    wrote?: readonly string[];
    intent: Intent;
  }): Promise<WriteResult>;
};

/** What the operation declares about identity, for the structural stage. */
type Declaration = {
  gone: string[];
  added: string[];
  rekey?: Record<string, { name: string; container: readonly string[] }>;
};

const MODES: Record<"edit" | "structural", LeaseMode[]> = {
  edit: ["write", "exclusive"],
  structural: ["exclusive"],
};

/**
 * Rewrite a descendant's container path after its ancestor was renamed. The
 * path is derived from the ancestor's name, so this follows from the declared
 * rename rather than inferring anything.
 */
const rewriteContainer = (
  descendant: RegisteredSymbol,
  ancestor: RegisteredSymbol,
  newName: string,
): string[] => {
  const path = [...descendant.container];
  path[ancestor.container.length] = newName;
  return path;
};

/**
 * Test targets, first occurrence wins. The floor and the selection above it
 * overlap by construction — a leaf that adds a test the impact graph already
 * chose is adding nothing, not asking for it twice.
 */
const dedupe = (targets: readonly TestTarget[]): TestTarget[] => {
  const seen = new Set<string>();
  return targets.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
};

export const openWritePath = (spec: {
  root: string;
  registry: Registry;
  log: EventLog;
  leases: LeaseManager;
  impact: ImpactGraph;
  parser: Parser;
  verifier: Verifier;
}): WritePath => {
  const { root, registry, log, leases, impact, parser, verifier } = spec;

  const rejected = (by: RejectedBy, detail: string, failed?: readonly string[]): WriteResult => ({
    outcome: "rejected",
    by,
    detail,
    ...(failed === undefined ? {} : { failed }),
  });

  /**
   * One declared write, end to end. The three operations differ only in how
   * they edit the source, what identity delta they declare, and what mode they
   * require, so all three go through here.
   */
  const perform = async (args: {
    leaseId: string;
    symbolId: string;
    expectedVersion: number;
    intent: Intent;
    requires: "edit" | "structural";
    eventKind: Extract<EventKind, "symbol-modified" | "symbol-renamed" | "symbol-deleted">;
    splice: (source: string, symbol: RegisteredSymbol) => string;
    declare: (symbol: RegisteredSymbol, descendants: RegisteredSymbol[]) => Declaration;
    detail?: (symbol: RegisteredSymbol) => string;
  }): Promise<WriteResult> => {
    const lease = leases.lease(args.leaseId);
    if (lease === undefined) return rejected("contract", `lease ${args.leaseId} is not live`);
    if (!MODES[args.requires].includes(lease.mode)) {
      return rejected(
        "contract",
        `this operation needs a ${MODES[args.requires].join(" or ")} lease; ${args.leaseId} is ${lease.mode}`,
      );
    }
    if (!lease.symbolIds.includes(args.symbolId)) {
      return rejected("contract", `lease ${args.leaseId} does not cover ${args.symbolId}`);
    }

    const declaredHere = [
      ...(args.intent.expectedOutcome.modified ?? []),
      ...(args.intent.expectedOutcome.tombstoned ?? []),
    ];
    if (!declaredHere.includes(args.symbolId)) {
      return rejected("contract", `the intent does not declare ${args.symbolId} as an outcome of this call`);
    }

    const symbol = registry.symbol(args.symbolId);
    if (symbol === undefined) return rejected("contract", `no symbol ${args.symbolId}`);
    if (symbol.tombstoned) return rejected("contract", `symbol ${args.symbolId} is tombstoned`);
    if (symbol.version !== args.expectedVersion) {
      return { outcome: "conflict", currentVersion: symbol.version };
    }

    const file = registry.fileById(symbol.fileId);
    if (file === undefined) return { outcome: "infra-failed", detail: `no tracked file ${symbol.fileId}` };
    const absolute = join(root, file.path);

    let onDisk: string;
    try {
      onDisk = readFileSync(absolute, "utf8");
    } catch (err) {
      return { outcome: "infra-failed", detail: `cannot read ${file.path}: ${String(err)}` };
    }
    if (onDisk !== file.content) {
      // Something outside the system edited the file between the acquire and
      // this write. That is a desync, and it is not the caller's error.
      registry.reinventory(file.path, onDisk, parser.symbols(onDisk));
      return { outcome: "infra-failed", detail: `${file.path} was changed outside the system; it is now desynced` };
    }

    const descendants = registry.descendantsOf(symbol.id);
    const declaration = args.declare(symbol, descendants);
    const before = registry.symbolsOf(symbol.fileId).map(identityKey);
    const next = args.splice(file.content, symbol);

    const restore = (): void => writeFileSync(absolute, file.content, "utf8");
    const fail = (outcome: Extract<StageOutcome, { status: "failed" } | { status: "infra-failed" }>): WriteResult => {
      restore();
      log.append({
        kind: "write-failed",
        symbolId: symbol.id,
        fileId: file.id,
        leaseId: args.leaseId,
        taskId: args.intent.taskId,
        ...(args.intent.parentTaskId === undefined ? {} : { parentTaskId: args.intent.parentTaskId }),
        description: args.intent.description,
        verification: "failed",
        category: categoryOf(outcome) ?? "infrastructure",
        detail: outcome.detail,
      });
      return outcome.status === "failed"
        ? rejected(outcome.by, outcome.detail, outcome.failed)
        : { outcome: "infra-failed", detail: outcome.detail };
    };

    try {
      writeFileSync(absolute, next, "utf8");
    } catch (err) {
      return { outcome: "infra-failed", detail: `cannot write ${file.path}: ${String(err)}` };
    }

    const ctx = { root, path: file.path, source: next, symbolIds: [symbol.id, ...descendants.map((d) => d.id)] };
    let status: VerificationStatus = "passed";

    /**
     * One stage. `undefined` means carry on; a `WriteResult` means the write
     * is over. An advisory outcome carries on and downgrades the write's
     * recorded verification status rather than blocking it (§ 6.4).
     */
    const gate = (outcome: StageOutcome): WriteResult | undefined => {
      if (outcome.status === "passed") return undefined;
      if (outcome.status === "advisory") {
        status = "advisory";
        return undefined;
      }
      return fail(outcome);
    };

    // Thunks, not values: § 6.1's whole point is that an expensive stage runs
    // only when the cheap ones ahead of it passed.
    const observed = parser.symbols(next);
    const stages: Array<() => StageOutcome | Promise<StageOutcome>> = [
      () =>
        structuralStage({
          parses: parser.parses(next),
          before,
          after: observed.map(identityKey),
          gone: declaration.gone,
          added: declaration.added,
        }),
      () => verifier.typecheck(ctx),
      /**
       * The impacted tests, MINUS every test THIS BATCH is rewriting.
       *
       * Running the very test you just edited to decide whether you were
       * allowed to edit it makes "activate a pending acceptance test" an
       * unrepresentable operation: an acceptance test's first honest run
       * FAILS, and that failure is the RED observation the caller's own next
       * step exists to make. The gate's question is "did you break something
       * else", and every other test that reaches this file still runs, so
       * that question is still answered.
       *
       * THE BATCH, not this write, and the difference is not theoretical. A
       * step whose acceptance criterion has two pending tests activates both,
       * and the two activations are two writes under ONE lease. Filtering only
       * the write in hand leaves the first-activated test in the second one's
       * impacted set — where it fails, by design, because the production code
       * it asserts is still a stub — and the second activation is refused for
       * the first one's honest red. The lease is what names the batch, so it
       * is what the filter is over.
       *
       * A production symbol's write is unaffected: its id is not a test id,
       * so nothing is filtered and the tests that cover it all run.
       */
      () => {
        const written = new Set([...lease.symbolIds, ...ctx.symbolIds]);
        return verifier.tests({
          root,
          symbolIds: ctx.symbolIds,
          targets: impact.impactedTests(ctx.symbolIds).filter((t) => !written.has(t.id)),
        });
      },
      () => verifier.policy(ctx),
    ];
    for (const stage of stages) {
      const stopped = gate(await stage());
      if (stopped !== undefined) return stopped;
    }

    const report = registry.reconcile({
      fileId: file.id,
      source: next,
      observed,
      ...(declaration.rekey === undefined ? {} : { rekey: declaration.rekey }),
    });
    impact.observe(file.id, file.path, parser.imports(next));

    const after = registry.symbol(symbol.id);
    if (after === undefined) return { outcome: "infra-failed", detail: `symbol ${symbol.id} vanished on commit` };

    // Child events first, transaction event last (§ 4.4). The children are
    // every symbol the re-key actually moved, which for an edit inside a class
    // includes the class, because its own text changed too.
    const children: number[] = [];
    const touched = [
      ...report.tombstoned.map((s) => ({ symbol: s, kind: "symbol-deleted" as const })),
      ...report.renamed.map((r) => ({ symbol: r.symbol, kind: "symbol-renamed" as const })),
      ...report.modified.map((s) => ({ symbol: s, kind: "symbol-modified" as const })),
      ...report.created.map((s) => ({ symbol: s, kind: "symbol-created" as const })),
    ];
    for (const { symbol: s, kind } of touched) {
      children.push(
        log.append({
          kind,
          symbolId: s.id,
          fileId: file.id,
          leaseId: args.leaseId,
          taskId: args.intent.taskId,
          ...(args.intent.parentTaskId === undefined ? {} : { parentTaskId: args.intent.parentTaskId }),
          description: args.intent.description,
          version: s.version,
          verification: status,
          ...(kind === "symbol-deleted" ? {} : { body: next.slice(s.start, s.end) }),
          ...(args.detail === undefined || s.id !== symbol.id ? {} : { detail: args.detail(symbol) }),
        }),
      );
    }

    // The parent carries no `symbolId`: it is about the commit, not about one
    // symbol, so `history(symbolId)` stays the symbol's own events and the
    // transaction is found through `byLease` / `byTask` and its `children`.
    const seq = log.append({
      kind: "transaction",
      fileId: file.id,
      leaseId: args.leaseId,
      taskId: args.intent.taskId,
      ...(args.intent.parentTaskId === undefined ? {} : { parentTaskId: args.intent.parentTaskId }),
      description: args.intent.description,
      version: after.version,
      verification: status,
      children,
      detail: args.eventKind,
    });

    return { outcome: "committed", version: after.version, seq, verification: status };
  };

  return {
    replaceSymbolBody: (s) =>
      perform({
        ...s,
        requires: "edit",
        eventKind: "symbol-modified",
        splice: (source, symbol) => source.slice(0, symbol.start) + s.body + source.slice(symbol.end),
        // An edit declares no identity change at all, which is what makes a
        // body that deletes or renames the symbol a contract violation.
        declare: () => ({ gone: [], added: [] }),
      }),

    renameSymbol: (s) =>
      perform({
        ...s,
        requires: "edit",
        eventKind: "symbol-renamed",
        splice: (source, symbol) =>
          source.slice(0, symbol.nameStart) + s.newName + source.slice(symbol.nameEnd),
        declare: (symbol, descendants) => ({
          gone: [symbol, ...descendants].map(identityKey),
          added: [
            identityKey({ kind: symbol.kind, name: s.newName, container: symbol.container }),
            ...descendants.map((d) =>
              identityKey({ kind: d.kind, name: d.name, container: rewriteContainer(d, symbol, s.newName) }),
            ),
          ],
          rekey: Object.fromEntries([
            [symbol.id, { name: s.newName, container: symbol.container }],
            ...descendants.map((d) => [d.id, { name: d.name, container: rewriteContainer(d, symbol, s.newName) }]),
          ]),
        }),
        detail: (symbol) => `${symbol.name} -> ${s.newName}`,
      }),

    deleteSymbol: (s) =>
      perform({
        ...s,
        requires: "structural",
        eventKind: "symbol-deleted",
        splice: (source, symbol) => source.slice(0, symbol.start) + source.slice(symbol.end),
        declare: (symbol, descendants) => ({
          gone: [symbol, ...descendants].map(identityKey),
          added: [],
        }),
      }),

    async writeFile(s) {
      const lease = leases.lease(s.leaseId);
      if (lease === undefined) return rejected("contract", `lease ${s.leaseId} is not live`);
      if (!MODES.edit.includes(lease.mode)) {
        return rejected("contract", `a whole-file write needs a write or exclusive lease; ${s.leaseId} is ${lease.mode}`);
      }
      if (coveringScopes(lease.paths, s.path).length === 0) {
        return rejected("contract", `lease ${s.leaseId} holds no path scope covering ${s.path}`);
      }
      if (!(s.intent.expectedOutcome.created ?? []).includes(s.path)) {
        return rejected("contract", `the intent does not declare ${s.path} as an outcome of this call`);
      }

      const absolute = join(root, s.path);
      const tracked = registry.file(s.path);
      let before: string | undefined;
      try {
        before = readFileSync(absolute, "utf8");
      } catch {
        // The file is not there, which is the case this operation exists for.
        before = undefined;
      }
      // A file the registry holds whose bytes moved under it is a desync, the
      // same as it is for a symbol write: something with no declared intent
      // changed it between the acquire and now (§ 9.1).
      if (tracked !== undefined && before !== tracked.content) {
        registry.reinventory(s.path, before ?? "", parser.symbols(before ?? ""));
        return { outcome: "infra-failed", detail: `${s.path} was changed outside the system; it is now desynced` };
      }

      const restore = (): void => {
        if (before === undefined) rmSync(absolute, { force: true });
        else writeFileSync(absolute, before, "utf8");
      };

      try {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, s.body, "utf8");
      } catch (err) {
        return { outcome: "infra-failed", detail: `cannot write ${s.path}: ${String(err)}` };
      }

      const observed = parser.symbols(s.body);
      const ctx = { root, path: s.path, source: s.body, symbolIds: [] as string[] };
      let status: VerificationStatus = "passed";

      // The tests stage is absent from this list, not stubbed inside it. See
      // the contract above `writeFile` for why.
      const stages: Array<() => StageOutcome | Promise<StageOutcome>> = [
        () =>
          wholeFileStage({
            parses: parser.parses(s.body),
            before: before === undefined ? [] : parser.symbols(before).map(identityKey),
            after: observed.map(identityKey),
          }),
        () => verifier.typecheck(ctx),
        () => verifier.policy(ctx),
      ];

      for (const stage of stages) {
        const outcome = await stage();
        if (outcome.status === "passed") continue;
        if (outcome.status === "advisory") {
          status = "advisory";
          continue;
        }
        restore();
        log.append({
          kind: "write-failed",
          ...(tracked === undefined ? {} : { fileId: tracked.id }),
          leaseId: s.leaseId,
          taskId: s.intent.taskId,
          ...(s.intent.parentTaskId === undefined ? {} : { parentTaskId: s.intent.parentTaskId }),
          description: s.intent.description,
          verification: "failed",
          category: categoryOf(outcome) ?? "infrastructure",
          detail: outcome.detail,
        });
        return outcome.status === "failed"
          ? rejected(outcome.by, outcome.detail, outcome.failed)
          : { outcome: "infra-failed", detail: outcome.detail };
      }

      const file = tracked ?? registry.createFile(s.path);
      const children: number[] = [];
      const attribute = (kind: EventKind, symbolId: string, version: number, body?: string): void => {
        children.push(
          log.append({
            kind,
            symbolId,
            fileId: file.id,
            leaseId: s.leaseId,
            taskId: s.intent.taskId,
            ...(s.intent.parentTaskId === undefined ? {} : { parentTaskId: s.intent.parentTaskId }),
            description: s.intent.description,
            version,
            verification: status,
            ...(body === undefined ? {} : { body }),
          }),
        );
      };

      if (tracked === undefined) {
        children.push(
          log.append({
            kind: "file-created",
            fileId: file.id,
            leaseId: s.leaseId,
            taskId: s.intent.taskId,
            ...(s.intent.parentTaskId === undefined ? {} : { parentTaskId: s.intent.parentTaskId }),
            description: s.intent.description,
            verification: status,
            detail: s.path,
          }),
        );
      }

      const report = registry.reconcile({ fileId: file.id, source: s.body, observed });
      impact.observe(file.id, s.path, parser.imports(s.body));
      for (const created of report.created) {
        attribute("symbol-created", created.id, created.version, s.body.slice(created.start, created.end));
      }
      for (const modified of report.modified) {
        attribute("symbol-modified", modified.id, modified.version, s.body.slice(modified.start, modified.end));
      }

      // The parent lands last, so a reader that sees it knows every child is
      // already in the log (§ 4.4). A whole-file write claims no symbol
      // version, so `version` is the transaction's own sequence number —
      // the same answer `runTests` gives for the same reason.
      const seq = log.append({
        kind: "transaction",
        fileId: file.id,
        leaseId: s.leaseId,
        taskId: s.intent.taskId,
        ...(s.intent.parentTaskId === undefined ? {} : { parentTaskId: s.intent.parentTaskId }),
        description: s.intent.description,
        verification: status,
        children,
        detail: "file-written",
      });
      return { outcome: "committed", version: seq, seq, verification: status };
    },

    async runTests(s) {
      const selected = dedupe([...impact.impactedTests(s.symbolIds), ...impact.testsById(s.extra ?? [])]);

      // The floor, recomputed here rather than trusted from the caller. A
      // selection that covers it may be wider; one that is narrower is a
      // contract violation, and the omitted ids ARE the finding, so they are
      // named in the event and in the rejection.
      const chosen = new Set(selected.map((t) => t.id));
      const omitted = impact
        .impactedTests(s.wrote ?? [])
        .filter((t) => !chosen.has(t.id))
        .map((t) => t.id)
        .sort();

      if (omitted.length > 0) {
        const detail =
          `the test selection omits ${omitted.length} impacted test` +
          `${omitted.length === 1 ? "" : "s"} for the symbols this batch wrote: ` +
          `${omitted.join(", ")} — tests may be added to the impact floor, never removed from it`;
        log.append({
          kind: "tests-run",
          taskId: s.intent.taskId,
          ...(s.intent.parentTaskId === undefined ? {} : { parentTaskId: s.intent.parentTaskId }),
          description: s.intent.description,
          verification: "failed",
          category: "contract",
          detail: JSON.stringify({
            omitted,
            selected: selected.map((t) => t.id),
            wrote: [...(s.wrote ?? [])],
            status: "omitted-impacted-tests",
          }),
        });
        return rejected("contract", detail);
      }

      const targets = selected;
      const outcome = await verifier.tests({ root, symbolIds: s.symbolIds, targets });
      const seq = log.append({
        kind: "tests-run",
        taskId: s.intent.taskId,
        ...(s.intent.parentTaskId === undefined ? {} : { parentTaskId: s.intent.parentTaskId }),
        description: s.intent.description,
        verification: outcome.status === "failed" ? "failed" : outcome.status === "advisory" ? "advisory" : "passed",
        ...(categoryOf(outcome) === undefined ? {} : { category: categoryOf(outcome) }),
        detail: JSON.stringify({ targets: targets.map((t) => `${t.path}::${t.name}`), status: outcome.status }),
      });
      switch (outcome.status) {
        case "passed":
        case "advisory":
          return { outcome: "committed", version: seq, seq, verification: outcome.status };
        case "failed":
          // The failing ids travel out of here, because the caller's next
          // decision is whether they are its own acceptance tests.
          return rejected(outcome.by, outcome.detail, outcome.failed);
        case "infra-failed":
          return { outcome: "infra-failed", detail: outcome.detail };
      }
    },
  };
};
