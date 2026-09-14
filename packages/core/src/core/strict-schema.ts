/**
 * Whether a schema is one a strict structured-output endpoint can answer —
 * decided when the schema is DEFINED, not when the first call fails.
 *
 * `src/bindings/mastra.ts` puts a step's output schema to an endpoint as
 * `response_format: { type: "json_schema", strict: true, schema }`. Strict mode
 * is not "the schema, but enforced". It is a narrower schema language, and a
 * schema outside it is not refused as a schema: the provider falls back to
 * unconstrained JSON and answers with whatever it felt like, at which point the
 * step's zod re-parse throws about a field the model was never asked for. The
 * failure surfaces three layers from its cause and reads as a bad model.
 *
 * This is that cause, caught at the definition. `stepOutput` and `stepDef`
 * refuse a schema with defects and name them, so a leaf whose output could not
 * be asked for strictly fails at import rather than in a run.
 *
 * ## The rules, and where each one comes from
 *
 * Only rules that can be grounded are checked. Three are OpenAI's documented
 * strict-mode requirements and are what this file exists for; two follow from
 * them; one is zod's own refusal. Keyword restrictions that OpenAI has
 * relaxed over time — `maxLength`, `pattern`, `minItems` and the rest — are
 * NOT checked, because nothing available offline says which of them a strict
 * endpoint rejects today, and a checker that guessed would refuse
 * `z.string().max(600)`, which every `rationale` in this repository uses.
 *
 *   root-is-not-an-object      strict mode's root must be an object
 *   optional-property          every key in `properties` must be in `required`.
 *                              Absence is `z.string().nullable()` — a nullable
 *                              union — never `.optional()`
 *   open-object                every object must carry
 *                              `additionalProperties: false`
 *   object-without-properties  an object that is closed and declares no
 *                              properties can only ever be `{}`; a
 *                              `z.record(...)` becomes exactly that
 *   untyped                    a subschema naming no type, enum, union or
 *                              reference is `{}`, which constrains nothing
 *   unrepresentable            zod itself refuses to convert it. `z.custom()`
 *                              is the one that happens here
 *
 * ## What `strictJsonSchema` is
 *
 * The schema AS THE ENDPOINT RECEIVES IT, which is not the same thing as
 * `z.toJSONSchema(schema)`. Mastra converts at draft-7 with `io: "input"` and
 * inlined reuse, then walks the result closing every object it finds through
 * `properties` and `items` (`@mastra/core`'s
 * `addAdditionalPropertiesToJsonSchema`). Both halves are reproduced here, and
 * `src/bindings/mastra.endpoint.test.ts` asserts that what a real `Agent`
 * sends a real endpoint is byte-identical to what this function returns — so
 * the two cannot drift without a test saying so.
 *
 * The closure is why `open-object` reads as a rule nothing of ours can break:
 * Mastra's walk reaches objects under `properties` and `items` and NOT ones
 * under `anyOf` / `oneOf` / `allOf`, so a union of objects arrives at the
 * endpoint open. That is the case the rule is for, along with any schema this
 * walk is pointed at that did not come from here — the captured wire body in
 * the endpoint test is one.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date.
 */

import { z } from "zod";

/** The six things a schema can be refused for. */
export const STRICT_DEFECT_KINDS = [
  "unrepresentable",
  "root-is-not-an-object",
  "optional-property",
  "open-object",
  "object-without-properties",
  "untyped",
] as const;
export type StrictDefectKind = (typeof STRICT_DEFECT_KINDS)[number];

/**
 * One reason a schema cannot be asked for strictly.
 *
 * `at` is a JSON pointer into the CONVERTED schema rather than a path through
 * the zod source, because the converted schema is what the endpoint reads and
 * a pointer into it is what a reader can check against the request body.
 */
export type StrictDefect = {
  kind: StrictDefectKind;
  /** JSON pointer into the converted schema. `#` is the root. */
  at: string;
  /** What is wrong, and what to write instead. */
  why: string;
};

/** One defect, rendered for a refusal or a person. */
export const describeStrictDefect = (defect: StrictDefect): string =>
  `${defect.at}: ${defect.why}`;

/**
 * What a refusal is. Carries the defects as data so a caller can report them
 * rather than re-parse the message.
 */
export class StrictSchemaError extends Error {
  readonly defects: readonly StrictDefect[];

  constructor(what: string, defects: readonly StrictDefect[]) {
    super(
      `${what} cannot be asked for as strict structured output:\n` +
        defects.map((d) => `- ${describeStrictDefect(d)}`).join("\n"),
    );
    this.name = "StrictSchemaError";
    this.defects = defects;
  }
}

/**
 * The conversion options Mastra uses. Named rather than inlined so the one
 * place they are written is the one place they can change.
 */
const TO_JSON_SCHEMA = { target: "draft-7", io: "input", reused: "inline" } as const;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Mastra's own closure, reproduced: every object reachable through
 * `properties` and `items` gets `additionalProperties: false`. Nothing else is
 * reached, which is the behaviour rather than an omission — see the header.
 */
