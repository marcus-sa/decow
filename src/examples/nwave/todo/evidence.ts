/**
 * The RED evidence, produced rather than narrated.
 *
 * `run-tests.red` is a leaf and its question is a judgement — "is this
 * acceptance test vacuous?", not "did it pass" — so it reads runner output
 * rather than an effect result. The README lists the *input* to that judgement
 * as not built: the pipeline hands the leaf a string the caller supplied.
 *
 * A supplied string is where a real run gets dishonest. The todo target's
 * pending tests are `test.skip`, so running the project as it stands reports
 * them SKIPPED, and a classifier handed that output would answer
 * `already-green` and park the run for a person — which would be a correct
 * answer to the wrong question. Handing it a made-up failure would be worse.
 *
 * So the evidence is measured: copy the run's project to a scratch directory,
 * strip every pending marker there, run the suite, and keep what it prints.
 * That is the output the acceptance tests actually produce against the stub
 * bodies, byte for byte, and it is produced BEFORE the run so it can be handed
 * to a leaf that reads it. The scratch copy is thrown away; the run's own
 * project is not touched, and the real activation still happens inside the
 * graph through the write path.
 *
 * This is the honest half of the not-built item, not a replacement for it. The
 * built version makes the RED run an effect whose typed result the leaf reads,
 * which needs a graph change; this needs none.
 */

import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PENDING_MARKERS } from "../deliver/oracle.ts";

/** `test.skip(` -> `test(`, over a whole file rather than one symbol. */
const activateAll = (source: string): string =>
  PENDING_MARKERS.reduce(
    (text, marker) => text.split(marker).join(`${marker.split(".")[0] as string}(`),
    source,
  );

/** Every file under `dir`, recursively, skipping `node_modules`. */
const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
};

export type Evidence = {
  /** Verbatim stdout+stderr of the scratch run. What the leaf classifies. */
  output: string;
  /** The scratch run's exit code. Non-zero is the RED this is here to show. */
  exitCode: number;
};

/**
 * Run the target's suite with every pending marker stripped, in a throwaway
 * copy. Returns the runner's own output, verbatim.
 */
export const redEvidence = (project: string, suite = "test"): Evidence => {
  const scratch = mkdtempSync(join(tmpdir(), "dw-red-"));
  try {
    cpSync(project, scratch, { recursive: true, dereference: false });
    for (const path of walk(join(scratch, suite))) {
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
      const source = readFileSync(path, "utf8");
      const activated = activateAll(source);
      if (activated !== source) writeFileSync(path, activated, "utf8");
    }
    const run = Bun.spawnSync(["bun", "test", suite], { cwd: scratch });
    return {
      output: `${run.stdout.toString()}${run.stderr.toString()}`.trim(),
      exitCode: run.exitCode ?? 1,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
