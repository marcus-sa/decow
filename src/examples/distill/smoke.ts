/**
 * One scenario through real models, via Mastra.
 *
 *   ANTHROPIC_API_KEY=... bun run smoke
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... bun run smoke
 *
 * The test suite never imports this file. Refuses to run without
 * ANTHROPIC_API_KEY.
 *
 * Which small models and which validator family is the consumer's column in
 * the design's framework/consumer split, which is why the wiring lives here;
 * the reusable binding itself is `src/bindings/mastra.ts`.
 */

import { mastraAgent } from "../../bindings/mastra.ts";
import { memoryJournal } from "../../core/journal.ts";
import { run } from "../../core/workflow.ts";
import { describeTrace } from "../../harness/matchers.ts";
import { classifierDefs, KINDS, type Kind } from "./classify.ts";
import { distillGraph, mergeVerdict, seed, type State } from "./graph.ts";

/** Mastra model-router ids: `provider/model`. No provider package needed. */
const WORKER_MODEL = "anthropic/claude-haiku-4-5";
const ESCALATE_MODEL = "anthropic/claude-sonnet-5";
/** A different family refutes more independently, when a key is available. */
const VALIDATOR_MODEL = process.env.OPENAI_API_KEY ? "openai/gpt-5-mini" : WORKER_MODEL;

const SCENARIO = {
  id: "S-SMOKE-1",
  text:
    "Launch 500 microVMs through `overdrive deploy` and record the p99 boot latency at a fixed " +
    "concurrency profile, then publish the distribution alongside the operator-visible boot log.",
  crossesBoundary: true,
};

const main = async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("smoke: ANTHROPIC_API_KEY is not set. Refusing to run.");
    process.exit(1);
  }

  const defs = classifierDefs({
    worker: mastraAgent({ model: WORKER_MODEL }),
    validator: mastraAgent({ model: VALIDATOR_MODEL }),
    escalateTo: mastraAgent({ model: ESCALATE_MODEL }),
  });

  const journal = memoryJournal();
  const trail: string[] = [];

  console.log(`worker:    ${WORKER_MODEL}`);
  console.log(`validator: ${VALIDATOR_MODEL}${process.env.OPENAI_API_KEY ? "" : "  (no OPENAI_API_KEY; same family)"}`);
  console.log(`escalate:  ${ESCALATE_MODEL}\n`);
  console.log(`scenario ${SCENARIO.id}: ${SCENARIO.text}\n`);

  const wf = distillGraph(journal, defs);
  const outcome = await run<State>(wf, seed(SCENARIO), async (effects) => {
    for (const e of effects) if (e.type === "append-trail") trail.push(e.line);
    return effects.map((effect) => ({ effect, outcome: "committed" as const, version: 1 }));
  });

  // A suspension parks before a terminal, so the last observable state is the
  // one the classifiers produced; re-derive it rather than invent one.
  if (outcome.kind === "terminal") {
    const state = outcome.terminal.state;
    for (const kind of KINDS) {
      const slot = state[kind as Kind];
      console.log(
        `  ${kind.padEnd(11)} ${String(slot.lane ?? "-").padEnd(12)}` +
          (slot.exhausted
            ? "(validator-exhausted)"
            : `anchor: ${JSON.stringify(slot.anchor ?? "")}`),
      );
    }
    console.log(`\nmerge verdict: ${mergeVerdict(state)}`);
    console.log(`terminal:      ${outcome.terminal.kind}`);
  } else if (outcome.kind === "suspended") {
    console.log(`\nsuspended:     ${outcome.reason}`);
    console.log(`run id:        ${outcome.runId}`);
    console.log(`trail:\n${outcome.trail.map((t) => `  ${JSON.stringify(t)}`).join("\n")}`);
    console.log(
      `\nresume with: resume(wf, "${outcome.runId}", { decision: "override", ` +
        `override: { kind: "dst", lane: "needed" } }, execute)`,
    );
  }

  console.log(`trace:         ${describeTrace(outcome.trace)}`);
  if (trail.length > 0) console.log(`effects:\n${trail.map((l) => `  ${l}`).join("\n")}`);
};

await main();
