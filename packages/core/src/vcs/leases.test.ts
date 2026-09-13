/**
 * The coordination protocol (ai-vcs.md § 5).
 *
 * Four properties, and each one is a rule the document states rather than a
 * behaviour that fell out of the implementation:
 *
 *   the mode matrix        § 5.2, all nine pairings, including the asymmetry:
 *                          a read blocks a later write, and a live write does
 *                          not block a later read
 *   the hierarchy          § 5.2, a write on a class conflicts with a lease on
 *                          its method, in both directions
 *   no hold-and-wait       § 5.3, which is how deadlock is prevented by
 *                          construction rather than detected
 *   the intent contract    § 4.5 and § 5.1, validated before any work begins
 */

import { describe, expect, test } from "bun:test";
import { openVcs, type Vcs } from "./index.ts";
import { LEASE_MODES, scopeCovers, scopesOverlap, type LeaseMode } from "./leases.ts";
import type { Intent } from "./log.ts";
import { counterIds, manualClock, passingVerifier, tempProject, type ManualClock } from "./testing.ts";

const SOURCE = `export function alpha(): number {
  return 1;
}

export function bravo(): number {
  return 2;
}

export class Charlie {
  delta(): void {}
}
`;

const open = () => {
  const clock = manualClock(1_000);
  const vcs = openVcs({
    root: tempProject({ "a.ts": SOURCE }),
    verifier: passingVerifier(),
    clock,
    ids: counterIds(),
  });
  const file = vcs.track("a.ts");
  const id = (name: string) => {
    const symbol = vcs.registry.symbolsOf(file.id).find((s) => s.name === name);
    if (symbol === undefined) throw new Error(`fixture has no symbol named ${name}`);
    return symbol.id;
  };
  return { vcs, clock, id };
};

const intent = (expectedOutcome: Intent["expectedOutcome"] = {}): Intent => ({
  taskId: "task-1",
  description: "hold some symbols",
  expectedOutcome,
});

const ask = (
  vcs: Vcs,
  session: string,
  symbolIds: string[],
  mode: LeaseMode,
  extra: Partial<Parameters<Vcs["acquire"]>[0]> = {},
) => vcs.acquire({ session, symbolIds, mode, ttlMs: 5_000, intent: intent(), ...extra });

describe("lease modes", () => {
  /** § 5.2 as a table: does a live lease in `held` block a request in `want`? */
  const BLOCKED: Record<LeaseMode, Record<LeaseMode, boolean>> = {
    read: { read: false, write: true, exclusive: true },
    write: { read: false, write: true, exclusive: true },
    exclusive: { read: true, write: true, exclusive: true },
  };

  for (const held of LEASE_MODES) {
    for (const want of LEASE_MODES) {
      test(`a live ${held} lease ${BLOCKED[held][want] ? "blocks" : "admits"} a ${want} request`, () => {
        const { vcs, id } = open();
        const first = ask(vcs, "session-a", [id("alpha")], held);
        expect(first.outcome).toBe("granted");

        const second = ask(vcs, "session-b", [id("alpha")], want);
        expect(second.outcome).toBe(BLOCKED[held][want] ? "conflict" : "granted");
        vcs.close();
      });
    }
  }

  test("a conflict names who holds what, so the caller can route rather than poll", () => {
    const { vcs, id } = open();
    const first = ask(vcs, "session-a", [id("alpha")], "write");
    if (first.outcome !== "granted") throw new Error("the first acquire should hold");
    const second = ask(vcs, "session-b", [id("alpha")], "write");
    expect(second).toEqual({
      outcome: "conflict",
      held: [{ symbolId: id("alpha"), leaseId: first.leaseId, mode: "write", session: "session-a" }],
    });
    vcs.close();
  });
});

describe("the symbol hierarchy", () => {
  test("a write on a class is blocked by a lease on its method", () => {
    const { vcs, id } = open();
    expect(ask(vcs, "session-a", [id("delta")], "write").outcome).toBe("granted");
    expect(ask(vcs, "session-b", [id("Charlie")], "write").outcome).toBe("conflict");
    vcs.close();
  });

  test("and a write on a method is blocked by a lease on its class", () => {
    const { vcs, id } = open();
    expect(ask(vcs, "session-a", [id("Charlie")], "write").outcome).toBe("granted");
    expect(ask(vcs, "session-b", [id("delta")], "write").outcome).toBe("conflict");
    vcs.close();
  });

  test("an unrelated symbol in the same file is untouched by either", () => {
    const { vcs, id } = open();
    expect(ask(vcs, "session-a", [id("Charlie")], "write").outcome).toBe("granted");
    expect(ask(vcs, "session-b", [id("alpha")], "write").outcome).toBe("granted");
    vcs.close();
  });
});

