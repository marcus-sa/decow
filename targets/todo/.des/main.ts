/**
 * `bun targets/todo/.des/main.ts [run-name]` — the todo target, served.
 *
 *   bun targets/todo/.des/main.ts              # the run directory `first`
 *   ANTHROPIC_API_KEY=... bun targets/todo/.des/main.ts second
 *
 * This replaced six commands. They were six processes over one run directory,
 * each one holding nothing and reading everything back out of five files,
 * because a suspension had to survive the exit of the process that produced
 * it. A server is one process that stays up, so a suspension is answered where
 * it is read — in the UI, from the closed enum the node itself declares — and
 * the run continues without anybody quoting a run id back at a shell.
 *
 * WHAT IT SERVES. Four graphs and two pipelines (`./registrations.ts`) and the
 * application that draws them. `serve` mounts `@des/ui`'s built request
 * handler, so the server functions the UI calls run in THIS process, over
 * THESE registrations. One origin, one port, one process.
 *
 * NO KEY IS NEEDED TO START IT, and that is deliberate rather than convenient.
 * The graphs, the projections, the artifact rows and the event stream are all
 * readable without one; what needs a key is a LEAF, and the binding refuses
 * there, by name, on the attempt. The refusal lands in the run's own trail
 * where a person reads it, and the server stays up — which is the difference
 * between a tool that tells you what is missing and one that exits.
 *
 * THE RUN DIRECTORY is still a copy: `targets/todo` is a template and is never
 * mutated. `runs/<name>/` holds the copied project and the five stores, so two
 * runs of this server against two names cannot see each other's writes.
 *
 * THE REPORT is still written, one JSON line per leaf call, to
 * `runs/<name>/report.jsonl`. Every line carries `concurrent: true`: a server
 * does not serialise its runs, so the DECISION columns are exact and the token
 * columns cannot be attributed to a leaf. That is the honest thing to record
 * rather than numbers nobody can stand behind.
 */

import { join } from "node:path";
import { serve } from "@des/server";
import { describeModels } from "./models.ts";
import { openReport } from "./report.ts";
import { todoRegistrations, ROADMAP_ID } from "./registrations.ts";
import { createRunDir, openRunDir, RUNS, shortPath } from "./run-dir.ts";
import { existsSync } from "node:fs";

const main = async (): Promise<void> => {
  const name = process.argv[2] ?? "first";
  const port = Number(process.env.PORT ?? 3000);

  // A run directory is a fresh checkout, created once and opened thereafter.
  // A restart of this server against the same name continues where it left
  // off, because every store in it is a file.
  if (!existsSync(join(RUNS, name))) createRunDir(name);
  const dir = await openRunDir(name);

  const report = openReport({
    path: join(dir.path, "report.jsonl"),
    run: name,
    concurrent: true,
  });

  const { workflows, pipelines } = todoRegistrations(dir, report);

  const server = await serve({
    port,
    workflows,
    pipelines,
    artifacts: dir.artifacts,
  });

  console.log(describeModels());
  console.log(`\nrun:     ${shortPath(dir.path)}`);
  console.log(`project: ${shortPath(dir.project)}`);
  console.log(`roadmap: ${ROADMAP_ID}`);
  console.log(`design:  ${dir.design.length} chars, including the symbol inventory`);
  console.log(`report:  ${shortPath(join(dir.path, "report.jsonl"))}`);
  console.log(
    process.env.ANTHROPIC_API_KEY
      ? "\nANTHROPIC_API_KEY is set: a leaf will call a model."
      : "\nANTHROPIC_API_KEY is NOT set. Everything is readable; a leaf will refuse by name.",
  );
  console.log(`\n  ${server.url}\n`);

  const stop = async (): Promise<void> => {
    await server.stop();
    dir.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
};

await main();
