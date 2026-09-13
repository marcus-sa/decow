/**
 * The test harness, as one entry point: the graph inspector, the reachable-path
 * walker with its effect-outcome axis, and the trace matchers.
 *
 * `stub-journal.ts` is deliberately NOT re-exported here and has a subpath of
 * its own. It is the thing that stands in for every model, so a consumer
 * naming it is saying something louder than "I am walking a graph", and the
 * import should say so too.
 */

export {
  cartesian,
  enumeratePaths,
  graphDefects,
  inspectGraph,
  loopBody,
  outEdges,
  scriptedExecutor,
  type Choose,
  type Edge,
  type EffectOutcome,
  type EffectOutcomeSpace,
  type GraphReport,
} from "./enumerate-paths.ts";

export {
  describeTrace,
  endedOnDeclaredNode,
  isDeclaredOutcome,
  isDeclaredTerminal,
  lastNode,
  visitCount,
  visited,
} from "./matchers.ts";
