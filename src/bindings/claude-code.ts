/**
 * A `ModelBinding` over a Claude Code subagent, via the Claude Agent SDK.
 *
 * `StepDef.worker.model`, `validator.model` and `escalateTo` are all
 * `ModelBinding` — `{ id, generate({ system, prompt, schema }) }`. That
 * one-method seam is where an agent plugs in: from the step's side there is no
 * difference between a single model call and a subagent that spent forty turns
 * reading a checkout, as long as what comes back satisfies the schema.
 *
 * ## Two binding shapes, and this is the first one
 *
 * **Opaque.** The agent edits the workspace itself, through its own tools, and
 * the binding returns only what the schema asks for. The writes have already
 * happened by the time `generate` resolves; the framework never sees them, so
 * it cannot lease them, verify them, or roll them back. Everything outside the
 * returned object is outside the design's guarantees. **This adapter is the
 * opaque shape.**
 *
 * **Proposal.** The agent returns its writes as data — `write-file` and
 * `replace-symbol` effects — and the runner commits them through the
 * agent-native VCS, under a lease, with the gate at the write boundary and the
 * task id recorded as the intent. A conflict comes back as a decision value
 * the graph routes, not as a surprise on disk. **Both shapes are built**, and
 * `proposal` is what selects the second.
 *
 * The distinction is not stylistic. Under the opaque shape a `conflict` is
 * unrepresentable, because the write never crossed the effect boundary where a
 * version check could happen.
 *
 * ## How the proposal shape gets writes it can lease
 *
 * The agent still edits files, because `Read, Edit` is the tool set that makes
 * it an acceptance designer rather than a chat. What changes is WHERE: the
 * turn runs in a SCRATCH COPY of the source tree, and afterwards the copy is
 * diffed against the original. Every changed file under the allowed paths
 * becomes an effect; a byte moved outside them is a contract failure raised
 * BEFORE any effect is emitted, so a turn that wrote where it may not proposes
 * nothing at all rather than proposing most of what it did.
 *
 * A new file becomes `write-file`. An existing one becomes `replace-symbol`
 * when the caller supplies a `symbolFor` port that can name the symbol it
 * belongs to, and `write-file` otherwise — a symbol id is the VCS's to assign
 * and this binding must not import the VCS to guess one.
 *
 * The effects arrive on the turn's object as `payload.proposal`, which is why
 * a step that wants them declares that field optional: the agent never
 * produces it and the binding always overwrites it.
 *
 * ## What this file does with the SDK
 *
 * - **Structured output is native.** `options.outputFormat = { type:
 *   "json_schema", schema }` makes the SDK validate the agent's final answer
 *   against a JSON Schema and re-prompt on mismatch; the validated object
 *   arrives on the result message as `structured_output`.
 * - **The zod schema is still the guarantee.** `z.toJSONSchema` is a
 *   projection, not a translation: a refinement zod can express and draft-07
 *   cannot is widened rather than carried across. So the SDK's validation is
 *   necessary and not sufficient, and this binding re-parses the returned
 *   object with the step's own zod schema. That re-parse is what the binding's
 *   small retry bound exists for, alongside the two failures the SDK documents
 *   — `error_max_structured_output_retries`, and a `success` result that
 *   carries no `structured_output` at all.
 * - **The subagent is selected by name.** `options.agent` names the agent for
 *   the main thread; the agent must exist in the settings the run loads, which
 *   is what `settingSources` controls (`"project"` loads `.claude/agents` from
 *   `cwd`). The subagent's own prompt is its system prompt, so the step's
 *   `system` is prepended to the turn rather than passed as `systemPrompt`,
 *   which would replace the agent's.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Effect } from "../core/effects.ts";
import type { ModelBinding } from "../core/step.ts";

/** Which filesystem settings the run loads. `"project"` loads `.claude/agents`. */
export type SettingSource = "user" | "project" | "local";

