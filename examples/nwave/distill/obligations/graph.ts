/**
 * DISTILL, first half: the acceptance facts.
 *
 * `des distill` is a provider-free CLI step. It takes a JSON manifest of
 * acceptance facts — per value, an observation that must already exist in the
 * handover, a non-empty list of obligations, exactly one oracle locator, and a
 * support list — validates it against a closed rule set, renders a brief, and
 * persists the facts into the value graph. It buys NO model turn and it writes
 * NO test.
 *
 * This graph is that step with one leaf in front of it, because something has
 * to propose the manifest. Everything that decides whether the proposal is
 * admissible is `../manifest.ts`, and none of it is a judgement.
 *
 *   obligations = loop(body: propose-obligations, until: valid or blocked, max: 2)
 *   |
 *   +- propose-obligations -> propose.route -+- proposed  -> validate-manifest
 *   |                                        +- exhausted -> obligations (blocked)
 *   +- validate-manifest --> manifest.route -+- valid     -> obligations (leave)
 *                                            +- invalid   -> obligations (iterate)
 *
 *   obligations.verdict -+- valid   -> persist -> persist.verdict -+- committed -> accepted
 *                        |                                          +- else      -> human
 *                        +- blocked -> human -> human.route -> rejected
 *
 * NO HUMAN GATE ON THE HAPPY PATH, which is the one shape decision worth
 * defending. The roadmap workflow parks for a person before it persists,
 * because a decomposition is the highest-judgement act in the pipeline and its
 * output is a diff somebody reads. This is not that. `des distill` validates
 * and persists in one step, and every reason it could refuse is a named defect
 * a proposal can be re-driven against. A review gate here would be a person
 * asked to re-read what a total function already decided.
 *
 * The body-boundary rule shapes the rest, as it does in every graph here: a
 * body node leaves only through the loop's own id, so `valid` and `invalid`
 * both route to `obligations` and the branch AFTER the loop is what turns one
 * into `persist` and the other into a person.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import type { Effect, EffectResult } from "@des/core/effects";
import type { Journal } from "@des/core/journal";
import type { StepObserver } from "@des/core/step";
import {
  branch,
  leaf,
  loop,
  suspend,
  type LoopExit,
  type Workflow,
} from "@des/core/workflow";
import { ROADMAP_STEPS_TABLE } from "../../roadmap/graph.ts";
import type { Roadmap } from "../../roadmap/schema.ts";
import {
  enrich,
  manifestDefects,
  manifestVerdict,
  type ManifestDefect,
  type ManifestVerdict,
  type ProposedValue,
} from "../manifest.ts";
import type { ObligationsDefs, ProposeInput, ProposeOutput } from "./steps.ts";

/* ------------------------------------------------------------------- bounds */

/**
 * One bound, and it is 2 for the reason the other graphs' bounds are: one
 * iteration to reach a re-proposal, a second to reach the bound. A third would
 * multiply the enumerated path space without adding an edge.
 */
export const MAX_PROPOSALS = 2;

/* ------------------------------------------------------------------ people */

/** What a person may answer here, and there is one answer. */
export const HUMAN_DECISIONS = ["abandon"] as const;
export const HumanAnswer = z.object({ decision: z.enum(HUMAN_DECISIONS) });
export type HumanAnswer = z.infer<typeof HumanAnswer>;
export type HumanDecision = HumanAnswer["decision"];

/**
 * The closed set of reasons this workflow may hand a person a blocked run.
 *
 * Every one of them needs work outside a closed enum: a manifest nobody could
 * make admissible in two attempts needs the roadmap or the design changed, and
 * a refused persist needs the world re-read. So `abandon` is the only answer,
 * exactly as it is at the roadmap workflow's own block node.
 */
