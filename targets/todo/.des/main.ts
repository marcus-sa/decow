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
 * THE DATABASE IS THE SOURCE OF TRUTH. Runs, the events they publish and what
 * every leaf call decided and cost are rows in `runs/<name>/runs.sqlite`, so a
 * restarted server shows every prior run, a delivered pipeline step stays
 * delivered, and a suspension one process produced is answerable by the next.
 * Token counts are attributed by `runStep` to the call that spent them, so
 * concurrency costs the numbers nothing.
 */

import { join } from "node:path";
import { serve } from "@des/server";
import { describeModels, todoModels } from "./models.ts";
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

  const { workflows, pipelines } = todoRegistrations(dir, { models: todoModels() });

  const server = await serve({
    port,
    workflows,
    pipelines,
    artifacts: dir.artifacts,
    store: dir.runs,
  });

  console.log(describeModels());
  console.log(`\nrun:     ${shortPath(dir.path)}`);
  console.log(`project: ${shortPath(dir.project)}`);
  console.log(`roadmap: ${ROADMAP_ID}`);
  console.log(`design:  ${dir.design.length} chars, including the symbol inventory`);
  console.log(`runs:    ${shortPath(join(dir.path, "runs.sqlite"))}`);
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
