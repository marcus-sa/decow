/**
 * The browser tests. One server, one worker, no model.
 *
 * `bun run e2e` from the repository root. The server under test is the real
 * `serve()` over the four example graphs and the two pipelines, seeded so that
 * every leaf is a journal hit — `e2e/fixture/boot.ts` — so a test that reaches
 * a model fails rather than spending one.
 *
 * ONE WORKER, deliberately. The tests share one server, one artifact store and
 * one checkout on disk, and two of them drive state the others read. They are
 * ordered by filename for the same reason.
 *
 * The viewport is fixed, because the screenshots are committed and reviewed:
 * a screenshot whose size depends on the machine that took it is a diff on
 * every machine.
 */

import { createServer } from "node:net";
import { defineConfig } from "@playwright/test";

/** A port the OS says is free right now. */
const freePort = async (): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("no free port")) : resolve(port)));
    });
  });

/**
 * One port, picked once.
 *
 * The config is evaluated in the runner AND in each worker process, so a port
 * chosen per evaluation is a different port per evaluation — the tests would
 * dial one the server is not on. It is stashed in the environment the workers
 * inherit, which is also how the server is told which one to bind.
 */
const PORT = Number(process.env["DES_E2E_PORT"] ?? (await freePort()));
process.env["DES_E2E_PORT"] = String(PORT);

export default defineConfig({
  testDir: "./e2e",
  // `.e2e.ts` rather than `.spec.ts`: `bun test` claims `*.spec.*`, and these
  // are not bun tests. One suffix keeps the two runners out of each other's
  // files.
  testMatch: /.*\.e2e\.ts$/,
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 960 },
    video: "off",
    trace: "off",
  },
  webServer: {
    command: "bun run ../../packages/ui/e2e/fixture/boot.ts",
    url: `http://127.0.0.1:${PORT}/`,
    env: { DES_E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  },
});
