/**
 * One oracle, authored by a real Claude Code subagent in the PROPOSAL shape,
 * written through the real VCS, and measured by a real `bun test`.
 *
 *   ANTHROPIC_API_KEY=... bun run smoke:oracle
 *   ANTHROPIC_API_KEY=... DW_ORACLE_AGENT=nw-acceptance-designer bun run smoke:oracle
 *
 * The test suite never imports this file: it dispatches a subagent, which costs
 * money and takes turns. It refuses to run without ANTHROPIC_API_KEY.
 *
 * What it demonstrates is the PROPOSAL binding under load, on the one leaf it
 * was built for. The agent runs with its own tools in a scratch copy of a temp
 * project; afterwards the copy is diffed and every changed file under the test
 * path becomes a `write-file` effect. From the graph's side nothing about that
 * is special — it is a leaf whose payload carries effects, and the runner
 * commits them through the same write path a structured-output turn's file
 * bodies would go through.
 *
 * The difference from the OPAQUE shape is the whole point. Opaque, the agent's
 * writes have already happened when `generate` resolves, outside the boundary
 * where a lease or a version check could see them. Proposal, they are data the
 * runner leases, gates, and rolls back — and a refusal is a decision value the
 * graph routes.
 */

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeCode } from "../../../bindings/claude-code.ts";
import { mastraAgent } from "../../../bindings/mastra.ts";
import { measurementOf } from "../../../core/effects.ts";
import { memoryJournal } from "../../../core/journal.ts";
import { run } from "../../../core/workflow.ts";
import { describeTrace } from "../../../harness/matchers.ts";
import { vcsExecutor } from "../../../vcs/executor.ts";
import { openVcs } from "../../../vcs/index.ts";
import { oracleGraph, seed, type State } from "./oracle/graph.ts";
import { oracleDefs, type ValueUnderOracle } from "./oracle/steps.ts";

/** This file is `<repo>/src/examples/nwave/distill/smoke.ts`. */
const REPO = dirname(dirname(dirname(dirname(dirname(import.meta.path)))));

const VALIDATOR_MODEL = "anthropic/claude-haiku-4-5";
const AGENT = process.env.DW_ORACLE_AGENT ?? "nw-acceptance-designer";
const TEST_PATHS = ["test"];

const SOURCE = `/** A counter with one stubbed method. */
export class Counter {
  #value = 0;

  increment(): number {
    this.#value += 1;
    return this.#value;
  }

  /** Reset the counter to zero and return the value it held. */
  reset(): number {
    throw new Error("not implemented");
  }
}
`;

const DESIGN = `# Counter — the design

\`\`\`ts
export class Counter {
  increment(): number;
  reset(): number;
}
\`\`\`

- **increment()** adds one and returns the new value. *Implemented.*
- **reset()** sets the counter to zero and returns the value it held before.
  *Stub.*

## The driving port

\`new Counter()\`, and its two methods. Nothing else is exported and there is no
other way to observe the value.

## Test substrate

- Test path scope: \`test/\`
`;

const VALUE: ValueUnderOracle = {
  stepId: "01-01",
  observation: "Counter.reset zeroes the counter and returns the value it held before.",
  acceptance: [
    {
      id: "01-01-AC-1",
      stimulus: "Increment a fresh counter twice, then reset it.",
      expected: "reset returns 2, and a following increment returns 1.",
    },
  ],
  oracle: "test/counter.test.ts::reset zeroes the counter and returns what it held",
  supports: [],
  authority: "design.md § Behaviour -> reset",
};

/** A temp project with the stub, its design, and this repo's node_modules. */
const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dw-oracle-smoke-"));
  writeFileSync(join(root, "counter.ts"), SOURCE, "utf8");
  writeFileSync(join(root, "design.md"), DESIGN, "utf8");
  writeFileSync(
    join(root, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          types: ["bun"],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  return root;
};

const main = async (): Promise<void> => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("smoke:oracle: ANTHROPIC_API_KEY is not set. Refusing to run.");
    process.exit(1);
  }

  const root = project();
  const vcs = openVcs({ root });
  vcs.track("counter.ts");

  const defs = oracleDefs({
    // The PROPOSAL shape. The agent edits a scratch copy of `root` with its own
    // tools; what it changed under `test/` comes back as effects.
    worker: claudeCode({
      agent: AGENT,
      cwd: root,
      maxTurns: 24,
      proposal: { source: root, allowed: TEST_PATHS },
    }),
    validator: mastraAgent({ model: VALIDATOR_MODEL }),
  });

  console.log(`author:    claude-code:${AGENT}  (proposal shape)`);
  console.log(`validator: ${VALIDATOR_MODEL}`);
  console.log(`project:   ${root}`);
  console.log(`oracle:    ${VALUE.oracle}\n`);

  const outcome = await run<State>(
    oracleGraph(memoryJournal(), defs),
    seed({ value: VALUE, design: DESIGN, testPaths: TEST_PATHS }),
    vcsExecutor({
      vcs,
      session: VALUE.stepId,
      intent: { taskId: VALUE.stepId, description: "author the oracle" },
    }),
  );

  if (outcome.kind === "terminal") {
    console.log(`terminal:  ${outcome.terminal.kind}`);
    const measured = measurementOf(outcome.terminal.state.measured);
    console.log(`verdict:   ${measured?.verdict ?? "(never measured)"} on ${measured?.axis ?? "-"}`);
    console.log(`files:     ${outcome.terminal.state.files.map((f) => f.path).join(", ") || "(none)"}`);
    if (measured !== undefined) console.log(`\n${measured.output}`);
  } else {
    console.log(`suspended: ${outcome.reason}`);
    console.log(`trail:\n${outcome.trail.map((t) => `  ${JSON.stringify(t)}`).join("\n")}`);
  }
  console.log(`trace:     ${describeTrace(outcome.trace)}`);
  console.log(`\nthe project, for reading: ${root}`);
  vcs.close();
};

await main();
