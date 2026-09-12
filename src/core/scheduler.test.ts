/**
 * The scheduler, against fake rows and a fake `runOne`.
 *
 * Generic on purpose, so its own arithmetic is testable without a workflow, a
 * VCS or a roadmap: what has to hold is the frontier rule, the concurrency
 * limit, the blast radius of a row that did not succeed, the resource leases,
 * and termination. The composition over real roadmap rows is
 * `src/examples/nwave/deliver/pipeline.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { inMemoryLeases, openScheduler, type RowStatus, type SchedulerRow } from "./scheduler.ts";
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
  const recorded = new Map<string, RowStatus>();
  return {
    recorded,
    statusOf: async (id: string): Promise<RowStatus> => recorded.get(id) ?? "pending",
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
const DIAMOND: SchedulerRow[] = [
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
      rows: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (row) => {
        order.push(row.id);
        return accepted(row.id);
      },
      resumeOne: async (row) => accepted(row.id),
    });

    const statuses = await scheduler.run();

    expect(order[0]).toBe("A");
    expect(order.slice(1, 3).sort()).toEqual(["B", "C"]);
    expect(order[3]).toBe("D");
    expect([...statuses.values()].every((s) => s === "accepted")).toBe(true);
  });

  test("a row already accepted in the projection is not run again", async () => {
    const store = projection();
    store.recorded.set("A", "accepted");
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      rows: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (row) => {
        ran.push(row.id);
        return accepted(row.id);
      },
      resumeOne: async (row) => accepted(row.id),
    });

    await scheduler.run();
    // State is a projection: a scheduler that restarted mid-feature picks up
    // where the recorded facts say it got to.
    expect(ran.sort()).toEqual(["B", "C", "D"]);
  });

  test("the frontier is dependencies-accepted, not dependencies-finished", async () => {
    const store = projection();
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      rows: [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: ["A"] },
      ],
      concurrency: 2,
      ...store,
      runOne: async (row) => {
        ran.push(row.id);
        return row.id === "A" ? suspended(row.id) : accepted(row.id);
      },
      resumeOne: async (row) => accepted(row.id),
    });

    const statuses = await scheduler.run();
    expect(ran).toEqual(["A"]);
    expect(statuses.get("B")).toBe("pending");
  });
});

describe("the blast radius of a row that did not succeed", () => {
  test("a rejected row blocks its subtree and nothing else", async () => {
    const store = projection();
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      rows: [
        { id: "A", dependencies: [] },
        { id: "A-child", dependencies: ["A"] },
        { id: "A-grandchild", dependencies: ["A-child"] },
        { id: "B", dependencies: [] },
        { id: "B-child", dependencies: ["B"] },
      ],
      concurrency: 4,
      ...store,
      runOne: async (row) => {
        ran.push(row.id);
        return row.id === "A" ? rejected(row.id) : accepted(row.id);
      },
      resumeOne: async (row) => accepted(row.id),
    });

    const statuses = await scheduler.run();

    // The independent branch kept going, which is the whole point: a person's
    // queue is a list of independent blocked subtrees, not a stalled feature.
    expect(ran.sort()).toEqual(["A", "B", "B-child"]);
    expect(statuses.get("A")).toBe("rejected");
    expect(statuses.get("A-child")).toBe("pending");
    expect(statuses.get("A-grandchild")).toBe("pending");
    expect(statuses.get("B-child")).toBe("accepted");
  });

  test("a suspended row resumes, and its dependents then run", async () => {
    const store = projection();
    const ran: string[] = [];
    let parkedOnce = false;
    const scheduler = openScheduler<S>({
      rows: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (row) => {
        ran.push(row.id);
        if (row.id === "A" && !parkedOnce) {
          parkedOnce = true;
          return suspended(row.id);
        }
        return accepted(row.id);
      },
      resumeOne: async (row) => accepted(row.id),
    });

    const parked = await scheduler.run();
    expect(ran).toEqual(["A"]);
    expect(parked.get("A")).toBe("suspended");
    expect(scheduler.parked().get("A")).toBe("run-A");

    // The resume re-evaluates the frontier in the same call, so answering one
    // row continues the FEATURE rather than the row.
    const statuses = await scheduler.resume("A", { decision: "commit" });
    expect(ran.sort()).toEqual(["A", "B", "C", "D"]);
    expect([...statuses.values()].every((s) => s === "accepted")).toBe(true);
    expect(scheduler.parked().size).toBe(0);
  });

  test("resuming a row that is not parked is refused by name", async () => {
    const store = projection();
    const scheduler = openScheduler<S>({
      rows: DIAMOND,
      concurrency: 4,
      ...store,
      runOne: async (row) => accepted(row.id),
      resumeOne: async (row) => accepted(row.id),
    });
    await scheduler.run();

    expect(scheduler.resume("A", {})).rejects.toThrow(/row A is not parked/);
    expect(scheduler.resume("nope", {})).rejects.toThrow(/no row nope/);
  });
});

describe("the concurrency limit", () => {
  /**
   * A run that yields a few microtask turns before finishing, so two rows the
   * scheduler started together genuinely overlap and the in-flight count is
   * observable without a clock or an external gate.
   */
  const counting = () => {
    let peak = 0;
    let live = 0;
    const runOne = async (row: SchedulerRow): Promise<RunOutcome<S>> => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      live -= 1;
      return accepted(row.id);
    };
    return { runOne, peak: () => peak };
  };

  const sixRows = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, dependencies: [] }));

  test("never more than `concurrency` rows are in flight, and no fewer when there is work", async () => {
    const store = projection();
    const g = counting();
    const scheduler = openScheduler<S>({
      rows: sixRows,
      concurrency: 2,
      ...store,
      runOne: g.runOne,
      resumeOne: async (row) => accepted(row.id),
    });

    const statuses = await scheduler.run();
    // The limit is a ceiling AND a target: the in-flight set is topped back up
    // as rows finish, so six rows at a limit of two is three batches.
    expect(g.peak()).toBe(2);
    expect([...statuses.values()].every((s) => s === "accepted")).toBe(true);
  });

  test("a limit above the row count runs them all at once", async () => {
    const store = projection();
    const g = counting();
    const scheduler = openScheduler<S>({
      rows: sixRows,
      concurrency: 10,
      ...store,
      runOne: g.runOne,
      resumeOne: async (row) => accepted(row.id),
    });

    await scheduler.run();
    expect(g.peak()).toBe(6);
  });

  test("a limit of one is sequential", async () => {
    const store = projection();
    const g = counting();
    const scheduler = openScheduler<S>({
      rows: sixRows,
      concurrency: 1,
      ...store,
      runOne: g.runOne,
      resumeOne: async (row) => accepted(row.id),
    });

    await scheduler.run();
    expect(g.peak()).toBe(1);
  });

  test("a concurrency of zero is a caller bug, refused at construction", () => {
    const store = projection();
    expect(() =>
      openScheduler<S>({
        rows: DIAMOND,
        concurrency: 0,
        ...store,
        runOne: async (row) => accepted(row.id),
        resumeOne: async (row) => accepted(row.id),
      }),
    ).toThrow(/concurrency must be a positive integer/);
  });
});