export const BLOCK_REASONS = [
  "validator-exhausted",
  "defects-unresolved",
  "persist-conflict",
  "persist-rejected",
  "persist-infra-failed",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/* -------------------------------------------------------------------- state */

export type PersistOutcome = EffectResult["outcome"];

const PERSIST_BLOCK: Record<Exclude<PersistOutcome, "committed">, BlockReason> = {
  conflict: "persist-conflict",
  rejected: "persist-rejected",
  "infra-failed": "persist-infra-failed",
};

export type State = {
  /** The roadmap as ROADMAP persisted it: rows with no acceptance facts. */
  roadmap: Roadmap;
  /** The design source the obligations are anchored in. */
  design: string;
  /** Where test substrate lives, from `design.md`. */
  testPaths: string[];
  /**
   * The version each `roadmap_steps` row is at, so the upsert is optimistic.
   * Carried in rather than read, because a graph that read the store would be
   * doing I/O in a node rather than through an effect.
   */
  versions: Record<string, number>;

  /** The manifest as proposed. Empty until `propose-obligations` has run. */
  values: ProposedValue[];
  /** Named defects, fed back into the leaf on the next iteration. */
  defects: ManifestDefect[];
  manifest?: ManifestVerdict;
  /** The leaf whose validator was never satisfied. */
  exhausted?: "propose-obligations";
  loopExhausted?: boolean;
  iterations: number;
  persist?: PersistOutcome;

  human?: HumanAnswer;
};

export const seed = (spec: {
  roadmap: Roadmap;
  design: string;
  testPaths: readonly string[];
  versions?: Record<string, number>;
}): State => ({
  roadmap: spec.roadmap,
  design: spec.design,
  testPaths: [...spec.testPaths],
  versions: spec.versions ?? {},
  values: [],
  defects: [],
  iterations: 0,
});

/* ------------------------------------------------------- decision functions */

/**
 * What is blocking, if anything. One pure function, read by the loop's `until`,
 * by the branch after the loop, and by the suspend node's reason.
 */
export const blockedReason = (s: State): BlockReason | undefined => {
  if (s.exhausted !== undefined) return "validator-exhausted";
  if (s.persist !== undefined && s.persist !== "committed") return PERSIST_BLOCK[s.persist];
  if (s.loopExhausted === true) return "defects-unresolved";
  return undefined;
};

export type ProposeVerdict = "proposed" | "exhausted";
export type ObligationsVerdict = "valid" | "blocked";
export type PersistVerdict = PersistOutcome;

/** The leaf either proposed, or its validator was never satisfied. */
export const proposeVerdict = (s: State): ProposeVerdict =>
  s.exhausted === undefined ? "proposed" : "exhausted";

/** What the validator said. Absent means it has not run this iteration. */
export const manifestOutcome = (s: State): ManifestVerdict => s.manifest ?? "invalid";

/**
 * The loop leaves when the manifest validates, or when something is blocking.
 * An invalid manifest is an ITERATION: the defects are the feedback the next
 * proposal reads, which is the whole reason they are named rows.
 */
export const proposalsDone = (s: State): boolean =>
  blockedReason(s) !== undefined || s.manifest === "valid";

/** The one branch after the loop. `valid` is the only route to `persist`. */
export const obligationsVerdict = (s: State): ObligationsVerdict =>
  blockedReason(s) === undefined && s.manifest === "valid" ? "valid" : "blocked";

export const persistVerdict = (s: State): PersistVerdict => {
  if (s.persist === undefined) {
    throw new Error("graph bug: persist.verdict reached before any artifact row was written");
  }
  return s.persist;
};

export const humanReason = (s: State): BlockReason => {
  const reason = blockedReason(s);
  if (reason === undefined) throw new Error("graph bug: the human node was reached with nothing blocking");
  return reason;
};

/** What a person reads: the manifest as it stands, and why it was refused. */
export const humanTrail = (s: State): unknown[] => [
  { request: s.roadmap.request, steps: s.roadmap.steps.map((step) => step.id) },
  { values: s.values },
  { defects: s.defects },
  { iterations: s.iterations, exhausted: s.exhausted, persist: s.persist },
];

export const humanDecision = (s: State): HumanDecision => {
  if (!s.human) throw new Error("graph bug: human.route reached with no answer absorbed");
  return s.human.decision;
};

/* -------------------------------------------------------------------- nodes */

/** The enriched rows the manifest produces. One upsert per roadmap step. */
export const artifactEffects = (s: State): Effect[] =>
  enrich(s.roadmap, { values: s.values }).steps.map(
    (step): Effect => ({
      type: "upsert-artifact",
      table: ROADMAP_STEPS_TABLE,
      id: step.id,
      expectedVersion: s.versions[step.id] ?? 0,
      row: step,
    }),
  );

/**
 * How the batch landed, as one outcome. The first row that did not commit is
 * the one a person is told about: a partial write is not a smaller success,
 * and naming the first failure keeps the reason deterministic in the order the
 * effects were emitted.
 */
export const persistOutcomeOf = (results: readonly EffectResult[]): PersistOutcome => {
  const failed = results.find((r) => r.outcome !== "committed");
  return failed === undefined ? "committed" : failed.outcome;
};

const absorbLoop = (s: State, exit: LoopExit): State => ({
  ...s,
  iterations: exit.iterations,
  loopExhausted: exit.exhausted ? true : s.loopExhausted,
});

export const obligationsGraph = (
  journal: Journal,
  defs: ObligationsDefs,
  /**
   * Does this repository ignore that path? The one manifest rule that is a
   * question about the repository rather than about the proposal, so it is a
   * read port the composition supplies and a walk answers with a literal.
   */
  ignored: (path: string) => boolean = () => false,
  observe?: StepObserver,
): Workflow<State> => ({
  start: "obligations",
  nodes: {
    obligations: loop<State>({
      body: "propose-obligations",
      until: proposalsDone,
      max: MAX_PROPOSALS,
      absorb: absorbLoop,
      next: "obligations.verdict",
    }),

    /**
     * The one leaf. A new proposal invalidates the defects it just read and
     * the verdict they produced, which is what the reset is for.
     */
    "propose-obligations": leaf<State, ProposeInput, ProposeOutput>({
      id: "propose-obligations",
      def: defs["propose-obligations"],
      journal,
      input: (s) => ({
        roadmap: s.roadmap,
        design: s.design,
        testPaths: s.testPaths,
        defects: s.defects,
      }),
      absorb: (s, r) => {
        const base: State = { ...s, defects: [], manifest: undefined };
        return r.decision === "ok"
          ? { ...base, values: r.output.payload.values }
          : { ...base, values: [], exhausted: "propose-obligations" };
      },
      ...(observe === undefined ? {} : { observe }),
      next: "propose.route",
    }),

    "propose.route": branch<State, ProposeVerdict>(proposeVerdict, {
      proposed: "validate-manifest",
      exhausted: "obligations",
    }),

    /**
     * Not a model. A pure decision function over the proposal, the roadmap and
     * one injected repository fact, whose named defects are both the branch's
     * input and the feedback the next proposal reads.
     */
    "validate-manifest": {
      type: "step",
      run: async (s) => {
        const defects = manifestDefects({
          manifest: { values: s.values },
          roadmap: s.roadmap,
          ignored,
        });
        return { state: { ...s, defects, manifest: manifestVerdict(defects) }, effects: [] };
      },
      absorb: (s) => s,
      next: "manifest.route",
    },

    "manifest.route": branch<State, ManifestVerdict>(manifestOutcome, {
      valid: "obligations",
      invalid: "obligations",
    }),

    "obligations.verdict": branch<State, ObligationsVerdict>(obligationsVerdict, {
      valid: "persist",
      blocked: "human",
    }),

    /**
     * Not a leaf. One `upsert-artifact` per roadmap row, at the version the
     * state carries, through the effect executor. The rows are the SAME rows
     * ROADMAP wrote, with their three empty fields filled in — which is what
     * "DISTILL persists its facts into the value graph" means when the value
     * graph is rows.
     */
    persist: {
      type: "step",
      run: async (s) => ({ state: s, effects: artifactEffects(s) }),
      absorb: (s, results) => ({ ...s, persist: persistOutcomeOf(results) }),
      next: "persist.verdict",
    },

    "persist.verdict": branch<State, PersistVerdict>(persistVerdict, {
      committed: "accept",
      conflict: "human",
      rejected: "human",
      "infra-failed": "human",
    }),

    human: suspend<State, HumanAnswer>({
      reason: humanReason,
      trail: humanTrail,
      resumeSchema: HumanAnswer,
      absorb: (s, answer) => ({ ...s, human: answer }),
      next: "human.route",
    }),

    "human.route": branch<State, HumanDecision>(humanDecision, { abandon: "reject" }),

    accept: { type: "terminal", done: (s: State) => ({ kind: "accepted", state: s }) },
    reject: {
      type: "terminal",
      done: (s: State) => ({ kind: "rejected", state: s, trail: humanTrail(s) }),
    },
  },
});
