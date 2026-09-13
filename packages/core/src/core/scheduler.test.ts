/**
 * The scheduler, against fake steps and a fake `runOne`.
 *
 * Generic on purpose, so its own arithmetic is testable without a workflow, a
 * VCS or a real step set: what has to hold is the frontier rule, the
 * concurrency limit, the blast radius of a step that did not succeed, the
 * resource leases, and termination. A consumer's own tests are where the
 * composition over real steps is driven.
 */

import { describe, expect, test } from "bun:test";
import { inMemoryLeases, openScheduler, type StepStatus, type SchedulerStep } from "./scheduler.ts";
import type { RunOutcome } from "./workflow.ts";

type S = { id: string };

const accepted = (id: string): RunOutcome<S> => ({
  kind: "terminal",
  terminal: { kind: "accepted", state: { id } },
  trace: [],
  runId: `run-${id}`,
});

const rejected = (id: string): RunOutcome<S> => ({
  kind: "terminal",
  terminal: { kind: "rejected", state: { id }, trail: [] },
  trace: [],
  runId: `run-${id}`,
});

const suspended = (id: string): RunOutcome<S> => ({
  kind: "suspended",
  reason: "design-gap",
  trail: [],
  trace: [],
  runId: `run-${id}`,
});

/**
 * A projection over recorded outcomes, which is what a consumer's own store
 * is: the scheduler asks, it does not remember.
 */
const projection = () => {
  const recorded = new Map<string, StepStatus>();
  return {
    recorded,
    statusOf: async (id: string): Promise<StepStatus> => recorded.get(id) ?? "pending",
    record: async (id: string, outcome: RunOutcome<S>) => {
      recorded.set(id, outcome.kind === "suspended" ? "suspended" : outcome.terminal.kind);
    },
  };
};

/**
 * The diamond: A, then B and C in parallel, then D. The shape that makes the
 * frontier rule worth having — B and C are independent of each other and both
 * gate D.
 */
const DIAMOND: SchedulerStep[] = [
  { id: "A", dependencies: [] },
  { id: "B", dependencies: ["A"] },
  { id: "C", dependencies: ["A"] },
  { id: "D", dependencies: ["B", "C"] },
];

describe("the frontier", () => {
  test("a diamond runs A, then B and C, then D", async () => {
    const store = projection();
    const order: string[] = [];
    const scheduler = openScheduler<S>({
      steps: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (step) => {
        order.push(step.id);
        return accepted(step.id);
      },
      resumeOne: async (step) => accepted(step.id),
    });

    const statuses = await scheduler.run();

    expect(order[0]).toBe("A");
    expect(order.slice(1, 3).sort()).toEqual(["B", "C"]);
    expect(order[3]).toBe("D");
    expect([...statuses.values()].every((s) => s === "accepted")).toBe(true);
  });

  test("a step already accepted in the projection is not run again", async () => {
    const store = projection();
    store.recorded.set("A", "accepted");
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      steps: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (step) => {
        ran.push(step.id);
        return accepted(step.id);
      },
      resumeOne: async (step) => accepted(step.id),
    });

    await scheduler.run();
    // State is a projection: a scheduler that restarted part-way through
    // picks up where the recorded facts say it got to.
    expect(ran.sort()).toEqual(["B", "C", "D"]);
  });

  test("the frontier is dependencies-accepted, not dependencies-finished", async () => {
    const store = projection();
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      steps: [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: ["A"] },
      ],
      concurrency: 2,
      ...store,
      runOne: async (step) => {
        ran.push(step.id);
        return step.id === "A" ? suspended(step.id) : accepted(step.id);
      },
      resumeOne: async (step) => accepted(step.id),
    });

    const statuses = await scheduler.run();
    expect(ran).toEqual(["A"]);
    expect(statuses.get("B")).toBe("pending");
  });
});

