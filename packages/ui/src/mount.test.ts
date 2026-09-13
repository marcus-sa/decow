/**
 * The application, mounted by `serve` in one process.
 *
 * Everything else about the UI is tested where it can be tested without a
 * browser: the server functions' bodies in `@des/server`, the layout's
 * arithmetic beside it, and the whole of what a person actually sees by
 * Playwright (`../e2e/`). What is left for this file is the claim that makes
 * it one process rather than two — that `serve` renders the app's own routes,
 * serves its own assets, and answers the one endpoint that is not a server
 * function, over the registrations the same call was given.
 *
 * It needs the build and skips itself without one, because a handler is a
 * built artifact. `bun run ui:build` is what makes it run.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { memoryEffects } from "@des/core/effects";
import { memoryJournal } from "@des/core/journal";
import type { Workflow } from "@des/core/workflow";
import { registration, serve, type Server, type ServerEvent } from "@des/server";
import { z } from "zod";
import { isBuilt, uiHandler } from "./handler.ts";

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

const withUi = async () => {
  const effects = memoryEffects();
  const server = await serve({
    port: 0,
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

describe("the application, served", () => {
  test.skipIf(!isBuilt())("a route is rendered on the server, from the registrations", async () => {
    const server = await withUi();
    const response = await fetch(`${server.url}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");

    // Server-RENDERED, not a shell: the registration's own id and title are in
    // the document, which means the loader ran here, over this registry, before
    // any client bundle existed.
    const html = await response.text();
    expect(html).toContain("trivial");
    expect(html).toContain("One node and a terminal");
    expect(html).toContain("<script");
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

  test.skipIf(!isBuilt())("the event stream is a server route over this server's own bus", async () => {
    // The one endpoint that is not a server function, because a server
    // function is one request and one response.
    const server = await withUi();
    const stream = await fetch(`${server.url}/api/events`);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const reader = stream.body?.getReader();
    if (reader === undefined) throw new Error("the event stream has no body");
    const decoder = new TextDecoder();

    server.registry.runner.start("trivial", { subject: "x" });

    const seen: ServerEvent[] = [];
    const deadline = Date.now() + 10_000;
    while (!seen.some((e) => e.type === "terminal") && Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of decoder.decode(value, { stream: true }).split("\n\n")) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data !== undefined) seen.push(JSON.parse(data.slice(6)) as ServerEvent);
      }
    }
    await reader.cancel();

    expect(seen.map((e) => e.type)).toContain("run-started");
    expect(seen.map((e) => e.type)).toContain("terminal");
  });

  test("an unbuilt UI says so rather than 404ing at a person", async () => {
    const handle = await uiHandler({ serverEntry: "/nowhere-at-all/server.js" });
    const response = await handle(new Request("http://localhost/"));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("bun run ui:build");
  });

  test.skipIf(!isBuilt())("a path that names no asset is the app's, not the filesystem's", async () => {
    // The static half answers only for files that are actually under the
    // client directory; everything else is a route, and the app decides what
    // to do with it. A path that would escape the directory is refused before
    // either — unreachable through a URL, which normalises `..` away, and kept
    // because the next caller may not be a URL.
    const server = await withUi();
    const response = await fetch(`${server.url}/package.json`);
    expect(response.status).not.toBe(200);
    expect(response.headers.get("content-type")).not.toContain("application/json");
  });
});
