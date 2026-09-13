/**
 * The graphs the server's own tests drive.
 *
 * Hand-built and tiny, because what is under test here is the SERVER: the
 * projection it reports, the run record it keeps, the events it publishes, and
 * the refusal it returns for an answer outside a closed enum. A consumer's
 * real graphs are tested where they live, and driving one here would make a
 * failure in this package's routing look like a failure in their waves.
 *
 * Between them they cover every node type the projection has a shape for, and
 * `gate` has a leaf in it so the attempt seam is exercised by a real `runStep`
 * — against a scripted binding, so the output schema, the mechanical check and
 * the validator all run and no model is called.
 */

import { z } from "zod";
import { stepOutput, type ModelBinding, type StepDef } from "@des/core/step";
import { verbatimRequirement } from "@des/core/checks/verbatim";
import { branch, leaf, loop, suspend, type LoopExit, type Workflow } from "@des/core/workflow";
import type { Journal } from "@des/core/journal";
import { scriptedBinding } from "@des/core/harness/scripted-binding";

/** A binding that fails the test if anything reaches a model. */
export const forbidden = (id: string): ModelBinding => ({
  id,
  generate: async <T>(): Promise<T> => {
    throw new Error(`model "${id}" was called; the server's own tests spend zero model calls`);
  },
});

export const CLASSIFY_DECISIONS = ["ready", "needs-a-person"] as const;
export type ClassifyDecision = (typeof CLASSIFY_DECISIONS)[number];

export const ClassifyInput = z.object({ subject: z.string() });
export type ClassifyInput = z.infer<typeof ClassifyInput>;

export const ClassifyOutput = stepOutput(CLASSIFY_DECISIONS, {
  anchor: z.string().describe("A verbatim quote from the subject"),
});
export type ClassifyOutput = z.infer<typeof ClassifyOutput>;

/** What the fixture's one leaf is bound to. The server's own `Models`. */
export type GateModels = { worker: ModelBinding; validator: ModelBinding };

/** The one leaf: a worker, a mandatory validator, one mechanical check. */
export const classifyDef = (models: GateModels): StepDef<ClassifyInput, ClassifyOutput> => ({
  id: "fixture.classify",
  version: 1,
  input: ClassifyInput,
  output: ClassifyOutput,
  requirements: [
    verbatimRequirement<{ input: ClassifyInput; output: ClassifyOutput }>({
      id: "fixture.anchor-is-verbatim",
      sourceId: "fixture",
      text: "The anchor must be a verbatim substring of the subject.",
      decisions: CLASSIFY_DECISIONS,
      source: (ctx) => ctx.input.subject,
      quote: (ctx) => ctx.output.payload.anchor,
    }),
  ],
  worker: {
    model: models.worker,
    system: "Classify the subject.",
    prompt: (input) => input.subject,
  },
  validator: { model: models.validator },
  maxAttempts: 2,
});

/** What the `gate` graph carries. */
export type GateState = {
  subject: string;
  classified?: ClassifyDecision;
  anchor?: string;
  answer?: "approve" | "reject";
  /** How the artifact row landed, so the terminal can say. */
  persisted?: string;
};

export const GateInput = z.object({ subject: z.string().min(1) });
export type GateInput = z.infer<typeof GateInput>;

export const gateSeed = (input: GateInput): GateState => ({ subject: input.subject });

export const GateAnswer = z.object({
  decision: z.enum(["approve", "reject"]),
  notes: z.string().optional(),
});
export type GateAnswer = z.infer<typeof GateAnswer>;

export const ARTIFACT_TABLE = "gate_rows";

/**
 * A leaf, a branch, a person, a step that writes, and two terminals.
 *
 * `classify` decides; `classify.route` routes; `ask` parks; `ask.route` routes
 * the person's answer exactly as it routed the model's; `persist` emits the
 * one effect, and the branch after it reads the outcome the executor returned.
 */
