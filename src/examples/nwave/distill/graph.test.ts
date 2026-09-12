/**
 * The exhaustive test. Three lanes, four classifiers, two boundary flags:
 * 3^4 * 2 = 162 paths. A journal pre-seeded with the outputs stands in for the
 * models. Every path must land on a declared outcome: a terminal, or parked
 * for a person.
 *
 * Zero model calls, no API key, no network. The stub journal throws on a miss,
 * so a step that would reach a model fails the test instead of silently
 * spending one — and the model bindings the defs carry throw if called at all.
 */

import { describe, expect, test } from "bun:test";
import { resume, run } from "../../../core/workflow.ts";
import type { StepResult } from "../../../core/step.ts";
import { cartesian, graphDefects } from "../../../harness/enumerate-paths.ts";
import { endedOnDeclaredNode, isDeclaredOutcome, visited } from "../../../harness/matchers.ts";
import { exhausted, ok, stubJournal } from "../../../harness/stub-journal.ts";
import {
  classifierDefs,
  classifierStepId,
  KINDS,
  LANES,
  type Classification,
  type Kind,
  type Lane,
} from "./classify.ts";
import {
  distillGraph,
  mergeVerdict,
  seed,
  type HumanAnswer,
  type MergeVerdict,
  type State,
} from "./graph.ts";

const SCENARIO_TEXT = "Launch 500 microVMs and record the p99 boot latency under a fixed concurrency profile.";
const ANCHOR = "record the p99 boot latency";

/** A model binding that fails the test if anything reaches a model. */
const forbidden = (id: string) => ({
  id,
  generate: async <T,>(): Promise<T> => {
    throw new Error(`model "${id}" was called; the enumeration suite must spend zero model calls`);
  },
});

const defs = classifierDefs({
  worker: forbidden("worker"),
  validator: forbidden("validator"),
  escalateTo: forbidden("escalate"),
});

const classification = (decision: Lane): Classification => ({
  decision,
  payload: { anchor: ANCHOR, rationale: `stubbed: ${decision}` },
});

/** Seeds one StepResult per classifier step id. */
const laneJournal = (lanes: Record<Kind, Lane>) =>
  stubJournal(
    Object.fromEntries(
      KINDS.map((k) => [classifierStepId(k), ok(classification(lanes[k]))]),
    ) as Record<string, StepResult<unknown>>,
  );

/** The same, with one classifier's validator never satisfied. */
const exhaustedJournal = (exhaustedKind: Kind, lane: Lane = "needed") =>
  stubJournal({
    ...(Object.fromEntries(
      KINDS.map((k) => [classifierStepId(k), ok(classification(lane))]),
    ) as Record<string, StepResult<unknown>>),
    [classifierStepId(exhaustedKind)]: exhausted(),
  });

const scenario = (crossesBoundary: boolean) => ({
  id: "S-1",
  text: SCENARIO_TEXT,
  crossesBoundary,
});

const noEffects = async () => [];

/** Lanes that route to `incomplete-boundary`, which parks for a person. */
const BLOCKED_LANES: Record<Kind, Lane> = {
  e2e: "not-needed",
  expectation: "not-needed",
  benchmark: "not-needed",
  dst: "not-needed",
};