/** The slice of the Agent SDK's `Options` this binding sets. */
export type AgentSdkOptions = {
  agent?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  settingSources?: SettingSource[];
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
};

/** The slice of the Agent SDK's `SDKMessage` this binding reads. */
export type AgentSdkMessage = {
  type: string;
  subtype?: string;
  structured_output?: unknown;
  errors?: string[];
};

/**
 * The Agent SDK's `query`, narrowed to what this binding uses. Injected so the
 * binding is unit-testable against scripted messages: the test suite must never
 * reach the real SDK, and the real SDK is a 1.5 MB module that is not even
 * loaded unless `generate` is called without a fake.
 */
export type AgentSdkQuery = (params: {
  prompt: string;
  options?: AgentSdkOptions;
}) => AsyncIterable<AgentSdkMessage>;

/** One file the scratch diff found changed. */
export type ProposedChange = {
  /** Repository-relative, against the proposal's `source`. */
  path: string;
  /** The bytes the turn left there. */
  body: string;
  /** Whether the file existed in `source` before the turn. */
  existed: boolean;
};

/**
 * How a changed file becomes an effect, when the caller can name the symbol it
 * belongs to. Absent, or answering `undefined`, means the whole file is the
 * unit and the effect is a `write-file`.
 *
 * Injected rather than derived, because a symbol id is the VCS's to assign and
 * a binding that imported the VCS to look one up would put the data plane
 * inside the model seam.
 */
export type SymbolFor = (change: ProposedChange) => { id: string; version: number } | undefined;

export type ProposalOptions = {
  /** The tree the scratch copy is made from, and diffed against. */
  source: string;
  /**
   * The only paths the turn may change, as prefixes. A byte outside them is a
   * contract failure before any effect is emitted.
   */
  allowed: readonly string[];
  /** Resolve a changed file to the symbol that owns it, when one is known. */
  symbolFor?: SymbolFor;
};

export type ClaudeCodeOptions = {
  /** The subagent to dispatch, e.g. "nw-acceptance-designer". */
  agent: string;
  /** The workspace the agent runs in. */
  cwd: string;
  /** Model alias or full id. Omitted: the agent's own, else the CLI default. */
  model?: string;
  /** Maximum agentic turns before the SDK stops the run. */
  maxTurns?: number;
  /** Defaults to `["user", "project"]`, so `.claude/agents` under `cwd` loads. */
  settingSources?: SettingSource[];
  /** How many times to ask before giving up. Small by design; default 2. */
  attempts?: number;
  /** The SDK's `query`. Defaults to the real one, imported lazily. */
  query?: AgentSdkQuery;
  /**
   * Run this turn in a scratch copy and return its writes as effects. Absent:
   * the OPAQUE shape, where the agent edits `cwd` and the framework never sees
   * the writes.
   */
  proposal?: ProposalOptions;
};

/** Where the proposal's effects land on the turn's object. */
export const PROPOSAL_FIELD = "proposal";

/** The real SDK, imported only when a call is actually made. */
const sdkQuery: AgentSdkQuery = (params) => ({
  async *[Symbol.asyncIterator]() {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    for await (const message of query(params)) {
      yield {
        type: message.type,
        subtype: "subtype" in message ? String(message.subtype) : undefined,
        structured_output:
          "structured_output" in message ? message.structured_output : undefined,
        errors: "errors" in message ? message.errors : undefined,
      };
    }
  },
});

/** What one run of the agent produced, as a decision rather than an exception. */
type Reply = { ok: true; value: unknown } | { ok: false; why: string };

const describeFailure = (message: AgentSdkMessage): string => {
  const subtype = message.subtype ?? "<no subtype>";
  const errors = message.errors ?? [];
  if (errors.length > 0) return `the run ended ${subtype}: ${errors.join("; ")}`;
  return subtype === "success"
    ? "the run succeeded but carried no structured output"
    : `the run ended ${subtype}`;
};

