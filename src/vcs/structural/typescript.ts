/**
 * The tree-sitter TypeScript parser (ai-vcs.md § 4.1).
 *
 * Native `tree-sitter` plus `tree-sitter-typescript`, not `web-tree-sitter`
 * plus wasm grammars. Both were tried under bun; the wasm pair fails to load
 * because the published grammar wasm and the current `web-tree-sitter` runtime
 * disagree on the dylink ABI. The native bindings ship prebuilt binaries for
 * every platform this runs on, parse synchronously, and need no init step, so
 * a parse can happen inside the write path without an await.
 *
 * Recognised, which is the set the registry can address:
 *
 *   function            function / generator declarations, at any depth
 *   class               class and abstract class declarations
 *   method              method definitions inside a class body
 *   interface           interface declarations
 *   type-alias          type alias declarations
 *   enum                enum declarations
 *   variable            const / let / var declarators
 *   test                a `test(...)` or `it(...)` call whose first argument is
 *                       a string literal, named by that string. A modifier —
 *                       `test.skip`, `test.todo`, `test.only`, `test.failing`
 *                       — is the same test, marked; identity is
 *                       (kind, container, name) and a modifier is none of
 *                       those, which is what makes stripping a pending marker
 *                       a body edit rather than a rename
 *
 * A `describe(...)` call is not a symbol. It contributes its string argument to
 * the container path of the tests inside it, which is what makes two tests
 * called "commits" in two different describes two different symbols.
 *
 * The walk stops at a function-like symbol rather than descending into it: a
 * function's body is its *content*, not a container of separately addressable
 * symbols. A class body is descended, because its methods are addressable.
 *
 * That boundary is load-bearing rather than tidy, and the real-tool test is
 * what found it. Descending into function bodies made every local `const` a
 * tracked symbol, so replacing a body with one that introduced a local changed
 * the file's identity set, and the structural stage correctly refused an edit
 * that was perfectly fine. The registry addresses what a lease can be taken on
 * and a version can be bumped for; a local is neither.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date, no randomUUID. src/harness/no-nondeterminism.test.ts enforces that
 * mechanically.
 */

import TSParser from "tree-sitter";
import TypeScriptGrammar from "tree-sitter-typescript";
import { contentHash, type ObservedSymbol, type Parser, type SymbolKind } from "./parser.ts";

type Node = TSParser.SyntaxNode;

/**
 * Kinds whose body holds further addressable symbols. Only a class does: its
 * methods are leasable and versionable in their own right.
 */
const DESCENDED: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["class"]);

/** Declaration node type to the kind the registry stores. */
const DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  interface_declaration: "interface",
  type_alias_declaration: "type-alias",
  enum_declaration: "enum",
};

/** Calls that define a test, by the name they are called with. */
const TEST_CALLEES = new Set(["test", "it"]);
const GROUP_CALLEES = new Set(["describe", "suite"]);

/**
 * Modifiers a test or group call may carry: `test.skip("…")` is the same test
 * as `test("…")`, marked pending.
 *
 * The identity that falls out of this is load-bearing rather than tidy.
 * Identity is `(kind, container, name)` and a modifier is none of those, so
 * stripping a pending marker is a body edit and NOT a rename — which is
 * exactly what lets an acceptance test be activated through the write path,
 * where an undeclared identity change is refused as a contract violation.
 * Without this, `test.skip` would not be a test at all, activating one would
 * ADD an identity the edit did not declare, and the gate would correctly
 * refuse a perfectly good activation.
 */
const CALL_MODIFIERS = new Set(["skip", "todo", "only", "failing"]);

/** `export function f() {}` is one symbol whose span includes the keyword. */
const unwrapExport = (node: Node): Node =>
  node.type === "export_statement" ? (node.childForFieldName("declaration") ?? node) : node;

/**
 * The name a call is made under, ignoring a modifier: `test` for both
 * `test(…)` and `test.skip(…)`. Anything else — a call on an unknown property,
 * a call on an expression — is not a labelled call.
 */
const calleeName = (callee: Node): string | undefined => {
  if (callee.type === "identifier") return callee.text;
  if (callee.type !== "member_expression") return undefined;
  const object = callee.childForFieldName("object");
  const property = callee.childForFieldName("property");
  if (object === null || object.type !== "identifier") return undefined;
  if (property === null || !CALL_MODIFIERS.has(property.text)) return undefined;
  return object.text;
};

