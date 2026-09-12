/**
 * The roadmap authoring workflow.
 *
 * The roadmap is DATA. An agent never generates a workflow per feature; it
 * generates rows, and a scheduler instantiates the fixed DELIVER step cycle
 * once per row. So this graph is fixed and hand-written like the other two,
 * and what it produces is `roadmaps` and `roadmap_steps` rows through the
 * effect executor.
 *
 * The shape, with the bounded loop drawn out:
 *
 *   author = loop(body: decompose, until: a person approved or abandoned or
 *                 something is blocking, max: 2) -> author.verdict
 *   |
 *   +- decompose ----------> decompose.route -+- proposed ---------> validate-shape
 *   |                                         +- cannot-decompose -> author  (blocked)
 *   |                                         +- exhausted --------> author  (blocked)
 *   +- validate-shape -----> shape.route -----+- valid ------------> validate-slices
 *   |                                         +- invalid ----------> author  (iterate)
 *   +- validate-slices ----> slices.route ----+- all-ok -----------> measure-disjointness
 *   |                                         +- some-not-slice ---> author  (iterate)
 *   |                                         +- cannot-tell ------> author  (blocked)
 *   |                                         +- exhausted --------> author  (blocked)
 *   +- measure-disjointness  disjointness.route
 *   |                                         +- consistent -------> human-review
 *   |                                         +- edges-added ------> human-review
 *   |                                         +- drift-unresolvable> author  (blocked)
 *   +- human-review (suspend) -> review.route +- approve ----------> author  (leave)
 *                                             +- revise -----------> author  (iterate)
 *                                             +- abandon ----------> author  (leave)
 *
 *   author.verdict -+- approved -> persist -> persist.verdict -+- committed -> accepted
 *                   |                                          +- everything else -> human
 *                   +- abandoned -> rejected
 *                   +- blocked ---> human -> human.route -> rejected
 *
 * Two things about that drawing are the body-boundary rule rather than a
 * choice. The design's own sketch draws `human-review --approve--> persist`
 * and `slices-verdict --cannot-tell--> human`; neither can be an edge, because
 * a loop body leaves only through the loop's own id. So `approve` records the
 * answer and routes to the boundary, `until` goes true because of it, the run
 * unwinds, and `author.verdict` — the one branch after the loop — sends it to
 * `persist`. A block arrives at the same place by the same route with its own
 * reason. That is the same move DELIVER makes, and the same move rule 3 makes
 * for a failing step one level down.
 *
 * `human-review` is INSIDE the loop and `human` is outside it, and that is
 * what `revise` costs: a person who asks for a revision is answering from
 * inside an iteration, so the next iteration re-runs `decompose` with their
 * notes. A person handed a BLOCK is outside every loop, so nothing they could
 * answer would re-drive the decomposition — see `HUMAN_DECISIONS`.
 *
 * `validate-slices` is ONE leaf returning per-step verdicts, not a fanout of
 * one leaf per step. Both were available and the design document allows
 * either; this is why it is the first. A fanout would have to be sized to a
 * declared maximum step count (say 8) because the compiler fixes its shape,
 * which puts 4^8 = 65536 combinations at one point in the walk. Worse, the
 * walk here is `enumeratePaths` rather than `cartesian`, because this graph
 * has a bounded loop and its path space is therefore SEQUENCES — and
 * `enumeratePaths` refuses a fanout by name rather than miscounting it. So a
 * fanout would have made the graph unenumerable by the only walker that fits
 * it. One leaf keeps the per-step verdicts (in the payload, where the graph
 * cannot branch on them), keeps the aggregate as the one closed enum the graph
 * reads, and costs one choice point.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import type { Effect, EffectResult } from "../../core/effects.ts";
import type { Journal } from "../../core/journal.ts";
import {
  branch,
  leaf,
  loop,
  suspend,
  type LoopExit,
  type Node,
  type NodeId,
  type Workflow,
} from "../../core/workflow.ts";
import {
  DISJOINTNESS_VERDICTS,
  measureDisjointness,
  describeEdge,
  type AddedEdge,
  type DisjointnessVerdict,
  type Drift,
} from "./disjointness.ts";
import { noSteps, roadmapId, type Roadmap } from "./schema.ts";
import { shapeDefects, shapeVerdict, type ShapeDefect, type ShapeVerdict } from "./shape.ts";
import {
  DECOMPOSE_OUTCOMES,
  SLICE_VERDICTS,
  type DecomposeInput,
  type DecomposeOutcome,
  type DecomposeOutput,
  type RoadmapDefs,
  type RoadmapLeafId,
  type SliceVerdict,
  type SliceVerdictRow,
  type SlicesInput,
  type SlicesOutput,
} from "./steps.ts";

/* ------------------------------------------------------------------- bounds */

