/**
 * The cheapest guardrail: did the model quote its input verbatim, or did it
 * paraphrase? A paraphrase is an unanchored claim. Runs with no model.
 */

import type { Requirement, Violation } from "../core/requirement.ts";

/**
 * Builds a `Requirement.check` asserting that `quote(ctx)` appears verbatim
 * inside `source(ctx)`. An empty quote is a violation: an empty string is a
 * substring of everything, so it would otherwise pass vacuously.
 */
export const verbatim =
  <Ctx>(requirementId: string, source: (ctx: Ctx) => string, quote: (ctx: Ctx) => string) =>
  (ctx: Ctx): Violation | null => {
    const q = quote(ctx);
    if (q.length === 0) return { requirementId, evidence: "<empty quote>" };
    return source(ctx).includes(q) ? null : { requirementId, evidence: q };
  };

/** Convenience: a whole Requirement row whose only check is a verbatim anchor. */
export const verbatimRequirement = <Ctx>(row: {
  id: string;
  sourceId: string;
  text: string;
  decisions: readonly string[];
  source: (ctx: Ctx) => string;
  quote: (ctx: Ctx) => string;
}): Requirement<Ctx> => ({
  id: row.id,
  sourceId: row.sourceId,
  text: row.text,
  decisions: row.decisions,
  check: verbatim(row.id, row.source, row.quote),
});
