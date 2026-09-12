# Agent-Native Version Control

### A Coordination Layer for Autonomous Coding Agents

---

Modern coding agents operate inside a toolchain designed for humans. Git, file editing, and shell access were built around the asynchronous coordination needs of a small number of slow, careful, accountable people. As autonomous agents become more capable and operate at greater concurrency, these primitives become a bottleneck: agents conflict on edits, drift back to unstructured tools under uncertainty, and produce changes whose provenance and verification are difficult to reason about.

This article proposes a version control system purpose-built for agents. I argue for replacing branching and merging with symbol-level leases, replacing commit history with an event log keyed to stable symbol identities, and replacing pull requests with verification gates enforced at write time. I describe a layered architecture comprising a structural parser layer (tree-sitter), a pattern-search and rewrite layer (ast-grep), a lease manager, and an event log, all exposed to agents through a constrained tool surface delivered over the Model Context Protocol. I motivate each design choice from observed agent behavior, contrast the approach here with existing tools such as Serena, and present a phased build plan beginning with a minimal single-agent CLI.

---

## 1. Introduction

Coding agents have entered production use at a pace that has outrun the tooling beneath them. The infrastructure agents rely on — Git for version control, the shell for arbitrary execution, file-level read and edit operations — was designed for humans. Humans coordinate slowly, review each other's work asynchronously, and accept friction in exchange for structured collaboration. Agents do not match this profile. They are fast, parallel, stateless between sessions, prone to regression toward unstructured fallbacks under uncertainty, and capable of producing more changes per unit time than any human reviewer can meaningfully audit.

The result is a recurring set of failure modes. Two agents working in the same codebase race on file edits with no coordination protocol beyond the filesystem. An agent that encounters a tool failure reverts to running shell commands, abandoning whatever structured guarantees the surrounding system was meant to provide. Histories of agent-driven changes accumulate as opaque blocks of diff with little provenance, making it hard to reconstruct what an agent was trying to do, why it made a particular change, or whether the change should be trusted.

Existing responses to these problems mostly treat agents as fast humans. They wrap agent edits in pull requests, route them through code review, and depend on humans to catch mistakes the agent could not. This works at small scale and breaks at larger scale, both economically and epistemically: human reviewers cannot keep pace with agent throughput, and the failure modes that matter — subtle semantic regressions, verification gaps, coordination conflicts — are not the failure modes humans are best equipped to catch by inspection.

This article takes a different position. I argue that the right response is to build infrastructure designed around how agents actually operate. The specific primitives I propose are: symbol-level locking instead of branching, an append-only event log keyed by stable symbol identity instead of a commit graph, optimistic concurrency control with version-aware reads and writes, atomic multi-symbol transactions for cross-cutting refactors, and verification gates that run synchronously inside the write path. The system delivering these primitives is exposed to agents through a constrained tool surface over MCP, with structural search and rewrite capabilities engineered to be cheaper and more reliable than the unstructured alternatives agents would otherwise reach for.

The contributions of this piece are: (1) a diagnosis of why current tooling fails for agents, grounded in observed behavior rather than speculation; (2) a design for a coordination layer that addresses these failure modes directly; (3) a layered architecture that combines tree-sitter, ast-grep, a lease manager, and an event log into a single system; and (4) a build plan that begins with a minimal CLI usable today and extends incrementally toward the multi-agent system.

---

## 2. Why Existing Tools Fail Agents

### 2.1 Git was built for humans

Git's primitives — branches, commits-as-narrative, merges, and pull requests — exist because humans need to coordinate intent asynchronously and review each other's work. The branch is a workspace where one person's intent develops in isolation. The commit message is a story told to future readers. The pull request is a synchronization point where humans align on whether a body of work should enter the shared trunk. Each of these primitives reflects assumptions that do not hold for agents.

Agents do not need workspaces in which to develop intent in isolation; their intent is supplied with each task. They write commit messages poorly because the cost of writing a clear narrative for future humans is misaligned with their reward signal. They produce volume that overwhelms pull-request review at any meaningful scale. The merge process — reconciling textual diffs at file granularity — is exactly the operation agents are worst at, because semantic merge conflicts are problems of intent, not text.

### 2.2 Drift toward unstructured tools

A reliably observed behavior in coding agents is regression toward bash, grep, and unstructured file editing during long sessions or after tool failures. Three reinforcing causes drive this:

- **Training distribution.** Models have seen orders of magnitude more shell commands and full-file edits in training than they have seen any specific structured tool. Under uncertainty, they regress toward the mean.
- **Asymmetric failure recovery.** When a structured tool fails, the recovery instinct is to drop to bash, which always works. Structured tools must therefore be more reliable than bash, or agents will route around them.
- **Cost in tokens and turns.** If a structured search requires three tool calls to surface what grep returns in one, the agent learns that grep is faster. Structured tools must win on token cost, latency, and number of calls per task, not just on correctness.

