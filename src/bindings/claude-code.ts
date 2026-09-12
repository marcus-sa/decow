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
 * **Proposal.** The agent returns its writes as data — `replace-symbol`
 * effects — and the runner commits them through the agent-native VCS, under a
 * lease, with the typecheck-and-impacted-tests gate at the write boundary, and
 * the journal key recorded as the intent. A conflict comes back as a decision
 * value the graph routes, not as a surprise on disk. That is the shape the
 * design's "the VCS is the effect executor and mechanical verifier" section
 * describes, and it is **not built** — it needs the VCS. See the README's
 * "Not built yet".
 *
 * The distinction is not stylistic. Under the opaque shape a `conflict` is
 * unrepresentable, because the write never crossed the effect boundary where a
 * version check could happen.
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

import { z } from "zod";
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
};

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
        const reply = await replyOf(
          runQuery({
            prompt: turn(req, failures),
            options: {
              agent: options.agent,
              cwd: options.cwd,
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
        const parsed = req.schema.safeParse(reply.value);
        if (parsed.success) return parsed.data;
        failures.push(`the reply did not satisfy the step's schema: ${parsed.error.message}`);
      }

      // runStep turns this into a trail entry and moves to its next attempt.
      throw new Error(
        `${id} produced no schema-conforming output in ${attempts} attempts:\n` +
          failures.map((f) => `- ${f}`).join("\n"),
      );
    },
  };
};
