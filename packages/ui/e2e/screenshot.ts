/**
 * Where a screenshot goes.
 *
 * Resolved against THIS file rather than the process's working directory,
 * which is the repository root when `bun run e2e` starts the runner: a
 * relative path would put the committed evidence somewhere nobody is looking.
 */

import { fileURLToPath } from "node:url";

export const shot = (name: string): string =>
  fileURLToPath(new URL(`./screenshots/${name}.png`, import.meta.url));