This pattern means that simply offering structured tools alongside bash is insufficient. Agents will use bash whenever bash is easier, and bash is often easier in the moment even when the long-term cost is higher. Any system that wants agents to use structured primitives must make the structured path strictly cheaper than the unstructured one, and must constrain the unstructured path enough that drift is detectable.

### 2.3 Concurrency without coordination

Multiple agents operating against the same repository today coordinate only through the filesystem. There is no notion of which agent currently owns which symbol, no protocol for declaring the read-set on which a write depends, and no mechanism for surfacing conflicts before they manifest as broken merges or silent regressions. Pull-request gating is the workaround, but it serializes work at the wrong granularity — the entire branch — when most conflicts are local to specific functions or classes.

### 2.4 Provenance and verification gaps

Commit messages and PR descriptions are unstructured prose. Querying "which agent made this change, in service of which task, with what verification" requires parsing free text that agents are not motivated to write well. There is no machine-queryable record of what tests were run, which symbols were touched, or what the agent expected to happen. When something goes wrong downstream, reconstructing the chain of agent actions is largely manual.

---

## 3. Design Principles

From the diagnosis above I derive five design principles. Each principle informs specific architectural choices in the sections that follow.

### 3.1 Granularity follows intent

Agents reason about code at the level of functions, classes, and methods, not files. Coordination should occur at the same granularity. Locking, versioning, attribution, and verification all operate on symbols rather than on files or lines. File-level operations remain available as escape hatches but are not the primary path.

### 3.2 Identity persists through change

A function that is renamed, moved between files, or restructured is still the same logical entity. The system maintains stable, opaque identifiers for symbols and files that survive these operations. Human-readable paths are display attributes, not identity. Without this, history queries break the moment a refactor occurs.

### 3.3 Optimistic concurrency, fail fast

Most agent edits do not conflict. Pessimistic locking penalizes the common case to defend against the rare one. Reads and writes are version-tagged: every read carries the version of the symbol observed, every write carries the version the agent expected to see. Conflicts are detected at write time and surfaced as actionable feedback ("the symbol you read has changed — here is the new version"), not as merge errors after the fact.

### 3.4 Verification at the write boundary

Pull-request review is verification deferred. Verification moves inside the write path: typecheck, scoped tests, and policy checks run synchronously before a write is committed to the event log. Failed verification rolls back the write atomically. The agent receives an actionable failure and retries. Humans enter the loop only when verification cannot decide.

### 3.5 Make the structured path cheaper

Agents will use whichever path is cheaper in the moment. The structured tool surface must therefore be: more reliable than bash, lower in token cost than reading whole files, faster in number of calls than grep-and-sed workflows, and presented with error messages that are recoverable rather than terminal. Where the unstructured path remains necessary, it is gated behind explicit justification that surfaces in the audit log.

---

## 4. System Architecture

The system is organized as four layers, each with a well-defined responsibility and a clean interface to the layer above. From the bottom up:

### 4.1 Structural parser layer (tree-sitter)

The lowest layer parses source code into syntax trees and maintains a structural inventory of the codebase. For each file, the layer tracks the set of top-level and nested symbols, their byte ranges, their kinds (function, class, method, etc.), and a content hash per symbol. This information is incrementally updated as files change.

Tree-sitter is the right primitive at this layer because it is fast, in-process, robust to syntax errors, and supports a large set of languages through a uniform API. The structural inventory does not require type information or cross-file resolution, which keeps this layer free of the latency and complexity of language servers.

Concretely, the structural layer answers questions like "what symbols exist in this file," "what is the byte range of this symbol," and "what is the content hash of this symbol's body." These answers feed the symbol identity registry and the lease manager above it.

### 4.2 Pattern search and rewrite layer (ast-grep)

Above tree-sitter sits a structural pattern engine for the agent-facing search and rewrite operations. ast-grep wraps tree-sitter with a query language whose patterns look like ordinary code with metavariables. An agent searching for calls to a function writes the pattern as the call itself, with placeholders for the arguments, rather than constructing a node-typed query. Rewrites use the same syntax: pattern on the left, replacement on the right, with captured metavariables interpolated.

This layer matters because pattern syntax is the most agent-legible interface to structural code operations I'm aware of. It directly addresses the drift-to-grep problem: when an agent wants to find or change code by shape, the pattern is shorter and more obvious than the equivalent regex, and the cost of using it is lower than the cost of falling back to text-based tools.

### 4.3 Symbol identity registry and lease manager

The lease manager is a stateful coordinator that owns three things: the symbol identity registry, the lease table, and the entry point for the event log. It runs as a single process and is the source of truth for which agent currently holds which lease, what version each symbol is at, and how symbol identifiers map to current paths.

The registry assigns an opaque, stable identifier to each symbol on first observation. The identifier travels with the symbol through renames, moves, and body modifications. When a symbol is deleted, the identifier is tombstoned but retained in the registry forever, so that historical events referencing it remain interpretable. Files are tracked in the same way.