describe("resource leases", () => {
  /** Records the set of rows in flight at every moment a run starts. */
  const overlapping = () => {
    const live = new Set<string>();
    const together: string[][] = [];
    const runOne = async (row: SchedulerRow): Promise<RunOutcome<S>> => {
      live.add(row.id);
      together.push([...live].sort());
      // Two microtask turns, so a genuinely parallel pair overlaps here.
      await Promise.resolve();
      await Promise.resolve();
      live.delete(row.id);
      return accepted(row.id);
    };
    return { runOne, together };
  };

  const independent: SchedulerRow[] = [
    { id: "X", dependencies: [] },
    { id: "Y", dependencies: [] },
  ];

  test("two rows that share a resource serialize on it", async () => {
    const store = projection();
    const o = overlapping();
    const scheduler = openScheduler<S>({
      rows: independent,
      concurrency: 2,
      ...store,
      runOne: o.runOne,
      resumeOne: async (row) => accepted(row.id),
      resourcesFor: () => ["the-kernel-table"],
      leases: inMemoryLeases(),
    });

    await scheduler.run();
    // They are independent in the DAG and both need the one table, so they
    // serialize on that and on nothing else.
    expect(o.together).toEqual([["X"], ["Y"]]);
  });

  test("two rows that share nothing run together", async () => {
    const store = projection();
    const o = overlapping();
    const scheduler = openScheduler<S>({
      rows: independent,
      concurrency: 2,
      ...store,
      runOne: o.runOne,
      resumeOne: async (row) => accepted(row.id),
      resourcesFor: (row) => [`vm-${row.id}`],
      leases: inMemoryLeases(),
    });

    await scheduler.run();
    expect(o.together.at(-1)).toEqual(["X", "Y"]);
  });

  test("a row that needs nothing is not held up by a lease it did not ask for", async () => {
    const store = projection();
    const o = overlapping();
    const scheduler = openScheduler<S>({
      rows: independent,
      concurrency: 2,
      ...store,
      runOne: o.runOne,
      resumeOne: async (row) => accepted(row.id),
      resourcesFor: (row) => (row.id === "X" ? ["the-kernel-table"] : []),
      leases: inMemoryLeases(),
    });

    await scheduler.run();
    expect(o.together.at(-1)).toEqual(["X", "Y"]);
  });

  test("the lease is released when the run throws, not only when it returns", async () => {
    const leases = inMemoryLeases();
    const store = projection();
    const scheduler = openScheduler<S>({
      rows: [{ id: "X", dependencies: [] }],
      concurrency: 1,
      ...store,
      runOne: async () => {
        throw new Error("graph bug: a dangling edge");
      },
      resumeOne: async (row) => accepted(row.id),
      resourcesFor: () => ["the-kernel-table"],
      leases,
    });

    // A `runOne` that throws is a graph bug and is not absorbed into a status.
    await expect(scheduler.run()).rejects.toThrow(/graph bug/);
    // And the resource is free afterwards, so the next row is not deadlocked
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
    // FIFO, so which of two blocked rows goes first is a function of the order
    // they asked rather than of timing.
    expect(order).toEqual(["first", "second"]);
  });
});

