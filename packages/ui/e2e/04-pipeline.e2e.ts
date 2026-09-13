/**
 * The delivery pipeline, driven from the browser.
 *
 * The claim under test is that a pipeline step is an ORDINARY RUN. A person
 * supplies WHICH roadmap the pipeline is driven over — through the pipeline's
 * own input form, whose one field is a closed list because the composition
 * declared where its options live; by now there are two roadmaps, and the one
 * the second test authored is not the one with the oracles — and the tree is
 * then that roadmap's two steps, whose oracles DISTILL already measured red;
 * pressing one button drives the frontier through the server's own scheduler;
 * each step becomes a run with a server id, and the step links to it; and
 * opening that link is the same run page every other run is drawn on, with a
 * trace through the step cycle's authored nodes.
 *
 * The field is selected by the id the FORM derives from the schema's field
 * name, not by anything about roadmaps: the page renders whatever fields the
 * registration's input declares and knows nothing about what they mean.
 *
 * Nothing here is stubbed below the graph: each step's run writes a real
 * production body through the real write path, with a real `tsc`, a real
 * `biome check` and a real `bun test` at the gate. Only the leaves are journal
 * hits.
 */

import { expect, test } from "@playwright/test";
import { DELIVERY_REQUEST } from "./fixture/roadmaps.ts";
import { shot } from "./screenshot.ts";

const STEPS = ["01-01", "01-02"];

test("both steps reach accepted, and each one's link opens its own run", async ({ page }) => {
  await page.goto("/pipelines/delivery");

  // Nothing is declared until an input is supplied: a composition whose steps
  // are derived has no steps until it is told what to derive them from.
  await expect(page.locator('[data-testid="steps"] li.row')).toHaveCount(0);
  await expect(page.locator('[data-testid="run-pipeline"]')).toBeDisabled();

  // The options are the ones the composition's own `choices` returned, so this
  // cannot name a roadmap nobody authored — and the pre-baked one is among
  // them. The test id is the schema's field name, which is the only thing the
  // page knows about this field.
  const choose = page.locator('[data-testid="field-roadmapId"]');
  await expect(choose.locator("option").filter({ hasText: DELIVERY_REQUEST })).toHaveCount(1);
  await choose.selectOption(DELIVERY_REQUEST);
  await page.getByRole("button", { name: "Show the steps" }).click();

  // The tree is the steps the consumer declared for THAT roadmap, in
  // declaration order, with the dependency it declared.
  const steps = page.locator('[data-testid="steps"] li.row');
  await expect(steps).toHaveCount(2);
  for (const id of STEPS) {
    await expect(page.locator(`[data-step="${id}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-step="01-02"]')).toContainText("after 01-01");

  // Nothing has run them yet, so the transition below is a transition.
  for (const id of STEPS) {
    await expect(page.locator(`[data-step="${id}"]`)).toHaveAttribute("data-status", "pending");
  }
  await expect(page.locator('[data-testid="steps"] a')).toHaveCount(0);

  await page.locator('[data-testid="run-pipeline"]').click();

  // Both steps run. B only becomes ready once A reads `accepted`, so this is
  // also the frontier holding.
  for (const id of STEPS) {
    await expect(page.locator(`[data-step="${id}"]`)).toHaveAttribute("data-status", "accepted", {
      timeout: 150_000,
    });
  }

  await page.screenshot({ path: shot("04-pipeline-accepted") });

  // Each step links to a run of its own, and that run is drawn like any other.
  for (const id of STEPS) {
    const link = page.locator(`[data-step="${id}"] a`);
    await expect(link).toHaveCount(1);
    const href = await link.getAttribute("href");
    expect(href).toMatch(/^\/runs\//);

    await link.click();
    await page.waitForURL(/\/runs\//);
    await expect(page.locator('[data-testid="run-status"]')).toHaveText("accepted");

    const trace = page.locator('[data-testid="trace"]');
    // The step cycle's own nodes, under the ids its author wrote: the write,
    // the gates it passed, and the terminal it reached.
    await expect(trace).toContainText("implement");
    await expect(trace).toContainText("gates");
    await expect(trace).toContainText("commit");
    await expect(trace).toContainText("accept");

    if (id === STEPS[0]) {
      await page.screenshot({ path: shot("04-step-run") });
    }
    await page.goBack();
    await page.waitForURL(/\/pipelines\/delivery/);
    // The supplied input is in the URL, so walking back lands on the same tree
    // rather than on the empty state.
    await expect(page.locator('[data-testid="steps"] li.row')).toHaveCount(2);
  }
});
