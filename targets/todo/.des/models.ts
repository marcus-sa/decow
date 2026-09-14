/**
 * Which model runs which leaf. The consumer's column of the design's
 * framework/consumer split, for the todo target.
 *
 * The shape the framework argues for is "many small models, one frontier call
 * per feature, and a mid-size model where the output is genuinely open":
 *
 *   decompose    opus     the one act the design says stays wide. Decomposing
 *                         a design into production-drivable slices is the
 *                         highest-judgement thing in the pipeline and the
 *                         framework validates its SHAPE and nothing about
 *                         whether it is good
 *   author-oracle sonnet  writing an executable oracle that falsifies every
 *                         obligation through a declared port is code
 *                         generation too, and it is validated the same way:
 *                         narrowly, plus a measurement software owns
 *   implement    sonnet   "make this acceptance test pass with the minimal
 *                         change" is code generation, not a closed-enum
 *                         decision. The document is explicit that this leaf
 *                         stays wide and is validated narrowly instead
 *   everything   haiku    classifications into two, three or four words, each
 *                         with a verbatim anchor and a mechanical check
 *   validators   haiku    every step's adversarial reviewer
 *
 * NO ESCALATION IS WIRED, deliberately. `escalateTo` fires once after the
 * attempt budget, and leaving it unset is what makes the exhaustion count
 * mean something: it is the number of decisions the SMALL models could
 * not get past their own validators, which is the open question this run
 * exists to produce evidence for. A Sonnet backstop would answer a different
 * question and hide that one.
 *
 * The validator is the same family as the worker for the Haiku leaves, which
 * the design says is the weaker arrangement — "a Haiku worker refuted by a
 * GPT-mini validator shares fewer blind spots than Haiku refuting Haiku". It is
 * what was asked for here; read the validator-rejection column with that in
 * mind.
 */

import { mastraAgent, modelId, requiredCredential, type MastraModel } from "@des/core/bindings/mastra";
import type { ModelBinding } from "@des/core/step";
import { deliverDefs, type DeliverDefs } from "../../../examples/nwave/deliver/steps.ts";
import { obligationsDefs, type ObligationsDefs } from "../../../examples/nwave/distill/obligations/steps.ts";
import { oracleDefs, type OracleDefs } from "../../../examples/nwave/distill/oracle/steps.ts";
import { roadmapDefs, type RoadmapDefs } from "../../../examples/nwave/roadmap/steps.ts";

const deepseek = (modelId: string) => ({
  providerId: "deepseek",
  modelId,
  url: `https://${process.env.LLM_INFERENCE_ENDPOINT}/v1`,
  apiKey: process.env.LLM_INFERENCE_API_KEY ?? "",
});

export const DECOMPOSE_MODEL = deepseek("deepseek-v4-pro-260425");
export const ORACLE_MODEL = deepseek("deepseek-v4-pro-260425");
export const IMPLEMENT_MODEL = deepseek("deepseek-v4-flash-260425");
export const WORKER_MODEL = deepseek("deepseek-v4-flash-260425");
export const VALIDATOR_MODEL = deepseek("deepseek-v4-flash-260425");

/**
 * Which binding runs which leaf. THE ONLY INJECTION POINT THIS COMPOSITION
 * HAS.
 *
 * Five roles rather than one binding per leaf, because five is what the model
 * table above actually distinguishes: the one act that stays wide, the two
 * that are code generation, everything else, and the adversary. Production
 * passes `todoModels()`; a test passes scripted ones, and there is nothing
 * else for a test to reach — no journal to seed, no evidence to fix, no hook
 * that exists because a test needed one.
 */
export type Models = {
  /** The decomposition. The one act the design says stays wide. */
  decompose: ModelBinding;
  /** The acceptance designer, writing an executable oracle. */
  authorOracle: ModelBinding;
  /** The crafter, making one acceptance test pass. */
  implement: ModelBinding;
  /** Every leaf that classifies into two, three or four words. */
  other: ModelBinding;
  /** Every step's adversarial reviewer. */
  validator: ModelBinding;
};

/**
 * ONE OpenAI-compatible endpoint for every role, from the environment.
 *
 * The defaults above are Anthropic router ids, and the model table is an
 * argument about model SIZE rather than about a vendor. A reader who wants to
 * run the same waves against a gateway, a proxy, or a model served on their
 * own machine should not have to edit this file to do it, so four variables
 * say it instead:
 *
 *   DES_OPENAI_COMPATIBLE_URL       the endpoint. SETTING IT IS THE SWITCH.
 *   DES_OPENAI_COMPATIBLE_MODEL     the model it serves. Required with a URL.
 *   DES_OPENAI_COMPATIBLE_PROVIDER  the name it is reported under.
 *                                   Defaults to `openai-compatible`.
 *   DES_OPENAI_COMPATIBLE_API_KEY   defaults to `unused`, which is what a
 *                                   local server wants and what tells the
 *                                   binding not to look for a key.
 *
 * Every role gets the SAME endpoint, so the five-way split the table argues
 * for collapses: a report from such a run says what one model did at five
 * jobs, which is a different reading and a useful one — the table's claim is
 * that small models suffice for four of the five, and one model everywhere is
 * the control for it.
 *
 * A URL with no model is refused AT THE DOOR, unlike a missing key. The two
 * are not the same kind of wrong: a run with no credential is entirely
 * readable and refuses only where a model is actually needed, whereas a URL
 * naming no model is a contradiction inside the configuration a person just
 * typed, with no model to name in a trail and nothing to be read later.
 */
