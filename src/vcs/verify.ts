/**
 * Verification at the write boundary (ai-vcs.md § 6).
 *
 * Four stages in increasing cost, and a stage runs only if the ones before it
 * passed:
 *
 *   structural   does the edited file still parse, and is the identity delta
 *                the one the caller declared? Pure, free, built in.
 *   typecheck    the language's own diagnostics. Shells out by default.
 *   tests        the impact-scoped subset of the suite. Shells out by default.
 *   policy       repository-specific rules. A stub that passes.
 *
 * Plus one thing that is NOT a stage and sits here anyway: `measure`, which
 * executes one oracle and reads a verdict off it. No write gates on it, and
 * its interesting answer is a failure. It lives on the verifier because this
 * is the module's one place that knows how to run a runner and read what it
 * printed.
 *
 * Every stage is injectable. The default implementations spawn `bunx tsc` and
 * `bun test`, which is real and slow; a test supplies its own and the whole
 * write path runs in milliseconds. That seam is the reason a failing typecheck
 * can be asserted without a compiler.
 *
 * `RejectedBy` is deliberately the same union as `EffectResult`'s
 * `rejected.by`, minus `schema`, which belongs to `upsert-artifact`. A stage
 * failure therefore maps onto an effect result by the identity function.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

/** § 6.3: every write has one of these, queryable from the event log. */
export const VERIFICATION_STATUSES = ["pending", "passed", "failed", "advisory"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * § 5.4's three failure categories, kept apart because the responses differ:
 * a contract violation is the agent's error and is retryable as-is, a
 * verification failure is a quality signal the agent must respond to, and an
 * infrastructure failure is an operator concern that must not be
 * misattributed to the agent.
 */
export const FAILURE_CATEGORIES = ["contract", "verification", "infrastructure"] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const STAGE_NAMES = ["structural", "typecheck", "tests", "policy"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * What a rejected write was rejected by. `structural` is "the edit did not
 * parse"; `contract` is "the edit parsed, and it did something other than what
 * was declared" (§ 4.5, § 5.4), which is also where a policy violation lands,
 * because a policy is a rule the repository declares and the change broke.
 */
export type RejectedBy = "structural" | "contract" | "typecheck" | "tests";

export type StageOutcome =
  | { status: "passed" }
  | {
      status: "failed";
      by: RejectedBy;
      detail: string;
      /**
       * Ids of the targets that failed, when the stage can name them. The
       * tests stage can, and a caller that has to tell "the test I was making
       * pass is still failing" from "I broke a different one" needs it: that
       * is a set membership rather than a judgement. A stage with nothing to
       * name leaves it absent rather than reporting an empty set, which would
       * claim that nothing failed.
       */
      failed?: readonly string[];
    }
  /** § 6.4: the check could not decide. Recorded, does not block. */
  | { status: "advisory"; detail: string }
  /** The stage itself broke. Never the agent's fault (§ 5.4). */
  | { status: "infra-failed"; detail: string };

/** A test the impact graph selected, addressable by the runner. */
export type TestTarget = { id: string; path: string; name: string };

export type StageContext = {
  /** Absolute path of the repository root. */
  root: string;
  /** Root-relative path of the file the write touched. */
  path: string;
  /** The file's content after the write. */
  source: string;
  /** The symbols the write claims to have touched. */
  symbolIds: readonly string[];
};

/**
 * The tests stage reads no file: it runs the targets the impact graph
 * selected, wherever they live. It therefore takes its own context rather than
 * extending the one the file-scoped stages take.
 */
export type TestStageContext = {
  root: string;
  /** The symbols the run is scoped to, for the log. */
  symbolIds: readonly string[];
  targets: readonly TestTarget[];
};

/* ------------------------------------------------------- oracle measurement */

/**
 * What executing ONE oracle established. The same four words `EffectResult`
 * carries, deliberately, so the executor's mapping is the identity function on
 * `verdict` exactly as it already is on `outcome` and on `by`.
 */
export const ORACLE_VERDICTS = ["green", "red", "broken", "indeterminate"] as const;
export type OracleVerdict = (typeof ORACLE_VERDICTS)[number];

/** What reached the verdict. A `red` on `no-summary` would be a weaker claim. */
export const MEASURE_AXES = ["exit-status", "no-summary", "counts"] as const;
export type MeasureAxis = (typeof MEASURE_AXES)[number];

/** The runner's own summary of one run. */
export type RunCounts = { passed: number; failed: number; errored: number };

export type OracleMeasurement = {
  verdict: OracleVerdict;
  axis: MeasureAxis;
  /** Verbatim stdout and stderr, in that order. */
  output: string;
  exitCode?: number;
  counts?: RunCounts;
  argv: readonly string[];
};

export type MeasureContext = {
  root: string;
  /** The command to run. Derived from the locator, or supplied by the caller. */
  argv: readonly string[];
};

export type Verifier = {
  typecheck: (ctx: StageContext) => Promise<StageOutcome>;
  tests: (ctx: TestStageContext) => Promise<StageOutcome>;
  policy: (ctx: StageContext) => Promise<StageOutcome>;
  /**
   * Execute one oracle and read a verdict off it. Not a stage: nothing gates
   * on it, it blocks no write, and its interesting answer is a FAILURE. It
   * sits on the verifier because this is the one place in the module that
   * knows how to run a test runner and read what it printed.
   *
   * `undefined` is the honest answer for a runner that could not be started at
   * all. That is an infrastructure failure rather than a verdict about the
   * oracle, and the caller must not charge it to the oracle's author.
   */
  measure: (ctx: MeasureContext) => Promise<OracleMeasurement | undefined>;
};

/** The separator a `path::selector` oracle locator uses. */
export const LOCATOR_SEPARATOR = "::";

/** An oracle locator, split. A bare path selects the whole file. */
export const parseOracleLocator = (locator: string): { path: string; selector?: string } => {
  const at = locator.indexOf(LOCATOR_SEPARATOR);
  if (at < 0) return { path: locator.trim() };
  const path = locator.slice(0, at).trim();
  const selector = locator.slice(at + LOCATOR_SEPARATOR.length).trim();
  return selector.length === 0 ? { path } : { path, selector };
};

/**
 * The command one oracle locator names.
 *
 * `path::selector` runs that one test by name; a bare path runs the file. The
 * selector is a regex to `bun test -t`, so a test name carrying regex
 * metacharacters would need an explicit `argv` — stated rather than escaped,
 * because escaping it here would silently disagree with what an operator gets
 * when they run the printed command by hand.
 */
export const oracleArgv = (locator: string): string[] => {
  const { path, selector } = parseOracleLocator(locator);
  return selector === undefined ? ["bun", "test", path] : ["bun", "test", path, "-t", selector];
};

/**
 * The structural stage, as a pure function over identity keys.
 *
 * It answers one question: is the difference between the identities observed
 * before the edit and the identities observed after it exactly the difference
 * the caller declared? `replaceSymbolBody` declares no difference at all,
 * `renameSymbol` declares one key out and one key in, `deleteSymbol` declares
 * the symbol and everything it held going out. Anything else is the registry
 * refusing to infer identity from structure (§ 9.1).
 */
export const structuralStage = (spec: {
  parses: boolean;
  before: readonly string[];
  after: readonly string[];
  /** Identity keys the caller declared would disappear. */
  gone: readonly string[];
  /** Identity keys the caller declared would appear. */
  added: readonly string[];
}): StageOutcome => {
  if (!spec.parses) {
    return { status: "failed", by: "structural", detail: "the edited file no longer parses" };
  }
  const after = new Set(spec.after);
  const before = new Set(spec.before);
  const actualGone = [...before].filter((k) => !after.has(k)).sort();
  const actualAdded = [...after].filter((k) => !before.has(k)).sort();
  const declaredGone = [...new Set(spec.gone)].sort();
  const declaredAdded = [...new Set(spec.added)].sort();

  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(actualGone, declaredGone) && same(actualAdded, declaredAdded)) return { status: "passed" };

  return {
    status: "failed",
    by: "contract",
    detail:
      `declared identity delta does not match the observed one: ` +
      `declared -[${declaredGone.join(", ")}] +[${declaredAdded.join(", ")}], ` +
      `observed -[${actualGone.join(", ")}] +[${actualAdded.join(", ")}]`,
  };
};

/**
 * The stage for a WHOLE-FILE write, as a pure function over identity keys.
 *
 * It asks a weaker question than `structuralStage`, and deliberately: a caller
 * writing a whole file is authoring, so what appears is its business. What is
 * NOT its business is what DISAPPEARS. A file that already held a symbol and
 * comes back without it has had an identity removed that nothing declared, and
 * the registry does not infer a delete from an absence (§ 9.1) — so this is a
 * contract violation rather than a tombstone.
 *
 * A file that did not exist has an empty `before`, so every identity in it is
 * new and the check passes vacuously. That is the case this exists for.
 */
export const wholeFileStage = (spec: {
  parses: boolean;
  /** Identity keys the file held before the write. Empty for a new file. */
  before: readonly string[];
  /** Identity keys the written bytes hold. */
  after: readonly string[];
}): StageOutcome => {
  if (!spec.parses) {
    return { status: "failed", by: "structural", detail: "the written file does not parse" };
  }
  const after = new Set(spec.after);
  const vanished = [...new Set(spec.before)].filter((key) => !after.has(key)).sort();
  if (vanished.length === 0) return { status: "passed" };
  return {
    status: "failed",
    by: "contract",
    detail:
      `the write removes ${vanished.length} identity the file already held and nothing declared ` +
      `a delete for: ${vanished.join(", ")}`,
  };
};

/** The category an outcome belongs to, for the event log. */
export const categoryOf = (outcome: StageOutcome): FailureCategory | undefined => {
  switch (outcome.status) {
    case "failed":
      return outcome.by === "contract" || outcome.by === "structural" ? "contract" : "verification";
    case "infra-failed":
      return "infrastructure";
    default:
      return undefined;
  }
};

/* --------------------------------------------------------- default stages */

const spawn = async (cmd: string[], cwd: string): Promise<{ code: number; output: string }> => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, output: `${stdout}${stderr}`.trim() };
};

