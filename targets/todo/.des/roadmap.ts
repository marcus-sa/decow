/**
 * `bun run todo:roadmap <run-name>` — author a roadmap for the todo target.
 *
 *   ANTHROPIC_API_KEY=... bun run todo:roadmap first
 *
 * Copies `targets/todo` to `runs/<name>/todo`, tracks it in a fresh VCS, and
 * runs the roadmap authoring workflow against the copy's `design.md` plus the
 * VCS symbol inventory. `decompose` is Opus; `validate-slices` and its
 * validator are Haiku; `validate-shape` and `measure-disjointness` are pure
 * functions with no model in them at all.
 *
 * The run PARKS at `human-review` and this command exits. That is the whole
 * point of the durable snapshot: the person who reads the roadmap is not this
 * process, so the parked run is written to `runs/<name>/mastra.sqlite` and
 * `bun run todo:review <name> approve` picks it up in a second process.
 *
 * Nothing is persisted to the artifact store here. `persist` sits AFTER the
 * review in the graph, so a roadmap nobody approved leaves no rows behind.
 */

import { join } from "node:path";
import { run, type RunOutcome } from "../../../src/core/workflow.ts";
import { vcsExecutor } from "../../../src/vcs/executor.ts";
import { roadmapGraph, seed, type State } from "../../../src/examples/nwave/roadmap/graph.ts";
import { describeModels, todoRoadmapDefs } from "./models.ts";
import { heading, renderReviewTrail, renderTrace } from "./render.ts";
import { openReport } from "./report.ts";
import { REQUEST } from "./request.ts";
import { createRunDir, openRunDir, requireCredential, requireRunName, shortPath } from "./run-dir.ts";

const main = async (): Promise<void> => {
  requireCredential("todo:roadmap");
  const name = requireRunName("todo:roadmap", process.argv.slice(2));

  const path = createRunDir(name);
  const dir = await openRunDir(name);
  dir.save({ name, request: REQUEST });

  const report = openReport({ path: join(path, "report.jsonl"), run: name });
  const defs = todoRoadmapDefs({ onUsage: report.onUsage });

  console.log(describeModels());
  console.log(`\nrun:     ${shortPath(path)}`);
  console.log(`project: ${shortPath(dir.project)}`);
  console.log(`request: ${REQUEST}`);
  console.log(`design:  ${dir.design.length} chars, including the symbol inventory`);

  const executor = vcsExecutor({
    vcs: dir.vcs,
    session: `roadmap:${name}`,
    intent: { taskId: REQUEST, description: "author the roadmap" },
    artifacts: dir.artifacts,
  });
  // `vcsExecutor` rather than `memoryEffects`: an exhausted leaf's trail is
  // provenance and belongs in the event log under this task's id, and the
  // rows `persist` writes belong in the artifact store. Both are real files
  // in the run directory, so the second command sees what the first wrote.

  const outcome: RunOutcome<State> = await run<State>(
    roadmapGraph(dir.journal, defs, report.observerFor("roadmap")),
    seed(REQUEST, dir.design),
    executor,
    dir.runtime,
  );

  console.log(heading("outcome"));
  if (outcome.kind === "suspended") {
    console.log(`parked:  ${outcome.reason}`);
    console.log(`run id:  ${outcome.runId}`);
    dir.save({ roadmapRunId: outcome.runId, roadmapReason: outcome.reason });
    console.log(heading("the proposed roadmap"));
    console.log(renderReviewTrail(outcome.trail));
    console.log(heading("next"));
    console.log(`  bun run todo:review ${name} approve`);
    console.log(`  bun run todo:review ${name} revise "what to change"`);
    console.log(`  bun run todo:review ${name} abandon`);
  } else {
    // A terminal here means the run never reached a person: every block route
    // parks, so this is `rejected` after an abandon, which cannot happen on a
    // first run. Printed rather than assumed away.
    console.log(`terminal: ${outcome.terminal.kind}`);
    console.log(renderReviewTrail(outcome.terminal.kind === "rejected" ? outcome.terminal.trail : []));
  }

  console.log(`\ntrace:   ${renderTrace(outcome.trace)}`);
  console.log(`report:  ${shortPath(join(path, "report.jsonl"))} (${report.read().length} leaf calls)`);
  dir.close();
};

await main();
