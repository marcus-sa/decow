/**
 * The structural layer against a fixture (ai-vcs.md § 4.1).
 *
 * What the registry above it needs from a parser is exactly four things per
 * symbol: what kind it is, what it is called, what holds it, and where it
 * starts and ends. These tests assert those four and the content hash, and
 * they assert the one property the write path depends on: editing one symbol
 * changes that symbol's hash and the hash of whatever holds it, and nothing
 * else's.
 */

import { describe, expect, test } from "bun:test";
import { contentHash, identityKey } from "./parser.ts";
import { treeSitterTypeScript } from "./typescript.ts";

const parser = treeSitterTypeScript();

const FIXTURE = `import { z } from "zod";
import type { Thing } from "./thing.ts";

export function alpha(a: number): string {
  return String(a);
}

export class Bravo {
  private seed = 1;
  charlie(): void {}
  static delta(): number {
    return 2;
  }
}

export interface Echo {
  k: string;
}

export type Foxtrot = { a: 1 };

export enum Golf {
  A,
  B,
}

export const hotel = 1;
const india = 2;

describe("outer", () => {
  test("first", () => {});
  describe("inner", () => {
    it("second", () => {});
  });
});

test("top level", () => {});
`;

/** `kind name` under its container, for readable assertions. */
const shape = (source: string) =>
  parser.symbols(source).map((s) => `${s.kind} ${[...s.container, s.name].join(">")}`);

const byName = (source: string, name: string) => {
  const found = parser.symbols(source).find((s) => s.name === name);
  if (found === undefined) throw new Error(`fixture has no symbol named ${name}`);
  return found;
};

describe("tree-sitter TypeScript inventory", () => {
  test("every kind the registry can address is recognised, with its container path", () => {
    expect(shape(FIXTURE)).toEqual([
      "function alpha",
      "class Bravo",
      "method Bravo>charlie",
      "method Bravo>delta",
      "interface Echo",
      "type-alias Foxtrot",
      "enum Golf",
      "variable hotel",
      "variable india",
      "test outer>first",
      "test outer>inner>second",
      "test top level",
    ]);
  });

  test("a symbol's range is the whole declaration, export keyword included", () => {
    const alpha = byName(FIXTURE, "alpha");
    expect(FIXTURE.slice(alpha.start, alpha.end)).toBe(
      "export function alpha(a: number): string {\n  return String(a);\n}",
    );

    // The name token is addressed separately, because that is what a declared
    // rename splices and the declaration is what a body replacement splices.
    expect(FIXTURE.slice(alpha.nameStart, alpha.nameEnd)).toBe("alpha");
  });

  test("a test's name is the string it was called with, and its range is the call", () => {
    const second = byName(FIXTURE, "second");
    expect(second.container).toEqual(["outer", "inner"]);
    expect(FIXTURE.slice(second.start, second.end)).toBe('it("second", () => {})');
    // The name range is the label inside the quotes, so renaming a test leaves
    // the quoting alone.
    expect(FIXTURE.slice(second.nameStart, second.nameEnd)).toBe("second");
  });

  test("the content hash is sha256 of the symbol's own text", () => {
    const bravo = byName(FIXTURE, "Bravo");
    expect(bravo.contentHash).toBe(contentHash(FIXTURE.slice(bravo.start, bravo.end)));
  });

  test("editing one symbol changes its hash and its container's, and nothing else's", () => {
    const before = parser.symbols(FIXTURE);
    const charlie = byName(FIXTURE, "charlie");
    const edited =
      FIXTURE.slice(0, charlie.start) + "charlie(): void {\n    return;\n  }" + FIXTURE.slice(charlie.end);
    const after = parser.symbols(edited);

    const hashes = (list: typeof before) => new Map(list.map((s) => [identityKey(s), s.contentHash]));
    const [a, b] = [hashes(before), hashes(after)];
    const changed = [...a.keys()].filter((k) => a.get(k) !== b.get(k)).sort();

    // The class's text genuinely changed, because the method is inside it.
    // Saying only the method changed would be the lie.
    expect(changed).toEqual(["class::Bravo", "method:Bravo:charlie"]);
  });

  test("identity is kind, container and name, and never the content", () => {
    const charlie = byName(FIXTURE, "charlie");
    expect(identityKey(charlie)).toBe("method:Bravo:charlie");
    const rewritten = { ...charlie, contentHash: "a completely different body" };
    expect(identityKey(rewritten)).toBe("method:Bravo:charlie");
  });

  test("a function body holds no symbols, which is what keeps a body rewrite legal", () => {
    // The real-tool test found this. Inventorying locals made every edit that
    // introduced one a change to the file's identity set, so the structural
    // stage refused body rewrites that were perfectly fine. The registry
    // addresses what a lease can be taken on; a local is not that.
    const source = `export function outer(): number {
  const local = 1;
  function inner(): number {
    return local;
  }
  return inner();
}
`;
    expect(shape(source)).toEqual(["function outer"]);
  });

  test("a class body does hold symbols, because its methods are addressable", () => {
    const source = `export class Holder {
  private seed = 1;
  get value(): number {
    const doubled = this.seed * 2;
    return doubled;
  }
}
`;
    expect(shape(source)).toEqual(["class Holder", "method Holder>value"]);
  });

  test("imports are reported verbatim, relative and bare alike", () => {
    expect(parser.imports(FIXTURE)).toEqual(["zod", "./thing.ts"]);
  });

  test("a broken edit does not parse, which is the free verification stage", () => {
    expect(parser.parses(FIXTURE)).toBe(true);
    expect(parser.parses("export function alpha( {")).toBe(false);
  });

  test("offsets address the source string, so a non-ASCII file splices exactly", () => {
    const source = 'const prefix = "日本語";\nexport function after(): void {}\n';
    const after = byName(source, "after");
    expect(source.slice(after.start, after.end)).toBe("export function after(): void {}");
  });
});
