# src/vcs — the agent-native VCS

An implementation of [`ai-vcs.md`](../../../../ai-vcs.md) as a TypeScript library on
`bun:sqlite`, wired to the workflow framework through one seam: an
`EffectExecutor` that executes `replace-symbol`, `write-file`, `run-tests`,
`measure-oracle` and `run-command` for real.

The framework is the control plane: what happens, in what order, validated how.
This module is the data plane for code: how a write lands, under what
concurrency, with what provenance. The dependency runs one way. `src/core`
imports nothing from here. What this module imports back is the `Effect` /
`EffectResult` types and `src/core/commands.ts`, and nothing else from the
framework.

**NOTHING HERE SPAWNS ANYTHING.** Every stage is a composition of one effect,
`run-command`, over the consumer's four declared commands
(`src/core/commands.ts`): a stage builds the declared command into an effect
and hands it to an injected executor. In production that executor is the one
that spawns; in a test it is a script, and the whole verification pipeline runs
in microseconds. That is also what makes the module usable by a project that is
not a bun project, which the hardcoded `bunx tsc` and `bun test` it used to
spawn never were.

**174 tests, 2.3 s, no network, no key, no model.** The stages are injected or
scripted everywhere except three files: `verify.test.ts` drives every stage
through a scripted command executor, `real-tools.test.ts` runs the real
`bunx tsc --noEmit`, `bunx biome check` and `bun test` once, and
`measure.test.ts` runs the real oracle measurement against five files that
differ only in HOW they fail.

## Map to the design document

| Path | Implements |
|---|---|
| `structural/parser.ts` | § 4.1 Structural parser layer. The `Parser` contract, `SymbolKind`, `ObservedSymbol`, and `identityKey` — the one function that decides what "the same symbol" means. |
| `structural/typescript.ts` | § 4.1. tree-sitter over the TypeScript grammar: the symbol inventory, the import list, and the parse check that is the first verification stage. |
| `registry.ts` | § 3.2 Identity persists through change, § 4.3 Symbol identity registry, § 9.1 Out-of-band changes. Opaque ids, versions, tombstones, file ids, desync state, `importExternal` / `rejectExternal`. |
| `log.ts` | § 4.4 Event log. Append-only, seq-ordered, intent-carrying, lease-linked. `history` / `at` / `byTask` / `byLease` are the four capabilities the section claims over a commit graph. |
| `leases.ts` | § 5 Coordination protocol. Atomic multi-acquire, the mode matrix and its hierarchy, optimistic version checks, TTL and heartbeat, release-time intent validation. |
| `verify.ts` | § 6.1 Layers of verification, § 6.4 When verification cannot decide. The four stages, the failure categories, the verification statuses, and the default implementations over a consumer's declared commands — plus the oracle measurement, which is not a stage and lives here because this is the module's one place that knows what running a test MEANS. |
| `junit.ts` | The one JUnit XML reader. The tests stage and the oracle measurement both read their verdict off a report a declared command wrote, rather than off one runner's stdout. |
| `impact.ts` | § 6.2 Test impact analysis, § 6.3 Cold start (mode 3: static graph alone). |
| `writes.ts` | § 5.4 Release and commit, § 6.1. `replaceSymbolBody`, `renameSymbol`, `deleteSymbol`, `writeFile`, `runTests`, `measureOracle`, and the rollback. |
| `executor.ts` | The framework seam. `DETERMINISTIC-WORKFLOWS.md` § "The agent-native VCS is the effect executor and mechanical verifier". |
| `index.ts` | § 4.3's "runs as a single process and is the source of truth". The composition root: one database, one parser, one verifier, one clock, one id generator. |
| `defaults.ts` | The only file allowed to read a clock or an RNG. |
| `testing.ts` | Fixtures: counter ids, a manual clock, stage stubs, a temp project. The VCS's counterpart to `src/harness/`. |