describe("atomic multi-acquire", () => {
  test("one blocked symbol denies the whole request, and grants nothing", () => {
    const { vcs, id } = open();
    expect(ask(vcs, "session-a", [id("bravo")], "write").outcome).toBe("granted");

    const both = ask(vcs, "session-b", [id("alpha"), id("bravo")], "write");
    expect(both.outcome).toBe("conflict");

    // Nothing partial was taken: `alpha` is still free for a third session.
    expect(ask(vcs, "session-c", [id("alpha")], "write").outcome).toBe("granted");
    vcs.close();
  });

  test("a granted lease hands back the current version of every symbol in it", () => {
    const { vcs, id } = open();
    const lease = ask(vcs, "session-a", [id("alpha"), id("bravo")], "write");
    if (lease.outcome !== "granted") throw new Error("the acquire should hold");
    // § 5.1: one round trip yields both the lock and the versions, so the
    // caller needs no separate check-version step.
    expect(lease.versions).toEqual({ [id("alpha")]: 1, [id("bravo")]: 1 });
    vcs.close();
  });

  test("holding a lease and asking for more is refused, which is why there is no deadlock", () => {
    const { vcs, id } = open();
    expect(ask(vcs, "session-a", [id("alpha")], "write").outcome).toBe("granted");
    expect(ask(vcs, "session-a", [id("bravo")], "write")).toMatchObject({
      outcome: "contract-violation",
      violation: "hold-and-request",
    });
    vcs.close();
  });

  test("releasing first makes the wider request available", () => {
    const { vcs, id } = open();
    const first = ask(vcs, "session-a", [id("alpha")], "write");
    if (first.outcome !== "granted") throw new Error("the acquire should hold");
    vcs.release(first.leaseId);
    expect(ask(vcs, "session-a", [id("alpha"), id("bravo")], "write").outcome).toBe("granted");
    vcs.close();
  });
});

describe("optimistic concurrency", () => {
  test("an expected version that has moved is stale, and carries the current ones", () => {
    const { vcs, id } = open();
    const stale = ask(vcs, "session-a", [id("alpha")], "write", {
      expectedVersions: { [id("alpha")]: 7 },
    });
    expect(stale).toEqual({ outcome: "stale", versions: { [id("alpha")]: 1 } });

    // The same request with the version the world is actually at is granted.
    expect(
      ask(vcs, "session-a", [id("alpha")], "write", { expectedVersions: { [id("alpha")]: 1 } }).outcome,
    ).toBe("granted");
    vcs.close();
  });
});

describe("the intent contract", () => {
  test("an expected outcome naming a symbol the request does not is refused before any work", () => {
    const { vcs, id } = open();
    const refused = vcs.acquire({
      session: "session-a",
      symbolIds: [id("alpha")],
      mode: "write",
      ttlMs: 5_000,
      intent: intent({ modified: [id("bravo")] }),
    });
    expect(refused).toMatchObject({ outcome: "contract-violation", violation: "intent-scope-mismatch" });
    expect(vcs.leases.live()).toEqual([]);
    vcs.close();
  });

  test("a declared tombstone needs an exclusive lease, because deletion is structural", () => {
    const { vcs, id } = open();
    expect(
      vcs.acquire({
        session: "session-a",
        symbolIds: [id("alpha")],
        mode: "write",
        ttlMs: 5_000,
        intent: intent({ tombstoned: [id("alpha")] }),
      }),
    ).toMatchObject({ outcome: "contract-violation", violation: "tombstone-needs-exclusive" });
    vcs.close();
  });

  test("an empty request, an over-long description, and an unknown symbol are all contract violations", () => {
    const { vcs, id } = open();
    expect(ask(vcs, "session-a", [], "write")).toMatchObject({ violation: "empty-request" });
    expect(
      ask(vcs, "session-a", [id("alpha")], "write", {
        intent: { ...intent(), description: "x".repeat(501) },
      }),
    ).toMatchObject({ violation: "description-too-long" });
    expect(ask(vcs, "session-a", ["sym-nope"], "write")).toMatchObject({ violation: "unknown-symbol" });
    vcs.close();
  });
});

