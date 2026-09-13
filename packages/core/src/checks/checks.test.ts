import { describe, expect, test } from "bun:test";
import { enumMember } from "./enum-member.ts";
import { filterKnown, idInSet, idsInSet } from "./id-in-set.ts";
import { verbatim, verbatimRequirement } from "./verbatim.ts";

type Ctx = { source: string; quote: string; ids: string[] };
const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  source: "the quick brown fox",
  quote: "quick brown",
  ids: ["a", "b"],
  ...over,
});

const check = verbatim<Ctx>("r.verbatim", (c) => c.source, (c) => c.quote);

describe("verbatim", () => {
  test("a verbatim substring passes", () => expect(check(ctx())).toBeNull());

  test("a paraphrase is a violation, and the paraphrase is the evidence", () =>
    expect(check(ctx({ quote: "a fast brown fox" }))).toEqual({
      requirementId: "r.verbatim",
      evidence: "a fast brown fox",
    }));

  test("an empty quote is a violation, not a vacuous pass", () =>
    // "" is a substring of everything, so a naive includes() would pass here.
    expect(check(ctx({ quote: "" }))).toEqual({
      requirementId: "r.verbatim",
      evidence: "<empty quote>",
    }));

  test("verbatimRequirement builds a Requirement whose check is the same predicate", () => {
    const row = verbatimRequirement<Ctx>({
      id: "r.verbatim",
      sourceId: "src",
      text: "Quote verbatim.",
      decisions: ["yes", "no"],
      source: (c) => c.source,
      quote: (c) => c.quote,
    });
    expect(row.check?.(ctx())).toBeNull();
    expect(row.check?.(ctx({ quote: "nope" }))?.requirementId).toBe("r.verbatim");
  });
});

describe("enumMember", () => {
  const inLanes = enumMember<Ctx>("r.enum", ["needed", "not-needed"], (c) => c.quote);
  test("a member passes", () => expect(inLanes(ctx({ quote: "needed" }))).toBeNull());
  test("a non-member is a violation", () =>
    expect(inLanes(ctx({ quote: "maybe" }))).toEqual({ requirementId: "r.enum", evidence: "maybe" }));
});

describe("idInSet", () => {
  test("every cited id existing passes", () =>
    expect(idsInSet<Ctx>("r.ids", ["a", "b", "c"], (c) => c.ids)(ctx())).toBeNull());

  test("the first invented id is the evidence", () =>
    expect(idsInSet<Ctx>("r.ids", ["a"], (c) => c.ids)(ctx({ ids: ["a", "ghost", "phantom"] }))).toEqual({
      requirementId: "r.ids",
      evidence: "ghost",
    }));

  test("the single-id form agrees with the plural form", () =>
    expect(idInSet<Ctx>("r.ids", ["a"], (c) => c.quote)(ctx({ quote: "z" }))).toEqual({
      requirementId: "r.ids",
      evidence: "z",
    }));

  test("filterKnown keeps only ids in the set, preserving order", () =>
    expect(
      filterKnown(
        [{ id: "a" }, { id: "ghost" }, { id: "b" }],
        new Set(["a", "b"]),
        (i) => i.id,
      ),
    ).toEqual([{ id: "a" }, { id: "b" }]));
});
