/**
 * The oracle: locate this step's acceptance tests, and activate them.
 *
 * nWave's discipline is that DISTILL pre-authors the acceptance-test bodies
 * with a pending marker and DELIVER activates them. So the node ahead of RED
 * is LOCATE-AND-ACTIVATE, not author: a roadmap row carries acceptance
 * obligations, each optionally naming where its assertion lives, and the
 * oracle resolves those locators against the VCS symbol inventory. All found
 * is `located`; any missing is `missing-at`, which goes to a person.
 *
 * It is not a leaf. Resolving a locator is a lookup and stripping a marker is
 * a string operation; neither is a judgement, and a model asked to do either
 * could get it wrong in a way nothing downstream would catch.
 *
 * THE PENDING-MARKER CONVENTION, for this repo's TypeScript tests:
 *
 *     test.skip("…", () => { … })    is pending
 *     test("…", () => { … })         is active
 *
 * and the same for `it`, and for `todo` as well as `skip`. Activating strips
 * the modifier and changes nothing else.
 *
 * That convention is chosen because it is the one the language already has,
 * and because it is IDENTITY-PRESERVING: a symbol's identity is
 * `(kind, container, name)`, a modifier is none of those, so the strip is a
 * body edit rather than a rename. That is what lets the activation go through
 * the VCS write path at all — an undeclared identity change is refused there
 * as a contract violation, and `replaceSymbolBody` declares no change.
 *
 * The inventory is reached through a narrow read port rather than the VCS
 * itself, so this module imports no database, no parser and no filesystem: the
 * graph needs the type and the pure functions, and a walk of the graph must
 * not drag a native dependency behind it. The VCS-backed implementation lives
 * with the composition, in `./pipeline.ts`.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

/** A test symbol an oracle locator resolved to, as the write path needs it. */
export type TestSymbol = {
  /** The symbol id, stable across renames and moves. */
  id: string;
  /** The version a `replace-symbol` must claim to edit it. */
  version: number;
  /** Its current text, which is what a marker is stripped from. */
  body: string;
};

/**
 * Resolve an oracle locator to the test symbol it names, or nothing.
 *
 * A locator is `path::name` or a bare `name`. A bare name that matches more
 * than one test resolves to NOTHING rather than to the first: an ambiguous
 * locator names nothing in particular, and guessing would activate a test the
 * roadmap did not mean.
 */
export type OracleIndex = { locate(locator: string): Promise<TestSymbol | undefined> };

/** The separator a `path::name` locator uses. Shared with the design sources. */
export const LOCATOR_SEPARATOR = "::";

/** A locator, split into the file part (if any) and the test name. */
export const parseLocator = (locator: string): { path?: string; name: string } => {
  const at = locator.indexOf(LOCATOR_SEPARATOR);
  if (at < 0) return { name: locator.trim() };
  return {
    path: locator.slice(0, at).trim(),
    name: locator.slice(at + LOCATOR_SEPARATOR.length).trim(),
  };
};

/** The call forms a pending acceptance test may be written in. */
export const PENDING_MARKERS = ["test.skip(", "test.todo(", "it.skip(", "it.todo("] as const;

/** The active form each pending marker becomes. */
const ACTIVATED: Record<(typeof PENDING_MARKERS)[number], string> = {
  "test.skip(": "test(",
  "test.todo(": "test(",
  "it.skip(": "it(",
  "it.todo(": "it(",
};

/** The marker this body carries, if any. */
export const pendingMarker = (body: string): (typeof PENDING_MARKERS)[number] | undefined =>
  PENDING_MARKERS.find((marker) => body.trimStart().startsWith(marker));

/**
 * The body with its pending marker stripped, or `undefined` when there is no
 * marker to strip.
 *
 * `undefined` is the useful answer rather than the body unchanged: a test
 * somebody already activated needs no activation, and emitting a write that
 * replaces a body with itself would spend a lease and a verification pass to
 * change nothing.
 *
 * Only the leading call is rewritten. A `test.skip` elsewhere in the body is
 * some other test's marker, or a string, and neither is this one's.
 */
export const stripPendingMarker = (body: string): string | undefined => {
  const marker = pendingMarker(body);
  if (marker === undefined) return undefined;
  const at = body.indexOf(marker);
  return body.slice(0, at) + ACTIVATED[marker] + body.slice(at + marker.length);
};

/** One obligation's resolution: the test it names, or the fact that it names none. */
export type Resolution =
  | { obligationId: string; outcome: "located"; test: TestSymbol }
  | { obligationId: string; outcome: "missing"; locator?: string };

/** One acceptance obligation, as much of it as the oracle reads. */
export type Obligation = { id: string; oracleLocator?: string };

/**
 * Resolve every obligation, in order. An obligation with no locator is missing
 * by definition: there is nothing to look for, which is the normal state of a
 * roadmap authored before its tests were written.
 */
export const resolveObligations = async (
  index: OracleIndex,
  obligations: readonly Obligation[],
): Promise<Resolution[]> => {
  const out: Resolution[] = [];
  for (const obligation of obligations) {
    if (obligation.oracleLocator === undefined || obligation.oracleLocator.trim() === "") {
      out.push({ obligationId: obligation.id, outcome: "missing" });
      continue;
    }
    const test = await index.locate(obligation.oracleLocator);
    out.push(
      test === undefined
        ? { obligationId: obligation.id, outcome: "missing", locator: obligation.oracleLocator }
        : { obligationId: obligation.id, outcome: "located", test },
    );
  }
  return out;
};
