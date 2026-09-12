# The todo target

A tiny TypeScript project that exists to be delivered *to*. It is the thing the
framework's three waves are pointed at: the roadmap workflow decomposes a
request against `design.md`, DISTILL states what each value must be observed to
do and authors the oracle that measures it, and the DELIVER step cycle writes
the two stubbed method bodies in `src/todo.ts` until that oracle is green.

**This is a template. It is never mutated in place.** Every run copies it to a
fresh directory under `runs/<name>/todo/` (gitignored) and works there, so the
repository stays clean and each run is a fresh checkout. See
[`src/examples/nwave/todo/`](../../src/examples/nwave/todo) for the three
commands that drive it.

| File | What it is |
|---|---|
| `design.md` | The authority. The whole public surface, the behaviour of each method, the driving port, and the test path scope. |
| `src/todo.ts` | `TodoStore`. `add` and `list` are implemented; `complete` and `remove` are stubs whose bodies throw. |

**There is no test file, and that is the point.** The oracle for each value is
authored by `des oracle` into `test/`, and software measures it red before one
production byte is written. A pre-written test would make the RED observation a
thing the repository asserted rather than a thing the runner measured.

The walking-skeleton shape is deliberate for the same reason one layer down:
the stub *symbols* exist with their declared signatures, so a `replace-symbol`
effect has a target and the gap is a missing body rather than a missing
surface. `write-file` is what creates the oracle; `replace-symbol` is what
fills the body.