/** Trim a tool's output to something an event row can carry. */
const excerpt = (text: string): string => (text.length > 2000 ? `${text.slice(0, 2000)}…` : text);

/**
 * `bunx tsc --noEmit` over the whole project. Project-scoped rather than
 * file-scoped because a type error an edit introduces usually surfaces in the
 * file that consumes the symbol, not the one that defines it.
 */
export const bunxTypecheck: Verifier["typecheck"] = async (ctx) => {
  try {
    const { code, output } = await spawn(["bunx", "tsc", "--noEmit"], ctx.root);
    return code === 0 ? { status: "passed" } : { status: "failed", by: "typecheck", detail: excerpt(output) };
  } catch (err) {
    return { status: "infra-failed", detail: `tsc could not be run: ${String(err)}` };
  }
};

/**
 * `bun test <file> -t <name>` per impacted test. An empty target set passes:
 * the impact graph said nothing depends on the change, and running the whole
 * suite to disprove that is exactly the cost § 6.2 exists to avoid.
 */
export const bunTests: Verifier["tests"] = async (ctx) => {
  for (const target of ctx.targets) {
    try {
      const { code, output } = await spawn(["bun", "test", target.path, "-t", target.name], ctx.root);
      if (code !== 0) {
        return {
          status: "failed",
          by: "tests",
          detail: excerpt(`${target.path} :: ${target.name}\n${output}`),
          // Which test failed, by id, because the caller routes on whether it
          // is one of its own. The run stops at the first failure, so this is
          // one id rather than the whole failing set.
          failed: [target.id],
        };
      }
    } catch (err) {
      return { status: "infra-failed", detail: `bun test could not be run: ${String(err)}` };
    }
  }
  return { status: "passed" };
};

