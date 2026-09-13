/**
 * The one file in `src/vcs/` allowed to read a clock or an RNG.
 *
 * Everything else in the module takes its clock and its id generator as
 * constructor arguments, so a lease TTL can be tested without waiting and an
 * event log can be compared byte for byte across runs. That property is only
 * worth anything if there is exactly one place the real implementations live,
 * and this is it: `src/harness/no-nondeterminism.test.ts` scans every other
 * file under `src/vcs/` and fails the build on a clock read or an RNG call.
 */

import type { Clock, IdGen } from "./registry.ts";

export const systemClock: Clock = () => Date.now();

/**
 * Opaque ids, prefixed by what they name. The prefix is for a human reading an
 * event row; nothing parses it, and § 3.2 requires that nothing can, because
 * an id that carries meaning is an id something will eventually infer from.
 */
export const randomIds: IdGen = (prefix) => `${prefix}-${crypto.randomUUID()}`;
