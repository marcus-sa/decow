/**
 * The strict-mode rules, and the refusal `stepOutput` and `stepDef` make from
 * them.
 *
 * No agent, no key, no socket: a schema is converted and walked, which is what
 * the check does in production too.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { stepDef, stepOutput, Verdict, type ModelBinding } from "./step.ts";
import {
  jsonSchemaDefects,
  strictJsonSchema,
  strictSchemaDefects,
  StrictSchemaError,
  type StrictDefectKind,
} from "./strict-schema.ts";

const kinds = (schema: z.ZodType): StrictDefectKind[] =>
  strictSchemaDefects(schema).map((d) => d.kind);

const never: ModelBinding = { id: "never", generate: async () => ({}) as never };

describe("what strict mode refuses", () => {
  test("an optional property is refused, and its nullable equivalent is accepted", () => {
    // The failure that made this file exist. `.optional()` leaves the key out
    // of `required`, strict mode requires every declared key to be in it, and
    // a provider handed a malformed strict schema does not refuse it — it
    // stops constraining the answer at all.
    const optional = z.object({ a: z.string(), b: z.string().optional() });
    expect(kinds(optional)).toEqual(["optional-property"]);
    expect(strictSchemaDefects(optional)[0]?.at).toBe("#/properties/b");

    const nullable = z.object({ a: z.string(), b: z.string().nullable() });
    expect(strictSchemaDefects(nullable)).toEqual([]);
    // Absence became a VALUE the model returns rather than a key it omits.
    expect(strictJsonSchema(nullable).properties).toMatchObject({
      b: { type: ["string", "null"] },
    });
    expect(strictJsonSchema(nullable).required).toEqual(["a", "b"]);
  });

  test("an optional property is found however deep it is nested", () => {
    const deep = z.object({
      outer: z.object({ rows: z.array(z.object({ id: z.string(), note: z.string().optional() })) }),
    });
    expect(strictSchemaDefects(deep)).toEqual([
      {
        kind: "optional-property",
        at: "#/properties/outer/properties/rows/items/properties/note",
        why: expect.stringContaining("`.nullable()`"),
      },
    ]);
  });

  test("a construct zod cannot convert is refused rather than thrown out of", () => {
    // `z.custom` throws at conversion, so the schema could not be sent at all
    // — which a checker has to REPORT, not re-raise: a walk over every leaf in
    // a repository must survive the first one that is broken.
    expect(kinds(z.object({ effects: z.array(z.custom<{ x: 1 }>(() => true)) }))).toEqual([
      "unrepresentable",
    ]);
  });

  test("a record is an object nobody can fill, so it is refused", () => {
    // It converts to `type: "object"` with no `properties`, and closed to
    // additional ones it can only ever be `{}`.
    expect(kinds(z.object({ labels: z.record(z.string(), z.string()) }))).toEqual([
      "object-without-properties",
    ]);
  });

  test("a subschema that constrains nothing is refused", () => {
    expect(kinds(z.object({ anything: z.unknown() }))).toEqual(["untyped"]);
  });

  test("a root that is not an object is refused, whatever is under it", () => {
    expect(kinds(z.array(z.string()))).toEqual(["root-is-not-an-object"]);
  });

  test("an object left open is refused, which is what reaches an endpoint under a union", () => {
    // Mastra closes objects it reaches through `properties` and `items` and
    // not ones under `anyOf`, so a union of objects arrives at the endpoint
    // open. That is this rule's case, and the reason the walk is exported
    // separately: `mastra.endpoint.test.ts` points it at the captured body.
    expect(
      jsonSchemaDefects({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      }),
    ).toEqual([
      { kind: "open-object", at: "#", why: expect.stringContaining("additionalProperties") },
    ]);
  });

  test("every defect is reported, not just the first", () => {
    const several = z.object({
      a: z.string().optional(),
      b: z.string().optional(),
      c: z.unknown(),
    });
    expect(kinds(several).sort()).toEqual(["optional-property", "optional-property", "untyped"]);
  });
});

describe("where the refusal happens", () => {
  test("stepOutput refuses at the definition, naming the decisions and the defect", () => {
    expect(() => stepOutput(["yes", "no"] as const, { note: z.string().optional() })).toThrow(
      StrictSchemaError,
    );
    try {
      stepOutput(["yes", "no"] as const, { note: z.string().optional() });
    } catch (error) {
      const message = String(error);
      expect(message).toContain("a step output over [yes | no]");
      expect(message).toContain("#/properties/payload/properties/note");
    }
  });

  test("stepOutput accepts the nullable form of the same field", () => {
    const output = stepOutput(["yes", "no"] as const, { note: z.string().nullable() });
    expect(strictSchemaDefects(output)).toEqual([]);
  });

  test("stepDef catches an output schema stepOutput did not build", () => {
    // The leaf that picks one of four shapes at run time and casts is why this
    // exists: what reaches a model is `def.output`, whatever built it.
    const byHand = z.object({
      decision: z.enum(["yes"]),
      payload: z.object({ note: z.string().optional() }),
    });
    expect(() =>
      stepDef({
        id: "test.by-hand",
        version: 3,
        input: z.object({}),
        output: byHand,
        requirements: [],
        worker: { model: never, system: "s", prompt: () => "p" },
        validator: { model: never },
        maxAttempts: 1,
      }),
    ).toThrow(/test\.by-hand@3's output schema/);
  });

  test("stepDef is identity on a schema it accepts", () => {
    const def = {
      id: "test.fine",
      version: 1,
      input: z.object({}),
      output: stepOutput(["yes"] as const, { note: z.string() }),
      requirements: [],
      worker: { model: never, system: "s", prompt: () => "p" },
      validator: { model: never },
      maxAttempts: 1,
    };
    expect(stepDef(def)).toBe(def);
  });

  test("the validator's own schema is one an endpoint can answer", () => {
    // It goes to a model exactly as a step's output does, so it is held to the
    // same rule — and it passes, which is why nothing here had to change.
    expect(strictSchemaDefects(Verdict)).toEqual([]);
  });
});
