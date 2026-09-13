/**
 * Rendering, for the three commands. Prose for a person; the rows are the
 * truth.
 *
 * A suspension's payload is `{ reason, trail }` and the trail is
 * `unknown[]` — the framework's `suspend` node carries evidence without
 * knowing its shape, which is what lets one node type serve every graph. So
 * reading it back is the consumer's, and it is done defensively: a row that is
 * not the shape this file expects is printed raw rather than dropped, because
 * a renderer that silently skips what it does not recognise is how a person
 * ends up approving a roadmap they did not read.
 */

import type { Roadmap, RoadmapStep } from "../../../src/examples/nwave/roadmap/schema.ts";

/** One row of the trail, by the key it carries. */
const rowOf = <T>(trail: readonly unknown[], key: string): T | undefined => {
  for (const row of trail) {
    if (row !== null && typeof row === "object" && key in row) {
      return (row as Record<string, T>)[key];
    }
  }
  return undefined;
};

const bullet = (text: string): string => `  - ${text}`;

export const renderStep = (step: RoadmapStep): string =>
  [
    `  ${step.id}  ${step.observation}`,
    `      authority:  ${step.authority}`,
    `      depends on: ${step.dependencies.length === 0 ? "(nothing)" : step.dependencies.join(", ")}`,
    `      touches:    ${step.predictedTouches.length === 0 ? "(nothing)" : step.predictedTouches.join(", ")}`,
    `      oracle:     ${step.oracle ?? "(none yet: DISTILL has not run)"}`,
    ...(step.supports.length === 0 ? [] : [`      supports:   ${step.supports.join(", ")}`]),
    ...step.acceptance.map((a) => `      ${a.id}: ${a.stimulus} -> ${a.expected}`),
  ].join("\n");

export const renderRoadmap = (roadmap: Roadmap): string =>
  [
    `request: ${roadmap.request}`,
    `steps:   ${roadmap.steps.length}`,
    "",
    ...roadmap.steps.map(renderStep),
  ].join("\n");

/**
 * Everything a person has to read before answering: the roadmap, what the
 * shape validator said, what the slice check said, and what the disjointness
 * pass did to the dependency graph.
 */
export const renderReviewTrail = (trail: readonly unknown[]): string => {
  const out: string[] = [];

  const roadmap = rowOf<Roadmap>(trail, "roadmap");
  out.push(roadmap === undefined ? "(no roadmap in the trail)" : renderRoadmap(roadmap));

  const defects = rowOf<unknown[]>(trail, "defects") ?? [];
  out.push("", `shape defects: ${defects.length === 0 ? "none" : defects.length}`);
  for (const defect of defects) out.push(bullet(JSON.stringify(defect)));

  const verdicts = rowOf<{ stepId: string; verdict: string; anchor: string }[]>(trail, "sliceVerdicts") ?? [];
  out.push("", `slice verdicts: ${verdicts.length === 0 ? "none recorded" : ""}`);
  for (const v of verdicts) out.push(bullet(`${v.stepId}: ${v.verdict} — anchored on ${JSON.stringify(v.anchor)}`));

  const edges = rowOf<string[]>(trail, "addedEdges") ?? [];
  const unresolvable = rowOf<unknown>(trail, "unresolvable");
  out.push("", `disjointness: ${edges.length === 0 ? "every pair already disjoint" : `${edges.length} edge(s) added`}`);
  for (const edge of edges) out.push(bullet(String(edge)));
  if (unresolvable !== undefined) {
    out.push(bullet(`unresolvable overlap: ${JSON.stringify(unresolvable)}`));
  }

  const tail = rowOf<unknown>(trail, "iterations");
  if (tail !== undefined) out.push("", `author-loop iterations: ${String(tail)}`);

  return out.join("\n");
};

/** A DELIVER row's trail, which is a different shape: leaf verdicts and loops. */
export const renderDeliverTrail = (trail: readonly unknown[]): string =>
  trail.map((row) => bullet(JSON.stringify(row))).join("\n");

export const renderTrace = (trace: readonly string[]): string => trace.join(" -> ");

/** A heading, so three commands' output reads the same way. */
export const heading = (text: string): string => `\n${text}\n${"=".repeat(text.length)}`;
