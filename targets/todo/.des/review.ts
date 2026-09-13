/**
 * `bun run todo:review <run-name> <approve|revise|abandon> [notes]` — answer
 * the parked roadmap.
 *
 *   ANTHROPIC_API_KEY=... bun run todo:review first approve
 *   ANTHROPIC_API_KEY=... bun run todo:review first revise "01-02 is not a slice"
 *
 * This is a SECOND PROCESS resuming a run a first process parked. Nothing is
 * held between them: the run id is in `run.json`, the snapshot is in
 * `mastra.sqlite`, the graph is recompiled from source, and `resume` reattaches
 * by run id. That is the whole of the durable-snapshot claim, exercised.
 *
 * A key is still required, because `revise` re-drives `decompose` — the person
 * answering from INSIDE the author loop is what makes their notes an input to
 * the next proposal rather than a comment on a finished one.
 *
 * On `approve` the run leaves the loop, `persist` writes one `roadmaps` row and
 * one `roadmap_steps` row per step through `upsert-artifact`, and the terminal
 * is `accepted`. Those rows are what `todo:deliver` reads.
 */

import { join } from "node:path";
import { resume } from "@des/core/workflow";
import { vcsExecutor } from "@des/core/vcs/executor";
import {
  REVIEW_DECISIONS,
  REVIEW_REASONS,
  ROADMAP_STEPS_TABLE,
  ROADMAP_TABLE,
  roadmapGraph,
  type ReviewDecision,
  type State,
} from "../../../examples/nwave/roadmap/graph.ts";
import { todoRoadmapDefs } from "./models.ts";
import { heading, renderReviewTrail, renderTrace } from "./render.ts";
import { openReport } from "./report.ts";
import { openRunDir, requireCredential, requireRunName, shortPath } from "./run-dir.ts";

const USAGE = "usage: bun run todo:review <run-name> <approve|revise|abandon> [notes]";

const isReviewDecision = (value: string): value is ReviewDecision =>
  (REVIEW_DECISIONS as readonly string[]).includes(value);

const main = async (): Promise<void> => {
  requireCredential("todo:review");
  const argv = process.argv.slice(2);
  const name = requireRunName("todo:review", argv);
  const decision = argv[1];
  const notes = argv.slice(2).join(" ");

  if (decision === undefined || !isReviewDecision(decision)) {
    console.error(`${USAGE}\n  got: ${decision ?? "(nothing)"}`);
    process.exit(1);
  }

  const dir = await openRunDir(name);
  const { roadmapRunId, roadmapReason } = dir.manifest;
  if (roadmapRunId === undefined) {
    console.error(`todo:review: run "${name}" has no parked roadmap. Run todo:roadmap ${name} first.`);
    process.exit(1);
  }

  // The two suspend nodes take different answers. `human-review` is inside the
  // author loop and takes all three; `human` is outside it and takes only
  // `abandon`, because every route into it is a block no closed enum could
  // clear. Refusing here names why, rather than letting a zod parse fail
  // several frames down.
  const parkedAtReview = (REVIEW_REASONS as readonly string[]).includes(roadmapReason ?? "");
  if (!parkedAtReview && decision !== "abandon") {
    console.error(
      `todo:review: this run is parked on a BLOCK (${roadmapReason}), not on a review.\n` +
        "The only answer a blocked run takes is `abandon`: a block needs the roadmap changed, " +
        "which is a new run rather than an answer.",
    );
    process.exit(1);
  }

  const report = openReport({ path: join(dir.path, "report.jsonl"), run: name });
  const defs = todoRoadmapDefs({ onUsage: report.onUsage });
  const executor = vcsExecutor({
    vcs: dir.vcs,
    session: `roadmap:${name}`,
    intent: { taskId: dir.manifest.request, description: `review: ${decision}` },
    artifacts: dir.artifacts,
  });

  console.log(`run:     ${shortPath(dir.path)}`);
  console.log(`parked:  ${roadmapReason} (run ${roadmapRunId})`);
  console.log(`answer:  ${decision}${notes.length === 0 ? "" : ` — ${notes}`}`);

  const outcome = await resume<State>(
    roadmapGraph(dir.journal, defs, report.observerFor("roadmap")),
    roadmapRunId,
    { decision, ...(notes.length === 0 ? {} : { notes }) },
    executor,
    dir.runtime,
  );

  console.log(heading("outcome"));
  if (outcome.kind === "suspended") {
    // `revise` re-enters the loop and parks again, under a new reason or the
    // same one. The manifest tracks the latest parking, so a third command
    // answers the run as it now stands.
    console.log(`parked:  ${outcome.reason}`);
    console.log(`run id:  ${outcome.runId}`);
    dir.save({ roadmapRunId: outcome.runId, roadmapReason: outcome.reason });
    console.log(heading("the roadmap as it now stands"));
    console.log(renderReviewTrail(outcome.trail));
  } else if (outcome.terminal.kind === "accepted") {
    const roadmap = outcome.terminal.state.roadmap;
    dir.save({ request: roadmap.request });
    console.log("terminal: accepted — the roadmap is rows now");
    const rows = dir.artifacts.list(ROADMAP_STEPS_TABLE);
    const head = dir.artifacts.read(ROADMAP_TABLE, roadmap.request);
    console.log(`\n${ROADMAP_TABLE}/${roadmap.request}`);
    console.log(`  version ${head?.version ?? "?"}, ${rows.length} step row(s)`);
    for (const row of rows) console.log(`  ${ROADMAP_STEPS_TABLE}/${row.id}  v${row.version}`);
    console.log(heading("next"));
    console.log(`  bun run todo:deliver ${name}`);
  } else {
    console.log("terminal: rejected");
    console.log(renderReviewTrail(outcome.terminal.trail));
  }

  console.log(`\ntrace:   ${renderTrace(outcome.trace)}`);
  console.log(`report:  ${shortPath(join(dir.path, "report.jsonl"))} (${report.read().length} leaf calls)`);
  dir.close();
};

await main();