/** The string a `test("…", fn)` / `describe("…", fn)` call was given, if any. */
const callLabel = (call: Node): { callee: string; label: string } | undefined => {
  const callee = call.childForFieldName("function");
  const name = callee === null ? undefined : calleeName(callee);
  if (name === undefined) return undefined;
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  if (first === undefined || first.type !== "string") return undefined;
  // A `string` node's named children are its fragments and escapes; the text
  // between the quotes is what the call was labelled with.
  return { callee: name, label: first.text.slice(1, -1) };
};

/**
 * `nameStart` / `nameEnd` address the name *token*, which for a test is the
 * text between the quotes rather than the string literal, so a declared rename
 * splices the label and leaves the quoting alone.
 */
const emit = (
  out: ObservedSymbol[],
  source: string,
  kind: SymbolKind,
  name: { text: string; start: number; end: number },
  span: Node,
  container: readonly string[],
): void => {
  out.push({
    kind,
    name: name.text,
    container: [...container],
    start: span.startIndex,
    end: span.endIndex,
    nameStart: name.start,
    nameEnd: name.end,
    contentHash: contentHash(source.slice(span.startIndex, span.endIndex)),
  });
};

const identifierName = (node: Node) => ({ text: node.text, start: node.startIndex, end: node.endIndex });

/** The label inside a string literal's quotes. */
const literalName = (node: Node) => ({
  text: node.text.slice(1, -1),
  start: node.startIndex + 1,
  end: node.endIndex - 1,
});

/**
 * A `const a = 1, b = 2;` statement holds two symbols whose spans would
 * otherwise overlap, so a multi-declarator statement gives each declarator its
 * own span and the single-declarator case keeps the whole statement. The
 * common case is the one a rewrite has to be able to replace wholesale.
 */
const collectVariables = (out: ObservedSymbol[], source: string, decl: Node, span: Node, container: readonly string[]): void => {
  const declarators = decl.namedChildren.filter((c) => c.type === "variable_declarator");
  for (const declarator of declarators) {
    const name = declarator.childForFieldName("name");
    if (name === null || name.type !== "identifier") continue;
    emit(out, source, "variable", identifierName(name), declarators.length === 1 ? span : declarator, container);
  }
};

/**
 * One pass over the tree. Every node either declares a symbol (emit, then
 * descend with the symbol's name appended to the container), groups tests
 * (descend with the label appended), defines a test (emit, do not descend), or
 * is structure (descend unchanged).
 */
const collect = (out: ObservedSymbol[], source: string, node: Node, container: readonly string[]): void => {
  for (const child of node.namedChildren) {
    const decl = unwrapExport(child);
    const kind = DECLARATION_KINDS[decl.type];

    if (kind !== undefined) {
      const name = decl.childForFieldName("name");
      if (name !== null) {
        emit(out, source, kind, identifierName(name), child, container);
        if (DESCENDED.has(kind)) collect(out, source, decl, [...container, name.text]);
        continue;
      }
    }

    if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      collectVariables(out, source, decl, child, container);
      continue;
    }

    if (decl.type === "call_expression") {
      const call = callLabel(decl);
      if (call !== undefined && TEST_CALLEES.has(call.callee)) {
        const label = decl.childForFieldName("arguments")?.namedChildren[0];
        if (label !== undefined) {
          emit(out, source, "test", literalName(label), child, container);
          continue;
        }
      }
      if (call !== undefined && GROUP_CALLEES.has(call.callee)) {
        collect(out, source, decl, [...container, call.label]);
        continue;
      }
    }

    collect(out, source, decl, container);
  }
};

const importSpecifiers = (root: Node, out: string[]): void => {
  for (const child of root.namedChildren) {
    if (child.type === "import_statement" || child.type === "export_statement") {
      const source = child.childForFieldName("source");
      if (source !== null && source.type === "string") out.push(source.text.slice(1, -1));
    }
    if (child.type === "ambient_declaration") importSpecifiers(child, out);
  }
};

/**
 * A parser bound to one grammar. `tsx` parses the same language with JSX
 * enabled; `typescript` is the default because this repo has no JSX.
 */
export const treeSitterTypeScript = (dialect: "typescript" | "tsx" = "typescript"): Parser => {
  const parser = new TSParser();
  parser.setLanguage(TypeScriptGrammar[dialect] as unknown as TSParser.Language);

  return {
    language: `typescript:${dialect}`,
    symbols(source) {
      const out: ObservedSymbol[] = [];
      collect(out, source, parser.parse(source).rootNode, []);
      return out;
    },
    imports(source) {
      const out: string[] = [];
      importSpecifiers(parser.parse(source).rootNode, out);
      return out;
    },
    parses(source) {
      return !parser.parse(source).rootNode.hasError;
    },
  };
};