describe("distill graph", () => {
  test("the graph is structurally well-formed", () => {
    const wf = distillGraph(laneJournal(BLOCKED_LANES), defs);
    expect(graphDefects(wf)).toEqual([]);
  });

  test("every classifier outcome reaches a declared outcome", async () => {
    let paths = 0;
    for (const [e2e, expectation, benchmark, dst] of cartesian(LANES, 4) as Lane[][]) {
      for (const crossesBoundary of [true, false]) {
        const journal = laneJournal({
          e2e: e2e as Lane,
          expectation: expectation as Lane,
          benchmark: benchmark as Lane,
          dst: dst as Lane,
        });
        const wf = distillGraph(journal, defs);
        const outcome = await run<State>(wf, seed(scenario(crossesBoundary)), noEffects);

        expect(isDeclaredOutcome(outcome)).toBe(true);
        expect(endedOnDeclaredNode(wf, outcome)).toBe(true);
        expect(outcome.trace.at(-1)).toMatch(/^(accept|reject|human)$/);
        if (outcome.kind === "terminal") {
          expect(["accepted", "rejected"]).toContain(outcome.terminal.kind);
        }
        // Nothing reached a model: every classifier was a journal hit.
        expect(journal.reads.length).toBe(KINDS.length);
        paths += 1;
      }
    }
    expect(paths).toBe(162);
  });

  test("benchmark plus expectation always demotes expectation", async () => {
    const journal = laneJournal({
      e2e: "not-needed",
      expectation: "needed",
      benchmark: "needed",
      dst: "not-needed",
    });
    const outcome = await run<State>(distillGraph(journal, defs), seed(scenario(false)), noEffects);

    expect(outcome.trace).toContain("demote-expectation");
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(
      outcome.kind === "terminal" &&
        outcome.terminal.kind === "accepted" &&
        outcome.terminal.state.expectation.lane,
    ).toBe("not-needed");
  });

  test("the conflict rule wins over the boundary rule on a boundary-crossing scenario", async () => {
    const journal = laneJournal({
      e2e: "not-needed",
      expectation: "needed",
      benchmark: "needed",
      dst: "not-needed",
    });
    const outcome = await run<State>(distillGraph(journal, defs), seed(scenario(true)), noEffects);
    expect(visited(outcome.trace, "demote-expectation")).toBe(true);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
  });

  test("an exhausted classifier parks for a person with a typed reason and the trail", async () => {
    const outcome = await run<State>(
      distillGraph(exhaustedJournal("dst"), defs),
      seed(scenario(false)),
      noEffects,
    );

    expect(outcome.kind).toBe("suspended");
    if (outcome.kind !== "suspended") return;
    expect(outcome.reason).toBe("validator-exhausted");
    expect(outcome.trace.at(-1)).toBe("human");
    expect(outcome.runId).toBeTruthy();
    // The trail is the evidence: one row per classifier, dst flagged exhausted.
    expect(outcome.trail).toHaveLength(KINDS.length);
    expect(outcome.trail).toContainEqual({ kind: "dst", lane: "cannot-tell", exhausted: true });
  });

  test("an incomplete boundary parks for a person under its own reason", async () => {
    const outcome = await run<State>(
      distillGraph(laneJournal(BLOCKED_LANES), defs),
      seed(scenario(true)),
      noEffects,
    );
    expect(outcome.kind === "suspended" && outcome.reason).toBe("incomplete-boundary");
  });

  test("exhaustion is detected regardless of which classifier exhausted", async () => {
    // The per-slice fanout merge must not lose an earlier classifier's
    // exhaustion behind a later one's success.
    for (const exhaustedKind of KINDS) {
      const outcome = await run<State>(
        distillGraph(exhaustedJournal(exhaustedKind), defs),
        seed(scenario(false)),
        noEffects,
      );
      expect(outcome.kind).toBe("suspended");
      expect(outcome.kind === "suspended" && outcome.reason).toBe("validator-exhausted");
    }
  });

  test("the trace is the traversal, fanout sub-steps in declaration order", async () => {
    const fanout = [
      "classify",
      "classify.e2e",
      "classify.expectation",
      "classify.benchmark",
      "classify.dst",
    ];
    const complete = await run<State>(
      distillGraph(laneJournal(BLOCKED_LANES), defs),
      seed(scenario(false)),
      noEffects,
    );
    expect(complete.trace).toEqual([...fanout, "merge", "accept"]);

    const conflicted = await run<State>(
      distillGraph(
        laneJournal({ e2e: "needed", expectation: "needed", benchmark: "needed", dst: "needed" }),
        defs,
      ),
      seed(scenario(false)),
      noEffects,
    );
    expect(conflicted.trace).toEqual([...fanout, "merge", "demote-expectation", "accept"]);

    const parked = await run<State>(
      distillGraph(laneJournal(BLOCKED_LANES), defs),
      seed(scenario(true)),
      noEffects,
    );
    expect(parked.trace).toEqual([...fanout, "merge", "human"]);
  });

  test("mergeVerdict is total over the state space it can see", () => {
    const verdicts = new Set<MergeVerdict>();
    for (const [e2e, expectation, benchmark, dst] of cartesian(LANES, 4) as Lane[][]) {
      for (const crossesBoundary of [true, false]) {
        for (const isExhausted of [true, false]) {
          const s: State = {
            scenario: scenario(crossesBoundary),
            e2e: { lane: e2e as Lane, exhausted: isExhausted },
            expectation: { lane: expectation as Lane },
            benchmark: { lane: benchmark as Lane },
            dst: { lane: dst as Lane },
          };
          verdicts.add(mergeVerdict(s));
        }
      }
    }
    expect([...verdicts].sort()).toEqual([
      "benchmark-expectation-conflict",
      "complete",
      "incomplete-boundary",
      "undecidable",
    ]);
  });
});

