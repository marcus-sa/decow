/**
 * The path walker, against a synthetic decider rather than a workflow.
 *
 * `enumeratePaths` is what makes the claim "447 paths, every one of them
 * reaches a declared outcome" checkable, so its own arithmetic is worth
 * pinning: it must visit each reachable combination exactly once, it must not
 * visit combinations a shorter path never reached, and it must refuse a
 * decision order that is not a function of the decisions already made.
 *
 * `scriptedExecutor` is the second axis and is pinned the same way: an effect
 * forks once per declared outcome, an effect type with no declared outcomes is
 * refused rather than answered, and a step that emits nothing forks nothing.
 */

import { describe, expect, test } from "bun:test";
import {
  cartesian,
  enumeratePaths,
  loopBody,
  scriptedExecutor,
  type EffectOutcomeSpace,
} from "./enumerate-paths.ts";
import type { Effect, EffectResult } from "../core/effects.ts";
import { branch, loop, type Workflow } from "../core/workflow.ts";

describe("cartesian", () => {
  test("is every n-length tuple, in a stable order", () => {
    expect(cartesian(["a", "b"], 2)).toEqual([
      ["a", "a"],
      ["b", "a"],
      ["a", "b"],
      ["b", "b"],
    ]);
    expect(cartesian(["x", "y", "z"], 4)).toHaveLength(81);
    expect(cartesian(["x"], 0)).toEqual([[]]);
  });
});

describe("enumeratePaths", () => {
  test("walks a fixed decision tuple exactly once per combination", async () => {
    const paths = await enumeratePaths(async (choose) => {
      const a = choose("a", ["1", "2", "3"] as const);
      const b = choose("b", ["x", "y"] as const);
      return `${a}${b}`;
    });
    expect(paths.sort()).toEqual(["1x", "1y", "2x", "2y", "3x", "3y"]);
  });

  test("never walks a choice a shorter path did not reach", async () => {
    // The second choice only exists on one branch of the first, so the space
    // is 3, not 6. This is the whole reason the DELIVER walk is four figures
    // rather than six: unreachable combinations are never run.
    const paths = await enumeratePaths(async (choose) => {
      const first = choose("first", ["stop", "go"] as const);
      if (first === "stop") return "stop";
      return `go-${choose("second", ["a", "b"] as const)}`;
    });
    expect(paths.sort()).toEqual(["go-a", "go-b", "stop"]);
  });

  test("a bounded repetition is finite; the bound is the multiplier", async () => {
    const MAX = 3;
    const paths = await enumeratePaths(async (choose) => {
      const seen: string[] = [];
      for (let i = 0; i < MAX; i += 1) {
        const answer = choose(`tick#${i}`, ["again", "done"] as const);
        seen.push(answer);
        if (answer === "done") break;
      }
      return seen.join(",");
    });
    // again^k then done, for k < MAX, plus the one path that runs out.
    expect(paths.sort()).toEqual([
      "again,again,again",
      "again,again,done",
      "again,done",
      "done",
    ]);
  });

  test("a decision order that is not a function of prior decisions is refused", async () => {
    let flip = false;
    const walk = enumeratePaths(async (choose) => {
      // Reading the same two choices in a different order run to run is what
      // a fanout does. The walker names it rather than miscounting.
      const ids = flip ? ["b", "a"] : ["a", "b"];
      flip = !flip;
      return ids.map((id) => choose(id, ["0", "1"] as const)).join("");
    });
    expect(walk).rejects.toThrow(/the decision order must be a function of the decisions already made/);
  });

  test("a choice point with no options is a harness bug, named as one", async () => {
    expect(enumeratePaths(async (choose) => choose("empty", []))).rejects.toThrow(
      /choice point "empty" has no options/,
    );
  });
});

/**
 * The second axis. A leaf's decision is one thing a graph routes on; the typed
 * result of the effects it asked for is the other, and a walk that enumerates
 * only the first covers half the edge tables.
 */
