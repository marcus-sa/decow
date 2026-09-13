/**
 * A suspension survives the runtime that produced it.
 *
 * `resume` rebuilds the graph rather than holding a live handle, so the only
 * thing standing between "a parked run is resumable from a fresh compile" and
 * "a parked run is resumable from a fresh PROCESS" is where the snapshot
 * lives. `InMemoryStore` keeps it in a map that dies with the process;
 * `openWorkflowRuntime("file:…")` keeps it in libSQL.
 *
 * The test that proves it cannot be two `run`/`resume` calls in one process
 * against the default runtime — that passes today and proves nothing. It has
 * to be two RUNTIME INSTANCES over one file, with the first one dropped before
 * the second is built, which is what a second command in a second process is
 * from the snapshot's point of view.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { openWorkflowRuntime } from "./compile.ts";
import { branch, resume, run, suspend, type Node, type Workflow } from "./workflow.ts";

type State = { asked: number; answer?: string };

const Answer = z.object({ decision: z.enum(["proceed", "abandon"]) });
type Answer = z.infer<typeof Answer>;

/** ask -> gate (suspend) -> route -> accept | reject. One parking place. */
const graph = (): Workflow<State> => ({
  start: "ask",
  nodes: {
    ask: {
      type: "step",
      run: async (s) => ({ state: { ...s, asked: s.asked + 1 }, effects: [] }),
      absorb: (s) => s,
      next: "gate",
    } satisfies Node<State>,

    gate: suspend<State, Answer>({
      reason: () => "needs-a-person",
      trail: (s) => [{ asked: s.asked }],
      resumeSchema: Answer,
      absorb: (s, answer) => ({ ...s, answer: answer.decision }),
      next: "route",
    }),

    route: branch<State, Answer["decision"]>(
      (s) => (s.answer === "abandon" ? "abandon" : "proceed"),
      { proceed: "accept", abandon: "reject" },
    ),

    accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) },
    reject: { type: "terminal", done: (s) => ({ kind: "rejected", state: s, trail: [] }) },
  },
});

const noEffects = async () => [];

const dirs: string[] = [];
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "dw-snapshot-"));
  dirs.push(dir);
  return `file:${join(dir, "mastra.sqlite")}`;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable snapshots", () => {
  test("a run parked under one runtime is resumed by a second runtime on the same file", async () => {
    const url = tempDb();
    const wf = graph();

    // The first "process": park the run, then drop every reference to the
    // runtime that holds it.
    let parkedRunId: string;
    {
      const first = openWorkflowRuntime(url);
      const parked = await run<State>(wf, { asked: 0 }, noEffects, first);
      expect(parked.kind).toBe("suspended");
      if (parked.kind !== "suspended") throw new Error("expected a suspension");
      expect(parked.reason).toBe("needs-a-person");
      expect(parked.trail).toEqual([{ asked: 1 }]);
      parkedRunId = parked.runId;
    }

    // The second "process": a brand-new runtime over the same file, a brand-new
    // compile of the same graph, and the run continues from where it stopped.
    const second = openWorkflowRuntime(url);
    const resumed = await resume<State>(wf, parkedRunId, { decision: "proceed" }, noEffects, second);

    expect(resumed.kind).toBe("terminal");
    if (resumed.kind !== "terminal") throw new Error("expected a terminal");
    expect(resumed.terminal.kind).toBe("accepted");
    expect(resumed.terminal.state.answer).toBe("proceed");
    // `ask` ran once, in the first runtime. The second did not re-run it,
    // which is what "resumed" means as opposed to "re-run".
    expect(resumed.terminal.state.asked).toBe(1);
    // And the trace spans both halves, because it lives in the snapshot.
    expect(resumed.trace).toEqual(["ask", "gate", "route", "accept"]);
  });

  test("a second runtime on a DIFFERENT file cannot see the parked run", async () => {
    // The negative that makes the positive mean something: if resuming worked
    // against an empty store, the first test would pass without the file.
    const wf = graph();
    const parked = await run<State>(wf, { asked: 0 }, noEffects, openWorkflowRuntime(tempDb()));
    if (parked.kind !== "suspended") throw new Error("expected a suspension");

    const elsewhere = openWorkflowRuntime(tempDb());
    expect(resume<State>(wf, parked.runId, { decision: "proceed" }, noEffects, elsewhere)).rejects.toThrow();
  });

  test("the default runtime is in-memory and still resumes within one process", async () => {
    // The suite's own path, unchanged: no url, no file, one process.
    const wf = graph();
    const parked = await run<State>(wf, { asked: 0 }, noEffects);
    if (parked.kind !== "suspended") throw new Error("expected a suspension");
    const resumed = await resume<State>(wf, parked.runId, { decision: "abandon" }, noEffects);
    expect(resumed.kind === "terminal" && resumed.terminal.kind).toBe("rejected");
  });
});
