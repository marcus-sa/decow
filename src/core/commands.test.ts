/**
 * The consumer's declaration, and the one runner behind it.
 *
 * Two halves. `normalizeCommand` is pure: it is the whole of what "a bare argv
 * means the object form at the default timeout" amounts to, and it is asserted
 * as such. `runCommand` really spawns, because every claim worth making about
 * it — a non-zero exit, a binary that is not there, a process that outlives its
 * budget, a channel that outruns its cap — is a claim about a process.
 */

import { describe, expect, test } from "bun:test";
import {
  COMMAND_OUTPUT_CAP,
  DEFAULT_COMMAND_TIMEOUT_MS,
  normalizeCommand,
  runCommand,
} from "./commands.ts";

describe("a declared command, normalised", () => {
  test("a bare argv is the object form at the framework's default timeout", () => {
    expect(normalizeCommand(["bunx", "tsc", "--noEmit"])).toEqual({
      argv: ["bunx", "tsc", "--noEmit"],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
  });

  test("the object form keeps every field it declared, and fills in the one it did not", () => {
    expect(
      normalizeCommand({
        argv: ["cargo", "nextest", "run"],
        env: { RUST_LOG: "warn" },
        resources: ["shared-db"],
      }),
    ).toEqual({
      argv: ["cargo", "nextest", "run"],
      env: { RUST_LOG: "warn" },
      resources: ["shared-db"],
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
  });

  test("a declared timeout wins over the default", () => {
    expect(normalizeCommand({ argv: ["sleep", "1"], timeoutMs: 50 }).timeoutMs).toBe(50);
  });

  test("the two forms of the same command normalise to the same thing", () => {
    // Which is the whole point of accepting both: a consumer writes the short
    // one until it needs one of the three fields the long one carries.
    expect(normalizeCommand(["a", "b"])).toEqual(normalizeCommand({ argv: ["a", "b"] }));
  });
});

describe("one command, run", () => {
  const run = (argv: readonly string[], timeoutMs = 10_000) =>
    runCommand({ argv, cwd: process.cwd(), timeoutMs });

  test("exit zero comes back with both channels and a duration", async () => {
    const result = await run(["bash", "-c", "echo out; echo err >&2"]);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result?.stdout.trim()).toBe("out");
    expect(result?.stderr.trim()).toBe("err");
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("a non-zero exit is a result, not a failure to run", async () => {
    // The distinction the whole effect mapping rests on: a command that RAN
    // and refused is evidence about the change; one that could not run is not.
    const result = await run(["bash", "-c", "echo nope >&2; exit 3"]);
    expect(result).toMatchObject({ exitCode: 3, timedOut: false });
    expect(result?.stderr.trim()).toBe("nope");
  });

  test("a binary that is not there is undefined: nothing was observed", async () => {
    expect(await run(["a-binary-that-does-not-exist-anywhere"])).toBeUndefined();
  });

  test("an empty argv is undefined rather than a spawn of nothing", async () => {
    expect(await run([])).toBeUndefined();
  });

  test("a process that outlives its budget is killed, and says so", async () => {
    const result = await run(["bash", "-c", "echo started; sleep 30"], 150);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    // It RAN, so what it printed before it was killed is evidence.
    expect(result?.stdout).toContain("started");
  });

  test("each channel is capped, and a truncated one says so", async () => {
    const bytes = COMMAND_OUTPUT_CAP + 5_000;
    const result = await run(["bash", "-c", `head -c ${bytes} /dev/zero | tr '\\0' 'x'`]);
    expect(result?.stdout.endsWith("…")).toBe(true);
    expect(new TextEncoder().encode(result?.stdout ?? "").length).toBeLessThanOrEqual(
      COMMAND_OUTPUT_CAP + 3,
    );
  });

  test("the declared environment is overlaid on the parent's, never replacing it", async () => {
    // `bunx biome check` is a normal declaration, and a replaced PATH would
    // make every such declaration fail for a reason nobody declared.
    const result = await runCommand({
      argv: ["bash", "-c", "echo $DW_DECLARED:$([ -n \"$PATH\" ] && echo has-path)"],
      cwd: process.cwd(),
      env: { DW_DECLARED: "yes" },
      timeoutMs: 10_000,
    });
    expect(result?.stdout.trim()).toBe("yes:has-path");
  });

  test("cwd is where the command runs", async () => {
    const result = await runCommand({ argv: ["pwd"], cwd: "/tmp", timeoutMs: 10_000 });
    expect(result?.stdout.trim()).toContain("tmp");
  });
});