describe("the blast radius of a step that did not succeed", () => {
  test("a rejected step blocks its subtree and nothing else", async () => {
    const store = projection();
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      steps: [
        { id: "A", dependencies: [] },
        { id: "A-child", dependencies: ["A"] },
        { id: "A-grandchild", dependencies: ["A-child"] },
        { id: "B", dependencies: [] },
        { id: "B-child", dependencies: ["B"] },
      ],
      concurrency: 4,
      ...store,
      runOne: async (step) => {
        ran.push(step.id);
        return step.id === "A" ? rejected(step.id) : accepted(step.id);
      },
      resumeOne: async (step) => accepted(step.id),
    });

    const statuses = await scheduler.run();

    // The independent branch kept going, which is the whole point: a person's
    // queue is a list of independent blocked subtrees, not one stalled set.
    expect(ran.sort()).toEqual(["A", "B", "B-child"]);
    expect(statuses.get("A")).toBe("rejected");
    expect(statuses.get("A-child")).toBe("pending");
    expect(statuses.get("A-grandchild")).toBe("pending");
    expect(statuses.get("B-child")).toBe("accepted");
  });

  test("a suspended step resumes, and its dependents then run", async () => {
    const store = projection();
    const ran: string[] = [];
    let parkedOnce = false;
    const scheduler = openScheduler<S>({
      steps: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (step) => {
        ran.push(step.id);
        if (step.id === "A" && !parkedOnce) {
          parkedOnce = true;
          return suspended(step.id);
        }
        return accepted(step.id);
      },
      resumeOne: async (step) => accepted(step.id),
    });

    const parked = await scheduler.run();
    expect(ran).toEqual(["A"]);
    expect(parked.get("A")).toBe("suspended");
    expect(scheduler.parked().get("A")).toBe("run-A");

    // The resume re-evaluates the frontier in the same call, so answering one
    // step continues the WHOLE SET rather than the one step.
    const statuses = await scheduler.resume("A", { decision: "commit" });
    expect(ran.sort()).toEqual(["A", "B", "C", "D"]);
    expect([...statuses.values()].every((s) => s === "accepted")).toBe(true);
    expect(scheduler.parked().size).toBe(0);
  });

  test("resuming a step that is not parked is refused by name", async () => {
    const store = projection();
    const scheduler = openScheduler<S>({
      steps: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (step) => accepted(step.id),
      resumeOne: async (step) => accepted(step.id),
    });
    await scheduler.run();

    expect(scheduler.resume("A", {})).rejects.toThrow(/step A is not parked/);
    expect(scheduler.resume("nope", {})).rejects.toThrow(/no step nope/);
  });
});

describe("the concurrency limit", () => {
  /**
   * A run that yields a few microtask turns before finishing, so two steps the
   * scheduler started together genuinely overlap and the in-flight count is
   * observable without a clock or an external gate.
   */
  const counting = () => {
    let peak = 0;
    let live = 0;
    const runOne = async (step: SchedulerStep): Promise<RunOutcome<S>> => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      live -= 1;
      return accepted(step.id);
    };
    return { runOne, peak: () => peak };
  };

  const sixSteps = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, dependencies: [] }));

  test("never more than `concurrency` steps are in flight, and no fewer when there is work", async () => {
    const store = projection();
    const g = counting();
    const scheduler = openScheduler<S>({
      steps: sixSteps,
      concurrency: 2,
      ...store,
      runOne: g.runOne,
      resumeOne: async (step) => accepted(step.id),
    });

    const statuses = await scheduler.run();
    // The limit is a ceiling AND a target: the in-flight set is topped back up
    // as steps finish, so six steps at a limit of two is three batches.
    expect(g.peak()).toBe(2);
    expect([...statuses.values()].every((s) => s === "accepted")).toBe(true);
  });

  test("a limit above the step count runs them all at once", async () => {
    const store = projection();
    const g = counting();
    const scheduler = openScheduler<S>({
      steps: sixSteps,
      concurrency: 10,
      ...store,
      runOne: g.runOne,
      resumeOne: async (step) => accepted(step.id),
    });

    await scheduler.run();
    expect(g.peak()).toBe(6);
  });

  test("a limit of one is sequential", async () => {
    const store = projection();
    const g = counting();
    const scheduler = openScheduler<S>({
      steps: sixSteps,
      concurrency: 1,
      ...store,
      runOne: g.runOne,
      resumeOne: async (step) => accepted(step.id),
    });

    await scheduler.run();
    expect(g.peak()).toBe(1);
  });

  test("a concurrency of zero is a caller bug, refused at construction", () => {
    const store = projection();
    expect(() =>
      openScheduler<S>({
        steps: DIAMOND,
        concurrency: 0,
        ...store,
        runOne: async (step) => accepted(step.id),
        resumeOne: async (step) => accepted(step.id),
      }),
    ).toThrow(/concurrency must be a positive integer/);
  });
});

