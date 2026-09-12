# src/vcs — the agent-native VCS

An implementation of [`ai-vcs.md`](../../ai-vcs.md) as a TypeScript library on
`bun:sqlite`, wired to the workflow framework through one seam: an
`EffectExecutor` that executes `replace-symbol` and `run-tests` for real.

The framework is the control plane: what happens, in what order, validated how.
This module is the data plane for code: how a write lands, under what
concurrency, with what provenance. The dependency runs one way. `src/core`
imports nothing from here, and `src/vcs/executor.ts` imports the `Effect` and
`EffectResult` types from `src/core/effects.ts` and nothing else from the
framework. Everything else under `src/vcs/` does not know the framework exists.

**87 tests, 1.9 s, no network, no key, no model.** The verification stages are
injected everywhere except one file, so "typecheck failed" is an input rather
than a compiler run; `real-tools.test.ts` runs the real `bunx tsc --noEmit` and
`bun test` stages once, for 1.1 s of that total.

## Map to the design document

| Path | Implements |
|---|---|
| `structural/parser.ts` | § 4.1 Structural parser layer. The `Parser` contract, `SymbolKind`, `ObservedSymbol`, and `identityKey` — the one function that decides what "the same symbol" means. |
| `structural/typescript.ts` | § 4.1. tree-sitter over the TypeScript grammar: the symbol inventory, the import list, and the parse check that is the first verification stage. |
| `registry.ts` | § 3.2 Identity persists through change, § 4.3 Symbol identity registry, § 9.1 Out-of-band changes. Opaque ids, versions, tombstones, file ids, desync state, `importExternal` / `rejectExternal`. |
| `log.ts` | § 4.4 Event log. Append-only, seq-ordered, intent-carrying, lease-linked. `history` / `at` / `byTask` / `byLease` are the four capabilities the section claims over a commit graph. |
| `leases.ts` | § 5 Coordination protocol. Atomic multi-acquire, the mode matrix and its hierarchy, optimistic version checks, TTL and heartbeat, release-time intent validation. |
| `verify.ts` | § 6.1 Layers of verification, § 6.4 When verification cannot decide. The four stages, the failure categories, the verification statuses, and the default implementations that shell out. |
| `impact.ts` | § 6.2 Test impact analysis, § 6.3 Cold start (mode 3: static graph alone). |
| `writes.ts` | § 5.4 Release and commit, § 6.1. `replaceSymbolBody`, `renameSymbol`, `deleteSymbol`, `runTests`, and the rollback. |
| `executor.ts` | The framework seam. `DETERMINISTIC-WORKFLOWS.md` § "The agent-native VCS is the effect executor and mechanical verifier". |
| `index.ts` | § 4.3's "runs as a single process and is the source of truth". The composition root: one database, one parser, one verifier, one clock, one id generator. |
| `defaults.ts` | The only file allowed to read a clock or an RNG. |
| `testing.ts` | Fixtures: counter ids, a manual clock, stage stubs, a temp project. The VCS's counterpart to `src/harness/stub-journal.ts`. |

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
| `test` | a `test(...)` or `it(...)` call whose first argument is a string, named by that string, with enclosing `describe(...)` labels as its container path |

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
-- payload release validates against. Rows are closed, never deleted.
leases (id TEXT PRIMARY KEY, session TEXT NOT NULL, mode TEXT NOT NULL,
        symbol_ids TEXT NOT NULL, ttl_ms INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, intent TEXT NOT NULL,
        versions TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0)

-- § 6.2, at module grain. See "Impact" below for why the reverse index from a
-- symbol to its tests is projected rather than materialised.
impact_edges (from_file_id TEXT NOT NULL, to_file_id TEXT NOT NULL,
              PRIMARY KEY (from_file_id, to_file_id))
