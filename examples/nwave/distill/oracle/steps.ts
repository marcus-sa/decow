/**
 * The oracle graph, leaf side. One leaf, and it is the acceptance designer.
 *
 * THE LEAF HOLDS NO TOOLS. `targets/todo/.des/models.ts` binds `author-oracle`
 * to the structured-output binding (`src/bindings/mastra.ts`), so the turn is
 * one call: the prompt below carries the observation, the obligations, the
 * oracle locator, the supports and the design source, and what comes back is
 * the oracle's body and each support's body as payload. `write-oracle` turns
 * those bodies into `write-file` effects, and the VCS lands them under a
 * PATH-SCOPE LEASE covering the target's declared test paths — `_designer_owns`
 * as a lease rather than as a tool grant, so a byte outside the scope is
 * `rejected { by: "contract" }` whatever the turn believed it was allowed
 * (`src/vcs/writes.ts`).
 *
 * `src/bindings/claude-code.ts` is the OTHER way to fill this leaf: in its
 * proposal shape a subagent reads and edits a scratch copy of the run
 * directory, the diff afterwards becomes the effects, and they arrive on
 * `AuthorOutput.proposal` instead of on `files`. `../smoke.ts` fills the leaf
 * that way; the todo target does not. The node reads whichever arrived, so the
 * two shapes reach `write-oracle` with the same meaning.
 *
 * The decision space is two words, and `cannot-express` is the interesting
 * one: the constructive chain cannot be expressed through the declared public
 * port WITHOUT INVENTING a field, an operation, a fixture fact or an expected
 * result. That is a finding about the DESIGN, and the graph routes it to the
 * design's owner. A leaf that could only say "authored" would have to invent
 * surface whenever the design left a gap, which is the failure this whole
 * arrangement exists to prevent.
 *
 * THE OBLIGATIONS REACH THIS LEAF. That is a defect in nwave-experimental
 * closed here rather than copied: `_derive` builds its `AuthorityFacts` with
 * `acceptance_obligations` left at its default `()`, and only `_craft` ever
 * populates it — so the facts the acceptance author receives carry the
 * OBLIGATION IDS the design declared but not the stimulus/expected pairs
 * `des distill` produced, and the author is asked to write an oracle for
 * obligations it cannot read. Here they are an input.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import { z } from "zod";
import type { Effect } from "@des/core/effects";
import type { Requirement } from "@des/core/requirement";
import { stepOutput, type ModelBinding, type StepDef } from "@des/core/step";
import { AcceptanceObligation } from "../../roadmap/schema.ts";

export const ORACLE_LEAF_IDS = ["author-oracle"] as const;
export type OracleLeafId = (typeof ORACLE_LEAF_IDS)[number];

/** Step id for the leaf. The journal keys on this. */
export const leafStepId = (leaf: OracleLeafId): string => `distill.${leaf}`;

/**
 * The two answers, and the second is the one that earns the enum.
 *
 * `cannot-express` is not "I gave up". It is the finding the author returns
 * INSTEAD OF a body when the constructive chain cannot be expressed through
 * the declared public port without inventing a field, an operation, a fixture
 * fact or an expected result. It carries no files, a mechanical check enforces
 * that, and `author.route` sends it to the design owner.
 */
export const AUTHOR_OUTCOMES = ["authored", "cannot-express"] as const;
export type AuthorOutcome = (typeof AUTHOR_OUTCOMES)[number];

/** One file the author proposes, whole. */
export const AuthoredFile = z.object({ path: z.string(), body: z.string() });
export type AuthoredFile = z.infer<typeof AuthoredFile>;

/** The value this turn is authoring an oracle for. */
export const ValueUnderOracle = z.object({
  /** The roadmap step's id. Carried so a journal key cannot be shared. */
  stepId: z.string(),
  observation: z.string(),
  /** Every obligation the oracle has to falsify. The input nwave drops. */
  acceptance: z.array(AcceptanceObligation),
  /** The one path::selector the oracle will be measured by. */
  oracle: z.string(),
  /** Whole-file substrate the oracle depends on, to be authored beside it. */
  supports: z.array(z.string()),
  /** A locator into the design source this value implements. */
  authority: z.string(),
});
export type ValueUnderOracle = z.infer<typeof ValueUnderOracle>;

export const AuthorInput = z.object({
  value: ValueUnderOracle,
  /** The design source: the declared public port, verbatim. */
  design: z.string(),
  /** Every path this turn may write. A byte outside them is a refusal. */
  testPaths: z.array(z.string()),
  /**
   * What went wrong last time: a gate's detail, or the measured output of an
   * oracle that came back broken. Absent on the first attempt.
   */
  finding: z.string().optional(),
});
export type AuthorInput = z.infer<typeof AuthorInput>;

