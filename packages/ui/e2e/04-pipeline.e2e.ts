/**
 * The delivery pipeline, driven from the browser.
 *
 * The claim under test is the one this cut is for: a pipeline row is an
 * ORDINARY RUN. The tree shows two rows whose oracles DISTILL already measured
 * red; pressing one button drives the frontier through the server's own
 * scheduler; each row becomes a run with a server id, and the row links to it;
 * and opening that link is the same run page every other run is drawn on,
 * with a trace through the step cycle's authored nodes.
 *
 * Nothing here is stubbed below the graph: each row's run writes a real
 * production body through the real write path, with a real `tsc`, a real
 * `biome check` and a real `bun test` at the gate. Only the leaves are journal
 * hits.
 */

import { expect, test } from "@playwright/test";
import { shot } from "./screenshot.ts";

const ROWS = ["01-01", "01-02"];

test("both rows reach accepted, and each one's link opens its own run", async ({ page }) => {
  await page.goto("/pipelines/delivery");

  // The tree is the rows the consumer declared, in declaration order, with the
  // dependency it declared.
  const rows = page.locator('[data-testid="rows"] li.row');
  await expect(rows).toHaveCount(2);
  for (const id of ROWS) {
    await expect(page.locator(`[data-row="${id}"]`)).toHaveCount(1);
  }
  await expect(page.locator('[data-row="01-02"]')).toContainText("after 01-01");

  // Nothing has run them yet, so the transition below is a transition.
  for (const id of ROWS) {
    await expect(page.locator(`[data-row="${id}"]`)).toHaveAttribute("data-status", "pending");
  }
  await expect(page.locator('[data-testid="rows"] a')).toHaveCount(0);

  await page.locator('[data-testid="run-pipeline"]').click();

  // Both rows run. B only becomes ready once A reads `accepted`, so this is
  // also the frontier holding.
  for (const id of ROWS) {
    await expect(page.locator(`[data-row="${id}"]`)).toHaveAttribute("data-status", "accepted", {
      timeout: 150_000,
    });
  }

  await page.screenshot({ path: shot("04-pipeline-accepted") });

  // Each row links to a run of its own, and that run is drawn like any other.
  for (const id of ROWS) {
    const link = page.locator(`[data-row="${id}"] a`);
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

    if (id === ROWS[0]) {
      await page.screenshot({ path: shot("04-row-run") });
    }
    await page.goBack();
    await page.waitForURL(/\/pipelines\/delivery/);
  }
});