Sections with no file behind them are in [Not built yet](#not-built-yet): § 4.2
(ast-grep), § 4.5 (the MCP tool surface), § 4.6 and § 7.3 (LSP), § 7.4 (git
export), § 9.2 (cross-repository), § 9.4 (authorization).

## The parser: native tree-sitter, not wasm

`tree-sitter` + `tree-sitter-typescript`, the native Node bindings.

`web-tree-sitter` with wasm grammars was tried first, because a wasm grammar is
the more portable artifact. It does not load under bun: the published
`tree-sitter-wasms` grammars and the current `web-tree-sitter` runtime disagree
on the dylink ABI, and `Language.load` throws inside the emscripten module
loader before any of our code runs. The native bindings ship prebuilt binaries
for darwin, linux and win32 on both arm64 and x64, so nothing compiles at
install time; they parse synchronously, so a parse can sit inside the write path
with no `await`; and they typecheck against a real `.d.ts`.

The cost is a native dependency and a platform matrix. The mitigation is the
`Parser` interface in `structural/parser.ts`: three methods, `symbols`,
`imports` and `parses`. A Rust grammar is a second file implementing that
interface, and nothing above it changes.

What the inventory recognises, which is exactly what a lease can be taken on:

| Kind | Recognised from |
|---|---|
| `function` | function and generator declarations |
| `class` | class and abstract class declarations |
| `method` | method definitions in a class body |
| `interface` | interface declarations |
| `type-alias` | type alias declarations |
| `enum` | enum declarations |
| `variable` | `const` / `let` / `var` declarators, outside a function body |
| `test` | a `test(...)` or `it(...)` call whose first argument is a string, named by that string, with enclosing `describe(...)` labels as its container path. A modifier — `test.skip`, `test.todo`, `test.only`, `test.failing` — is the **same** test, marked: identity is `(kind, container, name)` and a modifier is none of those, which is what makes stripping a pending marker a body edit rather than a rename |

**The walk stops at a function-like symbol and descends into a class.** A
function's body is its content, not a container of separately addressable
symbols; a class's methods are addressable in their own right. That boundary is
load-bearing rather than tidy, and the real-tool test is what found it:
descending into function bodies made every local `const` a tracked symbol, so
replacing a body with one that introduced a local changed the file's identity
set and the structural stage correctly refused an edit that was perfectly fine.

A symbol's range is its whole declaration, `export` keyword included, so a body
replacement is a self-contained unit. Its name range is the name token on its
own, because that is what a declared rename splices. Offsets are indices into
the source string rather than UTF-8 byte offsets: tree-sitter's Node bindings
report UTF-16 code units, which is what `String.prototype.slice` takes, so the
splice is exact for non-ASCII source.

## Storage

One `bun:sqlite` database per repository, path injected, `":memory:"` in tests.
Five tables. Events are immutable; symbols carry a current version and a
tombstone flag.

```sql
-- § 4.4. The total order is the rowid, so "later" is a number rather than a
-- clock reading, which is what lets the whole module run on an injected clock.
events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
  symbol_id TEXT, file_id TEXT, lease_id TEXT,
  task_id TEXT, parent_task_id TEXT, description TEXT,   -- intent (§ 4.5)
  source_channel TEXT,            -- set instead of task_id on an import (§ 9.1)
  version INTEGER,                -- the symbol's version after this event
  verification TEXT,              -- pending | passed | failed | advisory (§ 6.3)
  category TEXT,                  -- contract | verification | infrastructure (§ 5.4)
  body TEXT,                      -- the symbol's text, which is what at() reads
  children TEXT,                  -- child seqs, on a transaction event
  detail TEXT
)

-- § 4.3. `content` is the registry's last-known bytes, which is what a reject
-- restores; `pending` holds the divergent source a desync is waiting on.
files (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, content TEXT NOT NULL,
       desynced INTEGER NOT NULL DEFAULT 0, pending TEXT)

-- § 4.3. (kind, container, name) is the identity key; `id` is opaque and never
-- derived from it. `ord` preserves declaration order.
symbols (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, kind TEXT NOT NULL,
         name TEXT NOT NULL, container TEXT NOT NULL,
         start INTEGER NOT NULL, end INTEGER NOT NULL,
         name_start INTEGER NOT NULL, name_end INTEGER NOT NULL,
         content_hash TEXT NOT NULL, version INTEGER NOT NULL,
         tombstoned INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL)

-- § 5.1. `versions` is the snapshot handed back at acquisition; `intent` is the
-- payload release validates against. `paths` is the territorial half of the
-- claim: prefixes or globs a `write-file` may land under, for a file that has
-- no version to be optimistic about because it does not exist yet. Rows are
-- closed, never deleted.
leases (id TEXT PRIMARY KEY, session TEXT NOT NULL, mode TEXT NOT NULL,
        symbol_ids TEXT NOT NULL, paths TEXT NOT NULL, ttl_ms INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, intent TEXT NOT NULL,
        versions TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0)

-- § 6.2, at module grain. See "Impact" below for why the reverse index from a
-- symbol to its tests is projected rather than materialised.
impact_edges (from_file_id TEXT NOT NULL, to_file_id TEXT NOT NULL,
              PRIMARY KEY (from_file_id, to_file_id))
```

## The write path

Ten steps. Three SYMBOL operations, and they differ only in how they edit the
source, what identity delta they declare, and what lease mode they require.

1. **Resolve the lease.** Live, held in a mode that permits the operation
   (`write` or `exclusive` for an edit or a rename, `exclusive` only for a
   delete), and covering this symbol. Otherwise `rejected: contract`.
2. **Check the call's own intent.** § 4.5's payload declares `expectedOutcome`;
   if it does not name this symbol, the call is refused before anything happens.
3. **Optimistic version check.** A mismatch is `conflict` carrying
   `currentVersion`, never an exception (§ 3.3).
4. **Check the file is still the registry's.** If the bytes on disk differ from
   the last-known content, something outside the system edited it between the
   acquire and now: mark the file desynced (§ 9.1) and return `infra-failed`,
   because that is not the caller's error.
5. **Splice and write.** An edit replaces the symbol's whole range, a rename
   replaces the name token's range, a delete removes the range.
6. **Structural stage.** Does the file still parse, and is the identity delta
   the declared one? An edit declares no delta at all, a rename declares one key
   out and one in (plus the container-path rewrite of everything the symbol
   holds), a delete declares the symbol and its descendants going out. A body
   that does not parse is `rejected: structural`; a body that parses and does
   something other than what was declared is `rejected: contract`, which is the
   case of § 4.5's "a `structural_disposition` field claiming 'edit to symbol X'
   against a text replacement that removes X entirely".
7. **Typecheck stage.** The consumer's declared `commands.typecheck`, over the
   whole project, because a type error an edit introduces usually surfaces in
   the file that consumes the symbol rather than the one that defines it.
   `rejected: typecheck`.
8. **Lint stage.** The consumer's declared `commands.lint`, over the file the
   write touched. `rejected: lint`. This replaced a `policy` stage that was a
   stub returning "passed" because neither of § 6.1's policy mechanisms was
   built; a declared lint command is one that is. It is scoped to the write
   rather than to the project because it runs INSIDE the write path and the
   question it answers is whether THESE bytes broke a rule.
9. **Tests stage.** The consumer's declared `commands.tests`, once per
   impacted test, each told where to write a JUnit report. `rejected: tests`,
   with the failing ids taken from the report's own failing cases, because a
   caller routes on whether one of them is its own. The impacted set
   **excludes every test THIS BATCH is rewriting** — the lease's whole symbol
   set, not just the write in hand: running the very test you just activated
   to decide whether you were allowed to activate it makes a pending
   acceptance test unactivatable, since its first honest run fails by design.
   Every other test that reaches the file still runs, so "did you break
   something else" is still answered, and a production symbol's write is
   unaffected because its id is not a test id. A non-zero exit whose report
   records neither a failure nor an error is `advisory` rather than a refusal
   (§ 6.4): nothing was established, so nothing blocks.
10. **Commit.** Re-key the file, refresh every range and hash, bump the versions
    of everything that changed, append the child event(s), then append the
    `transaction` event naming their sequence numbers. The parent lands last, so
    a reader that sees it knows every child is already in the log (§ 4.4).

The stages are thunks rather than values, because § 6.1's whole point is that an
expensive stage runs only when the cheap ones ahead of it passed. Any failure
between 5 and 9 restores the file byte for byte and appends a `write-failed`
event carrying which of § 5.4's three categories it was. An `advisory` outcome
does not block; it downgrades the write's recorded verification status (§ 6.4).

### `writeFile`: the operation that can produce a file

A fourth operation, and not that shape, because it cannot be. The three above
all resolve a symbol id first, so a file that does not exist is unreachable
from any of them — the right shape for a crafter working inside a declared
surface, and useless for an author whose whole job is to write an oracle that
is not there yet.

What changes:

- **The claim is a path scope, not a version.** A file has none to be
  optimistic about before it exists, so the lease holds a territorial claim
  over a region of the tree and `writeFile` checks that it covers the path.
- **The intent declares the PATH**, under `expectedOutcome.created`, which is
  re-specified as paths rather than symbol ids for the same reason. Release
  learns the matching half: a symbol a whole-file write created could not have
  been named by id at acquire time, so a symbol whose file the lease's scope
  covers is inside the declaration.
- **The structural question is weaker, by exactly the right amount.**
  `wholeFileStage` asks that the file parses and that no identity it already
  held has vanished. What APPEARS is the author's business; what disappears is
  not, because the registry never infers a delete from an absence (§ 9.1).
- **The tests stage is skipped**, and that is the point rather than an
  omission. An oracle's first honest run fails; a stage that ran the suite
  would refuse every oracle for being what an oracle is. Measuring it is a
  separate observation with its own verdict. **Lint is NOT skipped**: an
  oracle is bytes in the repository like any other, and the rules the
  repository declares apply to it.
- **A failed write restores the previous bytes, or removes the file it
  created.** A rollback of a creation is a removal.
- **The creation is attributed to the TASK.** `file-created` is a new event
  kind, distinct from `file-tracked` — one carries a task, the other a source
  channel — because reading them as one would make "who wrote this file"
  unanswerable for exactly the files an agent wrote.

### `measureOracle`: not a write, not a gate

One oracle, executed, with a verdict read off it. It takes no lease, changes
nothing, and its interesting answer is a FAILURE.

The reason it is here rather than in a leaf is the rule the shipped nwave
runner names `boundary:software-measures-model-decides`: the two roles that
hold an oracle — its author, `Read, Edit`, and its reviewer, an enforced empty
tool set — cannot run it. So "this oracle fails on its assertion and not on its
scaffolding" is a property this module owns and measures.

Exit status alone cannot answer it, because a runner exits non-zero for both a
genuine assertion failure and an oracle that errored in its own scaffolding.
So the counts are read, and the AXIS that reached the verdict travels with it:

```
exit status absent, or outside {0, 1}   -> broken,        axis "exit-status"
no summary counts at all                -> broken,        axis "no-summary"
exit 0                                  -> green,         axis "counts"
errors > 0                              -> broken,        axis "counts"
failures > 0                            -> red,           axis "counts"
otherwise                               -> indeterminate, axis "counts"
```

The rule is unchanged from the cut that scraped bun's stdout. What changed is
where the counts come from: the declared oracle command is told where to write
a JUnit report and `junit.ts` reads it, so the verdict is no longer a function
of one runner's human output.

`junit.ts` keeps two absences apart, and that is what lets the rule stay as it
is. **No report at all** means the runner never got as far as writing one, so
it ran nothing: the counts are `undefined` and the verdict is `broken` on the
`no-summary` axis. A test file whose import does not resolve, or that does not
parse, lands here — measured against bun 1.3.12, which writes no document for
either. **A report no reader can count** is different: the runner wrote
something, so nothing was ESTABLISHED rather than nothing having run, the
counts are zeros, and a non-zero exit over them is `indeterminate`.

One reading moved, and it got sharper. A selector naming no test was `broken`
on `no-summary`, because bun printed no summary. Its JUnit report says two
tests existed and both were skipped, and it exits non-zero anyway: that is the
definition of `indeterminate`, and it is now what it is called.

`errored` is failures-versus-errors, which is the whole reason the counts are
read rather than the exit status. bun does not distinguish them and emits
`<failure>` for both, so for a bun project `errored` is always zero and
`broken` arrives by the absent-report route instead. A runner that does
distinguish them is read correctly, which is the point of reading the
interchange format rather than one runner's prose.

A runner that never STARTED is `infra-failed` with no measurement at all.
Nothing about the oracle was observed, so nothing about it is claimed, and in
particular its author is not blamed. That diverges from nwave, which reads a
None status as `broken`; the framework's own "a flaky harness must not burn a
budget" discipline is the stronger rule here.

EVERY measurement is on the event log, including the red ones. `red` is the
admitted answer and it is exactly the one a later reader needs, because it is
what says the oracle failed before one production byte existed.

### Known-red targets

The tests stage's question is "did you break something ELSE". It already
excludes every test the BATCH is rewriting (deviation 14). Once oracles are
live files rather than pending markers that is not wide enough: a value is only
ready to be delivered once its own oracle has been measured red, so a module
with two undelivered values always has a live failing test in it, and the gate
was refusing a sibling's correct write for it.

`replaceSymbolBody` and `runTests` therefore take `knownRed`: tests the caller
knows were already failing for a reason this write did not cause. The caller
has to say so because only the caller can know it — nothing in the bytes
distinguishes "you broke this" from "this was broken" without running the suite
twice, which is exactly the cost the impact graph exists to avoid.

For `runTests` the set comes off BOTH the run and the floor the union is
checked against. Excluding it from one and not the other would make the caller
refuse itself for omitting a test it was told to leave out. It is not the
caller narrowing the floor, which is the one thing the union rule forbids: the
floor is about what this change could have affected, and a test that was red
before it ran is a fact about the world the caller was handed.

The result union is deliberately the same shape as `EffectResult`'s:

| Write path | `EffectResult` |
|---|---|
| `committed { version, seq, verification }` | `committed { version }` |
| `conflict { currentVersion }` | `conflict { currentVersion }` |
| `rejected { by, detail, failed? }` | `rejected { by, detail? }` |
| `infra-failed { detail }` | `infra-failed` |

`by` is `structural \| contract \| typecheck \| tests`, which is
`EffectResult`'s own union minus `schema` (that one belongs to
`upsert-artifact`). So the executor's mapping is the identity function on
`outcome` and on `by`, and it interprets nothing.

