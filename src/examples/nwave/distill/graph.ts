/**
 * The DISTILL classification graph. Every cross-cutting rule is one line in
 * `mergeVerdict`, a total function into a closed enum, and the branch's edge
 * table is exhaustive over it. No `if` lives anywhere a model can reach.
 *
 * The graph has two merge branches over the same verdict function. The first
 * routes a block to a person; the second, reached only after a person has
 * answered, is terminal on every verdict. That is how "re-run the merge with
 * the human's answer" is expressed without a back edge: a second branch node,
 * not a cycle.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import type { Journal } from "../../../core/journal.ts";
import type { StepDef } from "../../../core/step.ts";
import { branch, leaf, suspend, type Node, type Workflow } from "../../../core/workflow.ts";
import { KINDS, Lane, type Classification, type Kind, type Scenario } from "./classify.ts";

/**
 * One slot per classifier. Each fanout sub-step writes exactly one top-level
 * key, so the compiler's per-slice merge is lossless. See README
 * "Deviations from the design".
 */
export type LaneSlot = { lane?: Lane; anchor?: string; exhausted?: boolean };

/** The closed set of reasons this workflow may park for a person. */
export const HUMAN_REASONS = ["validator-exhausted", "incomplete-boundary"] as const;
export type HumanReason = (typeof HUMAN_REASONS)[number];

/** The closed set of answers a person may give. */
export const HUMAN_DECISIONS = ["proceed", "abandon", "override"] as const;
export const HumanAnswer = z.object({
  decision: z.enum(HUMAN_DECISIONS),
  /** Only read when `decision` is "override". */
  override: z.object({ kind: z.enum(KINDS), lane: Lane }).optional(),
});
export type HumanAnswer = z.infer<typeof HumanAnswer>;
export type HumanDecision = HumanAnswer["decision"];

export type State = {
  scenario: Scenario;
  e2e: LaneSlot;
  expectation: LaneSlot;
  benchmark: LaneSlot;
  dst: LaneSlot;
  /** Absorbed by the `human` suspend node; read only by `human.route`. */
  human?: HumanAnswer;
};

export const seed = (scenario: Scenario): State => ({
  scenario,
  e2e: {},
  expectation: {},
  benchmark: {},
  dst: {},
});

/**
 * One classifier. The `leaf` constructor owns the exhaustion trail, so all
 * this has to say is where the input comes from and where the verdict goes.
 */
const classifyNode = (
  kind: Kind,
  def: StepDef<Scenario, Classification>,
  journal: Journal,
): Node<State> =>
  leaf<State, Scenario, Classification>({
    id: kind,
    def,
    journal,
    input: (s) => s.scenario,
    absorb: (s, r) =>
      r.decision === "ok"
        ? { ...s, [kind]: { lane: r.output.decision, anchor: r.output.payload.anchor } }
        : { ...s, [kind]: { lane: "cannot-tell" as Lane, exhausted: true } },
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

/** Why the run parked. A closed enum, carried verbatim in the suspend payload. */
export const humanReason = (s: State): HumanReason =>
  exhaustedKinds(s).length > 0 ? "validator-exhausted" : "incomplete-boundary";

/** The evidence a person reads: every classifier's slot, as it stands. */
export const humanTrail = (s: State): unknown[] => KINDS.map((kind) => ({ kind, ...s[kind] }));

/**
 * `human.route` is reachable only through the `human` suspend node, which
 * always absorbs an answer first. An absent answer is a graph bug, not a
 * decision, so it throws rather than routing.
 */
export const humanDecision = (s: State): HumanDecision => {
  if (!s.human) throw new Error("graph bug: human.route reached with no answer absorbed");
  return s.human.decision;
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
      "incomplete-boundary": "human",
      undecidable: "human",
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

    // The run parks here with a typed reason and the evidence behind it.
    human: suspend<State, HumanAnswer>({
      reason: humanReason,
      trail: humanTrail,
      resumeSchema: HumanAnswer,
      absorb: (s, answer) => ({ ...s, human: answer }),
      next: "human.route",
    }),

    // Drop a HumanDecision member from this table and it will not compile.
    "human.route": branch<State, HumanDecision>(humanDecision, {
      proceed: "merge.after-human",
      abandon: "reject",
      override: "apply-override",
    }),

    "apply-override": {
      type: "step",
      run: async (s) => {
        const override = s.human?.override;
        // "override" with no override payload changes nothing, so the second
        // merge sees the same blocked state and rejects. The person's answer
        // is recorded either way.
        return override === undefined
          ? {
              state: s,
              effects: [
                {
                  type: "append-trail",
                  line: `${s.scenario.id}: override requested with no override payload`,
                },
              ],
            }
          : {
              state: {
                ...s,
                [override.kind]: {
                  lane: override.lane,
                  anchor: "<human override>",
                  exhausted: false,
                },
              },
              effects: [
                {
                  type: "append-trail",
                  line: `${s.scenario.id}: ${override.kind} overridden to ${override.lane} by a person`,
                },
              ],
            };
      },
      absorb: (s) => s,
      next: "merge.after-human",
    },

    // The same verdict function, a terminal edge table. A person has already
    // answered, so nothing here routes back to them.
    "merge.after-human": branch<State, MergeVerdict>(mergeVerdict, {
      complete: "accept",
      "benchmark-expectation-conflict": "demote-expectation",
      "incomplete-boundary": "reject",
      undecidable: "reject",
    }),

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: {
      type: "terminal",
      done: (s) => ({ kind: "rejected", state: s, trail: humanTrail(s) }),
    },
  },
});
