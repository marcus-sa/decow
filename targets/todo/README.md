# The todo target

A tiny TypeScript project that exists to be delivered *to*. It is the thing the
framework's three waves are pointed at: the roadmap workflow decomposes a
request against `design.md`, DISTILL states what each value must be observed to
do and authors the oracle that measures it, and the DELIVER step cycle writes
the two stubbed method bodies in `src/todo.ts` until that oracle is green.

**This is a template. It is never mutated in place.** Every run copies it to a
fresh directory under `runs/<name>/todo/` (gitignored) and works there, so the
repository stays clean and each run is a fresh checkout. See [`.des/`](.des) for
the composition that registers the four graphs and the two pipelines against a
copy of it, and `bun run todo` for the server that serves them.

A pipeline here is DATA: steps naming one of those four graphs and the input one
run of it takes. The server schedules them, so delivering a step and starting
one by hand are the same registration — and `bun run e2e` drives exactly that
in a browser, against a throwaway copy of this directory.

| File | What it is |
|---|---|
| `design.md` | The authority for WHAT it is. The whole public surface, the behaviour of each method, the driving port, and the test path scope. |
| [`.des/commands.ts`](.des/commands.ts) | The authority for HOW it is checked. Four functions, from typed arguments to a command: typecheck, lint, tests, oracle. DES configuration, so it sits with the composition rather than with the project. |
| [`.des/models.ts`](.des/models.ts) | Which model runs which of the five roles. Anthropic router ids by default; four variables point every role at one OpenAI-compatible endpoint instead. |
| `biome.json` | Three lines, so the declared lint command has something to run. |
| `src/todo.ts` | `TodoStore`. `add` and `list` are implemented; `complete` and `remove` are stubs whose bodies throw. |

**The framework knows the four jobs; this project knows the four commands.**
Nothing in the framework knows that this is a bun project, that its linter is
biome, or that its test runner writes a JUnit report behind `--reporter=junit`.
Those are declarations, and `.des/commands.ts` is where they are made:

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

It is read by the framework and by nothing in this project, which is why it
lives in `.des/` beside the composition that drives the waves. `.des/` is
excluded from the copy every run works in, so the copy carries no declaration:
the commands are loaded from here and RUN with `cwd` set to the copy, which
resolves `bunx biome` and `bunx tsc` through the `node_modules` symlink the
copy is made with. The framework typechecks the file, and its
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

**Every leaf can run against one OpenAI-compatible endpoint**, without editing
`.des/models.ts`. The defaults there are Anthropic router ids — Opus for the
decomposition, Sonnet for the two code-generating leaves, Haiku for everything
else and for every validator — and the argument behind that table is about
model *size*, not about a vendor. Setting `DES_OPENAI_COMPATIBLE_URL` replaces
all five with one endpoint of your own: a gateway, a proxy, or a model served
on your own machine.

| Variable | What it does |
|---|---|
| `DES_OPENAI_COMPATIBLE_URL` | The endpoint. **Setting it is the switch**; leaving it unset keeps the Anthropic defaults. |
| `DES_OPENAI_COMPATIBLE_MODEL` | The model the endpoint serves. Required alongside a URL, and refused by name without one: an endpoint does not name a model. |
| `DES_OPENAI_COMPATIBLE_PROVIDER` | The name the model is reported under, in `describeModels()` and in every attempt row. Defaults to `openai-compatible`. |
| `DES_OPENAI_COMPATIBLE_API_KEY` | Defaults to `unused`, which is what a local server wants — and is also what tells the binding no key is needed, so no leaf refuses for want of one. |

A local [Ollama](https://ollama.com), whose OpenAI-compatible API is at
`/v1` — the model name is an example, and any model the endpoint serves works
the same way:

```bash
DES_OPENAI_COMPATIBLE_URL=http://localhost:11434/v1 \
DES_OPENAI_COMPATIBLE_MODEL=qwen3:8b \
bun run todo
```

The server prints what is in effect, so a report's numbers are readable
against the models that produced them:

```
decompose:     openai-compatible/qwen3:8b
author-oracle: openai-compatible/qwen3:8b
implement:     openai-compatible/qwen3:8b
every other leaf: openai-compatible/qwen3:8b
validators:    openai-compatible/qwen3:8b
endpoint:      http://localhost:11434/v1 (DES_OPENAI_COMPATIBLE_URL)
escalation:    none
credential:    none is read from the environment; the endpoint carries its own
```

Two things are worth knowing before reading such a run. **Structured output
depends on the endpoint honouring the schema**: every leaf asks for one object
against a zod schema, the step re-parses what comes back, and an endpoint that
returns prose or a differently-shaped object fails that parse. The failure is
not silent and it is not a wrong answer — `runStep` records it in the trail and
the leaf exhausts, so the run parks as `validator-exhausted` with the parse
error in it. **Token counts may be absent**, because not every
OpenAI-compatible server reports usage; an attempt then records no counts at
all rather than zeros, since "nobody said" and "it cost nothing" are different
claims.

The five roles collapse onto one model, which is a different reading of a run
rather than a broken one: the model table's claim is that small models suffice
for four of the five jobs, and one model at all five is the control for it.
