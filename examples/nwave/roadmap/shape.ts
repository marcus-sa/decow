/**
 * `validate-shape`, as a pure function. No model.
 *
 * The things nwave-experimental refuses a persisted handover for, each a NAMED
 * defect
 * rather than a boolean, because the defects are the feedback `decompose`
 * reads on the next iteration: "invalid" alone tells a model nothing it can
 * act on.
 *
 *   no-steps               the roadmap has no steps at all
 *   duplicate-id           two steps claim the same identity
 *   dangling-dependency    a dependency names no step in the roadmap
 *   cycle                  the dependency graph is not a DAG
 *   observation-too-short  a step says too little to be worked from
 *   empty-authority        a step implements no named design source
 *
 * `no-steps` is here because the zod schema deliberately admits an empty
 * `steps` array (that is what `cannot-decompose` returns). An empty roadmap
 * passes all five of the others vacuously and would otherwise reach
 * `human-review` as a proposal worth approving. nwave's own validator refuses
 * it in the same breath as a missing request (`not items`).
 *
 * What a value must be OBSERVED to do is DISTILL's act, so there is no
 * obligations defect here: a shape check demanding them at ROADMAP time would
 * refuse every roadmap for not having done a later wave's job.
 * `observation-too-short` is what ROADMAP can ask instead.
 *
 * The order of the checks is the order defects are reported in, and it is
 * stable: identity first, then the graph, then each step's own text.
 * `decompose`'s requirement rows consume the same predicates through
 * `firstDefectOfKind`, so the step's own mechanical guardrail and the graph's
 * gate cannot drift apart.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { Roadmap } from "./schema.ts";

export const SHAPE_DEFECT_KINDS = [
  "no-steps",
  "duplicate-id",
  "dangling-dependency",
  "cycle",
  "observation-too-short",
  "empty-authority",
] as const;

/**
 * The floor an observation has to clear, from nwave-experimental's
 * `ports/driven_ports/task_invocation_port.py`.
 *
 * Forty is measured rather than chosen: the shortest real accepted-turn
 * DIAGNOSTIC there is 41 characters, so a forty-character floor on the
 * diagnostic would have left one character of margin against a real answer.
 * The OBSERVATION is the byte that costs, and forty is the floor it carries.
 */
export const MINIMUM_OBSERVATION_CHARACTERS = 40;
export type ShapeDefectKind = (typeof SHAPE_DEFECT_KINDS)[number];

/**
 * One named defect. Every variant names the step it is about, so the feedback
 * to `decompose` is addressed rather than general — except `no-steps`, which
 * is about the roadmap, and `cycle`, which is about a set of steps.
 */
export type ShapeDefect =
  | { kind: "no-steps" }
  | { kind: "duplicate-id"; stepId: string }
  | { kind: "dangling-dependency"; stepId: string; dependency: string }
  | { kind: "cycle"; stepIds: string[] }
  | { kind: "observation-too-short"; stepId: string; characters: number }
  | { kind: "empty-authority"; stepId: string };

/** One defect, rendered for a prompt or a person. */
export const describeDefect = (defect: ShapeDefect): string => {
  switch (defect.kind) {
    case "no-steps":
      return "the roadmap has no steps";
    case "duplicate-id":
      return `two steps claim the id ${defect.stepId}`;
    case "dangling-dependency":
      return `step ${defect.stepId} depends on ${defect.dependency}, which is not a step in this roadmap`;
    case "cycle":
      return `the dependency graph has a cycle through ${defect.stepIds.join(" -> ")}`;
    case "observation-too-short":
      return (
        `step ${defect.stepId}'s observation is ${defect.characters} characters; ` +
        `${MINIMUM_OBSERVATION_CHARACTERS} is the floor, because an observation nobody could ` +
        `work from is not one`
      );
    case "empty-authority":
      return `step ${defect.stepId} names no authority`;
  }
};

/**
 * The smallest set of step ids that closes a dependency cycle, or `undefined`
 * when the graph is a DAG.
 *
 * Depth-first over the declared edges, in declaration order, reporting the
 * first cycle found as the path that closes it. Deterministic in the input's
 * own order, which is what makes the defect list stable across runs — a
 * defect list that reordered itself would send a different prompt to
 * `decompose` for the same roadmap.
 */
const findCycle = (roadmap: Roadmap): string[] | undefined => {
  const edges = new Map(roadmap.steps.map((s) => [s.id, s.dependencies] as const));
  const settled = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const walk = (id: string): string[] | undefined => {
    if (onPath.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (settled.has(id)) return undefined;
    onPath.add(id);
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue; // the dangling-dependency check owns this
      const cycle = walk(next);
      if (cycle !== undefined) return cycle;
    }
    path.pop();
    onPath.delete(id);
    settled.add(id);
    return undefined;
  };

  for (const step of roadmap.steps) {
    const cycle = walk(step.id);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
};

/**
 * Every named defect in a proposed roadmap, in a stable order. Empty means the
 * shape is valid, which is the only thing `shapeVerdict` reads.
 */
export const shapeDefects = (roadmap: Roadmap): ShapeDefect[] => {
  const defects: ShapeDefect[] = [];
  if (roadmap.steps.length === 0) return [{ kind: "no-steps" }];

  const seen = new Set<string>();
  for (const step of roadmap.steps) {
    if (seen.has(step.id)) defects.push({ kind: "duplicate-id", stepId: step.id });
    seen.add(step.id);
  }

  for (const step of roadmap.steps) {
    for (const dependency of step.dependencies) {
      if (!seen.has(dependency)) {
        defects.push({ kind: "dangling-dependency", stepId: step.id, dependency });
      }
    }
  }

  const cycle = findCycle(roadmap);
  if (cycle !== undefined) defects.push({ kind: "cycle", stepIds: cycle });

  for (const step of roadmap.steps) {
    const characters = step.observation.trim().length;
    if (characters < MINIMUM_OBSERVATION_CHARACTERS) {
      defects.push({ kind: "observation-too-short", stepId: step.id, characters });
    }
  }
  for (const step of roadmap.steps) {
    if (step.authority.trim().length === 0) {
      defects.push({ kind: "empty-authority", stepId: step.id });
    }
  }
  return defects;
};

/**
 * The first defect of one kind, for a `Requirement.check` that is bound to one
 * rule rather than to the whole shape. This is the shared predicate that keeps
 * `decompose`'s own mechanical guardrails and the graph's gate from drifting:
 * there is one implementation of "does every step name an authority", and both
 * consumers read it.
 */
export const firstDefectOfKind = (
  roadmap: Roadmap,
  kind: ShapeDefectKind,
): ShapeDefect | undefined => shapeDefects(roadmap).find((d) => d.kind === kind);

/** What the branch after `validate-shape` routes on. */
export type ShapeVerdict = "valid" | "invalid";

export const shapeVerdict = (defects: readonly ShapeDefect[]): ShapeVerdict =>
  defects.length === 0 ? "valid" : "invalid";