describe("termination", () => {
  test("an empty roadmap terminates at once", async () => {
    const store = projection();
    const scheduler = openScheduler<S>({
      rows: [],
      concurrency: 1,
      ...store,
      runOne: async (row) => accepted(row.id),
      resumeOne: async (row) => accepted(row.id),
    });
    expect([...(await scheduler.run())]).toEqual([]);
  });

  test("a roadmap whose rows all block terminates rather than spinning", async () => {
    const store = projection();
    const scheduler = openScheduler<S>({
      rows: [
        { id: "A", dependencies: [] },
        { id: "B", dependencies: ["A"] },
      ],
      concurrency: 2,
      ...store,
      runOne: async (row) => rejected(row.id),
      resumeOne: async (row) => accepted(row.id),
    });

    const statuses = await scheduler.run();
    expect(statuses.get("A")).toBe("rejected");
    expect(statuses.get("B")).toBe("pending");
  });

  test("a dependency on a row the roadmap does not hold never becomes ready", async () => {
    // The scheduler does not adjudicate a dangling dependency; the roadmap
    // workflow's `validate-shape` refuses one as a named defect before
    // anything is dispatched.
    const store = projection();
    const ran: string[] = [];
    const scheduler = openScheduler<S>({
      rows: [{ id: "A", dependencies: ["nowhere"] }],
      concurrency: 1,
      ...store,
      runOne: async (row) => {
        ran.push(row.id);
        return accepted(row.id);
      },
      resumeOne: async (row) => accepted(row.id),
    });

    expect((await scheduler.run()).get("A")).toBe("pending");
    expect(ran).toEqual([]);
  });
});

describe("eligibility, beyond the frontier", () => {
  test("an ineligible row never runs, and blocks its dependents exactly like a rejected one", async () => {
    // The frontier rule answers "is everything this row waits on done". It
    // does not answer "may this row start at all", and a consumer with a
    // precondition of its own — DELIVER's "the oracle was measured red" —
    // has nowhere else to put it.
    const ran: string[] = [];
    const statuses = new Map<string, RowStatus>([
      ["a", "pending"],
      ["b", "pending"],
      ["c", "pending"],
    ]);
    const scheduler = openScheduler<null>({
      rows: [
        { id: "a", dependencies: [] },
        { id: "b", dependencies: ["a"] },
        { id: "c", dependencies: [] },
      ],
      concurrency: 2,
      eligible: async (id) => id !== "a",
      runOne: async (row) => {
        ran.push(row.id);
        return { kind: "terminal", terminal: { kind: "accepted", state: null }, trace: [], runId: row.id };
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

  test("with no predicate every row is eligible, which is the behaviour before it existed", async () => {
    const ran: string[] = [];
    const statuses = new Map<string, RowStatus>([["a", "pending"]]);
    const scheduler = openScheduler<null>({
      rows: [{ id: "a", dependencies: [] }],
      concurrency: 1,
      runOne: async (row) => {
        ran.push(row.id);
        return { kind: "terminal", terminal: { kind: "accepted", state: null }, trace: [], runId: row.id };
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