/**
 * `bun test`'s own summary lines, or `undefined` when it printed none.
 *
 * MEASURED against bun 1.3.12 rather than assumed, because the whole verdict
 * rests on it:
 *
 *   a pass                    exit 0,  ` 1 pass`, ` 0 fail`
 *   an assertion failure      exit 1,  ` 0 pass`, ` 1 fail`
 *   a test body that throws   exit 1,  ` 0 pass`, ` 1 fail`
 *   an import that is missing exit 1,  ` 0 pass`, ` 1 fail`, ` 1 error`
 *   a file that does not parse exit 1, ` 0 pass`, ` 1 fail`, ` 1 error`
 *   `-t` matching no test     exit 1,  no summary at all
 *
 * So the `error` line is a real signal for `broken` — bun reports an unhandled
 * error between tests separately from the failure it also counts — and an
 * ABSENT summary means the runner did not get as far as running anything.
 */
export const bunCounts = (output: string): RunCounts | undefined => {
  const read = (label: string): number | undefined => {
    const match = new RegExp(`^\\s*(\\d+) ${label}$`, "m").exec(output);
    return match === null ? undefined : Number(match[1]);
  };
  const passed = read("pass");
  const failed = read("fail");
  if (passed === undefined || failed === undefined) return undefined;
  return { passed, failed, errored: read("error") ?? 0 };
};

