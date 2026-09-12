/**
 * Effects are data. A step returns Effect[]; the runner executes them and feeds
 * typed results back into state. `outcome` is a decision value: a branch routes
 * on it. A lease conflict is an edge to a rebase-and-retry node, never an
 * exception. `infra-failed` is distinct from `rejected` so a flaky harness does
 * not burn the retry budget on a change that was fine.
 *
 * Notably absent from the union: create-issue, send-message, or anything else
 * that is a shared, outward-facing action. The only way to defer is a
 * needs-human terminal with a typed reason.
 */

import { openArtifacts, type ArtifactStore } from "../artifacts/store.ts";

export type Effect =
  | { type: "replace-symbol"; symbolId: string; expectedVersion: number; body: string }
  /**
   * Write a whole file, which may or may not already exist.
   *
   * `replace-symbol` names a symbol id, so it can only ever rewrite something
   * the registry already holds. That is the right shape for a crafter working
   * inside a declared surface, and the wrong shape for an author whose whole
   * job is to produce a file that is not there yet — an oracle, and the
   * supports beside it.
   *
   * The concurrency model is the path scope of the lease rather than a
   * version: a file has no version to be optimistic about before it exists.
   * What the write path checks instead is that the lease's scope covers the
   * path, that the intent declared it, and that no identity the file already
   * held vanished.
   */
  | { type: "write-file"; path: string; body: string }
  | { type: "upsert-artifact"; table: string; id: string; expectedVersion: number; row: unknown }
  /**
   * Run the suite. `impacted` names the symbols the run is scoped to, and the
   * executor derives the tests from them through the VCS impact graph.
   *
   * `extra` is the selection a leaf added *above* that floor: test ids a step
   * chose to run because it knows something the static import graph does not.
   * The split is load-bearing. The floor belongs to the VCS, which recomputes
   * it from the symbols the batch actually wrote rather than trusting what the
   * effect declared; the selection above it belongs to the workflow. So a leaf
   * may ADD tests and can never SUBTRACT one: an effect whose union misses a
   * test the impact graph considers impacted comes back
   * `rejected { by: "contract" }` with the omitted ids, not as a smaller run.
   */
  | { type: "run-tests"; impacted: string[]; extra?: string[] }
  /**
   * Execute one oracle and read a verdict off it.
   *
   * This is `run-tests` asking a different question and it is a different
   * effect because of it. `run-tests` asks "did the change break anything",
   * and a failure is a refusal. This asks "what does this one test do, on its
   * own, right now", and a failure — `red` — is the DESIRED answer.
   *
   * The reason it is software rather than a leaf is the rule nwave-experimental
   * names `boundary:software-measures-model-decides`: the two roles that hold
   * an oracle, the author and its reviewer, cannot run it. "This oracle fails
   * on its assertion and not on its scaffolding" is therefore a property the
   * runner owns and measures, and an observation is a fixed floor rather than
   * a rigor knob.
   *
   * `oracle` is a locator: `path::selector`, or a bare path for the whole file.
   * `argv` overrides the command the locator would derive, for a project whose
   * runner is not the default.
   */
  | { type: "measure-oracle"; oracle: string; argv?: string[] }
  | { type: "append-trail"; line: string };

/**
 * What executing one oracle established. Four answers, and the middle two are
 * the ones that earn the type.
 *
 *   green          it passed. Before any production code that is a VACUOUS
 *                  oracle — it proves nothing — and it is a person's
 *   red            it failed on its assertion. The desired answer
 *   broken         it failed on its scaffolding: an import that does not
 *                  resolve, a fixture that threw, a file that does not parse.
 *                  The defect is the ORACLE's and it goes back to its author
 *   indeterminate  the runner exited non-zero while its own summary recorded
 *                  no failure and no error. Nothing about the oracle was
 *                  established, so nothing about it may be claimed
 *
 * Exit status alone cannot tell `red` from `broken`: a runner exits non-zero
 * for both. That is why the counts are read, and why the axis travels with the
 * answer.
 */
export const ORACLE_VERDICTS = ["green", "red", "broken", "indeterminate"] as const;
export type OracleVerdict = (typeof ORACLE_VERDICTS)[number];

/** What reached the verdict, so a weaker claim is legible as one. */
export const MEASURE_AXES = ["exit-status", "no-summary", "counts"] as const;
export type MeasureAxis = (typeof MEASURE_AXES)[number];

/**
 * One oracle, measured.
 *
 * It rides on `EffectResult` as an optional field rather than as a fifth
 * outcome, because the outcome union is what every other graph's edge tables
 * are total over and a fifth member would give each of them a dead edge. A
 * pure branch reads `verdict` off this and gets all four answers from one
 * field; `outcome` stays the coarse "did the world accept this" every other
 * effect answers.
 */
export type OracleMeasurement = {
  verdict: OracleVerdict;
  axis: MeasureAxis;
  /** Verbatim runner output, both channels. What a person and a retry read. */
  output: string;
  /** The process's exit status. Absent when it never produced one. */
  exitCode?: number;
  /** The runner's own summary, when it printed one. */
  counts?: { passed: number; failed: number; errored: number };
  /** The command that ran, so a reader can run it by hand. */
  argv: readonly string[];
};

