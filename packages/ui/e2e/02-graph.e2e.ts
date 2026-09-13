/**
 * The authored graph, drawn — asserted on what a browser rendered.
 *
 * Every claim the README makes about the drawing is here: that the ids on the
 * canvas are the ones in the source rather than the compiler's; that a bounded
 * loop is a BOX with its bound written on it and the loop node OUTSIDE that
 * box, because the loop decides whether there is another iteration rather than
 * being part of one; and that a suspension is drawn as one.
 *
 * JointJS puts each cell's id on the group it renders, so `[model-id=...]` is
 * the node the author wrote.
 */

import { expect, test, type Locator } from "@playwright/test";
import { shot } from "./screenshot.ts";

/** Every node id `roadmap`'s author wrote, as the projection reports them. */
const AUTHORED = [
  "author",
  "decompose",
  "decompose.route",
  "validate-shape",
  "shape.route",
  "validate-slices",
  "slices.route",
  "measure-disjointness",
  "disjointness.route",
  "human-review",
  "review.route",
  "author.verdict",
  "persist",
  "persist.verdict",
  "human",
  "human.route",
  "accept",
  "reject",
];

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("the element is not rendered");
  return box;
};

test("the roadmap graph is drawn under the ids its author wrote", async ({ page }) => {
  await page.goto("/workflows/roadmap");
  await page.waitForSelector('[data-testid="graph"][data-drawn="true"]');

  // Every authored node is a rendered element.
  for (const id of AUTHORED) {
    await expect(page.locator(`[model-id="${id}"]`)).toHaveCount(1);
  }

  // And nothing the compiler mints reaches the canvas. Its ids carry `>` or
  // `#`, or start `wf:`; these are the author's.
  const rendered = await page
    .locator("[model-id]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("model-id") ?? ""));
  const nodes = rendered.filter((id) => AUTHORED.includes(id) || id.startsWith("cluster:"));
  expect(nodes.filter((id) => /[>#]|^wf:/.test(id))).toEqual([]);

  await page.screenshot({ path: shot("02-roadmap-graph") });
});

test("the author loop is a box with its bound on it, and the loop node is outside", async ({
  page,
}) => {
  await page.goto("/workflows/roadmap");
  await page.waitForSelector('[data-testid="graph"][data-drawn="true"]');

  const cluster = page.locator('[model-id="cluster:author"]');
  await expect(cluster).toHaveCount(1);
  await expect(cluster.locator("text")).toContainText("author · body, max 2");

  const box = await boxOf(cluster);
  const loop = await boxOf(page.locator('[model-id="author"]'));

  // The loop node is NOT inside its own body's box.
  const inside = loop.y >= box.y && loop.y + loop.height <= box.y + box.height;
  expect(inside).toBe(false);

  // Its body is. `decompose` is the body node; every node that takes part in
  // an iteration is laid out inside the box drawn round them.
  for (const id of ["decompose", "validate-shape", "validate-slices", "human-review"]) {
    const node = await boxOf(page.locator(`[model-id="${id}"]`));
    expect(node.y).toBeGreaterThanOrEqual(box.y);
    expect(node.y + node.height).toBeLessThanOrEqual(box.y + box.height);
  }
});

test("both places a person is asked are drawn as suspends", async ({ page }) => {
  await page.goto("/workflows/roadmap");
  await page.waitForSelector('[data-testid="graph"][data-drawn="true"]');

  for (const id of ["human", "human-review"]) {
    const node = page.locator(`[model-id="${id}"]`);
    // The label says what kind of node it is, in the same word the projection
    // uses; the stroke is the one this drawing gives a suspension.
    await expect(node.locator("text")).toContainText("suspend");
    await expect(node.locator("rect")).toHaveAttribute("stroke", "#d19a3d");
  }

  // And the two of them are the only suspensions in this graph.
  const suspends = await page
    .locator('[model-id] rect[stroke="#d19a3d"]')
    .evaluateAll((els) => els.map((e) => e.closest("[model-id]")?.getAttribute("model-id") ?? ""));
  expect(suspends.sort()).toEqual(["human", "human-review"]);
});
