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
 * "calls" in the table a count of inference rather than a count of nodes.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { StepAttempt, StepObserver } from "../../../core/step.ts";
import type { Violation } from "../../../core/requirement.ts";

/** Input and output token counts, when the provider layer reported them. */
export type Tokens = { input?: number; output?: number };

/** One leaf call. Exactly one line of `report.jsonl`. */
export type ReportLine = {
  /** The run directory's name. */
  run: string;
  /** The roadmap row, or `roadmap` for the authoring workflow's own leaves. */
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
   * True when more than one row may be in flight, which makes the token
   * columns unattributable. Recorded on every line rather than silently
   * reported.
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

/** One leaf's row of the table. */
export type LeafSummary = {
  step: string;
  /** Model calls, which is attempts, which is NOT the number of nodes run. */
  calls: number;
  /** Distinct (row, step) pairs that reached a model at all. */
  decisions: number;
  /** Decisions accepted on attempt 1, over decisions that were accepted. */
  firstAttempt: number;
  /** Decisions that were never accepted: every attempt was spent. */
  exhausted: number;
  /** Attempts the validator refused. */
  validatorRejections: number;
  /** Attempts a mechanical check refused before a validator was spent. */
  mechanicalFailures: number;
  /** Attempts whose provider call threw. */
  errors: number;
  input?: number;
  output?: number;
};

const add = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/**
 * The table, one row per leaf.
 *
 * A "decision" is one (row, step) pair that reached a model — the unit the
 * first-attempt rate is over. The number of CALLS is higher whenever an attempt
 * was refused, and that gap is the thing worth reading: it is what the
 * validator and the mechanical checks cost, in inference, to keep the graph
 * honest.
 */
export const summarize = (lines: readonly ReportLine[]): LeafSummary[] => {
  const byStep = new Map<string, LeafSummary>();
  /** Attempts per (row, step), so a decision is counted once. */
  const attempts = new Map<string, ReportLine[]>();

  for (const line of lines) {
    const summary = byStep.get(line.step) ?? {
      step: line.step,
      calls: 0,
      decisions: 0,
      firstAttempt: 0,
      exhausted: 0,
      validatorRejections: 0,
      mechanicalFailures: 0,
      errors: 0,
    };
    summary.calls += 1;
    if (line.verdict === "fail" || (line.verdict === "pass" && line.violations.length > 0)) {
      summary.validatorRejections += 1;
    }
    if (line.mechanical.length > 0) summary.mechanicalFailures += 1;
    if (line.error !== undefined) summary.errors += 1;
    summary.input = add(summary.input, add(line.workerTokens?.input, line.validatorTokens?.input));
    summary.output = add(summary.output, add(line.workerTokens?.output, line.validatorTokens?.output));
    byStep.set(line.step, summary);

    const key = `${line.row} ${line.step}`;
    attempts.set(key, [...(attempts.get(key) ?? []), line]);
  }

  for (const [key, group] of attempts) {
    const step = key.split(" ")[1] as string;
    const summary = byStep.get(step);
    if (summary === undefined) continue;
    summary.decisions += 1;
    const accepted = group.find((l) => l.accepted);
    if (accepted === undefined) summary.exhausted += 1;
    else if (accepted.attempt === 1) summary.firstAttempt += 1;
  }

  return [...byStep.values()].sort((a, b) => (a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
};

const pad = (text: string, width: number): string => text.padEnd(width);
const padStart = (text: string, width: number): string => text.padStart(width);

/** The table as text, for a terminal. */
export const renderTable = (rows: readonly LeafSummary[]): string => {
  if (rows.length === 0) return "(no leaf calls recorded)";

  const headers = ["leaf", "calls", "decided", "1st-try", "exhausted", "rejected", "mech", "err", "in", "out"];
  const body = rows.map((r) => [
    r.step,
    String(r.calls),
    String(r.decisions),
    r.decisions === 0 ? "-" : `${r.firstAttempt}/${r.decisions}`,
    String(r.exhausted),
    String(r.validatorRejections),
    String(r.mechanicalFailures),
    String(r.errors),
    r.input === undefined ? "-" : String(r.input),
    r.output === undefined ? "-" : String(r.output),
  ]);

  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      decisions: acc.decisions + r.decisions,
      firstAttempt: acc.firstAttempt + r.firstAttempt,
      exhausted: acc.exhausted + r.exhausted,
      rejected: acc.rejected + r.validatorRejections,
      mechanical: acc.mechanical + r.mechanicalFailures,
      errors: acc.errors + r.errors,
      input: add(acc.input, r.input),
      output: add(acc.output, r.output),
    }),
    {
      calls: 0,
      decisions: 0,
      firstAttempt: 0,
      exhausted: 0,
      rejected: 0,
      mechanical: 0,
      errors: 0,
      input: undefined as number | undefined,
      output: undefined as number | undefined,
    },
  );

  const totalRow = [
    "TOTAL",
    String(totals.calls),
    String(totals.decisions),
    totals.decisions === 0 ? "-" : `${totals.firstAttempt}/${totals.decisions}`,
    String(totals.exhausted),
    String(totals.rejected),
    String(totals.mechanical),
    String(totals.errors),
    totals.input === undefined ? "-" : String(totals.input),
    totals.output === undefined ? "-" : String(totals.output),
  ];

  const all = [headers, ...body, totalRow];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((cell, i) => (i === 0 ? pad(cell, widths[i] as number) : padStart(cell, widths[i] as number))).join("  ");

  return [
    line(headers),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...body.map(line),
    widths.map((w) => "-".repeat(w)).join("  "),
    line(totalRow),
  ].join("\n");
};
