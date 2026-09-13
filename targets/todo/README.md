# The todo target

A tiny TypeScript project that exists to be delivered *to*. It is the thing the
framework's three waves are pointed at: the roadmap workflow decomposes a
request against `design.md`, DISTILL states what each value must be observed to
do and authors the oracle that measures it, and the DELIVER step cycle writes
the two stubbed method bodies in `src/todo.ts` until that oracle is green.

**This is a template. It is never mutated in place.** Every run copies it to a
fresh directory under `runs/<name>/todo/` (gitignored) and works there, so the
repository stays clean and each run is a fresh checkout. See [`.des/`](.des) for
the composition that registers the four graphs against a copy of it, and
`bun run todo` for the server that serves them.

| File | What it is |
|---|---|
| `design.md` | The authority for WHAT it is. The whole public surface, the behaviour of each method, the driving port, and the test path scope. |
| `commands.ts` | The authority for HOW it is checked. Four functions, from typed arguments to a command: typecheck, lint, tests, oracle. |
| `biome.json` | Three lines, so the declared lint command has something to run. |
| `src/todo.ts` | `TodoStore`. `add` and `list` are implemented; `complete` and `remove` are stubs whose bodies throw. |

**The framework knows the four jobs; this project knows the four commands.**
Nothing in the framework knows that this is a bun project, that its linter is
biome, or that its test runner writes a JUnit report behind `--reporter=junit`.
Those are declarations, and `commands.ts` is where they are made:

```ts
export const commands: Commands = {
  typecheck: () => ["bunx", "tsc", "--noEmit"],
  lint: ({ paths }) => ["bunx", "biome", "check", ...paths],
  tests:  ({ file, selector, junit }) => ["bun", "test", file, ...(selector ? ["-t", selector] : []),
                                          "--reporter=junit", `--reporter-outfile=${junit}`],
  oracle: ({ file, selector, junit }) => ["bun", "test", file, ...(selector ? ["-t", selector] : []),
                                          "--reporter=junit", `--reporter-outfile=${junit}`],
};
```

All four are read by the framework and by nothing else. `typecheck` is the
write path's second stage, over the whole project. `lint` is its third, over
the files a write touched, and it is also the DELIVER cycle's entire quality
gate. `tests` is its fourth, once per impacted test. `oracle` is what executes
one test so DISTILL can read `green | red | broken | indeterminate` off it.

The JUnit flags were **measured** against bun 1.3.12, not assumed. A run whose
file does not parse, or whose import does not resolve, writes no document at
all, which is what the framework reads as "it ran nothing" rather than "nothing
failed". `biome check` exits 0 on warnings and non-zero on errors, so the gate
keys on the exit status exactly as it does for every other declared command —
which is why the two stub bodies, whose `id` parameters are unused and warned
about, pass the gate both before and after they are implemented.

It imports the `Commands` type and nothing else, so the import is erased before
the file is loaded and a copy of this directory under `runs/` resolves with no
path back to the framework. The framework typechecks it anyway, and its
no-nondeterminism scanner reads it: a declaration built out of a clock would
make the same write produce a different command on every run.

**There is no test file, and that is the point.** The oracle for each value is
authored into `test/` by DISTILL's oracle graph, and software measures it red
before one production byte is written. A pre-written test would make the RED observation a
thing the repository asserted rather than a thing the runner measured.

The walking-skeleton shape is deliberate for the same reason one layer down:
the stub *symbols* exist with their declared signatures, so a `replace-symbol`
effect has a target and the gap is a missing body rather than a missing
surface. `write-file` is what creates the oracle; `replace-symbol` is what
fills the body.