export const AuthorOutput = stepOutput(AUTHOR_OUTCOMES, {
  /**
   * The oracle and every declared support, whole. Empty on `cannot-express`,
   * because a rejecting author owns no byte: its finding travels, its edits do
   * not.
   */
  files: z.array(AuthoredFile),
  /**
   * On `cannot-express`, what the design would have to name. On `authored`,
   * why the oracle observes what it observes.
   */
  reason: z.string().max(800),
  /**
   * The effects a PROPOSAL-shape binding derived from the turn's own writes,
   * injected by the binding rather than answered by the model. Absent under a
   * structured-output binding, which returns the bodies directly.
   */
  proposal: z.array(z.custom<Effect>(() => true)).optional(),
});
export type AuthorOutput = z.infer<typeof AuthorOutput>;

export type AuthorCtx = { input: AuthorInput; output: AuthorOutput };

/* ------------------------------------------------------------ requirements */

/** The oracle path a locator names, which is the file the author must write. */
export const oraclePathOf = (locator: string): string => locator.split("::")[0] ?? locator;

/** The complete set of paths an `authored` turn owes, in declaration order. */
export const declaredPaths = (value: ValueUnderOracle): string[] => [
  oraclePathOf(value.oracle),
  ...value.supports,
];

/**
 * Exactly the declared paths, no more and no fewer.
 *
 * nwave checks the other half of this after the turn — an accepted design that
 * did not create its declared oracle is `OracleUnavailable`. Checking it at
 * the model boundary is cheaper and catches the same thing plus its mirror: a
 * turn that wrote a file nobody declared.
 */
export const authoredNamesEveryDeclaredPath = (
  decisions: readonly string[],
): Requirement<AuthorCtx> => ({
  id: "oracle.authored-names-every-declared-path",
  sourceId: "des.oracle.declared-oracle-must-exist",
  text:
    "Return the oracle file and every declared support, whole, and nothing else. A turn that " +
    "omitted one declared it would write something it did not, and a turn that added one wrote " +
    "into a path nobody declared.",
  decisions,
  check: ({ input, output }) => {
    const id = "oracle.authored-names-every-declared-path";
    if (output.decision !== "authored") return null;
    const owed = declaredPaths(input.value).sort();
    const given = [...new Set(output.payload.files.map((f) => f.path))].sort();
    const same = owed.length === given.length && owed.every((path, at) => path === given[at]);
    return same
      ? null
      : { requirementId: id, evidence: `declared [${owed.join(", ")}], returned [${given.join(", ")}]` };
  },
});

/**
 * Every path is test substrate.
 *
 * The property, not the target table. nwave measured this one twice: a runner
 * that read a unit test as production because the architect had also named it
 * somewhere else refused work the designer's own obligations demanded, for two
 * runs and roughly $2.6 apiece. A path is test substrate because of WHERE IT
 * SITS, and naming it somewhere else never moves it.
 */