## Leases

An acquire names the complete set it will need — symbols, PATH SCOPES, or both,
and not neither.

The mode matrix, § 5.2 as a table. Rows are the mode a live lease holds,
columns the mode being requested, and the cell says whether the request is
blocked:

| held ⧵ requested | `read` | `write` | `exclusive` |
|---|---|---|---|
| `read` | admits | blocks | blocks |
| `write` | admits | blocks | blocks |
| `exclusive` | blocks | blocks | blocks |

It is asymmetric, because the document is: a read lease blocks a later write,
and a live write lease does not block a later read, "because readers see the
pre-write version until the write commits". All nine pairings are tested.

The same table applies across the symbol hierarchy. A request on a symbol is
evaluated against leases on that symbol, on everything above it, and on
everything below it, so a write on a class is blocked by a lease on any of its
methods and the reverse. That is § 5.2's intention locks, computed from the
container path rather than stored.

And the same table applies over the TREE. Two sessions whose path scopes
overlap are asking for the same region, and who may have it is the question the
matrix already answers. `scopeCovers` is a prefix or a glob; `scopesOverlap` is
symmetric. For prefixes it is exact — `test` overlaps `test/todo.test.ts` and
neither overlaps `src`. For two globs it is an APPROXIMATION, because "can two
patterns match the same string" is not a question a matcher answers: one
scope's glob is matched against the other's literal text. That is right for
every shape a caller here writes and it never reports an overlap that is not
one; what it can miss is two globs that overlap only on strings neither spells.
Stated rather than hidden — a caller that needs the stronger guarantee names
prefixes.

