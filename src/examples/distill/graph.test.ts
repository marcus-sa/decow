/**
 * The exhaustive test. Three lanes, four classifiers, two boundary flags:
 * 3^4 * 2 = 162 paths. A journal pre-seeded with the outputs stands in for the
 * models. Every path must land on a declared terminal.
 *
 * Zero model calls, no API key, no network. The stub journal throws on a miss,
 * so a step that would reach a model fails the test instead of silently
 * spending one — and the model bindings the defs carry throw if called at all.
 */

import { describe, expect, test } from "bun:test";
import { run } from "../../core/workflow.ts";
import type { StepResult } from "../../core/step.ts";
import { cartesian, graphDefects } from "../../harness/enumerate-paths.ts";
import { endedOnTerminalNode, isDeclaredTerminal, visited } from "../../harness/matchers.ts";
import { exhausted, ok, stubJournal } from "../../harness/stub-journal.ts";
import {
  classifierDefs,
  classifierStepId,
  KINDS,
  LANES,
  type Classification,
  type Kind,
  type Lane,
} from "./classify.ts";
import { distillGraph, mergeVerdict, seed, type MergeVerdict, type State } from "./graph.ts";

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

const scenario = (crossesBoundary: boolean) => ({
  id: "S-1",
  text: SCENARIO_TEXT,
  crossesBoundary,
});

const noEffects = async () => [];

describe("distill graph", () => {
  test("the graph is structurally well-formed", () => {
    const wf = distillGraph(laneJournal({ e2e: "needed", expectation: "needed", benchmark: "needed", dst: "needed" }), defs);
    expect(graphDefects(wf)).toEqual([]);
  });

  test("every classifier outcome reaches a declared terminal", async () => {
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
        const { result, trace } = await run<State>(
          wf,
          seed(scenario(crossesBoundary)),
          noEffects,
        );

        expect(isDeclaredTerminal(result)).toBe(true);
        expect(["accepted", "rejected", "needs-human"]).toContain(result.kind);
        expect(endedOnTerminalNode(wf, trace)).toBe(true);
        expect(trace.at(-1)).toMatch(/^(accept|needs-human)$/);
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
    const { result, trace } = await run<State>(
      distillGraph(journal, defs),
      seed(scenario(false)),
      noEffects,
    );

    expect(trace).toContain("demote-expectation");
    expect(result.kind).toBe("accepted");
    expect(result.kind === "accepted" && result.state.expectation.lane).toBe("not-needed");
  });

  test("the conflict rule wins over the boundary rule on a boundary-crossing scenario", async () => {
    const journal = laneJournal({
      e2e: "not-needed",
      expectation: "needed",
      benchmark: "needed",
      dst: "not-needed",
    });
    const { result, trace } = await run<State>(
      distillGraph(journal, defs),
      seed(scenario(true)),
      noEffects,
    );
    expect(visited(trace, "demote-expectation")).toBe(true);
    expect(result.kind).toBe("accepted");
  });

  test("an exhausted classifier routes to needs-human with a typed reason", async () => {
    const journal = stubJournal({
      ...(Object.fromEntries(
        KINDS.map((k) => [classifierStepId(k), ok(classification("needed"))]),
      ) as Record<string, StepResult<unknown>>),
      [classifierStepId("dst")]: exhausted(),
    });

    const { result, trace } = await run<State>(
      distillGraph(journal, defs),
      seed(scenario(false)),
      noEffects,
    );

    expect(trace.at(-1)).toBe("needs-human");
    expect(result.kind === "needs-human" && result.reason).toBe("validator-exhausted");
  });

  test("exhaustion is detected regardless of which classifier exhausted", async () => {
    // The positional fanout merge must not lose an earlier classifier's
    // exhaustion behind a later one's success.
    for (const exhaustedKind of KINDS) {
      const journal = stubJournal({
        ...(Object.fromEntries(
          KINDS.map((k) => [classifierStepId(k), ok(classification("needed"))]),
        ) as Record<string, StepResult<unknown>>),
        [classifierStepId(exhaustedKind)]: exhausted(),
      });
      const { result } = await run<State>(distillGraph(journal, defs), seed(scenario(false)), noEffects);
      expect(result.kind).toBe("needs-human");
      expect(result.kind === "needs-human" && result.reason).toBe("validator-exhausted");
    }
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