export const everyPathIsTestSubstrate = (decisions: readonly string[]): Requirement<AuthorCtx> => ({
  id: "oracle.every-path-is-test-substrate",
  sourceId: "des.oracle.designer-owns-test-paths",
  text:
    "Write only under the declared test paths. A path is test substrate because of where it sits; " +
    "production code is not yours to touch even when an obligation would be easier to observe from " +
    "inside it.",
  decisions,
  check: ({ input, output }) => {
    const under = (path: string) =>
      input.testPaths.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`));
    const outside = output.payload.files.map((f) => f.path).find((path) => !under(path));
    return outside === undefined
      ? null
      : {
          requirementId: "oracle.every-path-is-test-substrate",
          evidence: `${outside} is not under ${input.testPaths.join(", ")}`,
        };
  },
});

/** A rejecting author owns no byte: its finding travels, its edits do not. */
export const rejectionCarriesAFindingAndNoBytes = (
  decisions: readonly string[],
): Requirement<AuthorCtx> => ({
  id: "oracle.rejection-carries-a-finding-and-no-bytes",
  sourceId: "des.oracle.acceptance-rejection-mutation",
  text:
    "Report `cannot-express` with a reason naming exactly what the design would have to declare, " +
    "and with no files. A rejecting author changes nothing: the finding is what travels.",
  decisions,
  check: ({ output }) => {
    const id = "oracle.rejection-carries-a-finding-and-no-bytes";
    if (output.decision !== "cannot-express") return null;
    if (output.payload.files.length > 0) {
      return { requirementId: id, evidence: `${output.payload.files.length} file(s) on a rejection` };
    }
    return output.payload.reason.trim().length === 0
      ? { requirementId: id, evidence: "a rejection with no reason" }
      : null;
  },
});

/**
 * The rule `cannot-express` exists for, in the words the agent's own
 * definition uses.
 */
export const nothingIsInvented = (decisions: readonly string[]): Requirement<AuthorCtx> => ({
  id: "oracle.nothing-is-invented",
  sourceId: "des.oracle.rejected-outcome",
  text:
    "Report `cannot-express` when the constructive chain cannot be expressed through the declared " +
    "public port without inventing a field, an operation, a fixture fact or an expected result. Do " +
    "not invent it and then assert against it: that is a design gap wearing a green test.",
  decisions,
});

/**
 * Completeness, in both directions, as a total relation. Not a checklist, not
 * a scenario count, not a percentage — nwave's `nw-at-completeness-check`
 * verbatim, bound here because this is the turn that decides what the oracle
 * observes.
 */
export const completenessIsATotalRelation = (
  decisions: readonly string[],
): Requirement<AuthorCtx> => ({
  id: "oracle.completeness-is-a-total-relation",
  sourceId: "nw-at-completeness-check",
  text:
    "Every declared obligation is falsified by one or more observations the oracle makes, and every " +
    "observation the oracle makes answers exactly one declared obligation. PASS only when both " +
    "directions hold. Never invent coverage from a fixed checklist, a scenario count, a percentage, " +
    "a test pyramid or a framework convention.",
  decisions,
});

export const oracleObservesThroughThePublicPort = (
  decisions: readonly string[],
): Requirement<AuthorCtx> => ({
  id: "oracle.observes-through-the-public-port",
  sourceId: "des.oracle.public-executable-oracle",
  text:
    "The oracle drives the declared public port and observes its declared results. It does not " +
    "reach into a private field, stub the subject, or assert on an internal step: an oracle that " +
    "does is measuring the implementation rather than the value.",
  decisions,
});

/* ----------------------------------------------------------------- prompts */

const SYSTEM =
  "You write ONE executable oracle for one value, through the declared public port, plus any " +
  "whole-file support it needs. Every obligation below must be falsifiable by something the oracle " +
  "observes, and every observation it makes must answer one of them. Report `authored` with the " +
  "file bodies. Before changing any byte, report `cannot-express` instead when the chain cannot be " +
  "expressed through the declared port without inventing a field, an operation, a fixture fact or " +
  "an expected result.";

const renderObligation = (o: AcceptanceObligation): string =>
  `- ${o.id}\n    stimulus: ${o.stimulus}\n    expected: ${o.expected}`;

const prompt = (i: AuthorInput): string =>
  [
    `Design source — the declared public port:\n${i.design}`,
    `Value ${i.value.stepId}\n  observation: ${i.value.observation}\n  authority:   ${i.value.authority}`,
    `Acceptance obligations:\n${i.value.acceptance.map(renderObligation).join("\n")}`,
    `Write exactly these files, whole:\n${declaredPaths(i.value).map((p) => `- ${p}`).join("\n")}`,
    `Test substrate lives under: ${i.testPaths.join(", ")}`,
    ...(i.finding === undefined ? [] : [`Your last attempt was refused:\n${i.finding}`]),
  ].join("\n\n");

/* --------------------------------------------------------------- step defs */

export type OracleModels = {
  worker: ModelBinding;
  validator: ModelBinding;
  escalateTo?: ModelBinding;
};

export type OracleDefs = { "author-oracle": StepDef<AuthorInput, AuthorOutput> };

export const oracleDefs = (models: OracleModels): OracleDefs => ({
  "author-oracle": {
    id: leafStepId("author-oracle"),
    version: 1,
    input: AuthorInput,
    output: AuthorOutput,
    requirements: [
      authoredNamesEveryDeclaredPath,
      everyPathIsTestSubstrate,
      rejectionCarriesAFindingAndNoBytes,
      nothingIsInvented,
      completenessIsATotalRelation,
      oracleObservesThroughThePublicPort,
    ].map((row) => row(AUTHOR_OUTCOMES)),
    worker: { model: models.worker, system: SYSTEM, prompt },
    validator: { model: models.validator },
    maxAttempts: 2,
    ...(models.escalateTo === undefined ? {} : { escalateTo: models.escalateTo }),
  },
});