Deadlock is prevented by construction rather than detected. An acquire names the
complete set it will need, and a session that already holds a live lease cannot
acquire another, so there is no hold-and-wait and therefore no cycle. Expiry is
lazy: nothing sweeps on a timer, and an acquire retires the deadlines that have
passed before it evaluates anything, which is the only moment at which an
expired lease can change an answer.

Release compares the intent declared at acquisition against what the log says
happened under the lease (§ 5.4). The test is containment in one direction: a
lease that declared two symbols and changed none of them refused its writes,
which is a refusal rather than a divergence, while a lease that changed
something it did not declare is the divergence the section names. The declared
scope is closed over the symbol hierarchy, because editing a method necessarily
rewrites the text of the class holding it.

## Desync, end to end

§ 9.1's conservative default, which is the one the document chooses.

1. Something with no declared intent changes a file: a person in an editor, a
   git pull, a codegen step.
2. `vcs.reinventory(path)` reads the file and compares it against the registry's
   last-known content. Equal: nothing happened. Different: the file is marked
   desynced, the divergent source is held in `files.pending`, a
   `desync-detected` event is appended, and the caller gets a `Divergence`
   naming which identity keys vanished, which appeared, and which symbols'
   bodies changed.
3. `acquire` on any symbol in a desynced file returns `{ outcome: "desync",
   fileIds }`. No new lease is granted until it is acknowledged.
