/**
 * The two roadmaps the e2e server is seeded with, and why there are two.
 *
 * One of them is the DELIVERY roadmap: the two todo values, pre-baked through
 * ROADMAP, DISTILL and the oracle measurement before the browser ever opens,
 * because the delivery pipeline is what the last test drives and it cannot
 * drive steps whose oracle has not been measured red.
 *
 * The other is the ROADMAP fixture the browser authors for itself, and it is
 * the committed known-good one — `examples/nwave/roadmap/fixture.ts`'s
 * `KNOWN_GOOD`, which is three steps with one declared dependency and one
 * deliberate overlap, so the run comes back `edges-added` and parks at
 * `human-review` with three answers to choose from.
 *
 * Both are named by their REQUEST, because that is the id a roadmap's row is
 * written under, and it is what the pipeline tests pick from the roadmap list
 * the page offers.
 *
 * Its step ids are RE-NUMBERED, and that is not cosmetic. `roadmap_steps` is
 * keyed by step id and `persist` claims version 0, so a second roadmap sharing
 * an id with the first would come back `conflict` and park at `human` instead
 * — which is a real behaviour of the graph and the wrong one to be testing
 * here.
 */

import { KNOWN_GOOD, REQUEST as KNOWN_GOOD_REQUEST } from "../../../../examples/nwave/roadmap/fixture.ts";
import type { Roadmap } from "../../../../examples/nwave/roadmap/schema.ts";

/** What a person types into the roadmap form, and what the journal is keyed on. */
export const BROWSER_REQUEST = KNOWN_GOOD_REQUEST;

/**
 * The request the pre-baked delivery roadmap is authored for, and therefore
 * the id its `roadmaps` row is written under: `persist` keys the row by the
 * request, as nWave keys a handover by one.
 */
export const DELIVERY_REQUEST =
  "Implement the stubbed behaviours `complete` and `remove` in src/todo.ts so the pending " +
  "acceptance tests in test/todo.test.ts pass.";

/** `01-0n` becomes `02-0n`, in the ids and in every dependency that names one. */
const renumber = (id: string): string => id.replace(/^01-/, "02-");

/** The known-good roadmap, out of the way of the delivery roadmap's steps. */
export const BROWSER_ROADMAP: Roadmap = {
  ...KNOWN_GOOD,
  steps: KNOWN_GOOD.steps.map((step) => ({
    ...step,
    id: renumber(step.id),
    dependencies: step.dependencies.map(renumber),
  })),
};
