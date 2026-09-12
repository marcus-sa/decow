/**
 * The DISTILL classification graph. Every cross-cutting rule is one line in
 * `mergeVerdict`, a total function into a closed enum, and the branch's edge
 * table is exhaustive over it. No `if` lives anywhere a model can reach.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { Journal } from "../../core/journal.ts";
import { runStep, type StepDef } from "../../core/step.ts";
import { branch, type Node, type Workflow } from "../../core/workflow.ts";
import { KINDS, type Classification, type Kind, type Lane, type Scenario } from "./classify.ts";

/**
 * One slot per classifier. Each fanout sub-step writes exactly one top-level
 * key, so the runner's positional shallow merge is lossless. See README
 * "Deviations from the design".
 */
export type LaneSlot = { lane?: Lane; anchor?: string; exhausted?: boolean };

export type State = {
  scenario: Scenario;
  e2e: LaneSlot;
  expectation: LaneSlot;
  benchmark: LaneSlot;
  dst: LaneSlot;
};

export const seed = (scenario: Scenario): State => ({
  scenario,
  e2e: {},
  expectation: {},
  benchmark: {},
  dst: {},
});

const classifyNode = (
  kind: Kind,
  def: StepDef<Scenario, Classification>,
  journal: Journal,
): Node<State> => ({
  type: "step",
  run: async (s) => {
    const r = await runStep(def, s.scenario, journal);
    return r.decision === "ok"
      ? {
          state: { ...s, [kind]: { lane: r.output.decision, anchor: r.output.payload.anchor } },
          effects: [],
        }
      : {
          state: { ...s, [kind]: { lane: "cannot-tell" as Lane, exhausted: true } },
          effects: [{ type: "append-trail", line: JSON.stringify({ kind, trail: r.trail }) }],
        };
  },
  absorb: (s) => s,
  next: "merge",
});

export type MergeVerdict =
  | "complete"
  | "benchmark-expectation-conflict"
  | "incomplete-boundary"
  | "undecidable";

export const exhaustedKinds = (s: State): Kind[] => KINDS.filter((k) => s[k].exhausted === true);

export const mergeVerdict = (s: State): MergeVerdict => {
  if (exhaustedKinds(s).length > 0) return "undecidable";
  if (s.benchmark.lane === "needed" && s.expectation.lane === "needed")
    return "benchmark-expectation-conflict";
  if (s.scenario.crossesBoundary && s.dst.lane !== "needed" && s.e2e.lane !== "needed")
    return "incomplete-boundary";
  return "complete";
};

export const distillGraph = (
  journal: Journal,
  defs: Record<Kind, StepDef<Scenario, Classification>>,
): Workflow<State> => ({
  start: "classify",
  nodes: {
    classify: {
      type: "fanout",
      steps: ["classify.e2e", "classify.expectation", "classify.benchmark", "classify.dst"],
      join: "merge",
    },
    "classify.e2e": classifyNode("e2e", defs.e2e, journal),
    "classify.expectation": classifyNode("expectation", defs.expectation, journal),
    "classify.benchmark": classifyNode("benchmark", defs.benchmark, journal),
    "classify.dst": classifyNode("dst", defs.dst, journal),

    // Drop a MergeVerdict member from this table and it will not compile.
    merge: branch<State, MergeVerdict>(mergeVerdict, {
      complete: "accept",
      "benchmark-expectation-conflict": "demote-expectation",
      "incomplete-boundary": "needs-human",
      undecidable: "needs-human",
    }),

    "demote-expectation": {
      type: "step",
      run: async (s) => ({
        state: { ...s, expectation: { ...s.expectation, lane: "not-needed" as Lane } },
        effects: [
          { type: "append-trail", line: `${s.scenario.id}: expectation demoted, benchmark wins` },
        ],
      }),
      absorb: (s) => s,
      next: "accept",
    },

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    "needs-human": {
      type: "terminal",
      done: (s) => ({
        kind: "needs-human",
        state: s,
        reason: exhaustedKinds(s).length > 0 ? "validator-exhausted" : "incomplete-boundary",
      }),
    },
  },
});