4. The acknowledgement is explicit, and it is one of two things.
   `importExternal(fileId, sourceChannel)` adopts the held source: new
   identities are created, vanished ones are tombstoned, changed bodies bump
   versions, and every event carries the channel and **no** task id, so an
   external change can never become indistinguishable from an agent action in
   the log. `rejectExternal(fileId)` discards the held source and writes the
   registry's content back to disk, leaving every id where it was.
5. Either way the desync clears and leases are available again.

The write path is the fifth entrance to this: if the bytes on disk moved between
the acquire and the write, step 4 of the sequence above marks the desync itself
and returns `infra-failed`.

What the registry never does is guess. Identity is `(kind, container, name)` and
never the content hash, so a symbol that disappeared and one that appeared are
two facts rather than one rename, and § 9.1's structural-similarity inference is
not available to be reached for.

## Impact

§ 6.3's third bootstrap mode, and only that: the static import graph, with no
coverage refinement. The stored edge is a module import edge; a test is impacted
by a symbol when the test's file can reach the symbol's file through imports, or
is that file.

The reverse index from a symbol to its tests is **projected at query time rather
than materialised**, which is a deliberate trade. Materialising it would make
every new file invalidate the whole table, because an import edge can create
edges between files that already existed; on this repo's own `src/` that is tens
of thousands of rows rebuilt per tracked file. The module graph is small, the
reachability walk is cheap, and the projection is exact.

Test identity is free. A test is a symbol of kind `test`, so § 6.2's "tests are
assigned stable identifiers on first observation, the same way symbols and
files are" needs no second registry.

The approximation is stated rather than hidden, as § 6.2 asks. It
over-approximates, because importing a module does not mean exercising every
symbol in it. It under-approximates for anything that crosses a module boundary
without an import: a fixture file, an environment variable, a subprocess.

## The executor seam

```ts
const execute = vcsExecutor({
  vcs,                    // openVcs({ root, commands, dbPath, parser, verifier, clock, ids })
  session: "session-crafter",
  intent: { taskId: "02-03", parentTaskId: "roadmap-7", description: "make the AT pass" },
});

await run(deliverGraph(journal, defs), seed(step, evidence), execute);
```

The batch is the unit. A step's `Effect[]` may name several symbols and several
paths, and § 5.3 says an acquire names the complete set it will need, so the
executor takes **one** write lease covering every `replace-symbol` target AND
every `write-file` path in the batch, applies the writes in order, releases,
and maps each outcome onto an `EffectResult`. That is the design document's
"fanout over writes needs leases per symbol, not per step", and it is also why
hold-and-request being refused costs nothing: the executor never needs it.

Ahead of all of it sits the PROTECTED scope. Any `replace-symbol` or
`write-file` landing under one is `rejected { by: "contract" }` before a lease
is asked for, with the refusal appended to the event log. This is
`_crafter_owns` as an executor rule: every path a task declares is the
crafter's EXCEPT the oracle, because RED to GREEN must be bought by production
and never by editing the test that measures it. Expressing it here rather than
in a graph is what makes it hold for every write the graph could emit,
including one a model proposed and the graph merely passed along.

The session and the task intent are fixed per executor instance, because
`EffectExecutor` is `(effects) => Promise<EffectResult[]>` and threading
provenance through that signature would put the framework's control plane inside
the VCS's argument list. One executor per task is the answer, and the core
signature does not change.

Beyond the write path's own four outcomes, the executor maps the lease layer's:

| Acquire | `EffectResult` | Why |
|---|---|---|
| `stale` | `conflict { currentVersion }` | the version the world moved to, which is the rebase input |
| `conflict` | `conflict { currentVersion }` | a lease conflict is an edge to a rebase-and-retry node |
| `contract-violation` | `rejected { by: "contract" }` | the agent's own error, retryable as stated |
| `desync` | `infra-failed` | a channel outside the system changed the file; not the agent's fault, and must not burn its budget |

And the effects that are not writes:

- **`run-tests`** runs the tests stage over `impactedTests(effect.impacted)`.
  Pass is `committed`, with the sequence number of the `tests-run` event as the
  version; fail is `rejected { by: "tests" }`; a broken runner is
  `infra-failed`.
