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
 * WHAT IS REAL HERE, and it is nearly all of it: the oracle resolves each
 * obligation's locator against the VCS symbol inventory, `activate-at` strips
 * the `test.skip(` marker through the write path, `implement` writes a method
 * body through the write path under a lease, and every one of those writes is
 * gated by a real `tsc --noEmit` and a real impact-scoped `bun test` that rolls
 * the file back byte for byte when it refuses. Then the whole suite runs once
 * at the end, because "the acceptance tests pass" is a thing you run, not a
 * thing you infer.
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
import { redEvidence } from "./evidence.ts";
import { describeModels, todoDeliverDefs } from "./models.ts";
import { heading, renderDeliverTrail, renderTrace } from "./render.ts";
import { openReport } from "./report.ts";
import { openRunDir, requireCredential, requireRunName, shortPath } from "./run-dir.ts";

const main = async (): Promise<void> => {
  requireCredential("todo:deliver");
  const name = requireRunName("todo:deliver", process.argv.slice(2));

  const dir = openRunDir(name);
  const request = dir.manifest.request;
  if (request.length === 0) {
    console.error(`todo:deliver: run "${name}" has no approved roadmap. Run todo:review ${name} approve first.`);
    process.exit(1);
  }

  const report = openReport({ path: join(dir.path, "report.jsonl"), run: name });
  const defs = todoDeliverDefs({ onUsage: report.onUsage });

  // The RED evidence, measured rather than supplied: the target's own suite
  // with every pending marker stripped, in a scratch copy. See `evidence.ts`.
  const evidence = redEvidence(dir.project);

  console.log(describeModels());
  console.log(`\nrun:      ${shortPath(dir.path)}`);
  console.log(`roadmap:  ${request}`);
  console.log(`evidence: the target's suite with the markers stripped, exit ${evidence.exitCode}, ${evidence.output.length} chars`);

  const outcomes = new Map<string, RunOutcome<State>>();
  const { scheduler, rows } = openPipeline({
    artifacts: dir.artifacts,
    vcs: dir.vcs,
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
  const suite = Bun.spawnSync(["bun", "test"], { cwd: project });
  console.log(`${suite.stdout.toString()}${suite.stderr.toString()}`.trim());
  console.log(`\nexit code: ${suite.exitCode}`);
};

await main();
