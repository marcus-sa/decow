/**
 * DISTILL, second half: the oracle is authored, and SOFTWARE measures it.
 *
 * Authoring and measuring are two things and one step. Between authoring and
 * measuring RED the caller has no decision to make, and between MEASURED and
 * JUDGED it deliberately buys no pre-craft judge: that would be a fourth model
 * boundary, and the incident that would justify one — a judge approving a
 * broken oracle in 27 seconds — is answered by a measurement that is software
 * and free. The oracle's independent judgement is the whole-diff review at the
 * end, which sees oracle and implementation together.
 *
 *   author = loop(body: author-oracle, until: red or blocked, max: 2)
 *   |
 *   +- author-oracle --> author.route --+- authored       -> write-oracle
 *   |                                   +- cannot-express -> author (blocked: design)
 *   |                                   +- exhausted      -> author (blocked)
 *   +- write-oracle ---> write.verdict -+- committed      -> measure
 *   |                                   +- conflict       -> author (iterate)
 *   |                                   +- defective      -> author (iterate, with the gate's detail)
 *   |                                   +- refused        -> author (blocked: out of scope)
 *   |                                   +- infra-failed   -> author (blocked)
 *   |                                   +- not-run        -> author (blocked)
 *   +- measure -------> measure.verdict +- red            -> author (leave: the desired answer)
 *                                       +- broken         -> author (iterate, with the output)
 *                                       +- green          -> author (blocked: vacuous)
 *                                       +- indeterminate  -> author (blocked: harness)
 *                                       +- unmeasured     -> author (blocked: harness)
 *                                       +- not-run        -> author (iterate)
 *
 *   author.verdict -+- red     -> accepted
 *                   +- blocked -> human -> human.route -> rejected
 *
 * THE MEASUREMENT IS NOT A LEAF, and that is the load-bearing shape rather
 * than an optimisation. The author cannot run its own oracle: `author-oracle`
 * holds no tools and returns file bodies, and what executes them is the
 * consumer's declared `commands.oracle`, read back through the JUnit reader as
 * `green | red | broken | indeterminate`. So "this oracle fails on its
 * assertion and not on its scaffolding" is a property the SOFTWARE owns and
 * measures, and observing an execution is a fixed floor rather than a rigor
 * knob. A leaf asked the same question would be a second source of truth for a
 * fact the runner produced. It is `des oracle`'s software-measures rule.
 *
 * `green` is a person's, not a pass. An oracle that passes before any
 * production code exists proves nothing; it is the vacuous-oracle signal, and
 * it goes to somebody who can decide whether the obligation was wrong or the
 * value was already delivered. nwave computes the same verdict and does not
 * ARM it, because four of its own designed behaviours legitimately reach a
 * green oracle before a craft turn — a resumed run, a value a sibling already
 * delivered, a no-delta request, a silent craft turn. This graph runs one
 * value once with nothing behind it, so none of those four is reachable here
 * and parking is the honest answer.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import { measurementOf, type Effect, type EffectResult } from "@des/core/effects";
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
import {
  declaredPaths,
  type AuthorInput,
  type AuthorOutcome,
  type AuthorOutput,
  type AuthoredFile,
  type OracleDefs,
  type OracleLeafId,
  type ValueUnderOracle,
} from "./steps.ts";

/* ------------------------------------------------------------------- bounds */

/**
 * One bound, and it is 2 for the same reason every other bound here is: one
 * iteration to reach a correction, a second to reach the bound.
 *
 * It is also the bound nwave gives the acceptance author, which grants exactly
 * ONE correction turn per request: a second chance to answer a finding, and no
 * third.
 */
export const MAX_AUTHOR_ATTEMPTS = 2;

/* ------------------------------------------------------------------ people */

export const HUMAN_DECISIONS = ["abandon"] as const;
export const HumanAnswer = z.object({ decision: z.enum(HUMAN_DECISIONS) });
export type HumanAnswer = z.infer<typeof HumanAnswer>;
export type HumanDecision = HumanAnswer["decision"];