- **`run-command`** runs one declared command in the repository this executor
  owns, through the framework's own single process runner
  (`src/core/commands.ts`). Exit 0 is `committed`, any other exit is
  `rejected { by: "command" }`, and a process that could not be spawned or was
  killed at its budget is `infra-failed`. It takes no lease, claims no version
  and writes no symbol, so there is nothing for the write path to do with it;
  it is still on the event log, as a `trail` line carrying the argv and the
  exit, because every effect this executor performs is. The version a committed
  run comes back with is that event's own sequence number, which is the answer
  `run-tests` gives one case over and for the same reason.
- **`append-trail`** becomes a `trail` event under the task. The exhaustion
  trail of a step whose validator was never satisfied is provenance, and the
  event log is the provenance store.
- **`measure-oracle`** is the one effect whose mapping is not the identity.
  `green` is `committed`, because it is the only verdict where the world
  accepted what it was handed; `red`, `broken` and `indeterminate` are
  `rejected { by: "tests" }` carrying the verdict that names which. The
  measurement rides on `measured`, so a pure branch reads all four answers off
  one field rather than two. A runner that never started is `infra-failed` with
  no measurement at all.
- **`upsert-artifact`** goes to the `ArtifactStore` the executor was handed
  (`src/artifacts/store.ts`), under the same optimistic version check
  `replace-symbol` gets one column over. The VCS is the data plane for CODE and
  is not becoming the data plane for artifact rows: the store is a separate
  module with its own database, and this is a route rather than an absorption.
  Without a store it is still `infra-failed`, because an executor with nowhere
  to write must not report that it wrote.

The `Effect` union did **not** need extending. `replace-symbol` already carries
`symbolId`, `expectedVersion` and `body`; the lease and the intent are the
executor's, not the graph's, which is the right split — a graph author should
not be writing lease ids into effect payloads.

## Deviations from ai-vcs.md

1. **A TypeScript library, not a Rust CLI.** § 8 phases a Rust command-line
   agent. The consumer here is the workflow framework in this repo, which is
   TypeScript on bun, and a coordinator in another language would need an IPC
   protocol before it could be used at all. The layering is the document's; the
   language and the process model are not.

2. **Phase 1 is skipped, because its question is moot here.** § 8.1's phase one
   exists to answer "do agents actually use the structured tools when given
   them". Inside a workflow the agent does not pick tools; the graph does. The
   document says this itself, in § "The 'do agents prefer structured tools'
   question is moot here": the VCS does not need to win a preference contest
   because the runner is its only caller. So the build starts at § 8.2.

3. **No MCP tool surface, and therefore no tier system.** § 4.5's three tiers
   exist to make the structured path cheaper than bash for an agent choosing
   between them. The caller is `vcsExecutor`, which has no bash to drift to.
   The intent payload § 4.5 defines is kept in full, because it is what the
   registry validates against; the tool surface that would deliver it is not.

4. **Commit is per write, not per release.** § 5.4 has release commit the work
   and § 6.1 has verification run "inside the write path, before the lease
   release that would commit an event". Those pull in opposite directions. This
   implementation takes § 6.1: each write verifies and commits atomically, so
   there are no tentative log entries for a release to roll back. Release
   validates declared-against-observed and closes the lease. The consequence is
   that a release-time contract violation is recorded rather than compensated,
   because the writes under it already landed and were each individually
   verified. Multi-write atomicity across a lease is in Not built yet.

5. **The transaction event is per write, not per lease.** § 4.4's
   children-then-parent ordering is implemented at the write, which is where the
   set of child events is known. A lease holding three writes produces three
   transactions and one `lease-released`, rather than one transaction over nine
   children.

6. **Expiry is lazy, not swept.** § 4.3 says "missed heartbeats expire them"
   without saying who notices. A timer would be a second source of
   nondeterminism and would need the clock this module deliberately does not
   read. An acquire retires the deadlines that have passed before it evaluates
   anything, which is the only moment an expired lease can change an answer.

7. **Offsets are source-string indices, not UTF-8 byte offsets.** § 4.1 says
   "byte range". tree-sitter's Node bindings report UTF-16 code units, which is
   the unit `String.prototype.slice` takes, so this is the same range in the
   unit the runtime addresses. A non-ASCII file splices exactly, which is
   asserted.

8. **A function body holds no symbols.** § 4.1 says "top-level and nested
   symbols" without drawing the line. Nesting stops at a function-like symbol
   and continues into a class body. See the parser section above for why: this
   is the boundary between what a lease can be taken on and what is merely text
   inside something leasable, and getting it wrong made every body rewrite that
   introduced a local variable a contract violation.

9. **Containers version alongside their children.** Editing a method bumps the
   method's version and the class's, because the class's text genuinely changed.
   The document does not address it. Saying only the method changed would be the
   lie, and the alternative reading (a version that does not move when the bytes
   do) breaks the optimistic check for anyone holding the class.

