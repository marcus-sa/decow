/**
 * Predicates over a run's outcome and trace. Deliberately plain functions
 * rather than `expect` extensions: the harness must be usable from any runner,
 * and a matcher that imports a test framework is not.
 */

import {
  TERMINAL_KINDS,
  type NodeId,
  type RunOutcome,
  type Terminal,
  type Workflow,
} from "../core/workflow.ts";

export const isDeclaredTerminal = <S>(t: Terminal<S>): boolean =>
  (TERMINAL_KINDS as readonly string[]).includes(t.kind);

/**
 * A run ends in one of two declared ways: a terminal, or parked for a person.
 * Both are outcomes the graph declares; neither is an exception.
 */
export const isDeclaredOutcome = <S>(o: RunOutcome<S>): boolean =>
  o.kind === "suspended" ? true : isDeclaredTerminal(o.terminal);

/** The node the run stopped on. */
export const lastNode = (trace: readonly NodeId[]): NodeId | undefined => trace.at(-1);

/**
 * Did the run stop on a node the graph declares as an ending — a terminal, or
 * a suspend node it is parked on?
 */
export const endedOnDeclaredNode = <S>(
  wf: Workflow<S>,
  outcome: RunOutcome<S>,
): boolean => {
  const last = lastNode(outcome.trace);
  const type = last === undefined ? undefined : wf.nodes[last]?.type;
  return outcome.kind === "suspended" ? type === "suspend" : type === "terminal";
};

export const visited = (trace: readonly NodeId[], id: NodeId): boolean => trace.includes(id);

/** How many times the run entered `id`. Useful for bounded-retry assertions. */
export const visitCount = (trace: readonly NodeId[], id: NodeId): number =>
  trace.reduce((n, x) => (x === id ? n + 1 : n), 0);

/** A one-line rendering of the traversal, for failure messages. */
export const describeTrace = (trace: readonly NodeId[]): string => trace.join(" -> ");
