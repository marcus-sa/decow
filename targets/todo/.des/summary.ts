/**
 * `bun run todo:report <run-name>` — the run report, as a table.
 *
 *   bun run todo:report first
 *
 * Reads `runs/<name>/report.jsonl` and prints one row per leaf: how many model
 * calls it made, how many decisions those calls produced, how many of those
 * were accepted on the first attempt, how many exhausted, how many attempts a
 * validator or a mechanical check refused, and what it all cost in tokens.
 *
 * No key, no model, no network. It reads a file.
 *
 * The gap between `calls` and `decided` is the number worth reading: it is what
 * the validator and the mechanical checks cost, in inference, to keep the graph
 * honest. The design says the many-small-calls approach is cheaper AND more
 * legible and that the first should be measured before the second is used to
 * justify it. This is the measurement.
 */

import { join } from "node:path";
import { heading } from "./render.ts";
import { readReport, renderTable, summarize } from "./report.ts";
import { RUNS, requireRunName } from "./run-dir.ts";

const main = (): void => {
  const name = requireRunName("todo:report", process.argv.slice(2));
  const path = join(RUNS, name, "report.jsonl");
  const lines = readReport(path);

  console.log(`run:    ${name}`);
  console.log(`report: ${path}`);
  console.log(`lines:  ${lines.length}`);

  if (lines.length === 0) {
    console.log("\nNo leaf calls recorded. Either nothing has run, or every leaf was a journal hit.");
    return;
  }

  if (lines.some((l) => l.concurrent === true)) {
    console.log(
      "\nNOTE: some lines were written while more than one row could be in flight. " +
        "Their decision columns are exact; their token columns may be attributed to the wrong leaf.",
    );
  }

  console.log(heading("by leaf"));
  console.log(renderTable(summarize(lines)));

  const exhausted = lines.filter((l) => !l.accepted);
  if (exhausted.length > 0) {
    console.log(heading("refused attempts"));
    for (const line of exhausted) {
      const why =
        line.error !== undefined
          ? `provider error: ${line.error}`
          : line.mechanical.length > 0
            ? `mechanical: ${line.mechanical.map((v) => v.requirementId).join(", ")}`
            : line.violations.length > 0
              ? `validator: ${line.violations.map((v) => v.requirementId).join(", ")}`
              : `validator said ${line.verdict ?? "nothing"}`;
      console.log(`  ${line.row}  ${line.step}  attempt ${line.attempt}  ${why}`);
      for (const v of [...line.mechanical, ...line.violations]) {
        console.log(`      ${v.requirementId}: ${JSON.stringify(v.evidence)}`);
      }
    }
  }

  const missing = lines.filter((l) => l.workerTokens?.input === undefined).length;
  if (missing > 0) {
    console.log(
      `\nNOTE: ${missing} of ${lines.length} lines carry no worker token count. ` +
        "The provider layer reported a usage shape `readTokens` does not recognise, or none at all.",
    );
  }
};

main();