describe("scriptedExecutor: the effect-outcome axis", () => {
  const trail = (line: string): Effect => ({ type: "append-trail", line });
  const write = (symbolId: string): Effect => ({
    type: "replace-symbol",
    symbolId,
    expectedVersion: 1,
    body: "…",
  });

  const SPACE: EffectOutcomeSpace = {
    "replace-symbol": [
      { name: "committed", result: (e) => ({ effect: e, outcome: "committed", version: 2 }) },
      { name: "conflict", result: (e) => ({ effect: e, outcome: "conflict", currentVersion: 7 }) },
      { name: "rejected", result: (e) => ({ effect: e, outcome: "rejected", by: "typecheck" }) },
    ],
    "append-trail": [
      { name: "committed", result: (e) => ({ effect: e, outcome: "committed", version: 1 }) },
    ],
  };

  test("an effect forks the walk once per declared outcome", async () => {
    const paths = await enumeratePaths(async (choose) => {
      const execute = scriptedExecutor(choose, SPACE);
      const [result] = await execute([write("s-1")]);
      return (result as EffectResult).outcome;
    });
    expect(paths.sort()).toEqual(["committed", "conflict", "rejected"]);
  });

  test("two effects in one batch fork independently, which is the product", async () => {
    const paths = await enumeratePaths(async (choose) => {
      const execute = scriptedExecutor(choose, SPACE);
      const results = await execute([write("s-1"), write("s-2")]);
      return results.map((r) => r.outcome).join("+");
    });
    expect(paths).toHaveLength(9);
  });

  test("a one-outcome effect type forks nothing", async () => {
    const paths = await enumeratePaths(async (choose) => {
      const execute = scriptedExecutor(choose, SPACE);
      const [result] = await execute([trail("a line")]);
      return (result as EffectResult).outcome;
    });
    expect(paths).toEqual(["committed"]);
  });

  test("a step that emits no effects forks nothing", async () => {
    const paths = await enumeratePaths(async (choose) => {
      const execute = scriptedExecutor(choose, SPACE);
      expect(await execute([])).toEqual([]);
      return "one path";
    });
    expect(paths).toEqual(["one path"]);
  });

  test("an effect type the space does not declare is refused, not committed", async () => {
    // Silently committing would make the walk's coverage claim a fiction for
    // that effect: the edges its other outcomes route to would never be
    // walked, and nothing would say so.
    const execute = scriptedExecutor(<T,>(_id: string, options: readonly T[]) => options[0] as T, SPACE);
    await expect(execute([{ type: "run-tests", impacted: [] }])).rejects.toThrow(
      /no declared outcome space for effect "run-tests"/,
    );
  });

  test("an effect type declared with an empty space is refused too", async () => {
    const execute = scriptedExecutor(
      <T,>(_id: string, options: readonly T[]) => options[0] as T,
      { "append-trail": [] },
    );
    await expect(execute([trail("a line")])).rejects.toThrow(/no declared outcome space/);
  });
});

describe("loopBody", () => {
  type S = { n: number };
  const wf: Workflow<S> = {
    start: "spin",
    nodes: {
      spin: loop<S>({
        body: "head",
        until: (s) => s.n > 0,
        max: 2,
        absorb: (s) => s,
        next: "done",
      }),
      head: branch<S, "again" | "more">((s) => (s.n > 0 ? "again" : "more"), {
        again: "spin",
        more: "tail",
      }),
      tail: {
        type: "step",
        run: async (s) => ({ state: s, effects: [] }),
        absorb: (s) => s,
        next: "spin",
      },
      done: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    },
  };

  test("is the nodes that can reach the loop again, and nothing else", () => {
    expect([...loopBody(wf, "spin")].sort()).toEqual(["head", "tail"]);
    // The exit is past the loop, not inside it.
    expect(loopBody(wf, "spin").has("done")).toBe(false);
  });

  test("is empty for a node that is not a loop", () => {
    expect(loopBody(wf, "head").size).toBe(0);
  });
});