/**
 * Drain the message stream and keep the last result message. A single-shot
 * `query()` throws after yielding an error result, so the throw is caught and
 * the more specific result — if one arrived — is what is reported.
 */
const replyOf = async (messages: AsyncIterable<AgentSdkMessage>): Promise<Reply> => {
  let reply: Reply = { ok: false, why: "the run produced no result message" };
  try {
    for await (const message of messages) {
      if (message.type !== "result") continue;
      reply =
        message.subtype === "success" && message.structured_output !== undefined
          ? { ok: true, value: message.structured_output }
          : { ok: false, why: describeFailure(message) };
    }
  } catch (err) {
    if (!reply.ok) reply = { ok: false, why: `the run threw: ${String(err)}` };
  }
  return reply;
};

/**
 * One turn. The agent's own prompt is its system prompt, so the step's
 * `system` leads the user turn, and anything a previous attempt got wrong is
 * appended verbatim — the same feedback shape `runStep` uses one level up.
 */
const turn = (req: { system: string; prompt: string }, failures: readonly string[]): string =>
  [
    req.system,
    "",
    req.prompt,
    ...(failures.length === 0
      ? []
      : [
          "",
          "Your previous reply could not be used:",
          ...failures.map((f) => `- ${f}`),
          "",
          "Answer again, conforming exactly to the required output schema.",
        ]),
  ].join("\n");

/* ---------------------------------------------------------- the proposal */

/** Every file under `dir`, repository-relative, skipping `node_modules`. */
const walk = (root: string, dir = root, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(root, path, out);
    else out.push(relative(root, path));
  }
  return out;
};

const read = (root: string, path: string): string | undefined => {
  const at = join(root, path);
  return existsSync(at) ? readFileSync(at, "utf8") : undefined;
};

/** Is this path inside one of the allowed prefixes? */
const allowedBy = (allowed: readonly string[], path: string): boolean =>
  allowed.some((scope) => {
    const base = scope.endsWith("/") ? scope.slice(0, -1) : scope;
    return path === base || path.startsWith(`${base}/`);
  });

/**
 * What the turn changed, by comparing the scratch copy against the source.
 *
 * Every file in either tree, so a creation and a rewrite are both found. A
 * DELETION is not a change this can express — `Effect` has no way to remove a
 * file — so one is reported as an out-of-scope change rather than silently
 * dropped: a turn that deleted an oracle proposed something the framework
 * cannot commit, and saying so beats committing the rest.
 */
export const proposedChanges = (source: string, scratch: string): ProposedChange[] => {
  const paths = [...new Set([...walk(source), ...walk(scratch)])].sort();
  const changes: ProposedChange[] = [];
  for (const path of paths) {
    const before = read(source, path);
    const after = read(scratch, path);
    if (after === undefined) {
      // Removed. Reported as a change with no bytes, which `effectsFor` turns
      // into a refusal rather than into an effect.
      if (before !== undefined) changes.push({ path, body: "", existed: true });
      continue;
    }
    if (before === after) continue;
    changes.push({ path, body: after, existed: before !== undefined });
  }
  return changes;
};

/** A change the framework cannot express, if this is one. */
const unrepresentable = (change: ProposedChange, source: string): string | undefined =>
  change.existed && read(source, change.path) !== undefined && change.body === ""
    ? `${change.path} was emptied or removed, and no effect expresses that`
    : undefined;

