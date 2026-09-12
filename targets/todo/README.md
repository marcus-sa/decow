# The todo target

A tiny TypeScript project that exists to be delivered *to*. It is the thing the
framework's three waves are pointed at: the roadmap workflow decomposes a
request against `design.md`, and the DELIVER step cycle activates the pending
acceptance tests in `test/todo.test.ts` and writes the two stubbed method
bodies in `src/todo.ts`.

**This is a template. It is never mutated in place.** Every run copies it to a
fresh directory under `runs/<name>/todo/` (gitignored) and works there, so the
repository stays clean and each run is a fresh checkout. See
[`src/examples/nwave/todo/`](../../src/examples/nwave/todo) for the three
commands that drive it.

| File | What it is |
|---|---|
| `design.md` | The authority. The whole public surface, the behaviour of each method, and the locator of every pre-authored acceptance test. |
| `src/todo.ts` | `TodoStore`. `add` and `list` are implemented; `complete` and `remove` are stubs whose bodies throw. |
| `test/todo.test.ts` | Eight acceptance tests. Four active, four pending behind `test.skip(`. |

The walking-skeleton shape is deliberate: the stub *symbols* exist with their
declared signatures, so a `replace-symbol` effect has a target and the gap is a
missing body rather than a missing surface. Nothing in the framework can create
a file or a symbol that does not already exist.
