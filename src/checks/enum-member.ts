/**
 * Did the model return a value inside the closed decision space the
 * requirement declares? The schema already enforces this for `decision`; this
 * check covers payload fields whose value space is closed but whose schema is
 * a string, and it is the check the authoring workflow runs against a
 * requirement row's `decisions` column.
 */

import type { Violation } from "../core/requirement.ts";

export const enumMember =
  <Ctx>(requirementId: string, allowed: readonly string[], value: (ctx: Ctx) => string) =>
  (ctx: Ctx): Violation | null => {
    const v = value(ctx);
    return allowed.includes(v) ? null : { requirementId, evidence: v };
  };