The lease table records active leases keyed by symbol identifier. Each lease has an agent session, a mode (read, write, or exclusive), a TTL, an expiration timestamp, and the version of each held symbol at acquisition time. Heartbeats from agent sessions extend leases; missed heartbeats expire them. Conflict detection uses a hierarchical lock model: a write lease on a parent symbol conflicts with leases on its children, ensuring agents cannot take inconsistent views of the same code.

### 4.4 Event log

The event log is append-only, totally ordered, and durable. Each event records a single observation about the codebase: a symbol created, modified, renamed, moved, or deleted; a verification outcome; or a transactional group of related changes. Events carry intent metadata — task identifier, parent task, tool name, agent session — and link to the lease under which they occurred. Multi-symbol changes are recorded as a parent transaction event followed by child events; the parent is appended last, giving atomic-commit semantics on the log itself.

The event log enables a set of capabilities that are awkward or impossible in Git's commit graph: time-travel reads to any past state, blame at symbol granularity in time linear in the events touching that symbol, provenance queries by task identifier, and replay-driven debugging that locates the exact change that introduced a regression without running every intervening commit.

### 4.5 Agent-facing tool surface (MCP)

Agents interact with the system exclusively through tools delivered over the Model Context Protocol. The tool surface is intentionally narrow and is organized into three tiers:

- **Default tools** are symbol-aware and pattern-aware: `find_symbol`, `get_symbol`, `get_symbols_overview`, `find_pattern`, `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `rewrite_pattern`, `create_file`, `delete_symbol`. These are always available and have first-class error messages.
- **Reason-required tools** provide escape hatches — `read_file_raw`, `replace_text_in_file` — but require an explicit reason field that is logged. The reason captures why structured tools were insufficient, providing data to inform tool design.
- **Restricted tools** are not available by default. Shell access falls into this category; agents that need it request a separate "raw mode" lease that locks larger regions and is conspicuous in the audit log.

Each tool call participates in the lease and event-log protocols transparently. A call to `replace_symbol_body` acquires the appropriate lease, performs the edit, runs verification, and either commits an event or rolls back the edit and reports failure. The agent does not see the lease machinery; it sees a tool that succeeds, fails with actionable feedback, or reports a stale version with the new content attached.

#### Intent payloads

Every tool call that mutates state carries an *intent payload* alongside its operational arguments. The intent payload is not a free-text comment; it is a structured contract whose contents are validated at the tool boundary, persisted in the event log, and used by the registry to make identity and provenance decisions. The minimum every mutating call provides:

- **`task_id`** — the work item the call is in service of, supplied by the orchestrator or the agent's own task tracking. Multiple tool calls share a `task_id` when they belong to the same logical operation.
- **`parent_task_id`** — optional, for hierarchical task structures where one task spawns subtasks.
- **`description`** — a short natural-language statement of what the agent is trying to accomplish with this specific call. Required, but bounded in length and never used as a substitute for the structured fields.
- **`expected_outcome`** — what the agent expects to be true after the call succeeds, expressed in terms the system can interpret. For an edit, the symbol identifiers that will be modified; for a creation, the symbol that will exist; for a deletion, the symbol that will be tombstoned.

For the structured tools, the operational arguments and the intent payload align unambiguously: `replace_symbol_body(symbol_id, new_source, ...)` is by construction an edit to a known identifier, and the registry honors it as such. There is no ambiguity to resolve.

For escape-hatch tools, the intent payload carries additional fields that resolve the structural ambiguity the tool itself cannot. A call to `replace_text_in_file` requires a **`structural_disposition`** field that declares, for each symbol whose body the text replacement will affect, whether the change is an edit (preserving identity), a replacement (assigning new identity), a rename (preserving identity, changing name), or a delete (tombstoning). The agent is responsible for this declaration because the agent knows its own intent; the registry is responsible for verifying that the post-call state is consistent with the declaration and rejecting the call if it is not. A `structural_disposition` field claiming "edit to symbol X" against a text replacement that removes X entirely is a contract violation, and the call fails before any change is committed.

For raw-mode shell access, the intent contract is more demanding still. The agent declares the set of symbols and files it expects to modify, the structural disposition for each, and the verification expectations for the resulting state. The lease covers the declared scope, the system observes what actually changed after the shell command runs, and any change that falls outside the declared scope causes the entire operation to be rejected and rolled back. This is intentionally onerous: raw mode exists for cases that justify the cost, and the cost includes spelling out what would happen up front.

The principle these contracts encode is that the system never *infers* identity or intent. It validates declarations against observed effects. When the declaration matches the observation, the call succeeds and the event log records the declared intent as the authoritative provenance. When they do not match, the call fails. When no declaration exists at all — see §9.1 — the change is treated as a desync condition rather than reconciled by guessing.

### 4.6 Optional semantic layer (Language Server Protocol)

Tree-sitter and ast-grep together provide structural understanding of code: what symbols exist, where they are, what shape they have. They do not provide *semantic* understanding: which `foo` a particular call resolves to, what type a symbol has, what symbols transitively reference a given definition across files. These questions require a compiler frontend, which is what language servers provide.

The Language Server Protocol is treated as an opt-in layer rather than a foundation, for three reasons. First, language servers are slow to start, often measured in seconds-to-minutes for large workspaces, and expensive to keep resident — a cost that compounds when pooling per-language-per-workspace across many concurrent agent sessions. Second, LSP servers are stateful and quirky, with each implementation exhibiting its own behavioral edge cases that must be handled defensively. Third, the structural layer answers the majority of agent operations adequately, and the cost of LSP is only justified for operations that genuinely require cross-file semantic analysis.

When enabled, the LSP layer contributes capabilities the structural layer cannot:

- **Cross-file reference resolution.** `find_referencing_symbols` returns the set of call sites for a symbol with correct semantics — accounting for imports, scoping, and shadowing — rather than the syntactically similar matches a pattern search would yield.
- **Type-aware rename.** Renaming a symbol updates every reference site that genuinely refers to *that* symbol, not every textually similar identifier. This is the canonical multi-symbol transaction, and the lease manager acquires leases on the symbol and every reference site atomically before applying the LSP-driven rename.
- **Type and diagnostic information.** Hover types, parameter signatures, and compiler diagnostics scoped to the affected file. These feed both the agent's context (when explicitly requested through tools like `get_type` or `get_diagnostics`) and the verification pipeline.
- **Implementation and definition lookup.** Navigating from a call to its definition, or from an interface to its implementations, with semantics rather than guesswork.

The LSP layer is implemented as a pool of language-server processes, one per language per workspace, managed by a multiplexer that handles initialization, request routing, and lifecycle. Servers are started lazily on first use and kept warm for the duration of an active session. The multiplexer normalizes across LSP implementations: each server has its own conventions for symbol kinds, rename refactor support, and diagnostic schemas, and the layer above the multiplexer sees a uniform API.

LSP availability is a per-language property and degrades gracefully. For languages with strong language servers (TypeScript, Rust, Python, Go), all semantic operations are available. For languages with weak or missing servers, the structural layer remains and semantic operations either return reduced results or are unavailable; the tool surface reports this honestly rather than silently producing wrong answers. For configuration files, build scripts, and other non-LSP-supported content, only file-level escape hatches apply.

The decision to expose an LSP-backed tool to agents is not automatic. Each LSP operation is wrapped in a tool whose error semantics, latency budget, and cache behavior are tuned for agent use. A naive wrapper around `textDocument/references` — returning thousands of results without ranking or filtering — is worse for agents than a thoughtful tool that returns the top-N most relevant references with the symbols they belong to and the lease state of each. The structural and pattern layers do not have this problem because their results are inherently bounded; the LSP layer requires explicit shaping.

---

## 5. Coordination Protocol

### 5.1 Acquisition

An acquire request specifies the agent session, a set of symbol identifiers, a mode, a TTL, the intent payload defined in §4.5, and optionally the versions the agent expects to see. The intent payload is not metadata the lease manager merely passes through; it is part of what the manager validates the request against. The declared scope in the intent — which symbols the agent expects to modify, with what structural disposition — must be consistent with the symbols being requested in the lease. A request to acquire a write lease on symbol `X` whose intent declares the call as a deletion of `Y` is rejected at acquisition time, before any work begins.

The lease manager evaluates the request atomically. If any held symbol is at a different version than the agent expected, the response carries a stale status with the current versions and the request is denied. If the symbols are unavailable in the requested mode, the request is either queued (when the agent indicated willingness to wait) or returns a conflict (when the agent requested fail-fast). If the intent payload is internally inconsistent or inconsistent with the requested scope, the request is rejected with a contract-violation status that identifies the inconsistency. Otherwise, the lease is granted and the response carries the lease identifier, expiration timestamp, and current versions of all granted symbols.

The current-versions field is what makes the protocol efficient: a single round trip yields both the lock and the version information needed for subsequent reads and writes. Agents do not need a separate "check version" step.

### 5.2 Modes and conflict semantics

Three modes are supported. Read leases coexist with other read leases on the same symbol but block write and exclusive leases. Write leases are exclusive against other writes and against exclusive leases but coexist with reads under multi-version concurrency: readers see the pre-write version until the write commits. Exclusive leases block all other access and are reserved for structural operations like deletion or move that should not be observed in flight.

Hierarchical locks ensure consistency across symbol granularities. A write lease on a class implicitly conflicts with any lease on its methods. Acquiring on a method requires intention-mode locks on its ancestors, which conflict with full write locks higher up. This is the standard hierarchical locking pattern from databases, applied to the symbol tree.

### 5.3 Deadlock prevention

Atomic multi-acquire is the primary protocol: an acquire request is the complete set of symbols an agent will need for its current operation. Holding leases and asking for more is disallowed; an agent that discovers it needs additional symbols must release everything and re-acquire. This eliminates deadlock by construction at the cost of forcing agents to plan their access in advance — a constraint that aligns with the more general goal of eliciting explicit intent from agents.

For cases where an agent legitimately cannot predict its full access set in advance, wait-die serves as a fallback: each agent has a priority by start timestamp, and an agent that would wait on an older agent aborts and retries instead. Cycle-detection-based deadlock detection is deferred until operational data justifies the additional complexity.

### 5.4 Release and commit

Releasing a lease commits or aborts the work performed under it. Before commit, the system validates that the actual state changes match the intent declared at acquisition. For structured tools this validation is trivial — the tool's operational arguments fully determine its effect — and serves only as a defense against bugs in the tool layer. For escape-hatch and raw-mode tools the validation is meaningful: the system compares the declared `structural_disposition` against the observed effect on the symbol registry and rejects any release where the two diverge. A declared edit that produced a deletion, or a declared scope of two symbols that produced changes to five, both fail validation.

A committed release atomically appends the corresponding event(s) to the log, increments the affected symbols' versions in the registry, and frees the lease. An aborted release frees the lease without log entries. A failed release frees the lease, rolls back any tentative event-log entries and any in-progress changes on disk, and records a failure event for audit purposes. Failure events distinguish between contract violations (declared intent did not match observed effect), verification failures (the change was internally consistent but failed typecheck, tests, or policy), and infrastructure failures (the underlying tool layer or storage failed). The distinction matters because the responses differ: contract violations are an agent error and feed back as a tool failure the agent can retry; verification failures are a quality signal the agent should respond to substantively; infrastructure failures are an operator concern and should not be misattributed to the agent.

---

## 6. Verification

Verification is the property that distinguishes a system that records changes from a system that gates them. Verification runs as a structured pipeline inside the write path, before the lease release that would commit an event.

### 6.1 Layers of verification

The verification pipeline runs in stages of increasing cost. Cheap checks run first; expensive checks run only if the cheap ones pass.

- **Structural validity:** the edited file still parses. This is a tree-sitter check on the post-edit content and is essentially free.
- **Type and lint diagnostics:** when the LSP layer is enabled for the affected language, the language server is queried for diagnostics on the edited file and any files affected by the change. Type errors, unresolved imports, and lint violations introduced by the edit surface here. For languages without LSP support, this stage is skipped; for languages where the LSP server is slow, the verification pipeline applies a per-stage timeout and degrades to advisory rather than blocking.
- **Scoped tests:** the subset of the test suite that transitively depends on the modified symbols. This requires a test impact graph maintained incrementally by the lease manager.
- **Policy checks:** repository-specific rules expressed as ast-grep patterns or external scripts. Useful for enforcing project conventions or security constraints that the model is unlikely to remember.

### 6.2 Test impact analysis

Running the entire test suite on every write is prohibitively slow. The system maintains a *test impact graph*: a reverse index from symbols to the tests whose outcomes could be affected by changes to those symbols. When a write affects symbols, the verification pipeline runs only the tests reachable from those symbols. In practice this reduces verification time by one to two orders of magnitude on large codebases, which is what makes synchronous verification at the write boundary tractable.

The literature on test impact analysis is decades deep, and every approach involves tradeoffs between accuracy, cost, and complexity. The design below commits to specific choices, with the understanding that they may need refinement based on operational data.

**Population strategy.** A hybrid approach combines coverage-based observation with static call graph analysis. Coverage observation is the primary mechanism: each test is run under coverage instrumentation at least once, and the symbols its execution touches are recorded as the test's covered set. The static call graph from tree-sitter and (where enabled) LSP supplements coverage with edges that observed runs may have missed — particularly useful for branches not exercised in the initial run and for languages where coverage tooling is weak.

Coverage-based observation captures dynamic dispatch, dependency injection, and reflection because these effects manifest in the actual execution trace. Static call graph supplementation catches transitive dependencies that coverage missed because the relevant branch did not fire. The combination is more accurate than either alone, at the cost of maintaining both indexes.

**Granularity.** The impact graph is maintained at symbol granularity. Tests cover symbols, not lines or files. Symbol granularity matches the rest of the architecture — the locking layer, the event log, and the verification gate all reason at the same level — and the index size is bounded by the product of test count and symbols-per-test, which fits comfortably in the transactional store. Line-level coverage offers marginally higher accuracy but at significant index-size and complexity cost; file-level coverage is a fallback for languages where reliable symbol extraction is not available.

**Test identity.** Tests are assigned stable identifiers on first observation, the same way symbols and files are. A test that is renamed or moved retains its history, its covered-set, and its outcome record. The structural layer recognizes test definitions through language-specific patterns (functions decorated with `@test`, methods named `test_*`, etc., depending on the framework) and surfaces them to the registry as symbols of kind `Test`.

**Selection algorithm.** When a write commits, the selection of tests to run proceeds as follows. From the events committed in the write, the set of modified symbols is collected. For each modified symbol, the reverse index yields candidate tests. The candidate sets are unioned. Tests that have been stale for longer than a configured threshold are added to the candidate set unconditionally, to catch index drift. Tests whose covered sets transitively include the modified symbols (through static-graph traversal) are added if they were not already present. The resulting set is scheduled for execution, ordered by historical duration (fast tests first, to fail fast) and historical reliability (low-flakiness tests first, to produce clean signal).

**Index maintenance.** The impact graph is updated on three events. When a new test is observed, it is marked for instrumented run on its next execution, and the resulting coverage populates its initial entry. When a test is modified, its existing entry is marked stale; the next execution is instrumented and the entry rebuilt. When code is modified, the entries for affected tests are marked as needing re-validation, but the existing covered-set is retained as the best available estimate until the test next runs. Periodic full-suite runs — nightly or weekly, depending on the project — provide ground truth and correct accumulated drift.

**Honest limitations.** The impact graph is approximate. It under-approximates when tests depend on configuration files, environment variables, external services, or fixtures that are not modeled as symbols. It over-approximates when symbol modifications do not change observable behavior (formatting, comments, dead code paths). The verification gate treats the impact graph as the primary signal but does not treat it as exhaustive: the system supports declared dependencies (a test annotation listing additional symbols or files it depends on) for cases where the automatic analysis is known to miss, and periodic full-suite runs provide the ground-truth backstop.

### 6.3 Cold start and slow tests

Two operational concerns shape how impact analysis is deployed in practice.

**Cold start.** Until coverage data exists, the impact graph is empty and the verification gate has nothing to filter on. Three bootstrap modes are supported. The first runs the entire test suite under coverage instrumentation as a one-time setup step, producing a complete impact graph before any agent activity. This is the most accurate but slowest to start. The second populates lazily: until a test has been observed, it is conservatively treated as affected by every write, and its first run is instrumented. After several writes the index converges to a useful state. The third uses the static call graph alone as the initial impact graph, refined by coverage on subsequent runs. The third mode is the default, because it provides immediate filtering on the first write and trades a small accuracy cost during the first day or two of operation for substantially faster onboarding.

**Slow tests.** Even with perfect impact analysis, individual tests may exceed the latency budget for synchronous verification. The verification gate handles this with a tiered pipeline. Tests below a configured duration threshold run synchronously and block the lease release. Tests above the threshold are scheduled asynchronously: the write commits with a verification status of pending, and the verification result is recorded as a follow-up event when the test completes. If an asynchronous test fails, the system does not automatically roll back the write — too much may have happened in the meantime — but it emits a verification-failed event that flags the affected write and any subsequent writes that read from the same symbols. Orchestrators can configure how this signal is handled: block dependent operations, prompt human review, or attempt automatic remediation.

For projects whose typical test latency is many minutes, the asynchronous tier may dominate. This is acceptable as long as the system surfaces verification status accurately and downstream consumers (other agents, dashboards, deployment pipelines) respect it. The architectural invariant is that every write has a verification status — pending, passed, failed, or advisory — that is queryable from the event log; the temporal placement of the verification work is a deployment choice.

### 6.4 When verification cannot decide

Some failures are not categorically resolvable: flaky tests, network-dependent assertions, or policy checks that produce warnings rather than errors. The system surfaces these as advisory outcomes that do not block the write but are recorded in the event log. Agents and orchestrators can configure whether advisory outcomes escalate to human review.

---

## 7. Relationship to Existing Tools

### 7.1 Serena

Serena is the closest existing system to what I describe. It exposes symbol-level retrieval and editing tools over MCP, backed by language servers through a custom abstraction layer. Its tool surface — `find_symbol`, `replace_symbol_body`, `insert_before_symbol`, `rename_symbol`, `find_referencing_symbols` — is the most direct prior art for the agent-facing layer of the design here.

What Serena does not do is the coordination half. It is a single-agent toolkit. There is no lease manager, no event log, no notion of versioned reads or atomic multi-symbol transactions. Concurrency is assumed to be serialized externally. For a system that wants to support multiple agents operating in parallel, Serena is the bottom of the stack; the coordination layer must be built on top.

### 7.2 ast-grep

ast-grep solves a problem that Serena does not address: agent-legible structural search and rewrite. Its pattern syntax — patterns shaped like the code they match, with metavariables for captures — is dramatically easier for agents to use than tree-sitter's S-expression queries or regex against syntax trees. ast-grep is adopted directly as the search and rewrite engine for the agent-facing layer.

### 7.3 Language servers and the LSP

Language servers occupy an interesting position in this architecture: indispensable for certain operations, prohibitive as a foundation. The Language Server Protocol was designed for IDE-in-the-loop interactive use, where a single editor session talks to a single language server warmed up over a single workspace. Headless multi-tenant operation — many concurrent agent sessions, many workspaces, many languages — was not the design center, and the operational reality reflects that.

Three concrete frictions matter. Startup latency for a large workspace can be tens of seconds, which is incompatible with the cold-start expectations of a per-session agent client. Memory footprint scales with workspace size and is non-trivial — `rust-analyzer` on a large Rust project routinely consumes multiple gigabytes — which makes pooling expensive and aggressive eviction necessary. Behavioral inconsistency across implementations is significant: the LSP specification leaves enough discretion to implementers that "find references" returns subtly different result sets across `pyright`, `gopls`, `rust-analyzer`, and `typescript-language-server`, and the failure modes differ further still.

Serena's contribution at this layer is concrete and worth borrowing from. Their fork of Microsoft's `multilspy`, called Solid-LSP, provides synchronous LSP calls and a normalization layer over the differences between implementations. Whether to depend on this work directly, fork it for Rust, or rewrite the equivalent in Rust is a project-level decision; the underlying integration patterns — pooled servers, lazy initialization, request multiplexing, per-language adapter logic — are roughly invariant across implementations.

LSP is treated as a secondary, opt-in layer for the reasons developed in §4.6, and full LSP integration is best deferred until the structural and pattern layers are working and the semantic operations with the highest payoff have been identified. In practice, the highest-payoff semantic operations are cross-file rename and find-references; type information is valuable but more often consumed by verification than by agent-facing tools directly. A reasonable phasing is: tree-sitter and ast-grep for everything in early phases, LSP added in a later phase first for rename and references, then expanded as the data justifies.

A final note on alternatives. For some languages, Rust-native semantic analyzers exist as libraries rather than LSP servers — `rust-analyzer`'s internals are published as crates, and parts of the Python ecosystem expose analyzer libraries. Where these are available, embedding them directly avoids the LSP overhead entirely. This is a heavier dependency but eliminates the IPC and lifecycle issues that make LSP painful at scale. For a Rust-native agent system operating primarily on Rust code, this is worth evaluating.

### 7.4 Git and centralized version control

The system is not a replacement for Git in collaborative human workflows. It is a coordination layer that runs alongside or beneath Git, recording agent-driven changes with the structure and provenance Git lacks. Periodic synchronization with Git is straightforward: a snapshot of the repository state at a given log sequence number is a Git tree, and projection onto Git history can be performed for human consumption. The core operational state lives in the event log; Git becomes an export format for human-facing tools and external systems.

---

## 8. Build Plan

I propose a phased build, each phase yielding a usable system. The phases are ordered to validate the most uncertain assumptions early.

### 8.1 Phase 1: minimal single-agent CLI

A Rust command-line agent that exercises the structural and pattern layers without coordination. The CLI loads a project, exposes symbol-aware tools (`find_symbol`, `get_symbol`, `replace_symbol_body`, `find_pattern`, `rewrite_pattern`) and pattern-aware tools through an LLM-agnostic client, and logs every tool call to JSONL for analysis. No lease manager, no event log, no verification — the goal is to measure whether agents actually use the structured tools when given them, and to identify which tools are missing or hard to use.

This phase answers the most important early question: do the structured tools win against bash on real tasks? If they do not, the rest of the system is premature. If they do, the friction points discovered here directly inform the lease and verification design.

### 8.2 Phase 2: structural inventory and event log

Add the symbol identity registry and the event log behind the existing tool surface. Tool calls now produce events even though there is still only one agent. This validates the event-log schema, the symbol-identity model under realistic refactor patterns, and the time-travel and provenance queries.

### 8.3 Phase 3: lease manager, single coordinator

Introduce the lease manager as a separate process. The CLI becomes a client of the coordinator. Run multiple CLI instances against the same project to validate the lease protocol, optimistic concurrency, and atomic multi-symbol transactions under real concurrent load.

### 8.4 Phase 4: verification gates and selective LSP integration

Add the verification pipeline at the lease-release boundary, including the test impact graph. Begin with structural validity and type diagnostics; add scoped test execution once the impact graph is stable.

This phase is also where the LSP layer first enters the system. Type and lint diagnostics in the verification pipeline are the highest-value LSP operation that does not require exposing semantic capabilities to agents directly, which makes it a low-risk place to prove out the language-server pool, the multiplexer, and the per-language adapters. Once that infrastructure is stable, the agent-facing semantic tools — cross-file rename, find-references — can be added as a follow-up.

### 8.5 Phase 5: production hardening

Replication for the lease manager, log compaction, cross-repository coordination, and the policy-check layer. These are the engineering investments that turn a working system into a reliable one. They are deferred until earlier phases prove the design.

---

## 9. Open Questions

Several design questions remain unresolved and will be informed by data from the early phases of the build.

### 9.1 Out-of-band changes

Within the architecture, every change carries declared intent because every change flows through a tool call and every tool call requires an intent payload. The escape-hatch tools and the raw-mode shell are not exceptions to this; they require *more* intent metadata, not less, because their structural ambiguity has to be resolved by the agent rather than inferred by the system. An agent using `replace_text_in_file` declares whether the resulting text constitutes an edit to existing symbols or a replacement, and the registry honors that declaration. Identity is never reconstructed from structure when an agent action is the source.

What remains genuinely unresolved is what happens when changes arrive through channels that are not agent actions at all: a human editing files directly in their editor, a Git pull bringing in upstream changes, a CI process committing generated artifacts, a deployment script regenerating configuration. In these cases there is no agent and therefore no declared intent. The system has two reasonable responses, and I propose supporting both as deployment policy.

The first is to treat external changes as a first-class desync condition. The lease manager refuses to grant new leases on affected symbols until the desync is acknowledged. Resolution is explicit: the operator (or an orchestrator with appropriate authority) either imports the external change as an event tagged with the source channel and no agent intent, or rejects the external change and restores the registry's view as authoritative. This is the conservative default, and the right one for systems where provenance integrity matters more than convenience.

The second is to permit advisory ingestion of external changes through configured channels. A Git pull from a trusted upstream can be auto-imported with the upstream commit attributed as the source. A human editor session can be auto-imported when the editor identifies itself. The key constraint is that the source must be identifiable and the attribution must be honest — there is no path by which external changes silently become indistinguishable from agent actions in the event log.

What I explicitly reject is structural-similarity inference for identity. The provenance story of the system depends on every change having known origin, and guessing whether a deleted-and-recreated symbol "is the same" without a declaring authority undermines that. When the answer cannot be determined from declared intent, the answer is desync, not heuristic.

### 9.2 Cross-repository coordination

Real systems span multiple repositories: microservices, monorepos with submodules, packages with consumers. The lease manager as described is project-scoped. A federated lease layer that coordinates across projects is straightforward in principle and complicated in practice; the right time to build it is once there is data on how often agents actually need cross-repository transactions.

### 9.3 Granularity of policy enforcement

Verification policies expressed as ast-grep patterns are easy to write and easy for agents to comply with. Policies expressed as full type-system constraints or runtime checks are more powerful but harder to fit into the synchronous write path. I expect a mix in practice, and the question of how policies are declared, scoped, and ordered is open.

### 9.4 Trust and authorization

This article assumes a single trust domain: all agents are authorized to perform all operations on the repository. Real deployments will need finer-grained authorization — some agents allowed only to read, some restricted to certain modules, some required to obtain human approval before committing certain classes of changes. The lease manager is the natural enforcement point, but the policy language and authentication model are out of scope for this article.

### 9.5 Language server pooling at scale

The LSP layer assumes a pool of language-server processes shared across agent sessions. The pooling policy — how aggressively to evict idle servers, how to handle workspace switches without full reinitialization, whether to share a single server across multiple concurrent requests or serialize per-server — is unresolved. Each language server has its own concurrency model, and the right policy is likely per-server rather than uniform. Operational data from Phase 4 will inform this; until then, I plan to start with a conservative one-server-per-language-per-workspace pool and refine.

---

## 10. Conclusion

The infrastructure that coding agents currently use is a thin agent-shaped wrapper around tooling built for humans. As agent capability and concurrency increase, the mismatch becomes the bottleneck. The response I propose is not to constrain agents to human-shaped workflows but to build infrastructure shaped to how agents actually operate.

The specific bets in this design are: that symbol-level granularity is the right unit of coordination, that stable identity through refactor is the right basis for history, that optimistic concurrency control with version-tagged operations matches the real conflict rate of agent edits, that synchronous verification at the write boundary is tractable when paired with test impact analysis, and that an agent-legible tool surface engineered to be cheaper than the unstructured fallback is the only durable defense against drift toward bash.

None of these bets is novel in isolation. Symbol-level locking exists in IDEs. Optimistic concurrency control is a textbook database technique. Event-sourced systems are well understood. Tree-sitter and ast-grep are mature open-source projects. The contribution of this piece is in the integration: assembling these pieces into a single system that meets agents where they are and provides the coordination, provenance, and verification properties that current tools do not.

My plan is to start with the smallest piece that validates the most important assumption: a minimal CLI that tests whether agents use structured tools when given them. The remainder of the system follows in phases, each one earning its place by solving a problem the previous phase exposed.

---

## References

- **Tree-sitter.** An incremental parsing system for programming tools. https://github.com/tree-sitter/tree-sitter
- **ast-grep.** A CLI tool and library for code structural search, lint, and rewriting. https://github.com/ast-grep/ast-grep
- **Serena.** A coding agent toolkit providing semantic retrieval and editing capabilities. https://github.com/oraios/serena
- **Model Context Protocol.** https://modelcontextprotocol.io
- **Rig.** Modular and scalable LLM applications in Rust. https://github.com/0xPlaygrounds/rig
- **Language Server Protocol.** https://microsoft.github.io/language-server-protocol/