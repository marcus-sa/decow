/**
 * Verification at the write boundary (ai-vcs.md § 6).
 *
 * Four stages in increasing cost, and a stage runs only if the ones before it
 * passed:
 *
 *   structural   does the edited file still parse, and is the identity delta
 *                the one the caller declared? Pure, free, built in.
 *   typecheck    the language's own diagnostics. A declared command.
 *   lint         the repository's own rules. A declared command.
 *   tests        the impact-scoped subset of the suite. One declared command
 *                per impacted test, and a JUnit report read off each.
 *
 * Plus one thing that is NOT a stage and sits here anyway: `measure`, which
 * executes one oracle and reads a verdict off it. No write gates on it, and
 * its interesting answer is a failure. It lives on the verifier because this
 * is the module's one place that knows what running a test MEANS.
 *
 * EVERY STAGE IS A COMPOSITION OF `run-command`, and that is the change this
 * file exists to carry. It used to spawn `bunx tsc --noEmit` and
 * `bun test <file> -t <name>` itself, which made the verifier a thing only a
 * bun project could be verified by. Now the four jobs are the framework's and
 * the four COMMANDS are the consumer's (`src/core/commands.ts`): a stage
 * builds the declared command into a `run-command` effect and hands it to the
 * injected executor. Nothing here spawns anything.
 *
 * That seam is also what makes the write path assertable without a process. A
 * test injects an executor that answers each effect from a script, and the
 * whole pipeline runs in microseconds; `real-tools.test.ts` and
 * `measure.test.ts` inject the spawning one and pay for it once.
 *
 * `RejectedBy` is deliberately a subset of `EffectResult`'s `rejected.by`:
 * minus `schema`, which belongs to `upsert-artifact`, and minus `command`,
 * which is what an UNINTERPRETED non-zero exit is. Every stage here
 * interprets one, so every stage reports its own name. A stage failure
 * therefore maps onto an effect result by the identity function.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandEffect,
  commandOf,
  commandOutput,
  executeCommand,
  type Effect,
  type EffectResult,
} from "../core/effects.ts";
import { normalizeCommand, type Commands } from "../core/commands.ts";
import { failingNames, readJunit, type RunCounts } from "./junit.ts";

export type { RunCounts };

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

export const STAGE_NAMES = ["structural", "typecheck", "lint", "tests"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * What a rejected write was rejected by. `structural` is "the edit did not
 * parse"; `contract` is "the edit parsed, and it did something other than what
 * was declared" (§ 4.5, § 5.4). `lint` is the repository's own declared rules
 * refusing the bytes, which used to be the stubbed `policy` stage and is now
 * a command a consumer names.
 */
export type RejectedBy = "structural" | "contract" | "typecheck" | "lint" | "tests";

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

export type OracleMeasurement = {
  verdict: OracleVerdict;
  axis: MeasureAxis;
  /** Verbatim stdout and stderr, in that order. */
  output: string;
  exitCode?: number;
  counts?: RunCounts;
  argv: readonly string[];
};

/**
 * Which oracle to execute. The LOCATOR, split, and never a command: what runs
 * it is the consumer's declared `commands.oracle`, so a project whose runner
 * is not bun is measured by naming its runner once rather than by overriding
 * an argv at every call site.
 */
export type MeasureContext = {
  root: string;
  /** Root-relative path of the file the oracle lives in. */
  file: string;
  /** The one test's name, when the locator named one. */
  selector?: string;
};