/**
 * `by` names the gate that refused the write. Five members, covering the three
 * failure categories the agent-native VCS distinguishes (`src/vcs`, ai-vcs.md
 * § 5.4): `contract` is "you declared one thing and did another",
 * `structural` is "the edit does not parse", and `typecheck` / `tests` /
 * `schema` are quality signals from a check that ran. An infrastructure
 * failure is not in here at all; it is `infra-failed`, so a flaky harness
 * cannot be mistaken for a bad change.
 */
export type RejectedBy = "typecheck" | "tests" | "schema" | "contract" | "structural";

/**
 * What a rejection can name beyond the gate that produced it.
 *
 * `failed` is the ids of the tests that failed. It exists because a graph has
 * to tell "my own acceptance test is still red" from "I broke something else"
 * — two causes with two different owners and two different routes — and that
 * distinction is a set membership against the step's own acceptance tests, not
 * a judgement a model should be asked to make. A stage that cannot name which
 * test failed leaves it absent, and the graph reads the absence honestly
 * rather than guessing.
 */
export type RejectionDetail = { failed?: readonly string[] };

export type EffectResult =
  | { effect: Effect; outcome: "committed"; version: number; measured?: OracleMeasurement }
  | { effect: Effect; outcome: "conflict"; currentVersion: number }
  | { effect: Effect; outcome: "rejected"; by: RejectedBy; detail?: RejectionDetail; measured?: OracleMeasurement }
  | { effect: Effect; outcome: "infra-failed"; measured?: OracleMeasurement };

/**
 * The measurement on a result, if there is one.
 *
 * `conflict` is the one outcome that carries none, because a measurement
 * claims no version and therefore has no optimistic check to lose. Reading the
 * field across the union needs that narrowing once rather than at every call
 * site, so it lives here — and a branch that routes an oracle verdict is then
 * a pure function of one field.
 */
export const measurementOf = (result: EffectResult | undefined): OracleMeasurement | undefined =>
  result === undefined || result.outcome === "conflict" ? undefined : result.measured;

export type Artifact = { version: number; row: unknown };

/**
 * The read surface the artifact `Map` had, over a store that is now a
 * database. Read-only and live: every call projects the store's own event log
 * rather than answering from a copy, so there is no second bookkeeping
 * structure to drift from the rows.
 */
export type ArtifactView = {
  get(key: string): Artifact | undefined;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<Artifact>;
  readonly size: number;
};

export type MemoryEffectsOptions = {
  /**
   * Where `upsert-artifact` lands. Defaults to an in-memory
   * `openArtifacts({ path: ":memory:" })`, so a caller that wants rows and does
   * not care where they live passes nothing; a caller that wants them to
   * outlive the process passes a store opened on a path.
   */
  store?: ArtifactStore;
};

/**
 * In-memory effect executor. `upsert-artifact` goes to a real artifact store
 * under the optimistic version check the effect declares; the trail is an
 * array. `replace-symbol`, `write-file`, `run-tests` and `measure-oracle` come
 * back `infra-failed` because there is no VCS and no test runner behind this
 * executor — that is the honest outcome, not `rejected`.
 */
export const memoryEffects = (options: MemoryEffectsOptions = {}) => {
  const store = options.store ?? openArtifacts();
  const trail: string[] = [];

  const upsert = (e: Extract<Effect, { type: "upsert-artifact" }>): EffectResult => {
    const result = store.upsert({
      table: e.table,
      id: e.id,
      expectedVersion: e.expectedVersion,
      row: e.row,
    });
    return result.outcome === "committed"
      ? { effect: e, outcome: "committed", version: result.version }
      : { effect: e, outcome: "conflict", currentVersion: result.currentVersion };
  };

  const execute = async (effects: Effect[]): Promise<EffectResult[]> =>
    effects.map((effect): EffectResult => {
      switch (effect.type) {
        case "upsert-artifact":
          return upsert(effect);
        case "append-trail":
          trail.push(effect.line);
          return { effect, outcome: "committed", version: trail.length };
        case "replace-symbol":
        case "write-file":
        case "run-tests":
        case "measure-oracle":
          return { effect, outcome: "infra-failed" };
      }
    });

  /**
   * The store's rows, keyed `table/id`. Derived from the store's own
   * append-only log — the last event for a key is that row's current state —
   * so nothing is cached and nothing can drift.
   */
  const snapshot = (): Map<string, Artifact> => {
    const rows = new Map<string, Artifact>();
    for (const event of store.events()) {
      rows.set(`${event.table}/${event.id}`, { version: event.version, row: event.row });
    }
    return rows;
  };

  /**
   * A live view rather than a snapshot, because `const { artifacts } =
   * memoryEffects()` is how every caller reads it: a getter would hand out the
   * state at destructuring time, which is empty.
   */
  const artifacts: ArtifactView = {
    get: (key) => snapshot().get(key),
    has: (key) => snapshot().has(key),
    keys: () => snapshot().keys(),
    values: () => snapshot().values(),
    get size() {
      return snapshot().size;
    },
  };

  return { execute, trail, store, artifacts };
};