const close = (value: unknown): unknown => {
  if (!isNode(value)) return value;
  const node: Node = { ...value };
  if (node.type === "object") {
    node.additionalProperties = false;
    if (isNode(node.properties)) {
      node.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, child]) => [key, close(child)]),
      );
    }
  }
  if (node.type === "array" && node.items !== undefined && node.items !== null) {
    node.items = Array.isArray(node.items) ? node.items.map(close) : close(node.items);
  }
  return node;
};

/**
 * A schema as the endpoint receives it: zod's conversion at Mastra's target,
 * with Mastra's object closure applied.
 *
 * Throws whatever zod throws for a construct it cannot represent — `z.custom`
 * is the one in this repository — because a schema that cannot be converted
 * cannot be sent either. `strictSchemaDefects` catches that and reports it as
 * a defect instead.
 */
export const strictJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  close(z.toJSONSchema(schema, TO_JSON_SCHEMA)) as Record<string, unknown>;

/** The types a node names, as a list, so `["string", "null"]` reads like `"string"`. */
const typesOf = (node: Node): string[] => {
  const type = node.type;
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
};

/** Does this node constrain anything at all? */
const constrains = (node: Node): boolean =>
  typesOf(node).length > 0 ||
  node.enum !== undefined ||
  node.const !== undefined ||
  node.$ref !== undefined ||
  Array.isArray(node.anyOf) ||
  Array.isArray(node.oneOf) ||
  Array.isArray(node.allOf);

const walk = (value: unknown, at: string, defects: StrictDefect[]): void => {
  if (!isNode(value)) return;
  const node = value;

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      branches.forEach((branch, i) => walk(branch, `${at}/${key}/${i}`, defects));
    }
  }

  if (typesOf(node).includes("object")) {
    const properties = isNode(node.properties) ? node.properties : undefined;
    const names = Object.keys(properties ?? {});

    if (node.additionalProperties !== false) {
      defects.push({
        kind: "open-object",
        at,
        why:
          "an object must carry `additionalProperties: false`; strict mode refuses one that " +
          "leaves the key space open",
      });
    }

    if (names.length === 0) {
      defects.push({
        kind: "object-without-properties",
        at,
        why:
          "an object that declares no `properties` and admits no others can only ever be `{}`. " +
          "A `z.record(...)` converts to exactly this — name the keys, or carry them as an " +
          "array of `{ key, value }`",
      });
    } else {
      const required = new Set(
        (Array.isArray(node.required) ? node.required : []).filter(
          (name): name is string => typeof name === "string",
        ),
      );
      for (const name of names) {
        if (required.has(name)) continue;
        defects.push({
          kind: "optional-property",
          at: `${at}/properties/${name}`,
          why:
            "every declared property must be in `required`. `.optional()` is what leaves one " +
            "out; write `.nullable()` instead, so absence is a value the model returns rather " +
            "than a key it omits",
        });
      }
    }

    for (const [name, child] of Object.entries(properties ?? {})) {
      walk(child, `${at}/properties/${name}`, defects);
    }
  }

  if (typesOf(node).includes("array") && node.items !== undefined) {
    if (Array.isArray(node.items)) {
      node.items.forEach((item, i) => walk(item, `${at}/items/${i}`, defects));
    } else {
      walk(node.items, `${at}/items`, defects);
    }
  }

  if (!constrains(node)) {
    defects.push({
      kind: "untyped",
      at,
      why:
        "a subschema that names no type, enum, union or reference constrains nothing, and a " +
        "strict endpoint has nothing to generate against",
    });
  }
};

/**
 * Every reason an already-converted JSON Schema cannot be asked for strictly.
 *
 * Separate from `strictSchemaDefects` because the interesting thing to walk is
 * not always a zod schema: the endpoint test walks the body a real `Agent`
 * actually PUT ON THE WIRE, which is the only reading of "the schema we send"
 * that no conversion of ours can flatter.
 */
export const jsonSchemaDefects = (schema: unknown): StrictDefect[] => {
  const defects: StrictDefect[] = [];
  if (!isNode(schema) || !typesOf(schema).includes("object")) {
    defects.push({
      kind: "root-is-not-an-object",
      at: "#",
      why: "strict mode's root must be an object; wrap the value in one",
    });
    return defects;
  }
  walk(schema, "#", defects);
  return defects;
};

/** Every reason a zod schema cannot be asked for strictly. Empty means it can. */
export const strictSchemaDefects = (schema: z.ZodType): StrictDefect[] => {
  let json: Record<string, unknown>;
  try {
    json = strictJsonSchema(schema);
  } catch (error) {
    return [
      {
        kind: "unrepresentable",
        at: "#",
        why:
          `zod cannot convert it to JSON Schema, so it cannot be sent at all: ${String(error)}. ` +
          "`z.custom()` is the usual cause — a field a binding injects is not a field the model " +
          "answers, and it does not belong in the schema the model is asked for",
      },
    ];
  }
  return jsonSchemaDefects(json);
};

/**
 * The schema, or a refusal naming every defect. `what` is what the message
 * calls it, so an import-time throw says which leaf's output was refused.
 */
export const refuseUnlessStrict = <T extends z.ZodType>(schema: T, what: string): T => {
  const defects = strictSchemaDefects(schema);
  if (defects.length > 0) throw new StrictSchemaError(what, defects);
  return schema;
};