/** The closed set of reasons this workflow may hand a person a blocked run. */
export const BLOCK_REASONS = [
  "design-gap",
  "write-refused",
  "write-infra-failed",
  "vacuous-oracle",
  "harness",
  "oracle-broken",
  "validator-exhausted",
  "author-loop-exhausted",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/**
 * Who owns a non-accepting finding. Two members and not more, because exactly
 * two roles can repair a rejected oracle set: the acceptance designer, who owns
 * the oracle and its supports, and the architect of the value, who owns its
 * obligations and the surface they are expressed through. A third word would
 * name a role no correction edge reaches.
 */
export const DEFECT_OWNERS = ["oracle", "design"] as const;
export type DefectOwner = (typeof DEFECT_OWNERS)[number];

const OWNED_BY: Partial<Record<BlockReason, DefectOwner>> = {
  "design-gap": "design",
  "oracle-broken": "oracle",
  "vacuous-oracle": "oracle",
};

/* -------------------------------------------------------------------- state */

export type State = {
  value: ValueUnderOracle;
  design: string;
  /** Every path this turn may write. The lease scope, and the wall. */
  testPaths: string[];

  leaf: { "author-oracle"?: AuthorOutcome };
  /** The files the author proposed. Payload; the graph never branches on them. */
  files: AuthoredFile[];
  /**
   * The effects a PROPOSAL-shape binding derived from the turn's own writes.
   * Payload, and the graph never branches on it either: `write-oracle` prefers
   * it over `files` when it is there, so the two binding shapes reach the same
   * node with the same meaning.
   */
  proposal?: Effect[];
  /** Why the author could not express it, on `cannot-express`. Payload. */
  reason?: string;
  /** How the writes landed. Cleared when a new turn writes. */
  writes?: EffectResult[];
  /** What the measurement said. Cleared when a new write is attempted. */
  measured?: EffectResult;
  /** What the last refusal said, fed back to the author. Payload. */
  finding?: string;
  exhausted?: OracleLeafId;
  loopExhausted?: boolean;
  iterations: number;

  human?: HumanAnswer;
};

export const seed = (spec: {
  value: ValueUnderOracle;
  design: string;
  testPaths: readonly string[];
}): State => ({
  value: spec.value,
  design: spec.design,
  testPaths: [...spec.testPaths],
  leaf: {},
  files: [],
  iterations: 0,
});

/* ------------------------------------------------------- decision functions */

/**
 * How the batch of writes landed.
 *
 * Six members, total over `EffectResult`'s own space, and the split inside
 * `rejected` is the one that earns its keep. A CONTRACT rejection is the
 * executor's wall — a path outside the lease's scope, or an identity the file
 * already held and the new bytes do not — and nothing the author could do from
 * inside this loop repairs a turn that wrote where it may not. Every other
 * gate is a defect in the bytes, which is exactly what a correction turn is
 * for.
 */
export const WRITE_VERDICTS = [
  "committed",
  "conflict",
  "defective",
  "refused",
  "infra-failed",
  "not-run",
] as const;
export type WriteVerdict = (typeof WRITE_VERDICTS)[number];

export const writeVerdictOf = (results: readonly EffectResult[] | undefined): WriteVerdict => {
  if (results === undefined) return "not-run";
  const writes = results.filter((r) => r.effect.type === "write-file");
  if (writes.length === 0) return "not-run";
  const failed = writes.find((r) => r.outcome !== "committed");
  if (failed === undefined) return "committed";
  switch (failed.outcome) {
    case "conflict":
      return "conflict";
    case "infra-failed":
      return "infra-failed";
    case "rejected":
      return failed.by === "contract" ? "refused" : "defective";
    default:
      return "committed";
  }
};

export const writeVerdict = (s: State): WriteVerdict => writeVerdictOf(s.writes);

/**
 * What the measurement said, off ONE field.
 *
 * `not-run` is the honest answer for an iteration whose write never landed, so
 * the measurement never happened; it is not a block, and the loop iterates.
 * `unmeasured` is the other absence and it IS a block: the effect came back
 * and carried no verdict, which means the runner did not start.
 */
export const MEASURE_VERDICTS = [
  "green",
  "red",
  "broken",
  "indeterminate",
  "unmeasured",
  "not-run",
] as const;
export type MeasureVerdict = (typeof MEASURE_VERDICTS)[number];

export const measureVerdict = (s: State): MeasureVerdict => {
  if (s.measured === undefined) return "not-run";
  return measurementOf(s.measured)?.verdict ?? "unmeasured";
};

/**
 * What is blocking, if anything. One pure function, read by the loop's
 * `until`, by the branch after the loop, and by the suspend node's reason.
 *
 * The order is the order the run reaches them, with one deliberate exception:
 * `loopExhausted` is last, and it asks what the LAST measurement said, because
 * "the author spent its budget and the oracle is still broken" is a more
 * specific answer than "the author spent its budget".
 */
export const blockedReason = (s: State): BlockReason | undefined => {
  if (s.leaf["author-oracle"] === "cannot-express") return "design-gap";
  const write = writeVerdict(s);
  if (write === "refused") return "write-refused";
  if (write === "infra-failed") return "write-infra-failed";
  const measured = measureVerdict(s);
  if (measured === "green") return "vacuous-oracle";
  if (measured === "indeterminate" || measured === "unmeasured") return "harness";
  if (s.exhausted !== undefined) return "validator-exhausted";
  if (s.loopExhausted === true) {
    return measured === "broken" ? "oracle-broken" : "author-loop-exhausted";
  }
  return undefined;
};

export type AuthorVerdict = AuthorOutcome | "exhausted";
export type RunVerdict = "red" | "blocked";

export const authorVerdict = (s: State): AuthorVerdict =>
  s.leaf["author-oracle"] ?? "exhausted";

/** The loop leaves on the answer it wants, or on a block. */
export const authorDone = (s: State): boolean =>
  blockedReason(s) !== undefined || measureVerdict(s) === "red";

/**
 * The one branch after the loop. `red` is the only route to `accepted`, and
 * nothing reaches it except a measured red on an unblocked run.
 */
export const runVerdict = (s: State): RunVerdict =>
  blockedReason(s) === undefined && measureVerdict(s) === "red" ? "red" : "blocked";

export const humanReason = (s: State): BlockReason => {
  const reason = blockedReason(s);
  if (reason === undefined) throw new Error("graph bug: the human node was reached with nothing blocking");
  return reason;
};

/** Who owns the finding, when anybody does. A closed enum, never free text. */
export const defectOwner = (s: State): DefectOwner | undefined => {
  const reason = blockedReason(s);
  return reason === undefined ? undefined : OWNED_BY[reason];
};

export const humanTrail = (s: State): unknown[] => [
  { value: s.value.stepId, observation: s.value.observation, oracle: s.value.oracle },
  { obligations: s.value.acceptance },
  { defectOwner: defectOwner(s), reason: s.reason },
  { write: writeVerdict(s), measured: measurementOf(s.measured) },
  { finding: s.finding, iterations: s.iterations, exhausted: s.exhausted },
  { files: s.files.map((f) => f.path) },
];

export const humanDecision = (s: State): HumanDecision => {
  if (!s.human) throw new Error("graph bug: human.route reached with no answer absorbed");
  return s.human.decision;
};

/* -------------------------------------------------------------------- nodes */

/**
 * The finding a refused write leaves for the next turn: the gate's own detail,
 * which is the compiler's or the parser's words rather than a paraphrase.
 */
export const writeFinding = (results: readonly EffectResult[]): string => {
  const failed = results.find((r) => r.effect.type === "write-file" && r.outcome !== "committed");
  if (failed === undefined) return "";
  const where = failed.effect.type === "write-file" ? failed.effect.path : "";
  return failed.outcome === "rejected"
    ? `${where}: the ${failed.by} gate refused the file`
    : `${where}: the write came back ${failed.outcome}`;
};

/**
 * The files as effects. One `write-file` per path the author returned — or the
 * proposal a proposal-shape binding derived from the turn's own writes, which
 * arrives as effects rather than as bodies.
 */
export const writeEffects = (s: State, proposal: readonly Effect[] | undefined): Effect[] =>
  proposal !== undefined && proposal.length > 0
    ? [...proposal]
    : s.files.map((file): Effect => ({ type: "write-file", path: file.path, body: file.body }));

const absorbLoop = (s: State, exit: LoopExit): State => ({
  ...s,
  iterations: exit.iterations,
  loopExhausted: exit.exhausted ? true : s.loopExhausted,
});

export const oracleGraph = (
  journal: Journal,
  defs: OracleDefs,
  observe?: StepObserver,
): Workflow<State> => ({
  start: "author",
  nodes: {
    author: loop<State>({
      body: "author-oracle",
      until: authorDone,
      max: MAX_AUTHOR_ATTEMPTS,
      absorb: absorbLoop,
      next: "author.verdict",
    }),

    /**
     * The acceptance designer. Its two answers are `authored` and
     * `cannot-express`, and the second is a finding about the DESIGN rather
     * than a failure of the turn.
     *
     * A new turn invalidates the writes and the measurement of the one before
     * it, which is what the reset in `absorb` is for. `proposal` is carried
     * out of the payload here rather than re-derived, because a proposal-shape
     * binding produces effects and a structured-output one produces bodies,
     * and the node reads whichever arrived.
     */
    "author-oracle": leaf<State, AuthorInput, AuthorOutput>({
      id: "author-oracle",
      def: defs["author-oracle"],
      journal,
      input: (s) => ({
        value: s.value,
        design: s.design,
        testPaths: s.testPaths,
        ...(s.finding === undefined ? {} : { finding: s.finding }),
      }),
      absorb: (s, r) => {
        const base: State = {
          ...s,
          writes: undefined,
          measured: undefined,
          files: [],
          proposal: undefined,
          reason: undefined,
        };
        return r.decision === "ok"
          ? {
              ...base,
              leaf: { "author-oracle": r.output.decision },
              files: r.output.payload.files,
              ...(r.output.payload.proposal === undefined ? {} : { proposal: r.output.payload.proposal }),
              reason: r.output.payload.reason,
            }
          : { ...base, leaf: {}, exhausted: "author-oracle" };
      },
      ...(observe === undefined ? {} : { observe }),
      next: "author.route",
    }),

    // `cannot-express` is a block and not a retry: the design is the contract,
    // and a gap in it is not something this turn may close by inventing the
    // surface an obligation happens to need.
    "author.route": branch<State, AuthorVerdict>(authorVerdict, {
      authored: "write-oracle",
      "cannot-express": "author",
      exhausted: "author",
    }),

    /**
     * Write the oracle and its supports, through the same write path every
     * other change goes through. Not a leaf: the bodies are the author's and
     * this node only hands them over.
     */
    "write-oracle": {
      type: "step",
      run: async (s) => ({
        state: { ...s, writes: undefined, measured: undefined },
        effects: writeEffects(s, s.proposal),
      }),
      absorb: (s, results) => {
        const verdict = writeVerdictOf(results);
        // The gate's own words become the next turn's finding, so a correction
        // answers what actually happened rather than a paraphrase of it.
        const finding = verdict === "defective" ? writeFinding(results) : s.finding;
        return { ...s, writes: [...results], ...(finding === undefined ? {} : { finding }) };
      },
      next: "write.verdict",
    },

    // `refused` and `infra-failed` are blocks: the first is the executor's wall
    // and nothing inside this loop repairs a turn that wrote where it may not;
    // the second is not the author's error at all. Everything else iterates.
    "write.verdict": branch<State, WriteVerdict>(writeVerdict, {
      committed: "measure",
      conflict: "author",
      defective: "author",
      refused: "author",
      "infra-failed": "author",
      "not-run": "author",
    }),

    /**
     * Execute the oracle. NOT a leaf, and that is the whole arrangement: the
     * roles that hold an oracle cannot run it, so the verdict is software's.
     */
    measure: {
      type: "step",
      run: async (s) => ({
        state: s,
        effects: [{ type: "measure-oracle", oracle: s.value.oracle }],
      }),
      absorb: (s, results) => {
        const measured = results.find((r) => r.effect.type === "measure-oracle");
        if (measured === undefined) return s;
        // A broken oracle's own output is what the next turn reads. Handing it
        // a summary would be handing it a paraphrase of the thing it has to
        // repair.
        const output = measurementOf(measured)?.output;
        return {
          ...s,
          measured,
          ...(output === undefined || measurementOf(measured)?.verdict !== "broken"
            ? {}
            : { finding: output }),
        };
      },
      next: "measure.verdict",
    },

    // `red` is the answer this whole graph exists to reach. `broken` is the
    // author's own defect and it gets the correction turn. The rest are blocks
    // that unwind through the loop boundary and land on a person.
    "measure.verdict": branch<State, MeasureVerdict>(measureVerdict, {
      red: "author",
      broken: "author",
      green: "author",
      indeterminate: "author",
      unmeasured: "author",
      "not-run": "author",
    }),

    "author.verdict": branch<State, RunVerdict>(runVerdict, {
      red: "accept",
      blocked: "human",
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

/** Re-exported so a consumer reads one module for the declared paths. */
export { declaredPaths };