/** The effects a set of changes becomes, or the reason it becomes none. */
export const effectsFor = (
  changes: readonly ProposedChange[],
  options: ProposalOptions,
): { effects: Effect[] } | { refused: string } => {
  const outside = changes.map((c) => c.path).filter((path) => !allowedBy(options.allowed, path));
  if (outside.length > 0) {
    return {
      refused:
        `the turn changed ${outside.join(", ")}, which is outside ${options.allowed.join(", ")}. ` +
        "A path is test substrate because of where it sits.",
    };
  }
  const effects: Effect[] = [];
  for (const change of changes) {
    const broken = unrepresentable(change, options.source);
    if (broken !== undefined) return { refused: broken };
    const symbol = change.existed ? options.symbolFor?.(change) : undefined;
    effects.push(
      symbol === undefined
        ? { type: "write-file", path: change.path, body: change.body }
        : {
            type: "replace-symbol",
            symbolId: symbol.id,
            expectedVersion: symbol.version,
            body: change.body,
          },
    );
  }
  return { effects };
};

/**
 * The turn's object with the derived effects on its payload.
 *
 * `stepOutput` fixes the shape at `{ decision, payload }` — that is the
 * framework's one contract about what a step returns — so there is exactly one
 * place the proposal can go and no guessing about where. The agent never
 * produces this field and the binding always overwrites it.
 */
const withProposal = (value: unknown, effects: Effect[]): unknown => {
  const object = (value ?? {}) as Record<string, unknown>;
  const payload = (object.payload ?? {}) as Record<string, unknown>;
  return { ...object, payload: { ...payload, [PROPOSAL_FIELD]: effects } };
};

/**
 * Bind a step's model slot to a Claude Code subagent.
 *
 * The binding's `id` is `claude-code:<agent>`, so `Attempt.model` in a step's
 * trail names which agent produced each attempt rather than which model.
 */
export const claudeCode = (options: ClaudeCodeOptions): ModelBinding => {
  const runQuery = options.query ?? sdkQuery;
  const attempts = options.attempts ?? 2;
  const id = `claude-code:${options.agent}`;

  return {
    id,
    async generate<T>(req: { system: string; prompt: string; schema: z.ZodType<T> }): Promise<T> {
      // Unrepresentable constructs widen to `{}` rather than throwing: the zod
      // re-parse below is the real gate, so a looser JSON Schema costs a retry
      // at worst and never fails the call before the agent has answered.
      const schema = z.toJSONSchema(req.schema, {
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>;

      const failures: string[] = [];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        // The proposal shape runs the turn in a throwaway copy of the source
        // tree, so the agent's own `Edit` writes land somewhere the framework
        // can diff rather than somewhere it has to trust.
        const scratch =
          options.proposal === undefined ? undefined : mkdtempSync(join(tmpdir(), "dw-proposal-"));
        try {
          if (options.proposal !== undefined && scratch !== undefined) {
            cpSync(options.proposal.source, scratch, { recursive: true, dereference: false });
          }
          const reply = await replyOf(
            runQuery({
              prompt: turn(req, failures),
              options: {
                agent: options.agent,
                cwd: scratch ?? options.cwd,
                model: options.model,
                maxTurns: options.maxTurns,
                settingSources: options.settingSources ?? ["user", "project"],
                outputFormat: { type: "json_schema", schema },
              },
            }),
          );

          if (!reply.ok) {
            failures.push(reply.why);
            continue;
          }

          let value = reply.value;
          if (options.proposal !== undefined && scratch !== undefined) {
            const derived = effectsFor(
              proposedChanges(options.proposal.source, scratch),
              options.proposal,
            );
            // A byte outside the allowed paths is a CONTRACT failure raised
            // before any effect is emitted: a turn that wrote where it may not
            // proposes nothing rather than proposing most of what it did.
            if ("refused" in derived) {
              failures.push(derived.refused);
              continue;
            }
            value = withProposal(value, derived.effects);
          }

          const parsed = req.schema.safeParse(value);
          if (parsed.success) return parsed.data;
          failures.push(`the reply did not satisfy the step's schema: ${parsed.error.message}`);
        } finally {
          if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
        }
      }

      // runStep turns this into a trail entry and moves to its next attempt.
      throw new Error(
        `${id} produced no schema-conforming output in ${attempts} attempts:\n` +
          failures.map((f) => `- ${f}`).join("\n"),
      );
    },
  };
};
