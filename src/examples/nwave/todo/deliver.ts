/**
 * `bun run todo:deliver <run-name>` — run the DELIVER step cycle over the
 * approved roadmap.
 *
 *   ANTHROPIC_API_KEY=... bun run todo:deliver first
 *
 * Reads the `roadmap_steps` rows `todo:review approve` persisted, hands them to
 * the scheduler, and runs the fixed step cycle once per row against the run's
 * own checkout. `implement` is Sonnet; every other leaf is Haiku; the oracle,
 * the activation and the suite are not models at all.
 *
 * WHAT IS REAL HERE, and it is nearly all of it: every process this command
 * runs comes from the copied target's own `commands.ts`. `implement` writes a
 * method body through the write path under a lease, gated by the declared
 * typecheck, the declared lint over the file it touched, and the declared test
 * command over the impact-scoped subset, rolling the file back byte for byte
 * when any of them refuses. The quality gate is the declared lint command
 * again, over the files the row writes, and its exit status is the verdict
 * rather than a model's reading of it. Then the whole suite runs once at the
 * end, because "the acceptance tests pass" is a thing you run, not a thing you
 * infer.
 *
 * CONCURRENCY IS 1. Two reasons, and the second is the load-bearing one. The
 * roadmap's two rows write different methods of the same class but they SHARE a
 * test file, so a row running its impact-scoped suite while another row has
 * activated its tests and not yet implemented them would read its own step as
 * having broken somebody else's — a true observation about a state no
 * sequential run reaches. And the report's token columns are attributed by call
 * order, which only holds while one leaf is in flight; see `report.ts`.
 */

import { join } from "node:path";
import type { RunOutcome } from "../../../core/workflow.ts";
import { openPipeline } from "../deliver/pipeline.ts";
import type { State } from "../deliver/graph.ts";
import { describeModels, todoDeliverDefs } from "./models.ts";
import { heading, renderDeliverTrail, renderTrace } from "./render.ts";
import { openReport } from "./report.ts";
import { openRunDir, requireCredential, requireRunName, runSuite, shortPath } from "./run-dir.ts";

const main = async (): Promise<void> => {
  requireCredential("todo:deliver");
  const name = requireRunName("todo:deliver", process.argv.slice(2));

  const dir = await openRunDir(name);
  const request = dir.manifest.request;
  if (request.length === 0) {
    console.error(`todo:deliver: run "${name}" has no approved roadmap. Run todo:review ${name} approve first.`);
    process.exit(1);
  }

  const report = openReport({ path: join(dir.path, "report.jsonl"), run: name });
  const defs = todoDeliverDefs({ onUsage: report.onUsage });

  // The evidence every classifying leaf quotes: the project's own suite, run
  // for real, verbatim. The oracles are already active and already measured
  // red, so this is the crafter looking at exactly what the runner printed.
  const evidence = runSuite(dir.project);

  console.log(describeModels());
  console.log(`\nrun:      ${shortPath(dir.path)}`);
  console.log(`roadmap:  ${request}`);
  console.log(`evidence: the project's own suite, exit ${evidence.exitCode}, ${evidence.output.length} chars`);

  const outcomes = new Map<string, RunOutcome<State>>();
  const { scheduler, rows, unoracled } = openPipeline({
    artifacts: dir.artifacts,
    vcs: dir.vcs,
    commands: dir.commands,
    journal: dir.journal,
    defs,
    roadmapId: request,
    design: dir.design,
    evidence: evidence.output,
    concurrency: 1,
    observe: report.observerFor,
    onRun: (rowId, outcome) => outcomes.set(rowId, outcome),
    runtime: dir.runtime,
  });

  console.log(`rows:     ${rows.map((r) => r.id).join(", ")}`);

  // A row with no oracle measured RED is not deliverable, and it is refused by
  // NAME rather than quietly skipped. This is where "no edge bypasses RED"
  // lives now that the step cycle has no RED node.
  const missing = unoracled();
  if (missing.length > 0) {
    console.error(
      `\ntodo:deliver: ${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no oracle ` +
        "measured red, so nothing may deliver them.\n" +
        `Run: bun run todo:distill ${name}`,
    );
    dir.close();
    process.exit(1);
  }

  const statuses = await scheduler.run();

  console.log(heading("rows"));
  for (const row of rows) {
    const outcome = outcomes.get(row.id);
    console.log(`\n${row.id}  ${statuses.get(row.id) ?? "pending"}`);
    console.log(`  ${row.observation}`);
    if (outcome === undefined) {
      console.log("  (never ran: a dependency was not accepted)");
      continue;
    }
    console.log(`  trace: ${renderTrace(outcome.trace)}`);
    if (outcome.kind === "suspended") {
      console.log(`  parked: ${outcome.reason}  (run ${outcome.runId})`);
      console.log(renderDeliverTrail(outcome.trail));
      console.log(`\n  continue with: bun run todo:resume ${name} ${row.id} commit`);
      console.log(`             or: bun run todo:resume ${name} ${row.id} abandon`);
    } else if (outcome.terminal.kind === "rejected") {
      console.log(renderDeliverTrail(outcome.terminal.trail));
    } else {
      console.log(`  leaves: ${JSON.stringify(outcome.terminal.state.leaf)}`);
    }
  }

  printSuite(dir.project);

  console.log(`\nreport:  ${shortPath(join(dir.path, "report.jsonl"))} (${report.read().length} leaf calls)`);
  console.log(`         bun run todo:report ${name}`);
  dir.close();
};

/**
 * The whole suite, run for real at the end. Not the impact-scoped subset the
 * write gate ran — the question here is "does the project pass", and the only
 * honest answer to that is the project's own `bun test`.
 */
const printSuite = (project: string): void => {
  console.log(heading("the todo project's own suite"));
  const suite = runSuite(project);
  console.log(suite.output);
  console.log(`\nexit code: ${suite.exitCode}`);
};

await main();
