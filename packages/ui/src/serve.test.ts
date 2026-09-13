/**
 * The UI, mounted in the same process as the API it reads.
 *
 * What is asserted is the claim that makes it one process rather than two: a
 * `GET /` and a `GET /runs/<id>` come back as the app's own shell from the
 * SERVER, on the same origin as `/api`, so nothing in the client has an origin
 * to be configured with.
 *
 * The graph's nodes are asserted on the API response rather than in the
 * document, because the app is a SPA: the shell is a shell, and what draws the
 * nodes is the client bundle it loads. Proving a browser rendered them is a
 * browser's job, and nothing here pretends otherwise.
 *
 * The three tests that need the build skip themselves without one, and the
 * build is not committed. `bun run ui:build` is what makes them run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { memoryEffects } from "@des/core/effects";
import { memoryJournal } from "@des/core/journal";
import type { Workflow } from "@des/core/workflow";
import { registration, serve, type Server } from "@des/server";
import { z } from "zod";
import { isBuilt, ui } from "./serve.ts";

let open: Server | undefined;
afterEach(async () => {
  await open?.stop();
  open = undefined;
});

type State = { subject: string };

/** One node, because what is under test is the mount rather than a graph. */
const trivial: Workflow<State> = {
  start: "accept",
  nodes: { accept: { type: "terminal", done: (s) => ({ kind: "accepted", state: s }) } },
};

const withUi = async (dir?: string) => {
  const effects = memoryEffects();
  const server = await serve({
    port: 0,
    fallback: ui(dir === undefined ? {} : { dir }),
    workflows: [
      registration<State, State>({
        id: "trivial",
        title: "One node and a terminal",
        input: z.object({ subject: z.string() }),
        journal: memoryJournal(),
        graph: () => trivial,
        seed: (input) => input,
        executor: () => effects.execute,
      }),
    ],
  });
  open = server;
  return server;
};

describe("the UI, mounted beside the API", () => {
  test.skipIf(!isBuilt())("every client route is served the app's own shell", async () => {
    const server = await withUi();

    for (const path of ["/", "/workflows/trivial", "/runs/run-1", "/pipelines/anything"]) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      // The shell loads the client, and the client is what draws the graph.
      expect(await response.text()).toContain("<script");
    }
  });

  test.skipIf(!isBuilt())("the hashed assets are served from the same origin", async () => {
    const server = await withUi();
    const html = await (await fetch(`${server.url}/`)).text();
    const asset = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)?.[0];
    expect(asset).toBeDefined();

    const response = await fetch(`${server.url}${asset}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  test.skipIf(!isBuilt())("the API is still the API, and its graph is the authored one", async () => {
    const server = await withUi();
    const listed = (await (await fetch(`${server.url}/api/workflows`)).json()) as {
      id: string;
      graph: { nodes: { id: string; kind: string }[] };
    }[];
    expect(listed[0]?.id).toBe("trivial");
    expect(listed[0]?.graph.nodes.map((n) => n.id)).toEqual(["accept"]);
  });

  test("an unbuilt UI says so rather than 404ing at a person", async () => {
    const server = await withUi("/nowhere-at-all");
    const response = await fetch(`${server.url}/`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("bun run build");

    // And the API is unaffected: the UI missing is not the server missing.
    expect((await fetch(`${server.url}/api/workflows`)).status).toBe(200);
  });
});
