/**
 * Every leaf of every graph, against the rules a strict structured-output
 * endpoint enforces.
 *
 * THIS IS THE TEST THAT WOULD HAVE CAUGHT IT. The first real run against a
 * live endpoint refused `roadmap.decompose` with
 * `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED: expected object, received
 * array`, and the cause was two layers up: `RoadmapStep.oracle` was
 * `z.string().optional()`, so the strict schema declared a property it did not
 * require, the provider stopped constraining the answer, and what came back
 * was a bare array with invented field names. `distill.author-oracle` was
 * worse and had never been called: `z.custom<Effect>()` has no JSON Schema at
 * all, so its conversion THREW and no run of that leaf against an endpoint
 * could ever have started.
 *
 * Neither was visible from a test that scripted its bindings, because a
 * scripted binding parses with zod and never converts. This one converts.
 *
 * The bindings here are scripted and never called: a `StepDef` is built to be
 * read, not run. No agent, no key, no socket.
 */

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { scriptedBinding } from "@des/core/harness/scripted-binding";
import type { ModelBinding } from "@des/core/step";
import { strictSchemaDefects } from "@des/core/strict-schema";
import { deliverDefs } from "./deliver/steps.ts";
import { obligationsDefs } from "./distill/obligations/steps.ts";
import { oracleDefs } from "./distill/oracle/steps.ts";
import { roadmapDefs } from "./roadmap/steps.ts";

/** One binding for every slot. Nothing calls it; the schemas are the subject. */
const binding: ModelBinding = scriptedBinding({});
const models = { worker: binding, validator: binding };

/**
 * The two fields this file reads off a leaf, which is all four graphs have in
 * common: their `StepDef`s differ in both type parameters, so a union of them
 * narrows to nothing useful.
 */
type Leaf = { id: string; output: z.ZodType };

/** Every leaf definition the four graphs build. */
const everyLeaf = (): Leaf[] => [
  ...Object.values<Leaf>(roadmapDefs(models)),
  ...Object.values<Leaf>(obligationsDefs(models)),
  ...Object.values<Leaf>(oracleDefs(models)),
  ...Object.values<Leaf>(deliverDefs(models)),
];

describe("every leaf's output schema is one a strict endpoint can answer", () => {
  test("the four graphs together declare the twelve leaves this walks", () => {
    // A graph that gained a leaf without gaining a check would make the sweep
    // below quietly narrower, so what it swept is asserted rather than assumed.
    expect(everyLeaf().map((def) => def.id).sort()).toEqual([
      "deliver.commit",
      "deliver.diagnose",
      "deliver.fix-acceptance-test",
      "deliver.fix-lint",
      "deliver.implement",
      "deliver.refactor",
      "deliver.select-tests",
      "deliver.surface-design-gap",
      "distill.author-oracle",
      "distill.propose-obligations",
      "roadmap.decompose",
      "roadmap.validate-slices",
    ]);
  });

  test("no leaf's output carries a defect, named leaf by leaf", () => {
    // Reported as a list rather than one assertion per leaf, so a failure
    // names every offender in one run instead of the first alphabetically.
    const offenders = everyLeaf().flatMap((def) =>
      strictSchemaDefects(def.output).map((defect) => `${def.id}: ${defect.kind} at ${defect.at}`),
    );
    expect(offenders).toEqual([]);
  });
});
