/**
 * Declared commands: how a consumer's project is typechecked, linted, tested,
 * and how one oracle is executed.
 *
 * A framework that spawned `bunx tsc --noEmit` and `bun test <file> -t <name>`
 * itself could check no project whose typechecker or test runner is anything
 * else, and could carry no lint stage at all, because nothing would declare
 * one.
 *
 * `Commands` is where a consumer says. It is four functions from typed
 * arguments to a command, declared in the consumer's own source and read by
 * the framework.
 * The framework knows the four JOBS; the consumer knows the four COMMANDS —
 * the consumer declares the argv forms and the framework runs them, rather
 * than the framework baking in what they declare.
 *
 * A bare `string[]` is the common case and normalises to `{ argv }` with this
 * module's default timeout. The object form is for a command that needs an
 * environment, a longer budget, or a named shared resource the scheduler must
 * serialise two steps on.
 *
 * The runner below is the ONE implementation of "spawn a process and read what
 * it printed" in the repository. Both effect executors call it, because a
 * `run-command` effect means the same thing to both.
 */

/** The typed arguments the framework hands each declared command. */
export type CommandArgs = {
  /** Typecheck the project. The framework has nothing to narrow it with. */
  typecheck: Record<string, never>;
  /** Lint these repository-relative paths. Empty means the whole project. */
  lint: { paths: readonly string[] };
  /** Run one test, writing a JUnit report to `junit`. */
  tests: { file: string; selector?: string; junit: string };
  /** Execute one oracle, writing a JUnit report to `junit`. */
  oracle: { file: string; selector?: string; junit: string };
};

/**
 * What a declared command is. A bare argv covers the common case; the object
 * form exists for the three things an argv cannot say.
 */
export type Command =
  | readonly string[]
  | {
      argv: readonly string[];
      /** Overlaid on the parent environment, never replacing it. */
      env?: Record<string, string>;
      timeoutMs?: number;
      /** Shared infrastructure this command needs exclusively. */
      resources?: readonly string[];
    };

/** The consumer's declaration. One function per job the framework has. */
export type Commands = { [K in keyof CommandArgs]: (args: CommandArgs[K]) => Command };

/**
 * The budget a command gets when its declaration names none. Two minutes is
 * long enough for a cold `tsc` over a real project and short enough that a
 * hung runner is a failed run rather than a stuck one.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * The per-channel byte cap on a command's output.
 *
 * Output is PAYLOAD: a person reads it, a correction turn reads it, and an
 * event row carries an excerpt of it. None of those needs a megabyte, and an
 * unbounded string crossing an effect result is a memory bug waiting for a
 * verbose compiler. 64 000 bytes of stdout and 64 000 of stderr is the cap,
 * and a truncated channel ends in `…` so a reader can tell.
 */
export const COMMAND_OUTPUT_CAP = 64_000;

/** A declared command, with every optional field resolved. */
export type NormalizedCommand = {
  argv: readonly string[];
  env?: Record<string, string>;
  timeoutMs: number;
  resources?: readonly string[];
};

/** A bare argv is `{ argv }` at the default timeout. Nothing else differs. */
export const normalizeCommand = (command: Command): NormalizedCommand => {
  if (Array.isArray(command)) return { argv: command as readonly string[], timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS };
  const declared = command as Exclude<Command, readonly string[]>;
  return {
    argv: declared.argv,
    ...(declared.env === undefined ? {} : { env: declared.env }),
    timeoutMs: declared.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    ...(declared.resources === undefined ? {} : { resources: declared.resources }),
  };
};

/**
 * What running one command produced.
 *
 * `exitCode` is `null` when the process never produced one, which today means
 * it was killed at the timeout. `timedOut` says which of the two that was, so
 * a reader does not have to infer it from a null.
 */
export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

/** Everything the runner needs. `cwd` is resolved by the caller. */
export type CommandSpec = {
  argv: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
};

/** Cap one channel at `bytes`, marking a truncation so a reader can tell. */
const cap = (text: string, bytes: number): string => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= bytes) return text;
  return `${new TextDecoder().decode(encoded.slice(0, bytes))}…`;
};

/**
 * Run one command and read both channels.
 *
 * `undefined` is the honest answer for a process that could not be STARTED:
 * nothing about the command was observed, so nothing about it is claimed, and
 * in particular the failure is not the caller's. A process that started and
 * was killed at its timeout is a `CommandResult` with `timedOut: true` — it
 * ran, and what it printed before it was killed is evidence.
 *
 * The environment is OVERLAID rather than replaced, because a declared command
 * is `bunx biome check` as often as it is anything else and a replaced `PATH`
 * would make every such declaration fail for a reason nobody declared.
 */
export const runCommand = async (spec: CommandSpec): Promise<CommandResult | undefined> => {
  const [command, ...rest] = spec.argv;
  if (command === undefined) return undefined;

  const started = Date.now();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const proc = Bun.spawn([command, ...rest], {
      cwd: spec.cwd,
      env: spec.env === undefined ? undefined : { ...process.env, ...spec.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, spec.timeoutMs);

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      // A killed process reports the signal's status rather than an exit of
      // its own, so the timeout is what decides whether there is one.
      exitCode: timedOut ? null : exitCode,
      stdout: cap(stdout, COMMAND_OUTPUT_CAP),
      stderr: cap(stderr, COMMAND_OUTPUT_CAP),
      durationMs: Date.now() - started,
      timedOut,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};