describe("TTL and heartbeat", () => {
  const expire = (clock: ManualClock) => clock.advance(5_001);

  test("an expired lease stops blocking, and says so in the log", () => {
    const { vcs, clock, id } = open();
    const first = ask(vcs, "session-a", [id("alpha")], "write");
    if (first.outcome !== "granted") throw new Error("the acquire should hold");
    expect(first.expiresAt).toBe(1_000 + 5_000);

    expire(clock);
    expect(ask(vcs, "session-b", [id("alpha")], "write").outcome).toBe("granted");
    expect(vcs.log.all().some((e) => e.kind === "lease-expired" && e.leaseId === first.leaseId)).toBe(true);
    vcs.close();
  });

  test("a heartbeat extends the deadline by another TTL, and keeps the lease blocking", () => {
    const { vcs, clock, id } = open();
    const first = ask(vcs, "session-a", [id("alpha")], "write");
    if (first.outcome !== "granted") throw new Error("the acquire should hold");

    clock.advance(4_000);
    expect(vcs.heartbeat(first.leaseId)).toBe(5_000 + 5_000);
    clock.advance(4_000);

    // Eight seconds in, on a five-second TTL, and still held: the heartbeat is
    // what § 4.3 says keeps a lease alive.
    expect(ask(vcs, "session-b", [id("alpha")], "write").outcome).toBe("conflict");
    vcs.close();
  });

  test("a heartbeat on a lease that already expired reports that it is gone", () => {
    const { vcs, clock, id } = open();
    const first = ask(vcs, "session-a", [id("alpha")], "write");
    if (first.outcome !== "granted") throw new Error("the acquire should hold");
    expire(clock);
    expect(vcs.heartbeat(first.leaseId)).toBeUndefined();
    vcs.close();
  });
});

/**
 * Path scopes (`write-file`'s concurrency model).
 *
 * A symbol lease is an optimistic claim on something the registry already
 * holds. A path scope is a territorial one on a region of the tree, and it is
 * the only claim a write to a file that does not exist yet can make. The mode
 * matrix is the same; what changes is what "the same thing" means.
 */
describe("path scopes", () => {
  test("a prefix covers itself and everything under it, and nothing beside it", () => {
    expect(scopeCovers("test", "test")).toBe(true);
    expect(scopeCovers("test", "test/todo.test.ts")).toBe(true);
    expect(scopeCovers("test/", "test/deep/a.test.ts")).toBe(true);
    expect(scopeCovers("test", "tests/a.test.ts")).toBe(false);
    expect(scopeCovers("test", "src/todo.ts")).toBe(false);
  });

  test("a glob scope matches by glob", () => {
    expect(scopeCovers("test/**", "test/deep/a.test.ts")).toBe(true);
    expect(scopeCovers("test/*.test.ts", "test/a.test.ts")).toBe(true);
    expect(scopeCovers("test/*.test.ts", "test/deep/a.test.ts")).toBe(false);
  });

  test("overlap is symmetric, and disjoint prefixes do not overlap", () => {
    expect(scopesOverlap("test", "test/todo.test.ts")).toBe(true);
    expect(scopesOverlap("test/todo.test.ts", "test")).toBe(true);
    expect(scopesOverlap("test", "test")).toBe(true);
    expect(scopesOverlap("test", "src")).toBe(false);
    expect(scopesOverlap("src/todo.ts", "src/other.ts")).toBe(false);
  });

  test("two sessions whose scopes overlap conflict, and disjoint ones do not", () => {
    const { vcs } = open();
    const take = (session: string, paths: string[]) =>
      vcs.acquire({
        session,
        paths,
        mode: "write",
        ttlMs: 5_000,
        intent: intent({ created: paths.map((p) => `${p}/x.ts`) }),
      });

    expect(take("session-a", ["test"]).outcome).toBe("granted");

    const overlapping = take("session-b", ["test/acceptance"]);
    expect(overlapping.outcome).toBe("conflict");
    // The report names the SCOPE rather than a symbol, because the collision
    // is on the tree and there is no symbol to name.
    expect(overlapping.outcome === "conflict" && overlapping.held[0]).toMatchObject({
      path: "test",
      session: "session-a",
    });

    expect(take("session-c", ["src"]).outcome).toBe("granted");
  });

  test("an acquire naming neither symbols nor paths is refused", () => {
    const { vcs } = open();
    const empty = vcs.acquire({ session: "s", mode: "write", ttlMs: 1_000, intent: intent() });
    expect(empty).toMatchObject({ outcome: "contract-violation", violation: "empty-request" });
  });

  test("a declared creation outside every requested scope is a contract violation", () => {
    // § 4.5's `created` names paths, and it goes through the same rule the
    // symbol ids do: the request has to have asked for the region it is about
    // to write.
    const { vcs } = open();
    const refused = vcs.acquire({
      session: "s",
      paths: ["test"],
      mode: "write",
      ttlMs: 1_000,
      intent: intent({ created: ["src/smuggled.ts"] }),
    });
    expect(refused).toMatchObject({
      outcome: "contract-violation",
      violation: "intent-scope-mismatch",
    });
  });

  test("a symbol lease and a path lease on different regions do not see each other", () => {
    const { vcs, id } = open();
    expect(
      vcs.acquire({
        session: "session-a",
        symbolIds: [id("alpha")],
        mode: "write",
        ttlMs: 5_000,
        intent: intent({ modified: [id("alpha")] }),
      }).outcome,
    ).toBe("granted");
    expect(
      vcs.acquire({
        session: "session-b",
        paths: ["test"],
        mode: "write",
        ttlMs: 5_000,
        intent: intent({ created: ["test/a.test.ts"] }),
      }).outcome,
    ).toBe("granted");
  });
});
