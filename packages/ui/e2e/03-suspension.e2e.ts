/**
 * A run, started from the form, parked for a person, and answered.
 *
 * This is the loop the whole entrypoint exists for. The graph asks for ONE
 * value from a closed set and stops until it gets one; the buttons on the
 * dialog ARE that set, read off the node's own `resumeSchema` by the server,
 * so a person cannot answer with something the node would refuse. The answer
 * continues the SAME run — the trace spans both halves — and the run ends
 * `accepted` with the rows persisted.
 *
 * The video is recorded for this one, because it is the one that is worth
 * watching rather than reading.
 */

import { expect, test } from "@playwright/test";
import { shot } from "./screenshot.ts";

test.use({ video: "on" });

/** What the form is filled with. The journal is seeded at this request. */
const REQUEST =
  "A reconciler declares how the loop wakes it, and the loop honours the declaration.";

test("a roadmap run parks at human-review, and approve carries it to accepted", async ({ page }) => {
  await page.goto("/workflows/roadmap");

  // Start it from the form the input schema rendered.
  await page.locator("form.form textarea").first().fill(REQUEST);
  await page.getByRole("button", { name: "Start" }).click();

  await page.waitForURL(/\/runs\//);

  // It parks, and the dialog says why.
  const dialog = page.locator('[data-testid="suspension"]');
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-testid="suspension-reason"]')).toHaveText("edges-added");

  // Exactly the three answers the node declares, and nothing else that posts
  // one. `later` beside them dismisses the dialog; it is not an answer.
  const answers = page.locator("[data-answer]");
  await expect(answers).toHaveCount(3);
  await expect(answers).toHaveText(["approve", "revise", "abandon"]);

  await page.screenshot({ path: shot("03-suspension-dialog") });

  await page.locator('[data-answer="approve"]').click();

  // The same run continues to a terminal.
  await expect(page.locator('[data-testid="run-status"]')).toHaveText("accepted", {
    timeout: 60_000,
  });

  // And the trace carries both halves: the person is in the middle of it.
  const trace = page.locator('[data-testid="trace"]');
  await expect(trace).toContainText("human-review");
  await expect(trace).toContainText("persist");
  await expect(trace).toContainText("accept");

  await page.screenshot({ path: shot("03-run-accepted") });
});