```

## The write path

Ten steps. Three operations, and they differ only in how they edit the source,
what identity delta they declare, and what lease mode they require.

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
7. **Typecheck stage.** Pluggable; `bunx tsc --noEmit` over the project by
   default. `rejected: typecheck`.
8. **Tests stage.** Pluggable; `impactedTests(symbolIds)` then
   `bun test <file> -t <name>` per target by default. `rejected: tests`.
9. **Policy stage.** A stub that passes, because neither of § 6.1's policy
   mechanisms is built and saying so by passing beats pretending to check.
10. **Commit.** Re-key the file, refresh every range and hash, bump the versions
    of everything that changed, append the child event(s), then append the
    `transaction` event naming their sequence numbers. The parent lands last, so
    a reader that sees it knows every child is already in the log (§ 4.4).

The stages are thunks rather than values, because § 6.1's whole point is that an
expensive stage runs only when the cheap ones ahead of it passed. Any failure
between 5 and 9 restores the file byte for byte and appends a `write-failed`
event carrying which of § 5.4's three categories it was. An `advisory` outcome
does not block; it downgrades the write's recorded verification status (§ 6.4).

The result union is deliberately the same shape as `EffectResult`'s:

| Write path | `EffectResult` |
|---|---|
| `committed { version, seq, verification }` | `committed { version }` |
| `conflict { currentVersion }` | `conflict { currentVersion }` |
| `rejected { by, detail }` | `rejected { by }` |
| `infra-failed { detail }` | `infra-failed` |

`by` is `structural \| contract \| typecheck \| tests`, which is
`EffectResult`'s own union minus `schema` (that one belongs to
`upsert-artifact`). So the executor's mapping is the identity function on
`outcome` and on `by`, and it interprets nothing.

## Leases

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
  vcs,                                  // openVcs({ root, dbPath, parser, verifier, clock, ids })
  session: "session-crafter",
  intent: { taskId: "02-03", parentTaskId: "roadmap-7", description: "make the AT pass" },
});

await run(deliverGraph(journal, defs), seed(step, evidence), execute);
```

The batch is the unit. A step's `Effect[]` may name several symbols, and § 5.3
says an acquire names the complete set it will need, so the executor takes
**one** write lease covering every `replace-symbol` target in the batch, applies
the writes in order, releases, and maps each outcome onto an `EffectResult`.
That is the design document's "fanout over writes needs leases per symbol, not
per step", and it is also why hold-and-request being refused costs nothing: the
executor never needs it.

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

And the two effects that are not writes:

- **`run-tests`** runs the tests stage over `impactedTests(effect.impacted)`.
  Pass is `committed`, with the sequence number of the `tests-run` event as the
  version; fail is `rejected { by: "tests" }`; a broken runner is
  `infra-failed`.
- **`append-trail`** becomes a `trail` event under the task. The exhaustion
  trail of a step whose validator was never satisfied is provenance, and the
  event log is the provenance store.
- **`upsert-artifact`** comes back `infra-failed`. The VCS is the data plane for
  code; artifact rows are the other half of the design's state layer and no
  executor is wired for them, which is an infrastructure fact rather than a
  rejection.

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

11. **A policy failure is reported as `rejected: contract`.** The `by` union
    has no `policy` member, and adding one to the framework's type for a stage
    that is a stub would be adding surface for nothing. A policy is a rule the
    repository declares and the change broke, which is the contract category.
    Stated here because it is a judgement rather than a derivation.

12. **`INVENTORY_CHANNEL`.** First observation of a file is attributed to a
    source channel called `inventory` rather than to a task, on the same
    grounds as § 9.1's external imports: adopting code that already exists is
    not an agent action, and the log should not imply that it was.

13. **`byLease` was added to the event log's queries.** § 4.4 says events "link
    to the lease under which they occurred" and § 5.4 needs to read that link
    back at release. A log that stores the link and cannot query it would have
    forced a second bookkeeping structure that could drift from it.

## Not built yet

- **The ast-grep pattern and rewrite layer (§ 4.2), and the policy checks it
  would carry (§ 6.1, § 9.3).** The policy stage is a stub that passes. An
  ast-grep pattern layer is also what the design's `checks/symbol-diff.ts`
  wants, and what would make "implement to the design, never invent public API"
  a set difference over exported symbols rather than a model refuting prose.
  The symbol inventory it needs now exists.
- **The MCP tool surface (§ 4.5).** See deviation 3. The intent payload is
  built; the tools that would deliver it to a free agent are not.
- **The LSP layer (§ 4.6, § 7.3).** No cross-file reference resolution, no
  type-aware rename, no compiler diagnostics from a language server. The
  typecheck stage shells out to `tsc` over the whole project instead, which is
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
- **The proposal-shape Claude Code binding.** `src/bindings/claude-code.ts` is
  the opaque shape: the agent edits the workspace through its own tools and the
  framework never sees the writes, so it cannot lease them, verify them, or roll
  them back. The proposal shape returns the agent's writes as `replace-symbol`
  effects for the runner to commit through this module. That is the next cut,
  and it now has its executor.