const URL_VAR = "DES_OPENAI_COMPATIBLE_URL";
const MODEL_VAR = "DES_OPENAI_COMPATIBLE_MODEL";
const PROVIDER_VAR = "DES_OPENAI_COMPATIBLE_PROVIDER";
const API_KEY_VAR = "DES_OPENAI_COMPATIBLE_API_KEY";

/** The object form of `MastraModel`, with every field this composition sets. */
type Endpoint = { providerId: string; modelId: string; url: string; apiKey: string };

const openAiCompatible = (): Endpoint | undefined => {
  const url = process.env[URL_VAR];
  if (url === undefined || url === "") return undefined;
  const model = process.env[MODEL_VAR];
  if (model === undefined || model === "") {
    throw new Error(
      `${URL_VAR} is ${url} but ${MODEL_VAR} is not set, and an endpoint does not name a model. ` +
        `Set ${MODEL_VAR}, or unset ${URL_VAR} to run on the Anthropic defaults.`,
    );
  }
  return {
    providerId: process.env[PROVIDER_VAR] ?? "openai-compatible",
    modelId: model,
    url,
    apiKey: process.env[API_KEY_VAR] ?? "unused",
  };
};

/** Which model each role runs, as the environment leaves it. */
const roleModels = (): Record<keyof Models, MastraModel> => {
  const endpoint = openAiCompatible();
  return endpoint === undefined
    ? {
        decompose: DECOMPOSE_MODEL,
        authorOracle: ORACLE_MODEL,
        implement: IMPLEMENT_MODEL,
        other: WORKER_MODEL,
        validator: VALIDATOR_MODEL,
      }
    : {
        decompose: endpoint,
        authorOracle: endpoint,
        implement: endpoint,
        other: endpoint,
        validator: endpoint,
      };
};

/**
 * The real bindings, one per role. What `main.ts` serves with.
 *
 * The credential is the BINDING's to refuse, at the leaf: a call that needs a
 * variable the environment does not have throws where it is made, `runStep`
 * records it as a trail entry, and the server stays up with everything else
 * readable. An endpoint carrying its own key is not refused at all.
 */
export const todoModels = (): Models => {
  const roles = roleModels();
  return {
    decompose: mastraAgent({ model: roles.decompose }),
    authorOracle: mastraAgent({ model: roles.authorOracle }),
    implement: mastraAgent({ model: roles.implement }),
    other: mastraAgent({ model: roles.other }),
    validator: mastraAgent({ model: roles.validator }),
  };
};

/** The roadmap workflow's two leaves: Opus proposes, Haiku judges and refutes. */
export const todoRoadmapDefs = (models: Models): RoadmapDefs =>
  roadmapDefs({
    worker: models.other,
    validator: models.validator,
    decomposeWith: models.decompose,
  });

/** DISTILL's first half: one small model proposing, a pure function judging. */
export const todoObligationsDefs = (models: Models): ObligationsDefs =>
  obligationsDefs({ worker: models.other, validator: models.validator });

/** DISTILL's second half: the acceptance designer, on the open-output class. */
export const todoOracleDefs = (models: Models): OracleDefs =>
  oracleDefs({ worker: models.authorOracle, validator: models.validator });

/** The DELIVER step cycle: Sonnet writes code, Haiku does everything else. */
export const todoDeliverDefs = (models: Models): DeliverDefs =>
  deliverDefs({
    worker: models.other,
    validator: models.validator,
    workers: { implement: models.implement },
  });

/**
 * The credential line: which variable a leaf will read, and whether it is
 * there. Derived from the same configs the bindings are built from, through
 * the same rule the guard applies, so the banner cannot claim a refusal the
 * binding will not make.
 */
const credentialLine = (roles: Record<keyof Models, MastraModel>): string => {
  const variables = [...new Set(Object.values(roles).flatMap((model) => requiredCredential(model)))];
  if (variables.length === 0) {
    return "credential:    none is read from the environment; the endpoint carries its own";
  }
  const names = variables.join(" or ");
  return variables.some((variable) => process.env[variable])
    ? `credential:    ${names} is set: a leaf will call a model`
    : `credential:    ${names} is NOT set. Everything is readable; a leaf will refuse by name`;
};

/**
 * What the server prints, so a reader knows what a report's numbers are of.
 *
 * What is IN EFFECT, not what is written above: with an OpenAI-compatible
 * endpoint configured, every role reads as that endpoint's model and the URL
 * is named, because a run's numbers belong to the models that produced them.
 */
export const describeModels = (): string => {
  const roles = roleModels();
  const endpoint = openAiCompatible();
  return [
    `decompose:     ${modelId(roles.decompose)}`,
    `author-oracle: ${modelId(roles.authorOracle)}`,
    `implement:     ${modelId(roles.implement)}`,
    `every other leaf: ${modelId(roles.other)}`,
    `validators:    ${modelId(roles.validator)}`,
    ...(endpoint === undefined ? [] : [`endpoint:      ${endpoint.url} (${URL_VAR})`]),
    `escalation:    none`,
    credentialLine(roles),
  ].join("\n");
};