10. **`contract` and `structural` were added to `EffectResult`'s `rejected.by`.**
    The framework's union was `typecheck | tests | schema`, which cannot express
    § 5.4's contract-violation category at all. It is now
    `typecheck | tests | schema | contract | structural`. This is the one change
    to `src/core`. `memoryEffects` needed no edit, because it never produced a
    `rejected` outcome.

11. **The `policy` stage is deleted, and `lint` is not it renamed.** The stage
    was a stub returning "passed", justified by neither of § 6.1's policy
    mechanisms being built, and it reported a failure it could never produce as
    `rejected: contract` because the `by` union had no `policy` member. What
    replaced it takes the paths a write touched, runs a command the CONSUMER
    declared, and rejects with `by: "lint"` — so the union gained `lint` for a
    refusal a stage actually produces, and `STAGE_NAMES` is now
    `structural | typecheck | lint | tests`.

12. **`INVENTORY_CHANNEL`.** First observation of a file is attributed to a
    source channel called `inventory` rather than to a task, on the same
    grounds as § 9.1's external imports: adopting code that already exists is
    not an agent action, and the log should not imply that it was.

13. **`byLease` was added to the event log's queries.** § 4.4 says events "link
    to the lease under which they occurred" and § 5.4 needs to read that link
    back at release. A log that stores the link and cannot query it would have
    forced a second bookkeeping structure that could drift from it.

14. **The tests stage excludes every test the BATCH is rewriting.** § 6.1 says
    the stage runs the impact-scoped subset without addressing the case where
    the write's own target IS one of those tests. Running it to decide whether
    the write was allowed makes activating a pending acceptance test
    impossible, because its first honest run fails by design and that failure
    is the caller's own next observation. See the write path, step 8.

    The filter is over the LEASE's symbol set rather than the write in hand,
    and that widening was forced by a target with two pending tests behind one
    stub: a step whose acceptance criterion has two acceptance tests activates
    both, as two writes under one lease, and a per-write filter leaves the
    first-activated test in the second one's impacted set — where it fails, by
    design, because the production code it asserts is still a stub. The second
    activation was then refused for the first one's honest red. The lease is
    what names the batch, so the lease is what the filter is over.

15. **A test's modifier does not change its identity.** § 4.1 lists what a test
    symbol is without addressing `test.skip` / `test.todo` / `test.only` /
    `test.failing`. They are recognised, and they map to the same identity key
    as the unmodified call, because identity is `(kind, container, name)`.
    Nothing in this repository depends on that any more — pending markers were
    the previous cut's model of DISTILL and are gone — but the parser is more
    correct with it than without, so it stays.

16. **`StageOutcome`'s failed variant and `WriteResult`'s rejected gained
    `failed?`.** The ids of the targets that failed, when the stage can name
    them, which the tests stage can, out of the JUnit report's own cases. A caller routing "the test I was making pass is
    still failing" against "I broke a different one" needs them, and that is a
    set membership rather than a judgement. A stage with nothing to name leaves
    it absent rather than reporting an empty set, which would claim that
    nothing failed.

17. **A fourth operation, `writeFile`, which § 5 does not have.** Every
    operation the document names resolves a symbol id first, so a file that
    does not exist is unreachable from all of them. That is the right shape for
    an agent working inside a declared surface and the wrong one for an author
    whose job is to write a test that is not there yet. The claim it holds is a
    PATH SCOPE rather than a version, because a file has none before it exists;
    `expectedOutcome.created` is re-specified as paths for the same reason
    (nothing had ever populated it with symbol ids); and its structural stage
    is weaker by exactly the right amount — what appears is the author's
    business, what vanishes is not. Its tests stage is absent rather than
    stubbed: see the write path above.

18. **Leases hold path scopes as well as symbols, and the mode matrix applies
    to both.** § 5.2's intention locks are over the symbol hierarchy; this is
    the same table over the tree, because two sessions whose scopes overlap are
    asking for the same region. The glob-vs-glob overlap test is an
    approximation, stated where it lives.

19. **`measureOracle`, which is neither a write nor a stage.** § 6 is about
    gates: cheap ones first, every one a reason to refuse. This is the
    opposite — nothing gates on it, it blocks nothing, and its interesting
    answer is a failure. It is here because it is the module's one place that
    knows how to run a runner and read what it printed, and because the roles
    that hold an oracle cannot run it. The verdict rule and its measured
    evidence are in the write-path section; the one divergence from nwave is
    that a runner which never STARTED is `infra-failed` rather than `broken`.

20. **`knownRed` on `replaceSymbolBody` and `runTests`.** Deviation 14's rule,
    one step wider: a test whose failure this write did not cause must not
    refuse it. The batch filter covers the tests the write is itself
    rewriting; this covers the ones that were already red. Only the caller can
    know which those are, so it says, and for `runTests` the set comes off the
    floor as well as the run — excluding it from one and not the other would
    make the caller refuse itself for omitting a test it was told to leave out.

21. **A protected scope on the executor.** Not in the document at all, because
    § 9.4's authorization is the thing it would have belonged to and that is
    not built. This is narrower and does one job: a write landing under a
    declared scope is refused before a lease is asked for, which is how one
    role's ownership of one file becomes structural rather than a rule a
    reviewer applies.

