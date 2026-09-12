/**
 * Does an id the model cited actually exist? A plausible-sounding answer with
 * an invented foreign key is the most common grounding failure, and it costs
 * nothing to catch.
 *
 * `runStep` applies the same idea to the validator itself: cited requirement
 * ids outside the step's requirement set are dropped as noise rather than
 * treated as rejections.
 */

import type { Violation } from "../core/requirement.ts";

/** Every cited id must be in `known`; the first stray id is the evidence. */
export const idsInSet =
  <Ctx>(requirementId: string, known: Iterable<string>, cited: (ctx: Ctx) => readonly string[]) =>
  (ctx: Ctx): Violation | null => {
    const set = new Set(known);
    const stray = cited(ctx).find((id) => !set.has(id));
    return stray === undefined ? null : { requirementId, evidence: stray };
  };

/** Single-id form of `idsInSet`. */
export const idInSet = <Ctx>(requirementId: string, known: Iterable<string>, cited: (ctx: Ctx) => string) =>
  idsInSet<Ctx>(requirementId, known, (ctx) => [cited(ctx)]);

/** Keep only the ids that exist. Used by `runStep` guardrail 6. */
export const filterKnown = <T>(items: readonly T[], known: Set<string>, id: (item: T) => string): T[] =>
  items.filter((item) => known.has(id(item)));