export const gateGraph = (
  journal: Journal,
  models: GateModels,
  observe?: (attempt: never) => void,
): Workflow<GateState> => ({
  start: "classify",
  nodes: {
    classify: leaf<GateState, ClassifyInput, ClassifyOutput>({
      def: classifyDef(models),
      journal,
      input: (s) => ({ subject: s.subject }),
      absorb: (s, r) =>
        r.decision === "ok"
          ? { ...s, classified: r.output.decision, anchor: r.output.payload.anchor }
          : { ...s, classified: "needs-a-person" },
      ...(observe === undefined ? {} : { observe: observe as never }),
      next: "classify.route",
    }),

    "classify.route": branch<GateState, ClassifyDecision>(
      (s) => s.classified ?? "needs-a-person",
      { ready: "persist", "needs-a-person": "ask" },
    ),

    ask: suspend<GateState, GateAnswer>({
      reason: () => "a person decides",
      trail: (s) => [{ subject: s.subject, anchor: s.anchor }],
      resumeSchema: GateAnswer,
      absorb: (s, answer) => ({ ...s, answer: answer.decision }),
      next: "ask.route",
    }),

    "ask.route": branch<GateState, GateAnswer["decision"]>((s) => s.answer ?? "reject", {
      approve: "persist",
      reject: "reject",
    }),

    persist: {
      type: "step",
      run: async (s) => ({
        state: s,
        effects: [
          {
            type: "upsert-artifact",
            table: ARTIFACT_TABLE,
            id: s.subject,
            expectedVersion: 0,
            row: { subject: s.subject, anchor: s.anchor ?? "" },
          },
        ],
      }),
      absorb: (s, results) => ({ ...s, persisted: results[0]?.outcome ?? "infra-failed" }),
      next: "accept",
    },

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: [s.answer] }) },
  },
});

/**
 * The bindings the gate graph's one leaf answers from.
 *
 * Both slots are the same scripted binding: it dispatches on the call's role,
 * so the worker answers from the script and the validator passes. The anchor
 * must be a verbatim substring of the subject, because the leaf's own
 * mechanical check runs for real now — which is the point of stubbing at the
 * binding rather than at the journal.
 */
export const gateModels = (decision: ClassifyDecision, anchor: string): GateModels => {
  const binding = scriptedBinding({ "fixture.classify": [{ decision, payload: { anchor } }] });
  return { worker: binding, validator: binding };
};

/* ------------------------------------------------------------- the loop */

export type SpinState = { n: number; iterations?: number; exhausted?: boolean };

/** A bounded loop and the branch after it, for the projection's sake. */
export const spinGraph = (): Workflow<SpinState> => ({
  start: "spin",
  nodes: {
    spin: loop<SpinState>({
      body: "bump",
      until: (s) => s.n >= 2,
      max: 3,
      absorb: (s: SpinState, exit: LoopExit) => ({
        ...s,
        iterations: exit.iterations,
        exhausted: exit.exhausted,
      }),
      next: "spin.verdict",
    }),
    bump: {
      type: "step",
      run: async (s) => ({ state: { ...s, n: s.n + 1 }, effects: [] }),
      absorb: (s) => s,
      next: "spin",
    },
    "spin.verdict": branch<SpinState, "done" | "stuck">((s) => (s.n >= 2 ? "done" : "stuck"), {
      done: "accept",
      stuck: "reject",
    }),
    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: [] }) },
  },
});

/* ------------------------------------------------------------- the overlap */

/**
 * How many runs were inside the step at once, at the most.
 *
 * What a resource lease is FOR is making two rows take turns, and the only
 * honest way to see that from outside is to watch whether they were ever both
 * in the work at the same moment. So the fixture counts.
 */
export type Overlap = {
  enter(): void;
  leave(): void;
  peak(): number;
};

export const overlapTracker = (): Overlap => {
  let held = 0;
  let peak = 0;
  return {
    enter: () => {
      held += 1;
      peak = Math.max(peak, held);
    },
    leave: () => {
      held -= 1;
    },
    peak: () => peak,
  };
};

export type BusyState = { row: string };

/** One step that takes long enough for a second run to be inside it too. */
export const busyGraph = (track: Overlap): Workflow<BusyState> => ({
  start: "work",
  nodes: {
    work: {
      type: "step",
      run: async (s) => {
        track.enter();
        await Bun.sleep(25);
        track.leave();
        return { state: s, effects: [] };
      },
      absorb: (s) => s,
      next: "accept",
    },
    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
  },
});
