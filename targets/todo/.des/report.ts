/**
 * The run report: one JSON line per leaf call, written as it happens.
 *
 * The repository's claim so far is that every graph is correct for every
 * combination of answers a model could give. What it has never had is evidence
 * about the answers a real model actually gives: how often a small model's
 * first attempt survives its own mechanical checks and an adversarial
 * validator, which requirement rows do the refusing, which leaves exhaust, and
 * what a completed task costs in tokens. That is what this file is for. It is
 * an OBSERVATION SINK — nothing in any graph reads it, and removing it changes
 * no trajectory.
 *
 * Three facts come from three places and are joined here:
 *
 *   the attempt   `StepObserver`, the one seam inside `runStep` — attempt
 *                 number, the worker's decision, the mechanical violations
 *                 that refused it, the validator's verdict and its violations
 *   the row       the observer is built PER ROW by the pipeline, so a record
 *                 knows which roadmap step it belongs to without parsing a
 *                 journal key
 *   the tokens    the model binding, through `mastraAgent`'s `onUsage`
 *
 * TOKEN ATTRIBUTION IS ORDER-BASED, and that is the one thing to know before
 * trusting the numbers. Inside one `runStep` the calls are strictly worker,
 * then (if the mechanical checks passed) validator, and the observer fires
 * after both. So the usage entries queued since the last observation are this
 * attempt's, in that order — PROVIDED only one leaf is in flight. The deliver
 * command therefore runs at concurrency 1. At a higher concurrency the decision
 * fields stay exact and the token fields would interleave across rows, so the
 * writer records `concurrent: true` on every line rather than reporting numbers
 * it cannot stand behind.
 *
 * A journal HIT writes no line, because no model was called. That is what makes
 * a count of lines a count of INFERENCE rather than a count of nodes.
 *
 * There is no table any more. The command that printed one went when the six
 * commands did, and a renderer nothing renders is dead code; what is left is
 * the writer, which the server uses, and `readReport`, which reads a file of
 * JSON lines back. The measurement the design asks for — the gap between the
 * calls a leaf made and the decisions it produced — is still in the file, one
 * line per call, and the UI shows the same facts per run.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { StepAttempt, StepObserver } from "@des/core/step";
import type { Violation } from "@des/core/requirement";

/** Input and output token counts, when the provider layer reported them. */
export type Tokens = { input?: number; output?: number };

/** One leaf call. Exactly one line of `report.jsonl`. */
export type ReportLine = {
  /** The run directory's name. */
  run: string;
  /**
   * What the call belongs to: the roadmap row, when whatever started the run
   * knew one, and the graph's own id when it did not.
   */
  row: string;
  /** The step id, e.g. `deliver.implement`. */
  step: string;
  /** 1-based; an escalation is the last attempt. */
  attempt: number;
  /** The worker binding this attempt ran on. */
  model: string;
  /** What the worker decided. Absent when the call threw. */
  decision?: string;
  /** True when this attempt's output was accepted and journaled. */
  accepted: boolean;
  /** The validator's verdict. Absent when a mechanical check refused first. */
  verdict?: "pass" | "fail";
  /** Requirement ids the validator refused it on, with their evidence. */
  violations: Violation[];
  /** Requirement ids a mechanical check refused it on, before any validator. */
  mechanical: Violation[];
  /** Set when a provider call threw. */
  error?: string;
  /** Tokens the worker call reported, if the provider layer reported any. */
  workerTokens?: Tokens;
  /** Tokens the validator call reported. Absent when no validator ran. */
  validatorTokens?: Tokens;
  /** True when more than one row could have been in flight; see the header. */
  concurrent?: boolean;
};

/**
 * Token counts out of whichever usage shape the provider layer returned.
 *
 * There are two live shapes in this dependency graph and they disagree:
 * `@mastra/core`'s `TokenUsage` is flat (`promptTokens` / `completionTokens`),
 * and the AI SDK's `LanguageModelUsage` nests (`inputTokens.total` /
 * `outputTokens.total`); an older AI SDK shape has `inputTokens` as a plain
 * number. All three are read here, and anything else yields an EMPTY object
 * rather than a zero — "the provider did not say" and "the call cost nothing"
 * are different claims and a report that conflated them would be lying about
 * the cheapest thing it measures.
 */
export const readTokens = (usage: unknown): Tokens => {
  if (usage === null || typeof usage !== "object") return {};
  const u = usage as Record<string, unknown>;

  const nested = (value: unknown): number | undefined => {
    if (typeof value === "number") return value;
    if (value !== null && typeof value === "object") {
      const total = (value as { total?: unknown }).total;
      if (typeof total === "number") return total;
    }
    return undefined;
  };

  const input = typeof u.promptTokens === "number" ? u.promptTokens : nested(u.inputTokens);
  const output = typeof u.completionTokens === "number" ? u.completionTokens : nested(u.outputTokens);

  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
};

export type ReportOptions = {
  /** Where the lines go. `runs/<name>/report.jsonl`. */
  path: string;
  /** The run directory's name, on every line. */
  run: string;
  /**
   * True when more than one run may be in flight, which makes the token
   * counts unattributable. Recorded on every line rather than silently
   * reported. A server sets it: it does not serialise its runs.
   */
  concurrent?: boolean;
};

export type Reporter = {
  /**
   * The usage sink to hand `mastraAgent`. Every call queues one entry; the
   * next observation drains the queue in call order.
   */
  onUsage(usage: unknown): void;
  /** An observer bound to one row. The pipeline builds one per row. */
  observerFor(row: string): StepObserver;
  /** Every line written so far, re-read from the file. */
  read(): ReportLine[];
};

export const openReport = (options: ReportOptions): Reporter => {
  /** Usage entries since the last observation, in call order. */
  let pending: Tokens[] = [];

  const write = (line: ReportLine): void => {
    appendFileSync(options.path, `${JSON.stringify(line)}\n`, "utf8");
  };

  const drain = (): { workerTokens?: Tokens; validatorTokens?: Tokens } => {
    const [worker, validator] = pending;
    pending = [];
    return {
      ...(worker === undefined ? {} : { workerTokens: worker }),
      ...(validator === undefined ? {} : { validatorTokens: validator }),
    };
  };

  const lineFor = (row: string, attempt: StepAttempt): ReportLine => ({
    run: options.run,
    row,
    step: attempt.stepId,
    attempt: attempt.attempt,
    model: attempt.model,
    ...(attempt.decision === undefined ? {} : { decision: attempt.decision }),
    accepted: attempt.accepted,
    ...(attempt.verdict === undefined ? {} : { verdict: attempt.verdict }),
    violations: attempt.violations,
    mechanical: attempt.mechanical,
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
    ...drain(),
    ...(options.concurrent === true ? { concurrent: true } : {}),
  });

  return {
    onUsage: (usage) => {
      pending.push(readTokens(usage));
    },
    observerFor: (row) => (attempt) => write(lineFor(row, attempt)),
    read: () => readReport(options.path),
  };
};

/** The lines of a report file, oldest first. A missing file is no lines. */
export const readReport = (path: string): ReportLine[] =>
  !existsSync(path)
    ? []
    : readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ReportLine);
