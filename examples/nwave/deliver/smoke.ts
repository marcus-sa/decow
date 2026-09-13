/**
 * One DELIVER step through real models and real agents.
 *
 *   ANTHROPIC_API_KEY=... bun run smoke:deliver
 *   ANTHROPIC_API_KEY=... DW_WORKSPACE=/path/to/repo bun run smoke:deliver
 *
 * The test suite never imports this file, and nothing here is reachable from
 * one: it constructs Mastra agents and dispatches Claude Code subagents, both
 * of which cost money and touch a workspace. It refuses to run without
 * ANTHROPIC_API_KEY.
 *
 * What it demonstrates is the binding seam under load. The classifying leaves
 * are one small model each, through `mastraAgent`. The three diagnosis-side
 * leaves are Claude Code subagents, through `claudeCode`, and each one is the
 * agent that owns its cause:
 *
 *   diagnose             why is this still red?            the crafter
 *   fix-acceptance-test  the test asserts it wrongly        the acceptance designer
 *   surface-design-gap   the design does not name it        the solution architect
 *
 * From the graph's side there is no difference: every leaf is a `runStep` with
 * a closed decision space and a validator, and the graph branches on `decision`
 * whether the thing behind the binding spent one call or forty turns.
 *
 * Two honest gaps. There is no VCS, so the executor below acknowledges
 * `replace-symbol` rather than landing it; and these three leaves run on the
 * **opaque** `claudeCode` shape, so an agent that edited the workspace did so
 * outside the effect boundary, where no lease or version check could see it.
 * The proposal shape is what `smoke:oracle` exercises.
 */

import { claudeCode } from "@des/core/bindings/claude-code";
import { mastraAgent } from "@des/core/bindings/mastra";
import type { Commands } from "@des/core/commands";
import type { EffectResult } from "@des/core/effects";
import { memoryJournal } from "@des/core/journal";
import type { ModelBinding } from "@des/core/step";
import { run } from "@des/core/workflow";
import { describeTrace } from "@des/core/harness";
import { deliverGraph, seed, type State } from "./graph.ts";
import { deliverDefs, type LeafId } from "./steps.ts";

/** Mastra model-router ids: `provider/model`. No provider package needed. */
const WORKER_MODEL = "anthropic/claude-haiku-4-5";
const ESCALATE_MODEL = "anthropic/claude-sonnet-5";
/** A different family refutes more independently, when a key is available. */
const VALIDATOR_MODEL = process.env.OPENAI_API_KEY ? "openai/gpt-5-mini" : WORKER_MODEL;

/** The workspace the subagents run in. */
const WORKSPACE = process.env.DW_WORKSPACE ?? process.cwd();

/**
 * How the workspace is checked, as a consumer declares it.
 *
 * The quality gate is a real `run-command` and `acknowledge` below answers it
 * `committed` like every other effect, because there is no VCS here and this
 * script is about which leaf a graph reaches rather than about what a linter
 * says. The declaration is still real: it is what the `gates` node composes.
 */
const COMMANDS: Commands = {
  typecheck: () => ["bunx", "tsc", "--noEmit"],
  lint: ({ paths }) => ["bunx", "biome", "check", ...paths],
  tests: ({ file, selector, junit }) => [
    "bun",
    "test",
    file,
    ...(selector ? ["-t", selector] : []),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ],
  oracle: ({ file, selector, junit }) => [
    "bun",
    "test",
    file,
    ...(selector ? ["-t", selector] : []),
    "--reporter=junit",
    `--reporter-outfile=${junit}`,
  ],
};

/** Which subagent owns which cause. Overridable, because agent names are local. */
const AGENTS: Partial<Record<LeafId, string>> = {
  diagnose: process.env.DW_DIAGNOSE_AGENT ?? "nw-software-crafter",
  "fix-acceptance-test": process.env.DW_FIX_AT_AGENT ?? "nw-acceptance-designer",
  "surface-design-gap": process.env.DW_DESIGN_GAP_AGENT ?? "nw-solution-architect",
};

