/**
 * Predicates over a run's terminal and trace. Deliberately plain functions
 * rather than `expect` extensions: the harness must be usable from any runner,
 * and a matcher that imports a test framework is not.
 */

import { TERMINAL_KINDS, type NodeId, type Terminal, type Workflow } from "../core/workflow.ts";

export const isDeclaredTerminal = <S>(t: Terminal<S>): boolean =>
  (TERMINAL_KINDS as readonly string[]).includes(t.kind);

/** The node the run stopped on. */
export const lastNode = (trace: readonly NodeId[]): NodeId | undefined => trace.at(-1);

/** Did the run stop on a node the graph declares as a terminal? */
export const endedOnTerminalNode = <S>(wf: Workflow<S>, trace: readonly NodeId[]): boolean => {
  const last = lastNode(trace);
  return last !== undefined && wf.nodes[last]?.type === "terminal";
};

export const visited = (trace: readonly NodeId[], id: NodeId): boolean => trace.includes(id);

/** How many times the run entered `id`. Useful for bounded-retry assertions. */
export const visitCount = (trace: readonly NodeId[], id: NodeId): number =>
  trace.reduce((n, x) => (x === id ? n + 1 : n), 0);

/** A one-line rendering of the traversal, for failure messages. */
export const describeTrace = (trace: readonly NodeId[]): string => trace.join(" -> ");