describe("resource leases", () => {
  /** Records the set of steps in flight at every moment a run starts. */
  const overlapping = () => {
    const live = new Set<string>();
    const together: string[][] = [];
    const runOne = async (step: SchedulerStep): Promise<RunOutcome<S>> => {
      live.add(step.id);
      together.push([...live].sort());
      // Two microtask turns, so a genuinely parallel pair overlaps here.
      await Promise.resolve();
      await Promise.resolve();
      live.delete(step.id);
      return accepted(step.id);
    };
    return { runOne, together };
  };

  const independent: SchedulerStep[] = [
    { id: "X", dependencies: [] },
    { id: "Y", dependencies: [] },
  ];

  test("two steps that share a resource serialize on it", async () => {
    const store = projection();
    const o = overlapping();
    const scheduler = openScheduler<S>({
      steps: independent,
      concurrency: 2,
      ...store,
      runOne: o.runOne,
      resumeOne: async (step) => accepted(step.id),
      resourcesFor: () => ["the-kernel-table"],
      leases: inMemoryLeases(),
    });

    await scheduler.run();
    // They are independent in the DAG and both need the one table, so they
    // serialize on that and on nothing else.
    expect(o.together).toEqual([["X"], ["Y"]]);
  });

  test("two steps that share nothing run together", async () => {
    const store = projection();
    const o = overlapping();
    const scheduler = openScheduler<S>({
      steps: independent,
      concurrency: 2,
      ...store,
      runOne: o.runOne,
      resumeOne: async (step) => accepted(step.id),
      resourcesFor: (step) => [`vm-${step.id}`],
      leases: inMemoryLeases(),
    });

    await scheduler.run();
    expect(o.together.at(-1)).toEqual(["X", "Y"]);
  });

  test("a step that needs nothing is not held up by a lease it did not ask for", async () => {
    const store = projection();
    const o = overlapping();
    const scheduler = openScheduler<S>({
      steps: independent,
      concurrency: 2,
      ...store,
      runOne: o.runOne,
      resumeOne: async (step) => accepted(step.id),
      resourcesFor: (step) => (step.id === "X" ? ["the-kernel-table"] : []),
      leases: inMemoryLeases(),
    });

    await scheduler.run();
    expect(o.together.at(-1)).toEqual(["X", "Y"]);
  });

  test("the lease is released when the run throws, not only when it returns", async () => {
    const leases = inMemoryLeases();
    const store = projection();
    const scheduler = openScheduler<S>({
      steps: [{ id: "X", dependencies: [] }],
      concurrency: 1,
      ...store,
      runOne: async () => {
        throw new Error("graph bug: a dangling edge");
      },
      resumeOne: async (step) => accepted(step.id),
      resourcesFor: () => ["the-kernel-table"],
      leases,
    });

    // A `runOne` that throws is a graph bug and is not absorbed into a status.
    await expect(scheduler.run()).rejects.toThrow(/graph bug/);
    // And the resource is free afterwards, so the next step is not deadlocked
    // behind a run that is over.
    const release = await leases.acquire(["the-kernel-table"]);
    release();
  });
});