const subagents = (): Partial<Record<LeafId, ModelBinding>> =>
  Object.fromEntries(
    Object.entries(AGENTS).map(([leaf, agent]) => [
      leaf,
      claudeCode({ agent, cwd: WORKSPACE, maxTurns: 24 }),
    ]),
  );

const STEP = {
  id: "02-03",
  criteria:
    "A submitted allocation reaches Running through the production driver, observed as an " +
    "alloc_status row written by the exit observer.",
  design: "ExecDriver::start(&self, spec: &AllocSpec) -> Result<AllocHandle>",
  authority: "ADR-0023 § the action-shim executor boundary",
  acceptance: [
    {
      id: "02-03-AC-1",
      stimulus: "Submit an allocation through the production driver.",
      expected: "It reaches Running, observed as an alloc_status row written by the exit observer.",
    },
  ],
  predictedTouches: ["ExecDriver::start"],
  oracle: "tests/alloc.test.ts::a submitted allocation reaches Running",
};

/** The step's own oracle, as the step carries it in. */
const ACCEPTANCE_TESTS = ["test-submit-to-running"];

const EVIDENCE =
  "running 1 test\n" +
  "test submit_to_running ... FAILED\n\n" +
  "---- submit_to_running stdout ----\n" +
  "assertion `left == right` failed: allocation never left Pending\n" +
  "  left: Pending\n" +
  " right: Running\n\n" +
  "test result: FAILED. 0 passed; 1 failed";

/**
 * The impact floor, as a VCS query would have answered it. There is no VCS
 * behind this script either, so the floor is supplied rather than derived, and
 * `select-tests` decides only what to ADD to it.
 */
const IMPACTED = ["exec_driver::submit_to_running", "exit_observer::writes_alloc_status_row"];

/**
 * There is no VCS behind this, so a write is acknowledged rather than landed.
 * `memoryEffects` would answer `infra-failed`, which is the honest outcome and
 * the one the graph routes to a person — correct, and not what this script is
 * here to show.
 */
const acknowledge = async (effects: Parameters<Parameters<typeof run>[2]>[0]) =>
  effects.map(
    (effect): EffectResult =>
      effect.type === "replace-symbol"
        ? { effect, outcome: "committed", version: effect.expectedVersion + 1 }
        : { effect, outcome: "committed", version: 1 },
  );

const main = async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("smoke: ANTHROPIC_API_KEY is not set. Refusing to run.");
    process.exit(1);
  }

  const defs = deliverDefs({
    worker: mastraAgent({ model: WORKER_MODEL }),
    validator: mastraAgent({ model: VALIDATOR_MODEL }),
    escalateTo: mastraAgent({ model: ESCALATE_MODEL }),
    workers: subagents(),
  });

  console.log(`worker:    ${WORKER_MODEL}`);
  console.log(
    `validator: ${VALIDATOR_MODEL}${process.env.OPENAI_API_KEY ? "" : "  (no OPENAI_API_KEY; same family)"}`,
  );
  console.log(`escalate:  ${ESCALATE_MODEL}`);
  console.log(`workspace: ${WORKSPACE}`);
  for (const [leaf, agent] of Object.entries(AGENTS)) {
    console.log(`  ${leaf.padEnd(20)} claude-code:${agent}`);
  }
  console.log(`\nstep ${STEP.id}: ${STEP.criteria}\n`);

  const outcome = await run<State>(
    deliverGraph(memoryJournal(), defs, COMMANDS),
    { ...seed(STEP, EVIDENCE, IMPACTED), acceptanceTests: ACCEPTANCE_TESTS },
    acknowledge,
  );

  if (outcome.kind === "terminal") {
    console.log(`terminal:      ${outcome.terminal.kind}`);
    console.log(`leaves:        ${JSON.stringify(outcome.terminal.state.leaf)}`);
  } else {
    console.log(`suspended:     ${outcome.reason}`);
    console.log(`run id:        ${outcome.runId}`);
    console.log(`trail:\n${outcome.trail.map((t) => `  ${JSON.stringify(t)}`).join("\n")}`);
    console.log(
      `\nresume with: resume(wf, "${outcome.runId}", { decision: "commit" }, acknowledge)`,
    );
  }
  console.log(`trace:         ${describeTrace(outcome.trace)}`);
};

await main();
