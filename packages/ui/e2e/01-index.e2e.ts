/**
 * What a person sees first: every graph this target can run, and every
 * composition over them.
 *
 * Server-rendered — the assertion runs before any hydration wait — because the
 * loader ran in the process that holds the registrations.
 */

import { expect, test } from "@playwright/test";
import { shot } from "./screenshot.ts";

const WORKFLOWS = ["roadmap", "obligations", "oracle", "deliver"];
const PIPELINES = ["oracles", "delivery"];

test("the index lists four graphs and two pipelines", async ({ page }) => {
  await page.goto("/");

  const workflows = page.locator('[data-testid="workflows"] li.card strong');
  await expect(workflows).toHaveText(WORKFLOWS);

  const pipelines = page.locator('[data-testid="pipelines"] li.card strong');
  await expect(pipelines).toHaveText(PIPELINES);

  // Each one links to its own page, by the id its author gave it.
  for (const id of WORKFLOWS) {
    await expect(page.locator(`a[href="/workflows/${id}"]`)).toHaveCount(1);
  }
  for (const id of PIPELINES) {
    await expect(page.locator(`a[href="/pipelines/${id}"]`)).toHaveCount(1);
  }

  await page.screenshot({ path: shot("01-index") });
});
