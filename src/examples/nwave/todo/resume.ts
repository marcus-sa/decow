/**
 * `bun run todo:resume <run-name> <row-id> <commit|abandon>` — answer a DELIVER
 * row that parked for a person.
 *
 *   ANTHROPIC_API_KEY=... bun run todo:resume first 01-02 commit
 *
 * The step cycle parks under a typed reason — a missing acceptance test, a
 * vacuous one, a design gap, an exhausted validator, a loop that ran out — and
 * a person answers from a two-member enum: `commit` takes the run to the commit
 * leaf, `abandon` rejects it. Either way the same run continues to a terminal;
 * neither is a new run.
 *
 * Like `todo:review`, this is a second process resuming a run a first one
 * parked. The run id is not held anywhere in memory: `record` persisted it on
 * the row's `step_runs` row, so the projection that answers "is this row
 * parked" also answers "which run is it parked under". After the answer the
 * frontier is re-evaluated, so rows that were waiting on this one run in the
 * same command.
 */

import { join } from "node:path";
import type { RunOutcome } from "../../../core/workflow.ts";
import { HUMAN_DECISIONS, type HumanDecision, type State } from "../deliver/graph.ts";
import { openPipeline } from "../deliver/pipeline.ts";
import { todoDeliverDefs } from "./models.ts";
import { heading, renderDeliverTrail, renderTrace } from "./render.ts";
import { openReport } from "./report.ts";
import { openRunDir, requireCredential, requireRunName, runSuite, shortPath } from "./run-dir.ts";

const USAGE = `usage: bun run todo:resume <run-name> <row-id> <${HUMAN_DECISIONS.join("|")}>`;

const isHumanDecision = (value: string): value is HumanDecision =>
  (HUMAN_DECISIONS as readonly string[]).includes(value);

const main = async (): Promise<void> => {
  requireCredential("todo:resume");
  const argv = process.argv.slice(2);
  const name = requireRunName("todo:resume", argv);
  const rowId = argv[1];
  const decision = argv[2];

  if (rowId === undefined || decision === undefined || !isHumanDecision(decision)) {
    console.error(`${USAGE}\n  got: ${argv.slice(1).join(" ") || "(nothing)"}`);
    process.exit(1);
  }

  const dir = openRunDir(name);
  const report = openReport({ path: join(dir.path, "report.jsonl"), run: name });
  const defs = todoDeliverDefs({ onUsage: report.onUsage });
  const evidence = runSuite(dir.project);

  const outcomes = new Map<string, RunOutcome<State>>();
  const { resumeParked, rows } = openPipeline({
    artifacts: dir.artifacts,
    vcs: dir.vcs,
    journal: dir.journal,
    defs,
    roadmapId: dir.manifest.request,
    design: dir.design,
    evidence: evidence.output,
    concurrency: 1,
    observe: report.observerFor,
    onRun: (id, outcome) => outcomes.set(id, outcome),
    runtime: dir.runtime,
  });

  console.log(`run:    ${shortPath(dir.path)}`);
  console.log(`row:    ${rowId}`);
  console.log(`answer: ${decision}`);

  const { statuses } = await resumeParked(rowId, { decision });

  console.log(heading("rows"));
  for (const row of rows) {
    const outcome = outcomes.get(row.id);
    console.log(`\n${row.id}  ${statuses.get(row.id) ?? "pending"}`);
    if (outcome === undefined) continue;
    console.log(`  trace: ${renderTrace(outcome.trace)}`);
    if (outcome.kind === "suspended") {
      console.log(`  parked: ${outcome.reason}  (run ${outcome.runId})`);
      console.log(renderDeliverTrail(outcome.trail));
    }
  }

  console.log(heading("the todo project's own suite"));
  const suite = runSuite(dir.project);
  console.log(suite.output);
  console.log(`\nexit code: ${suite.exitCode}`);
  console.log(`\nreport:  bun run todo:report ${name}`);
  dir.close();
};

await main();
