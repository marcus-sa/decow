/**
 * `validate-manifest`, as a pure function. No model.
 *
 * This is `des distill`'s whole contract. That step is PROVIDER-FREE: it takes
 * a JSON manifest of acceptance facts, validates it against a closed rule set,
 * renders a brief, and persists the facts into the handover. It buys no model
 * turn and it writes no test. The only reason a model appears in this wave at
 * all is that something has to PROPOSE the manifest; everything that decides
 * whether the proposal is admissible is here, and none of it is a judgement.
 *
 * The rules are nwave-experimental's, from
 * `des/domain/distill_document.py` plus the join in
 * `des/application/delivery_steps.py`. Fourteen of them are checked there; a
 * few have no analogue here because a typed schema makes them
 * UNREPRESENTABLE rather than merely invalid, and saying which is more honest
 * than counting to fourteen:
 *
 *   `schema_version` is exactly 1              the type IS the version
 *   the top level has exactly two keys         the type has exactly its fields
 *   `acceptance_supports` is an array          `z.array` already said so
 *
 * What is left is checked, and each is a NAMED defect rather than a boolean,
 * for the same reason `shape.ts`'s are: the defects are the feedback the
 * proposing leaf reads on the next iteration, and "invalid" tells a model
 * nothing it can act on.
 *
 *   no-values                 the manifest proposes nothing
 *   unknown-observation       a value names an observation the roadmap does not
 *   duplicate-observation     two values claim one observation
 *   uncovered-value           a roadmap step no value speaks for
 *   no-obligations            a value that must satisfy nothing
 *   duplicate-obligation-id   two obligations of one value claim one id
 *   blank-field               an observation, id, stimulus or expected that is
 *                             empty or whitespace
 *   oracle-not-a-locator      the oracle is not a safe repository-relative
 *                             locator
 *   support-not-a-whole-file  a support is not a safe repository-relative
 *                             whole-FILE path
 *   support-is-the-oracle     a support names the oracle's own file
 *   support-ignored           a support this repository ignores, which makes
 *                             it a generated artifact rather than evidence
 *                             reproducible from the commit
 *
 * `uncovered-value` is ours rather than nwave's, and the difference is
 * structural: `des distill` MERGES a partial manifest into a stored graph that
 * may already carry facts for the rest, so a value it says nothing about keeps
 * what it had. This wave runs once per roadmap and has nothing to merge with,
 * so a step no value speaks for would reach DELIVER with no oracle at all.
 *
 * `support-ignored` is the one rule that cannot be answered from the manifest
 * and the roadmap alone — it is a question about the repository — so the
 * predicate is injected. Everything else is a function of its two arguments.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { parseOracleLocator } from "@des/core/vcs/verify";
import type { AcceptanceObligation, Roadmap } from "../roadmap/schema.ts";

/* ---------------------------------------------------------- the manifest */

/** One value's acceptance facts, as a proposal. */
export type ProposedValue = {
  /** Exact-match key into the roadmap. Never an id: nwave keys on the text. */
  observation: string;
  acceptance: AcceptanceObligation[];
  /** `path::selector`, or a bare path. Exactly one per value. */
  oracle: string;
  /** Whole-file paths the oracle depends on. May be empty. */
  supports: string[];
};

export type Manifest = { values: ProposedValue[] };

/* ------------------------------------------------------------- the grammar */

/** A path segment that keeps a locator inside the repository. */
const safeSegment = (segment: string): boolean =>
  segment.length > 0 && segment !== "." && segment !== "..";

/**
 * A safe repository-relative whole-file locator.
 *
 * Relative, with no traversal and no line break. The properties are
 * nwave-experimental's `is_repository_relative_whole_file_locator`; the regex
 * there is elaborate because it also carries a legacy selector dialect, and
 * what it protects is this.
 */
