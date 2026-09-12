/**
 * `bun run todo:distill <run-name>` — state what each value must be observed
 * to do, then author and measure the oracle that measures it.
 *
 *   ANTHROPIC_API_KEY=... bun run todo:distill first
 *
 * Two disjoint steps, in order, because that is what DISTILL is.
 *
 * **The obligations graph**, once over the whole roadmap. `propose-obligations`
 * turns each observation into a stimulus and an expected result, names the one
 * oracle that will measure the value, and lists the whole-file substrate it
 * depends on. `validate-manifest` is a pure function with no model in it, and
 * on a valid manifest `persist` writes the three filled-in fields back onto the
 * `roadmap_steps` rows. No person is asked anything on the happy path.
 *
 * **The oracle graph**, once per value, in dependency order. `author-oracle`
 * writes the oracle and its supports as `write-file` effects under a path-scope
 * lease; then SOFTWARE runs the oracle and reads a verdict off it. `red` is the
 * answer: it is what says the oracle fails on its assertion before one
 * production byte exists, and it is the row DELIVER later refuses to run
 * without.
 *
 * WHAT IS REAL HERE is all of it except the two model calls. The writes go
 * through the VCS write path under a lease, gated by a real `tsc --noEmit`;
 * the measurement is a real `bun test` whose exit status and summary are read
 * by the same rule every other measurement is.
 *
 * CONCURRENCY IS 1, for the report's sake: token attribution is by call order,
 * which only holds while one leaf is in flight. See `report.ts`.
 */

import { join } from "node:path";
import { openOracles, runObligations, testPathScope } from "../distill/pipeline.ts";
import type { State as OracleState } from "../distill/oracle/graph.ts";
import type { RecordedVerdict } from "../distill/runs.ts";
import type { RunOutcome } from "../../../core/workflow.ts";
import { describeModels, todoObligationsDefs, todoOracleDefs } from "./models.ts";
import { heading, renderDeliverTrail, renderTrace } from "./render.ts";
import { openReport } from "./report.ts";
import { openRunDir, requireCredential, requireRunName, shortPath } from "./run-dir.ts";

const main = async (): Promise<void> => {
  requireCredential("todo:distill");
  const name = requireRunName("todo:distill", process.argv.slice(2));

  const dir = openRunDir(name);
  const request = dir.manifest.request;
  if (request.length === 0) {
    console.error(`todo:distill: run "${name}" has no approved roadmap. Run todo:review ${name} approve first.`);
    process.exit(1);
  }

  const report = openReport({ path: join(dir.path, "report.jsonl"), run: name });

  console.log(describeModels());
  console.log(`\nrun:      ${shortPath(dir.path)}`);
  console.log(`roadmap:  ${request}`);
  console.log(`substrate: ${testPathScope(dir.design).join(", ")}`);

  /* ---- first: the acceptance facts ------------------------------------ */

  console.log(heading("obligations"));
  const facts = await runObligations({
    artifacts: dir.artifacts,
    vcs: dir.vcs,
    journal: dir.journal,
    defs: todoObligationsDefs({ onUsage: report.onUsage }),
    roadmapId: request,
    design: dir.design,
    observe: report.observerFor("distill"),
    runtime: dir.runtime,
  });

  console.log(`trace:   ${renderTrace(facts.trace)}`);
  if (facts.kind === "suspended") {
    console.log(`parked:  ${facts.reason}`);
    console.log(renderDeliverTrail(facts.trail));
    console.log("\nNothing was persisted, so nothing downstream changed. Fix the roadmap and re-run.");
    dir.close();
    return;
  }
  if (facts.terminal.kind !== "accepted") {
    console.log("terminal: rejected");
    dir.close();
    return;
  }
  for (const step of facts.terminal.state.roadmap.steps) {
    const value = facts.terminal.state.values.find((v) => v.observation === step.observation);
    console.log(`\n${step.id}  ${step.observation}`);
    console.log(`  oracle:   ${value?.oracle ?? "(none)"}`);
    console.log(`  supports: ${value?.supports.join(", ") || "(none)"}`);
    for (const obligation of value?.acceptance ?? []) {
      console.log(`  ${obligation.id}: ${obligation.stimulus} -> ${obligation.expected}`);
    }
  }

  /* ---- second: the oracle, per value, measured ------------------------- */

  console.log(heading("oracles"));
  const verdicts = new Map<string, RecordedVerdict>();
  const outcomes = new Map<string, RunOutcome<OracleState>>();
  const { scheduler, rows } = openOracles({
    artifacts: dir.artifacts,
    vcs: dir.vcs,
    journal: dir.journal,
    defs: todoOracleDefs({ onUsage: report.onUsage }),
    roadmapId: request,
    design: dir.design,
    concurrency: 1,
    observe: report.observerFor,
    onRun: (rowId, outcome, verdict) => {
      verdicts.set(rowId, verdict);
      outcomes.set(rowId, outcome);
    },
    runtime: dir.runtime,
  });

  const statuses = await scheduler.run();

  for (const row of rows) {
    const outcome = outcomes.get(row.id);
    console.log(`\n${row.id}  ${statuses.get(row.id) ?? "pending"}  verdict: ${verdicts.get(row.id) ?? "(never ran)"}`);
    console.log(`  ${row.observation}`);
    if (outcome === undefined) {
      console.log("  (never ran: a dependency's oracle is not red)");
      continue;
    }
    console.log(`  trace: ${renderTrace(outcome.trace)}`);
    if (outcome.kind === "suspended") {
      console.log(`  parked: ${outcome.reason}`);
      console.log(renderDeliverTrail(outcome.trail));
    }
  }

  const red = rows.filter((row) => verdicts.get(row.id) === "red");
  console.log(heading("summary"));
  console.log(`${red.length} of ${rows.length} oracles measured red.`);
  console.log(
    red.length === rows.length
      ? `\nnext: bun run todo:deliver ${name}`
      : "\nA value whose oracle is not red cannot be delivered. Read the trail above.",
  );
  console.log(`\nreport:  ${shortPath(join(dir.path, "report.jsonl"))} (${report.read().length} leaf calls)`);
  dir.close();
};

await main();