/** Exit statuses that mean the runner completed rather than crashed. */
const COMPLETED_EXITS = new Set([0, 1]);

/**
 * The verdict, and the axis that reached it — never the verdict alone.
 *
 * Exit status alone admits exactly the artefact this exists to refuse: an
 * oracle that errored in its own scaffolding exits 1, the identical status a
 * genuine assertion failure returns. So the counts are read, and a run that
 * printed no counts is `broken` rather than `red`: bun always summarises a
 * suite it ran, so an absent summary is itself evidence it ran nothing.
 *
 * `indeterminate` is not decoration. A run that failed while its own summary
 * records neither a failure nor an error is a world this cannot describe, and
 * answering `red` there would be a silent-wrong pass into a paid craft turn.
 */
export const oracleVerdict = (
  exitCode: number | undefined,
  counts: RunCounts | undefined,
): { verdict: OracleVerdict; axis: MeasureAxis } => {
  if (exitCode === undefined || !COMPLETED_EXITS.has(exitCode)) {
    return { verdict: "broken", axis: "exit-status" };
  }
  if (counts === undefined) return { verdict: "broken", axis: "no-summary" };
  if (exitCode === 0) return { verdict: "green", axis: "counts" };
  if (counts.errored > 0) return { verdict: "broken", axis: "counts" };
  if (counts.failed > 0) return { verdict: "red", axis: "counts" };
  return { verdict: "indeterminate", axis: "counts" };
};

/** Execute one oracle with `bun test` and read bun's own summary. */
export const bunOracle: Verifier["measure"] = async (ctx) => {
  const [command, ...rest] = ctx.argv;
  if (command === undefined) return undefined;
  try {
    const { code, output } = await spawn([command, ...rest], ctx.root);
    const counts = bunCounts(output);
    return { ...oracleVerdict(code, counts), output: excerpt(output), exitCode: code, ...(counts === undefined ? {} : { counts }), argv: ctx.argv };
  } catch {
    // The runner never started. Nothing about the oracle was observed, so
    // nothing about it is claimed — and in particular the defect is NOT
    // charged to its author.
    return undefined;
  }
};

/**
 * The policy stage, as a stub that passes. The document's policy layer is
 * ast-grep patterns plus external scripts (§ 6.1, § 9.3); neither is built, so
 * this says so by passing rather than by pretending to check something.
 */
export const policyPasses: Verifier["policy"] = async () => ({ status: "passed" });

/** A stage that passes without looking. The injected default in tests. */
export const alwaysPasses = async (): Promise<StageOutcome> => ({ status: "passed" });

/** The production pipeline: real tsc, real bun test, stub policy. */
export const defaultVerifier = (): Verifier => ({
  typecheck: bunxTypecheck,
  tests: bunTests,
  policy: policyPasses,
  measure: bunOracle,
});