export type Verifier = {
  typecheck: (ctx: StageContext) => Promise<StageOutcome>;
  /**
   * The repository's own declared rules over the files a write touched. This
   * replaces the `policy` stage, which was a stub that passed because neither
   * of § 6.1's policy mechanisms was built; a declared lint command is one
   * that is.
   */
  lint: (ctx: StageContext) => Promise<StageOutcome>;
  tests: (ctx: TestStageContext) => Promise<StageOutcome>;
  /**
   * Execute one oracle and read a verdict off it. Not a stage: nothing gates
   * on it, it blocks no write, and its interesting answer is a FAILURE. It
   * sits on the verifier because this is the one place in the module that
   * knows what running a test MEANS.
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

/** An oracle locator as the arguments the declared oracle command takes. */
export const oracleContext = (root: string, locator: string): MeasureContext => {
  const { path, selector } = parseOracleLocator(locator);
  return { root, file: path, ...(selector === undefined ? {} : { selector }) };
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

/**
 * The one thing every stage does: run a declared command.
 *
 * This is an `EffectExecutor` narrowed to one effect type, deliberately. A
 * stage composes the consumer's declared command into a `run-command` effect
 * and hands it over; whatever is on the other side is what actually spawns.
 * In production that is the real runner; in a test it is a script, and the
 * whole verification pipeline runs without a process.
 */
export type RunCommandEffect = Extract<Effect, { type: "run-command" }>;
export type CommandExecutor = (effect: RunCommandEffect) => Promise<EffectResult>;

/** Trim a tool's output to something an event row can carry. */
const excerpt = (text: string): string => (text.length > 2000 ? `${text.slice(0, 2000)}…` : text);

/** What a stage says when the command it asked for could not be run at all. */
const infra = (what: string, result: EffectResult): StageOutcome => ({
  status: "infra-failed",
  detail: excerpt(
    commandOf(result) === undefined
      ? `${what} could not be run`
      : `${what} was killed at its timeout\n${commandOutput(commandOf(result))}`,
  ),
});

/**
 * One command, run, mapped onto a stage outcome.
 *
 * `by` is the STAGE's own name rather than the effect's `command`, because a
 * stage is exactly the thing that interprets a non-zero exit: "tsc said no" is
 * a typecheck failure and the caller routes it as one.
 */
const stageOf = async (
  run: CommandExecutor,
  effect: RunCommandEffect,
  by: Extract<RejectedBy, "typecheck" | "lint">,
): Promise<StageOutcome> => {
  const result = await run(effect);
  switch (result.outcome) {
    case "committed":
      return { status: "passed" };
    case "rejected":
      return { status: "failed", by, detail: excerpt(commandOutput(commandOf(result))) };
    default:
      return infra(by, result);
  }
};

/**
 * The declared typecheck, over the whole project. Project-scoped rather than
 * file-scoped because a type error an edit introduces usually surfaces in the
 * file that consumes the symbol, not the one that defines it, and because the
 * declaration takes no arguments for exactly that reason.
 */
export const typecheckStage =
  (commands: Commands, run: CommandExecutor): Verifier["typecheck"] =>
  async () =>
    stageOf(run, commandEffect(normalizeCommand(commands.typecheck({}))), "typecheck");

/**
 * The declared lint, over the files the write touched.
 *
 * Scoped to the write rather than to the project, because this stage runs
 * INSIDE the write path and the question it answers is whether these bytes
 * broke a rule. A consumer whose linter has no useful per-path mode declares
 * one that ignores `paths`; the framework hands over what it knows and does
 * not decide what the linter does with it.
 */
export const lintStage =
  (commands: Commands, run: CommandExecutor): Verifier["lint"] =>
  async (ctx) =>
    stageOf(run, commandEffect(normalizeCommand(commands.lint({ paths: [ctx.path] }))), "lint");

/** A directory for the JUnit reports of one stage invocation. */
const junitDir = (): string => mkdtempSync(join(tmpdir(), "dw-junit-"));

/**
 * The declared test command, once per impacted test, with the verdict read off
 * the JUnit report each run writes.
 *
 * An empty target set passes: the impact graph said nothing depends on the
 * change, and running the whole suite to disprove that is exactly the cost
 * § 6.2 exists to avoid.
 *
 * The run STOPS at the first target that did not pass, because the question is
 * "did this break something else" and one answer settles it. The ids on the
 * rejection come from the report's own failing cases, falling back to the
 * target that ran when the report named none, which is what a runner that
 * wrote nothing leaves behind.
 */
export const testsStage =
  (commands: Commands, run: CommandExecutor): Verifier["tests"] =>
  async (ctx) => {
    if (ctx.targets.length === 0) return { status: "passed" };
    const dir = junitDir();
    try {
      let n = 0;
      for (const target of ctx.targets) {
        const junit = join(dir, `${(n += 1)}.xml`);
        const effect = commandEffect(
          normalizeCommand(commands.tests({ file: target.path, selector: target.name, junit })),
        );
        const result = await run(effect);
        if (result.outcome === "conflict" || result.outcome === "infra-failed") {
          return infra(`the test command for ${target.path}`, result);
        }
        const command = commandOf(result);
        const report = readJunit(junit);
        const { verdict } = oracleVerdict(command?.exitCode ?? undefined, report.counts);
        if (verdict === "green") continue;

        const where = `${target.path} :: ${target.name}`;
        const detail = excerpt(`${where}\n${commandOutput(command)}`);
        // The runner exited non-zero while its own report records neither a
        // failure nor an error. Nothing was established, so nothing blocks
        // and the write's recorded status is downgraded instead (§ 6.4).
        if (verdict === "indeterminate") return { status: "advisory", detail };

        const failing = new Set(failingNames(report.cases));
        const failed = ctx.targets
          .filter((t) => t.path === target.path && failing.has(t.name))
          .map((t) => t.id);
        return {
          status: "failed",
          by: "tests",
          detail,
          // Which test failed, by id, because the caller routes on whether it
          // is one of its own.
          failed: failed.length > 0 ? failed : [target.id],
        };
      }
      return { status: "passed" };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

/** Exit statuses that mean the runner completed rather than crashed. */
const COMPLETED_EXITS = new Set([0, 1]);

/**
 * The verdict, and the axis that reached it — never the verdict alone.
 *
 * Exit status alone admits exactly the artefact this exists to refuse: an
 * oracle that errored in its own scaffolding exits 1, the identical status a
 * genuine assertion failure returns. So the counts are read, and a run that
 * produced no report at all is `broken` rather than `red`: a runner
 * summarises a suite it RAN, so an absent report is itself evidence it ran
 * nothing.
 *
 * `indeterminate` is not decoration. A run that failed while its own summary
 * records neither a failure nor an error is a world this cannot describe, and
 * answering `red` there would be a silent-wrong pass into a paid craft turn.
 *
 * The rule is unchanged by the move from a runner's stdout to a JUnit report.
 * What changed is where the counts come from, which is the whole point: the
 * verdict no longer depends on one runner's human output.
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

/** Execute one oracle with the declared oracle command, and read its report. */
export const measureStage =
  (commands: Commands, run: CommandExecutor): Verifier["measure"] =>
  async (ctx) => {
    const dir = junitDir();
    try {
      const junit = join(dir, "oracle.xml");
      const command = normalizeCommand(
        commands.oracle({
          file: ctx.file,
          ...(ctx.selector === undefined ? {} : { selector: ctx.selector }),
          junit,
        }),
      );
      const result = await run(commandEffect(command));
      const ran = commandOf(result);
      // The runner never started, or was killed before it could produce an
      // exit status. Nothing about the oracle was observed, so nothing about
      // it is claimed — and in particular the defect is NOT charged to its
      // author.
      if (ran === undefined || ran.exitCode === null) return undefined;

      const report = readJunit(junit);
      return {
        ...oracleVerdict(ran.exitCode, report.counts),
        output: excerpt(commandOutput(ran)),
        exitCode: ran.exitCode,
        ...(report.counts === undefined ? {} : { counts: report.counts }),
        argv: command.argv,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

/** A stage that passes without looking. The injected default in tests. */
export const alwaysPasses = async (): Promise<StageOutcome> => ({ status: "passed" });

/**
 * The command executor that actually spawns, bound to one repository root.
 *
 * The one seam in this module that reaches the world. `runCommand` is the
 * framework's single process runner (`src/core/commands.ts`), so a `tsc` the
 * verifier asks for and a `run-command` effect a graph emits go through the
 * same code, with the same timeout, the same environment overlay and the same
 * output cap.
 */
export const spawningExecutor =
  (root: string): CommandExecutor =>
  (effect) =>
    executeCommand(effect, root, () => 0);

/**
 * The production pipeline: the consumer's four declared commands, over the
 * executor that spawns.
 */
export const defaultVerifier = (spec: { commands: Commands; root: string }): Verifier => {
  const run = spawningExecutor(spec.root);
  return {
    typecheck: typecheckStage(spec.commands, run),
    lint: lintStage(spec.commands, run),
    tests: testsStage(spec.commands, run),
    measure: measureStage(spec.commands, run),
  };
};