22. **Every stage is a `run-command` over a CONSUMER's declaration.** § 6.1
    describes the stages and leaves the commands to the implementation, which
    is how they came to be `bunx tsc --noEmit` and `bun test <file> -t <name>`
    spawned from inside this module. That made the module usable by exactly one
    kind of project. The stages now take `Commands` (`src/core/commands.ts`)
    and a `CommandExecutor`, and compose a `run-command` effect per stage;
    nothing under `src/vcs/` calls `Bun.spawn`. The cost is the boundary: this
    module imports three types and one function from `src/core` rather than two
    types. The direction is unchanged.

23. **The verdict is read off a JUnit report, not off a runner's stdout.**
    § 6.1 does not say where a test result comes from. The previous cut scraped
    bun's own summary lines, which made the verdict a function of one runner's
    human output. A declared command is told where to write a JUnit report and
    `junit.ts` reads it. The four-word verdict rule is untouched; what moved is
    where the counts come from. `bunCounts` is deleted rather than kept beside
    the reader, because two ways to count one run is one more than a single
    verdict allows.

24. **`measureOracle` lost its `argv` override, and `MeasureContext` carries a
    locator rather than a command.** The override existed for "a project whose
    runner is not the default", which is now what the declaration is for. Two
    ways to name the runner is exactly the ambiguity `Commands` removes.

25. **The tests stage stops at the first target that did not pass, and mints a
    temp directory for the reports.** The first is unchanged behaviour, stated
    because the JUnit read makes it visible: one answer settles "did this break
    something else". The second is forced — a runner will not create the
    report's parent directory, measured against bun 1.3.12 — so the stage
    makes one per invocation and removes it afterwards.

## Not built yet

- **The ast-grep pattern and rewrite layer (§ 4.2, § 9.3).** The rule checks
  § 6.1 put in a policy stage are a declared lint command now, so the stage is
  no longer a stub; what is still missing is the pattern layer inside the VCS.
  It is also what the design's `checks/symbol-diff.ts` wants, and what would
  make "implement to the design, never invent public API" a set difference over
  exported symbols rather than a model refuting prose. The symbol inventory it
  needs now exists.
- **The MCP tool surface (§ 4.5).** See deviation 3. The intent payload is
  built; the tools that would deliver it to a free agent are not.
- **The LSP layer (§ 4.6, § 7.3).** No cross-file reference resolution, no
  type-aware rename, no compiler diagnostics from a language server. The
  declared typecheck command runs over the whole project instead, which is
  correct and slower and cannot answer "which symbols reference this one".
- **Coverage-refined impact (§ 6.2).** Static graph only, which is § 6.3's
  cold-start mode 3 without the refinement that was supposed to follow. Nothing
  runs a test under instrumentation, so dynamic dispatch and injection are
  invisible. Declared test dependencies and the periodic full-suite backstop
  § 6.2 names are also absent.
- **The asynchronous verification tier (§ 6.3).** Every stage runs
  synchronously inside the write. A test slower than the latency budget blocks
  the write rather than committing it `pending` and following up. The
  `pending` status exists in the union and nothing produces it.
- **Wait-die (§ 5.3).** Atomic multi-acquire is the whole protocol.
  Hold-and-request is refused, and a caller that cannot predict its access set
  has no fallback. There is also no queueing: an acquire is fail-fast, and the
  document's "queued when the agent indicated willingness to wait" is not an
  option a caller can ask for.
- **Lease-level rollback, and transaction groups spanning a lease.** See
  deviation 4. Each write is its own atomic unit. A lease whose second write
  fails leaves the first one committed, and release records the divergence
  rather than undoing it.
- **Git export (§ 7.4).** Nothing projects the log onto a git tree, and the
  registry is not seeded from git history.
- **Cross-repository coordination (§ 9.2).** One `openVcs` per repository, and
  no federation between them.
- **Authorization (§ 9.4).** A `session` is a string. Any session may acquire
  any lease in any mode on any symbol.
- **`renameSymbol` across files, which is § 3.2's "moved between files".** The
  registry's identity key is scoped to a file, and there is no declared move
  operation. A symbol that moves between files is a desync on both.
- **Durable snapshots for the lease table.** The database persists when given a
  path, but nothing recovers a lease held by a process that died; the lease
  simply expires at its deadline, which is the intended behaviour and is
  untested against a real restart.
- **A JUnit report per RUN rather than per target.** The tests stage runs one
  declared command per impacted test, each writing its own report, because a
  target is `path::name` and that is what a runner filters on. A runner that
  could be handed several names at once would need one command and one report,
  and the stage does not model that.
- **A second oracle measurement per run.** `measureOracle` runs the oracle once
  and reads one verdict. A flaky oracle — one that is red on its first run and
  green on its second — is therefore indistinguishable from a stable one, and
  the framework records the first answer as the fact. Running it twice would
  detect it and would double the cost of the one observation that is a fixed
  floor; nothing has measured how often it matters.
- **Authorization (§ 9.4) beyond the protected scope.** A `session` is still a
  string, any session may lease anything, and `protected` is a per-executor
  list rather than a policy the repository declares. It walls one file from one
  role because one caller asked it to.