describe("inMemoryLeases", () => {
  test("a multi-name acquire takes the whole set or waits for it", async () => {
    const leases = inMemoryLeases();
    const first = await leases.acquire(["a", "b"]);

    let granted = false;
    const second = leases.acquire(["b", "c"]).then((release) => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    first();
    await second;
    expect(granted).toBe(true);
  });

  test("an empty set is free", async () => {
    const leases = inMemoryLeases();
    const held = await leases.acquire(["a"]);
    (await leases.acquire([]))();
    held();
  });

  test("waiters are granted in the order they asked", async () => {
    const leases = inMemoryLeases();
    const held = await leases.acquire(["a"]);
    const order: string[] = [];
    const first = leases.acquire(["a"]).then((r) => {
      order.push("first");
      return r;
    });
    const second = leases.acquire(["a"]).then((r) => {
      order.push("second");
      return r;
    });

    held();
    (await first)();
    (await second)();
    // FIFO, so which of two blocked steps goes first is a function of the order
    // they asked rather than of timing.
    expect(order).toEqual(["first", "second"]);
  });
});

describe("termination", () => {
  test("an empty step set terminates at once", async () => {
    const store = projection();
    const scheduler = openScheduler<S>({
      steps: [],
      concurrency: 1,
      ...store,
      runOne: async (step) => accepted(step.id),
      resumeOne: async (step) => accepted(step.id),
    });
    expect([...(await scheduler.run())]).toEqual([]);
  });

  test("a step set whose steps all block terminates rather than spinning", async () => {
    const store = projection();
    const scheduler = openScheduler<S>({
      steps: [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: ["A"] },
      ],
      concurrency: 2,
      ...store,
      runOne: async (step) => rejected(step.id),
      resumeOne: async (step) => accepted(step.id),
    });

    const statuses = await scheduler.run();
    expect(statuses.get("A")).toBe("rejected");
    expect(statuses.get("B")).toBe("pending");
  });

  test("a dependency on a step the set does not hold never becomes ready", async () => {
    // The scheduler does not adjudicate a dangling dependency: the consumer
    // that authored the step set is where a dangling id is refused as a named
    // defect, before anything is dispatched.
    const store = projection();
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      steps: [{ id: "A", dependencies: ["nowhere"] }],
      concurrency: 1,
      ...store,
      runOne: async (step) => {
        ran.push(step.id);
        return accepted(step.id);
      },
      resumeOne: async (step) => accepted(step.id),
    });

    expect((await scheduler.run()).get("A")).toBe("pending");
    expect(ran).toEqual([]);
  });
});

describe("eligibility, beyond the frontier", () => {
  test("an ineligible step never runs, and blocks its dependents exactly like a rejected one", async () => {
    // The frontier rule answers "is everything this step waits on done". It
    // does not answer "may this step start at all", and a consumer with a
    // precondition of its own — "this step's oracle was measured red", say —
    // has nowhere else to put it.
    const ran: string[] = [];
    const statuses = new Map<string, StepStatus>([
      ["a", "pending"],
      ["b", "pending"],
      ["c", "pending"],
    ]);
    const scheduler = openScheduler<null>({
      steps: [
        { id: "a", dependencies: [] },
        { id: "b", dependencies: ["a"] },
        { id: "c", dependencies: [] },
      ],
      concurrency: 2,
      eligible: async (id) => id !== "a",
      runOne: async (step) => {
        ran.push(step.id);
        return { kind: "terminal", terminal: { kind: "accepted", state: null }, trace: [], runId: step.id };
      },
      resumeOne: async () => {
        throw new Error("not resumed here");
      },
      statusOf: async (id) => statuses.get(id) ?? "pending",
      record: async (id) => {
        statuses.set(id, "accepted");
      },
    });

    const final = await scheduler.run();

    // `a` never ran, so `b` never became ready; `c` is downstream of nothing.
    expect(ran).toEqual(["c"]);
    expect(final.get("a")).toBe("pending");
    expect(final.get("b")).toBe("pending");
    expect(final.get("c")).toBe("accepted");
  });

  test("with no predicate every step is eligible, which is the behaviour before it existed", async () => {
    const ran: string[] = [];
    const statuses = new Map<string, StepStatus>([["a", "pending"]]);
    const scheduler = openScheduler<null>({
      steps: [{ id: "a", dependencies: [] }],
      concurrency: 1,
      runOne: async (step) => {
        ran.push(step.id);
        return { kind: "terminal", terminal: { kind: "accepted", state: null }, trace: [], runId: step.id };
      },
      resumeOne: async () => {
        throw new Error("not resumed here");
      },
      statusOf: async (id) => statuses.get(id) ?? "pending",
      record: async (id) => {
        statuses.set(id, "accepted");
      },
    });
    await scheduler.run();
    expect(ran).toEqual(["a"]);
  });
});