describe("distill graph, resumed by a person", () => {
  /** Park a run on `human` and hand back the graph plus the parked run id. */
  const park = async () => {
    const wf = distillGraph(laneJournal(BLOCKED_LANES), defs);
    const parked = await run<State>(wf, seed(scenario(true)), noEffects);
    expect(parked.kind).toBe("suspended");
    if (parked.kind !== "suspended") throw new Error("expected the run to park");
    return { wf, parked };
  };

  test("abandon reaches the rejected terminal", async () => {
    const { wf, parked } = await park();
    const answer: HumanAnswer = { decision: "abandon" };
    const outcome = await resume<State>(wf, parked.runId, answer, noEffects);

    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
    expect(outcome.trace.at(-1)).toBe("reject");
    // The trace spans both halves of the run: it survived the suspension.
    expect(outcome.trace.slice(0, parked.trace.length)).toEqual(parked.trace);
    expect(outcome.runId).toBe(parked.runId);
  });

  test("proceed re-runs the merge, which still blocks, and rejects", async () => {
    const { wf, parked } = await park();
    const answer: HumanAnswer = { decision: "proceed" };
    const outcome = await resume<State>(wf, parked.runId, answer, noEffects);

    expect(visited(outcome.trace, "merge.after-human")).toBe(true);
    expect(visited(outcome.trace, "apply-override")).toBe(false);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("rejected");
  });

  test("override sets the lane, clears the block, and accepts", async () => {
    const { wf, parked } = await park();
    const answer: HumanAnswer = { decision: "override", override: { kind: "e2e", lane: "needed" } };
    const outcome = await resume<State>(wf, parked.runId, answer, noEffects);

    expect(visited(outcome.trace, "apply-override")).toBe(true);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
    expect(
      outcome.kind === "terminal" && outcome.terminal.kind === "accepted"
        ? outcome.terminal.state.e2e
        : undefined,
    ).toEqual({ lane: "needed", anchor: "<human override>", exhausted: false });
  });

  test("an override answers what a validator could not, and the second merge re-converges", async () => {
    const wf = distillGraph(exhaustedJournal("dst"), defs);
    const parked = await run<State>(wf, seed(scenario(false)), noEffects);
    expect(parked.kind === "suspended" && parked.reason).toBe("validator-exhausted");
    if (parked.kind !== "suspended") return;

    const answer: HumanAnswer = { decision: "override", override: { kind: "dst", lane: "needed" } };
    const outcome = await resume<State>(wf, parked.runId, answer, noEffects);

    // Every lane is now "needed", so benchmark and expectation conflict and the
    // second merge routes through the SAME demote-expectation node the first
    // merge uses. Re-convergence, compiled once per path, no cycle.
    expect(visited(outcome.trace, "demote-expectation")).toBe(true);
    expect(outcome.kind === "terminal" && outcome.terminal.kind).toBe("accepted");
  });

  test("the parked run carries the effects the trail describes", async () => {
    const wf = distillGraph(exhaustedJournal("benchmark"), defs);
    const lines: string[] = [];
    const collect = async (effects: { type: string; line?: string }[]) => {
      for (const e of effects) if (e.type === "append-trail" && e.line) lines.push(e.line);
      return [];
    };
    const parked = await run<State>(wf, seed(scenario(false)), collect as never);
    expect(parked.kind).toBe("suspended");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"leaf":"benchmark"');
  });
});
