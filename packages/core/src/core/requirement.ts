/**
 * A requirement is the rule verbatim, a foreign key to its source, the closed
 * decision space it admits, and optionally a mechanical check that runs with
 * no model.
 */

export type Violation = { requirementId: string; evidence: string };

export type Requirement<Ctx = unknown> = {
  /** e.g. "testing.classify.cohort-is-never-expectation" */
  id: string;
  /** FK to the rules row this came from */
  sourceId: string;
  /** the rule, verbatim */
  text: string;
  /** the closed enum a step bound to this rule may return */
  decisions: readonly string[];
  /** deterministic, no LLM */
  check?: (ctx: Ctx) => Violation | null;
};