/**
 * One bound, and it is 2 for the reason the other examples' bounds are: one
 * iteration to reach a revision, a second to reach the bound. A third would
 * multiply the enumerated path space without adding an edge.
 */
export const MAX_AUTHOR_ATTEMPTS = 2;

/* --------------------------------------------------------------- the tables */

/** The artifact tables this workflow writes. */
export const ROADMAP_TABLE = "roadmaps";
export const ROADMAP_STEPS_TABLE = "roadmap_steps";

/* ------------------------------------------------------------------- people */

/** What a person may answer at `human-review`. */
export const REVIEW_DECISIONS = ["approve", "revise", "abandon"] as const;
export const ReviewAnswer = z.object({
  decision: z.enum(REVIEW_DECISIONS),
  /** What to change. Read by `decompose` on the next iteration, never branched on. */
  notes: z.string().optional(),
});
export type ReviewAnswer = z.infer<typeof ReviewAnswer>;
export type ReviewDecision = ReviewAnswer["decision"];

/** Why `human-review` parked. Both mean "read this roadmap and decide". */
export const REVIEW_REASONS = ["roadmap-ready", "edges-added"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/**
 * What a person may answer at `human`, and there is one answer.
 *
 * That is a position rather than an omission. Every route into `human` is a
 * block no closed enum could clear: a shape nobody could fix from here needs a
 * re-decomposition, which is `revise` at `human-review` INSIDE the loop; an
 * overlap the rule could not order needs the author to change the roadmap; a
 * persist conflict needs the world re-read. Offering a second answer would
 * mean inventing a route — a forced persist, or a jump back into a loop the
 * run has already left — and neither is a thing this graph does. So the run
 * parks, a person reads the trail, and the only thing they can say from here
 * is that it is over. Rule 3's point is that the person is an input the graph
 * reads, not that every parking has two exits.
 */
export const HUMAN_DECISIONS = ["abandon"] as const;
export const HumanAnswer = z.object({ decision: z.enum(HUMAN_DECISIONS) });
export type HumanAnswer = z.infer<typeof HumanAnswer>;
export type HumanDecision = HumanAnswer["decision"];

/** The closed set of reasons this workflow may hand a person a blocked run. */
export const BLOCK_REASONS = [
  "cannot-decompose",
  "slices-cannot-tell",
  "drift-unresolvable",
  "validator-exhausted",
  "author-loop-exhausted",
  "persist-conflict",
  "persist-rejected",
  "persist-infra-failed",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** Every reason either suspend node may park under. */
export const SUSPEND_REASONS = [...REVIEW_REASONS, ...BLOCK_REASONS] as const;

/* -------------------------------------------------------------------- state */

/** How the artifact rows landed, from `EffectResult`. */
export type PersistOutcome = EffectResult["outcome"];

const PERSIST_BLOCK: Record<Exclude<PersistOutcome, "committed">, BlockReason> = {
  conflict: "persist-conflict",
  rejected: "persist-rejected",
  "infra-failed": "persist-infra-failed",
};

export type State = {
  request: string;
  /** The design source `decompose` reads. A string in this cut. */
  design: string;
  /** The optimistic version the artifact rows claim. 0 for a new roadmap. */
  expectedVersion: number;

  /** The roadmap as it stands: proposed by `decompose`, then resolved. */
  roadmap: Roadmap;
  /** Named shape defects, fed back into `decompose` on the next iteration. */
  defects: ShapeDefect[];
  /** Per-step slice verdicts. Payload; the graph never branches on them. */
  sliceVerdicts: SliceVerdictRow[];
  /** Dependency edges the disjointness rule added. */
  addedEdges: AddedEdge[];
  /** The overlap whose resolving edge would close a cycle. */
  unresolvable?: Drift;

  /** What each leaf last decided. Cleared when its validator refused. */
  leaf: { decompose?: DecomposeOutcome; "validate-slices"?: SliceVerdict };
  shape?: ShapeVerdict;
  disjointness?: DisjointnessVerdict;
  /** The leaf whose validator was never satisfied. */
  exhausted?: RoadmapLeafId;
  /** True when the author loop ran `max` times and was still not done. */
  loopExhausted?: boolean;
  /** Iterations the author loop last ran, folded in by its `absorb`. */
  iterations: number;
  /** How the artifact rows landed. Absent until `persist` ran. */
  persist?: PersistOutcome;

  /** Absorbed by `human-review`; read by `review.route` and by `decompose`. */
  review?: ReviewAnswer;
  /** Absorbed by `human`; read only by `human.route`. */
  human?: HumanAnswer;
};

export const seed = (request: string, design: string, expectedVersion = 0): State => ({
  request,
  design,
  expectedVersion,
  roadmap: noSteps(request),
  defects: [],
  sliceVerdicts: [],
  addedEdges: [],
  leaf: {},
  iterations: 0,
});

/* ------------------------------------------------------- decision functions */

/**
 * What is blocking, if anything. One pure function, read by the loop's
 * `until`, by the branch after the loop, and by both suspend nodes' reasons,
 * so "this run needs a person and cannot continue" is decided in one place and
 * routed in several.
 *
 * First match wins. A run normally has exactly one block: whatever set it made
 * the loop's `until` true, and the run unwound immediately.
 */
export const blockedReason = (s: State): BlockReason | undefined => {
  if (s.leaf.decompose === "cannot-decompose") return "cannot-decompose";
  if (s.leaf["validate-slices"] === "cannot-tell") return "slices-cannot-tell";
  if (s.disjointness === "drift-unresolvable") return "drift-unresolvable";
  if (s.exhausted !== undefined) return "validator-exhausted";
  if (s.persist !== undefined && s.persist !== "committed") return PERSIST_BLOCK[s.persist];
  if (s.loopExhausted === true) return "author-loop-exhausted";
  return undefined;
};

export type DecomposeVerdict = DecomposeOutcome | "exhausted";
export type SlicesVerdict = "all-ok" | "some-not-slice" | "cannot-tell" | "exhausted";
export type AuthorVerdict = "approved" | "abandoned" | "blocked";
export type PersistVerdict = PersistOutcome;

export const decomposeVerdict = (s: State): DecomposeVerdict => s.leaf.decompose ?? "exhausted";

/**
 * The aggregate the leaf returned, mapped onto the graph's own enum. The leaf
 * answers with a step-level word (`is-slice`) and the branch routes a
 * roadmap-level one (`all-ok`), because the question the graph is asking is
 * about the roadmap.
 */
export const slicesVerdict = (s: State): SlicesVerdict => {
  switch (s.leaf["validate-slices"]) {
    case "is-slice":
      return "all-ok";
    case "not-slice":
      return "some-not-slice";
    case "cannot-tell":
      return "cannot-tell";
    case undefined:
      return "exhausted";
  }
};

export const disjointnessVerdict = (s: State): DisjointnessVerdict =>
  s.disjointness ?? "drift-unresolvable";

/**
 * The author loop is done when a person has approved or abandoned, or when
 * something is blocking. `invalid`, `some-not-slice` and `revise` all leave it
 * false, which is what makes them iterations rather than endings.
 */
export const authorDone = (s: State): boolean =>
  blockedReason(s) !== undefined ||
  s.review?.decision === "approve" ||
  s.review?.decision === "abandon";

/**
 * The one branch after the loop. `approved` is the only route to `persist`,
 * and nothing reaches it except a person's approval on an unblocked run.
 */
export const authorVerdict = (s: State): AuthorVerdict => {
  if (blockedReason(s) !== undefined) return "blocked";
  if (s.review?.decision === "abandon") return "abandoned";
  return s.review?.decision === "approve" ? "approved" : "blocked";
};

/** How the artifact rows landed. Absent means `persist` never ran, a graph bug. */
export const persistVerdict = (s: State): PersistVerdict => {
  if (s.persist === undefined) {
    throw new Error("graph bug: persist.verdict reached before any artifact row was written");
  }
  return s.persist;
};

/**
 * Why `human-review` parked. `edges-added` names the added edges in the trail
 * rather than in the reason, because the reason is a closed enum and the edges
 * are not.
 */
export const reviewReason = (s: State): ReviewReason =>
  s.addedEdges.length > 0 ? "edges-added" : "roadmap-ready";

/**
 * Why `human` parked. Reachable only from a branch that already established a
 * block, so an absent reason is a graph bug rather than a decision.
 */
export const humanReason = (s: State): BlockReason => {
  const reason = blockedReason(s);
  if (reason === undefined) {
    throw new Error("graph bug: the human node was reached with nothing blocking");
  }
  return reason;
};

/**
 * What a person reads. The design's sketch names four things a review payload
 * carries — the reason, the roadmap, the added edges, the defects — and the
 * framework's suspend payload is `{ reason, trail }`, so the other three are
 * the trail's rows, in that order, plus the slice verdicts and the persist
 * outcome that the block path needs.
 */
export const reviewTrail = (s: State): unknown[] => [
  { roadmap: s.roadmap },
  { addedEdges: s.addedEdges.map(describeEdge), unresolvable: s.unresolvable },
  { defects: s.defects },
  { sliceVerdicts: s.sliceVerdicts },
  { persist: s.persist, iterations: s.iterations, exhausted: s.exhausted },
];

/** `review.route` is reachable only through the suspend node above it. */
export const reviewDecision = (s: State): ReviewDecision => {
  if (!s.review) throw new Error("graph bug: review.route reached with no answer absorbed");
  return s.review.decision;
};

/** `human.route` is reachable only through the suspend node above it. */
export const humanDecision = (s: State): HumanDecision => {
  if (!s.human) throw new Error("graph bug: human.route reached with no answer absorbed");
  return s.human.decision;
};

/* -------------------------------------------------------------------- nodes */

/** The artifact rows one roadmap becomes. One for it, one per step. */
export const artifactEffects = (s: State): Effect[] => [
  {
    type: "upsert-artifact",
    table: ROADMAP_TABLE,
    id: roadmapId(s.roadmap),
    expectedVersion: s.expectedVersion,
    row: { request: s.roadmap.request, stepIds: s.roadmap.steps.map((step) => step.id) },
  },
  ...s.roadmap.steps.map(
    (step): Effect => ({
      type: "upsert-artifact",
      table: ROADMAP_STEPS_TABLE,
      id: step.id,
      expectedVersion: s.expectedVersion,
      row: step,
    }),
  ),
];

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

/** The author loop's exit facts, folded into state. */
const absorbAuthorLoop = (s: State, exit: LoopExit): State => ({
  ...s,
  iterations: exit.iterations,
  loopExhausted: exit.exhausted ? true : s.loopExhausted,
});

export const roadmapGraph = (journal: Journal, defs: RoadmapDefs): Workflow<State> => ({
  start: "author",
  nodes: {
    /* ---- the one bounded loop: propose, check, review, repeat ----------- */

    author: loop<State>({
      body: "decompose",
      until: authorDone,
      max: MAX_AUTHOR_ATTEMPTS,
      absorb: absorbAuthorLoop,
      next: "author.verdict",
    }),

    /**
     * The frontier-class leaf, and the only one in the framework that is
     * expected to be. A new proposal invalidates everything downstream of it,
     * which is what `reset` is for: the defects it just read, the slice
     * verdicts, the disjointness measurement and the person's answer are all
     * about the roadmap it is replacing.
     */
    decompose: leaf<State, DecomposeInput, DecomposeOutput>({
      id: "decompose",
      def: defs.decompose,
      journal,
      input: (s) => ({
        request: s.request,
        design: s.design,
        defects: s.defects,
        notSlices: s.sliceVerdicts.filter((v) => v.verdict !== "is-slice"),
        ...(s.review?.notes === undefined ? {} : { notes: s.review.notes }),
      }),
      absorb: (s, r) => {
        const base: State = {
          ...s,
          defects: [],
          sliceVerdicts: [],
          addedEdges: [],
          unresolvable: undefined,
          shape: undefined,
          disjointness: undefined,
          review: undefined,
          leaf: {},
        };
        return r.decision === "ok"
          ? {
              ...base,
              leaf: { decompose: r.output.decision },
              roadmap: r.output.payload.roadmap,
            }
          : { ...base, exhausted: "decompose" };
      },
      next: "decompose.route",
    }),

    // `cannot-decompose` is an honest answer and it goes to a person, by the
    // loop-boundary route rather than by an edge: the block lands in state,
    // `authorDone` goes true because `blockedReason` sees it, and
    // `author.verdict` routes it on the way out.
    "decompose.route": branch<State, DecomposeVerdict>(decomposeVerdict, {
      proposed: "validate-shape",
      "cannot-decompose": "author",
      exhausted: "author",
    }),

    /**
     * Not a model. A pure decision function over the proposed roadmap, whose
     * named defects are both the branch's input and the feedback the next
     * iteration of `decompose` reads.
     */
    "validate-shape": {
      type: "step",
      run: async (s) => {
        const defects = shapeDefects(s.roadmap);
        return {
          state: { ...s, defects, shape: shapeVerdict(defects) },
          effects: [],
        };
      },
      absorb: (s) => s,
      next: "shape.route",
    },

    "shape.route": branch<State, ShapeVerdict>((s) => s.shape ?? "invalid", {
      valid: "validate-slices",
      invalid: "author",
    }),

    /**
     * One leaf, per-step verdicts in the payload, the aggregate as the
     * decision. See the file header for why this is not a fanout.
     */
    "validate-slices": leaf<State, SlicesInput, SlicesOutput>({
      id: "validate-slices",
      def: defs["validate-slices"],
      journal,
      input: (s) => ({ roadmap: s.roadmap, design: s.design }),
      absorb: (s, r) =>
        r.decision === "ok"
          ? {
              ...s,
              leaf: { ...s.leaf, "validate-slices": r.output.decision },
              sliceVerdicts: r.output.payload.verdicts,
            }
          : { ...s, leaf: { ...s.leaf, "validate-slices": undefined }, exhausted: "validate-slices" },
      next: "slices.route",
    }),

    // `some-not-slice` iterates: the refused steps ride back into `decompose`
    // as feedback. `cannot-tell` does not, because a decomposition nobody can
    // judge is not one a re-prompt fixes.
    "slices.route": branch<State, SlicesVerdict>(slicesVerdict, {
      "all-ok": "measure-disjointness",
      "some-not-slice": "author",
      "cannot-tell": "author",
      exhausted: "author",
    }),

    /**
     * Not a model. The pairwise-disjointness measurement plus its
     * deterministic resolution, and the RESOLVED roadmap replaces the proposed
     * one in state: the added edges are what the author's own declaration
     * implied once the overlap was measured, so they are what gets persisted.
     */
    "measure-disjointness": {
      type: "step",
      run: async (s) => {
        const measured = measureDisjointness(s.roadmap);
        return {
          state: {
            ...s,
            roadmap: measured.resolved,
            addedEdges: measured.addedEdges,
            unresolvable: measured.unresolvable,
            disjointness: measured.verdict,
          },
          effects: [],
        };
      },
      absorb: (s) => s,
      next: "disjointness.route",
    },

    "disjointness.route": branch<State, DisjointnessVerdict>(disjointnessVerdict, {
      consistent: "human-review",
      "edges-added": "human-review",
      "drift-unresolvable": "author",
    }),

    /**
     * The review. Inside the loop, because `revise` re-drives the
     * decomposition and a body leaves only through the loop's own id: all
     * three answers route to the boundary, `authorDone` reads the answer, and
     * `author.verdict` turns approve into `persist` and abandon into a
     * rejection on the way out.
     */
    "human-review": suspend<State, ReviewAnswer>({
      reason: reviewReason,
      trail: reviewTrail,
      resumeSchema: ReviewAnswer,
      absorb: (s, answer) => ({ ...s, review: answer }),
      next: "review.route",
    }),

    "review.route": branch<State, ReviewDecision>(reviewDecision, {
      approve: "author",
      revise: "author",
      abandon: "author",
    }),

    /* ---- out of the loop: persist, or a person -------------------------- */

    "author.verdict": branch<State, AuthorVerdict>(authorVerdict, {
      approved: "persist",
      abandoned: "reject",
      blocked: "human",
    }),

    /**
     * Not a leaf. One `upsert-artifact` per row, through the effect executor,
     * with the optimistic version the state carries — 0 for a new roadmap. The
     * outcome is a decision value the branch below routes, so a conflict is an
     * edge to a person rather than an exception.
     */
    persist: {
      type: "step",
      run: async (s) => ({ state: s, effects: artifactEffects(s) }),
      absorb: (s, results) => ({ ...s, persist: persistOutcomeOf(results) }),
      next: "persist.verdict",
    },

    // Total over `EffectResult`'s outcome space. Only `committed` accepts, and
    // each way of not committing has its own reason for the person.
    "persist.verdict": branch<State, PersistVerdict>(persistVerdict, {
      committed: "accept",
      conflict: "human",
      rejected: "human",
      "infra-failed": "human",
    }),

    /**
     * Outside every loop. A person reads the trail and ends the run: see
     * `HUMAN_DECISIONS` for why there is one answer rather than two.
     */
    human: suspend<State, HumanAnswer>({
      reason: humanReason,
      trail: reviewTrail,
      resumeSchema: HumanAnswer,
      absorb: (s, answer) => ({ ...s, human: answer }),
      next: "human.route",
    }),

    "human.route": branch<State, HumanDecision>(humanDecision, {
      abandon: "reject",
    }),

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: reviewTrail(s) }) },
  },
});

/** Re-exported so a consumer reads one module for the decision spaces. */
export { DECOMPOSE_OUTCOMES, DISJOINTNESS_VERDICTS, SLICE_VERDICTS };