export const isWholeFileLocator = (value: string): boolean => {
  if (value.length === 0 || /[\r\n]/.test(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every(safeSegment);
};

/** A safe oracle locator: a whole-file path, optionally with a selector. */
export const isOracleLocator = (value: string): boolean => {
  if (/[\r\n]/.test(value)) return false;
  const { path, selector } = parseOracleLocator(value);
  return isWholeFileLocator(path) && (selector === undefined || selector.trim().length > 0);
};

/* -------------------------------------------------------------- the defects */

export const MANIFEST_DEFECT_KINDS = [
  "no-values",
  "unknown-observation",
  "duplicate-observation",
  "uncovered-value",
  "no-obligations",
  "duplicate-obligation-id",
  "blank-field",
  "oracle-not-a-locator",
  "support-not-a-whole-file",
  "support-is-the-oracle",
  "support-ignored",
] as const;
export type ManifestDefectKind = (typeof MANIFEST_DEFECT_KINDS)[number];

/**
 * One named defect. Every variant that is about a value names it by its
 * observation, because that is the key the manifest itself is addressed by and
 * the one a proposing model will recognise.
 */
export type ManifestDefect =
  | { kind: "no-values" }
  | { kind: "unknown-observation"; observation: string }
  | { kind: "duplicate-observation"; observation: string }
  | { kind: "uncovered-value"; stepId: string; observation: string }
  | { kind: "no-obligations"; observation: string }
  | { kind: "duplicate-obligation-id"; observation: string; obligationId: string }
  | { kind: "blank-field"; observation: string; field: string }
  | { kind: "oracle-not-a-locator"; observation: string; oracle: string }
  | { kind: "support-not-a-whole-file"; observation: string; support: string }
  | { kind: "support-is-the-oracle"; observation: string; support: string }
  | { kind: "support-ignored"; observation: string; support: string };

/** One defect, rendered for a prompt or a person. */
export const describeManifestDefect = (defect: ManifestDefect): string => {
  const about = "observation" in defect ? ` for "${defect.observation}"` : "";
  switch (defect.kind) {
    case "no-values":
      return "the manifest proposes no values at all";
    case "unknown-observation":
      return `"${defect.observation}" is not an observation this roadmap declares`;
    case "duplicate-observation":
      return `two values claim the observation "${defect.observation}"`;
    case "uncovered-value":
      return `roadmap step ${defect.stepId} has no value in the manifest: "${defect.observation}"`;
    case "no-obligations":
      return `no acceptance obligations${about}; a value that must satisfy nothing is not a value`;
    case "duplicate-obligation-id":
      return `two obligations${about} claim the id ${defect.obligationId}`;
    case "blank-field":
      return `${defect.field} is empty${about}`;
    case "oracle-not-a-locator":
      return `the oracle "${defect.oracle}"${about} is not a safe repository-relative locator`;
    case "support-not-a-whole-file":
      return `the support "${defect.support}"${about} is not a safe repository-relative whole-file path`;
    case "support-is-the-oracle":
      return `the support "${defect.support}"${about} is the oracle's own file`;
    case "support-ignored":
      return (
        `the support "${defect.support}"${about} is ignored by this repository, so it is a ` +
        "generated artifact rather than evidence reproducible from the commit"
      );
  }
};

/* ------------------------------------------------------------ the validator */

export type ValidateSpec = {
  manifest: Manifest;
  /** The roadmap the observations must exist in, by exact match. */
  roadmap: Roadmap;
  /**
   * Does this repository ignore that path? The one rule that is a question
   * about the repository rather than about the manifest, so it is injected —
   * and a caller with nothing to ask answers `false`, which is the honest
   * neutral: an unanswered ignore question is not a defect.
   */
  ignored?: (path: string) => boolean;
};

/** A value's blank fields, in a stable order. */
const blankFields = (value: ProposedValue): string[] => {
  const fields: string[] = [];
  if (value.observation.trim().length === 0) fields.push("observation");
  value.acceptance.forEach((obligation: AcceptanceObligation, at: number) => {
    for (const [name, text] of [
      ["id", obligation.id],
      ["stimulus", obligation.stimulus],
      ["expected", obligation.expected],
    ] as const) {
      if (text.trim().length === 0) fields.push(`obligation ${at}'s ${name}`);
    }
  });
  return fields;
};

/**
 * Every named defect in a proposed manifest, in a stable order. Empty means
 * the manifest is admissible, which is the only thing `manifestVerdict` reads.
 */
export const manifestDefects = (spec: ValidateSpec): ManifestDefect[] => {
  const { values } = spec.manifest;
  if (values.length === 0) return [{ kind: "no-values" }];

  const defects: ManifestDefect[] = [];
  const declared = new Map(spec.roadmap.steps.map((step) => [step.observation, step.id] as const));
  const seen = new Set<string>();

  for (const value of values) {
    const observation = value.observation;
    if (seen.has(observation)) defects.push({ kind: "duplicate-observation", observation });
    seen.add(observation);
    // Exact string match, the way nwave's join reads it. An observation is the
    // key a value is addressed by, so a near miss is a value about something
    // else rather than a typo to be forgiven.
    if (!declared.has(observation)) defects.push({ kind: "unknown-observation", observation });
  }

  for (const step of spec.roadmap.steps) {
    if (!seen.has(step.observation)) {
      defects.push({ kind: "uncovered-value", stepId: step.id, observation: step.observation });
    }
  }

  for (const value of values) {
    const observation = value.observation;
    if (value.acceptance.length === 0) defects.push({ kind: "no-obligations", observation });

    const ids = new Set<string>();
    for (const obligation of value.acceptance) {
      if (ids.has(obligation.id)) {
        defects.push({ kind: "duplicate-obligation-id", observation, obligationId: obligation.id });
      }
      ids.add(obligation.id);
    }

    for (const field of blankFields(value)) defects.push({ kind: "blank-field", observation, field });

    if (!isOracleLocator(value.oracle)) {
      defects.push({ kind: "oracle-not-a-locator", observation, oracle: value.oracle });
    }

    const oraclePath = parseOracleLocator(value.oracle).path;
    for (const support of value.supports) {
      if (!isWholeFileLocator(support)) {
        defects.push({ kind: "support-not-a-whole-file", observation, support });
        continue;
      }
      // The oracle is not its own dependency, and a manifest that said so
      // would make the crafter's wall ambiguous: the oracle is the one path a
      // crafter may not write, and a support is one it may.
      if (support === oraclePath) {
        defects.push({ kind: "support-is-the-oracle", observation, support });
      }
      if (spec.ignored?.(support) === true) {
        defects.push({ kind: "support-ignored", observation, support });
      }
    }
  }

  return defects;
};

/** The first defect of one kind, for a `Requirement.check` bound to one rule. */
export const firstManifestDefectOfKind = (
  spec: ValidateSpec,
  kind: ManifestDefectKind,
): ManifestDefect | undefined => manifestDefects(spec).find((d) => d.kind === kind);

/** What the branch after `validate-manifest` routes on. */
export type ManifestVerdict = "valid" | "invalid";

export const manifestVerdict = (defects: readonly ManifestDefect[]): ManifestVerdict =>
  defects.length === 0 ? "valid" : "invalid";

/**
 * The roadmap with its acceptance facts filled in, which is what `persist`
 * writes. The proposal is joined onto the steps by observation, exactly as
 * nwave's own join does, so a step the manifest says nothing about keeps what
 * it had — and `uncovered-value` is what makes that unreachable here.
 */
export const enrich = (roadmap: Roadmap, manifest: Manifest): Roadmap => {
  const byObservation = new Map(manifest.values.map((value) => [value.observation, value] as const));
  return {
    ...roadmap,
    steps: roadmap.steps.map((step) => {
      const value = byObservation.get(step.observation);
      return value === undefined
        ? step
        : { ...step, acceptance: value.acceptance, oracle: value.oracle, supports: value.supports };
    }),
  };
};
