/**
 * The structural layer's contract (ai-vcs.md § 4.1).
 *
 * A parser answers three questions about one source file and nothing else:
 * what symbols exist in it, where each one starts and ends, and what the hash
 * of each one's text is. No type information, no cross-file resolution, no
 * language server. That is what keeps this layer fast enough to sit inside the
 * write path.
 *
 * The interface is here and the tree-sitter TypeScript implementation is in
 * `./typescript.ts`, so a second grammar is a second file rather than an edit
 * to the registry.
 *
 * Offsets are indices into the JavaScript source string, not UTF-8 byte
 * offsets. tree-sitter's Node bindings report UTF-16 code units, which is what
 * `String.prototype.slice` takes, so a splice is exact for non-ASCII source.
 * The document says "byte range"; this is the same range, in the unit the
 * runtime actually addresses.
 */

import { createHash } from "node:crypto";

/**
 * The kinds the registry distinguishes. `test` is the document's `Test`
 * (§ 6.2 "Test identity"): a test is a symbol like any other, so it gets a
 * stable id, a version, and a place in the event log for free.
 */
export const SYMBOL_KINDS = [
  "function",
  "class",
  "method",
  "interface",
  "type-alias",
  "enum",
  "variable",
  "test",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/**
 * One symbol as observed in a file. This is *observation*, not identity: the
 * registry assigns the opaque id, and it does so from `identityKey` plus the
 * file, never from `contentHash` (§ 3.2, § 9.1).
 */
export type ObservedSymbol = {
  kind: SymbolKind;
  name: string;
  /** The enclosing symbols, outermost first. `["Foo"]` for a method of `Foo`. */
  container: readonly string[];
  /** Start offset of the whole symbol, inclusive. */
  start: number;
  /** End offset of the whole symbol, exclusive. */
  end: number;
  /** The name token's own range, which is what a declared rename splices. */
  nameStart: number;
  nameEnd: number;
  /** sha256 of `source.slice(start, end)`. */
  contentHash: string;
};

export interface Parser {
  /** Reported on every event this parser's observations produce. */
  readonly language: string;
  /** Symbols in declaration order, an enclosing symbol before the ones it holds. */
  symbols(source: string): ObservedSymbol[];
  /** Module specifiers this source imports, verbatim and in order. */
  imports(source: string): string[];
  /**
   * Did this source parse cleanly? The cheapest verification stage (§ 6.1),
   * and the only free one. tree-sitter is error-tolerant by design, so "a tree
   * came back" is not the signal; "the tree holds no ERROR and no MISSING
   * node" is.
   */
  parses(source: string): boolean;
}

/**
 * A symbol's identity within its file: its kind, where it sits, and what it is
 * called. Never its content.
 *
 * This is the whole of "identity is never inferred from structure". Two
 * symbols with the same identity key in the same file across two observations
 * are the same symbol. A key that disappears is a symbol that disappeared, and
 * the only thing that makes that anything other than a desync is a declared
 * delete, rename or move (§ 9.1).
 */
export const identityKey = (symbol: Pick<ObservedSymbol, "kind" | "name" | "container">): string =>
  `${symbol.kind}:${symbol.container.join(">")}:${symbol.name}`;

export const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
