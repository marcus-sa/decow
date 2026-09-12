/**
 * The path space of a workflow is finite, so it can be walked before anything
 * runs. Three tools live here:
 *
 * - `cartesian`, for enumerating the decision space a set of steps can return.
 * - `enumeratePaths`, a depth-first walk of the *reachable* decision tree: it
 *   re-runs a workflow once per path, forcing a different combination of leaf
 *   decisions each time, and stops when every choice point is exhausted. A
 *   loop makes a leaf answer more than once per run, so the space is
 *   sequences, not tuples — and it stays finite because every loop is bounded.
 * - `inspectGraph`, a static walk of the graph itself, which rejects a graph
 *   with a dangling edge, an unreachable node, a fanout target that is not a
 *   step, a malformed loop, a raw back edge, or no terminal — the structural
 *   defects the design says the harness must catch before any model runs.
 *
 * `graphDefects` is also the compiler's admission gate: `compileWorkflow`
 * refuses to build any graph this function rejects, so a graph bug is one
 * error in one place rather than a mis-compiled workflow.
 *
 * Branch predicates are not evaluated here: the walk follows every edge in
 * every edge table, which is exactly the closed set guarantee 1 buys us.
 */

import type { NodeId, Workflow } from "../core/workflow.ts";

/** All n-length tuples over `xs`, in a stable order. */
export const cartesian = <T>(xs: readonly T[], n: number): T[][] =>
  n === 0 ? [[]] : cartesian(xs, n - 1).flatMap((rest) => xs.map((x) => [x, ...rest]));

/** Every node id an edge from `id` can lead to. */
export const outEdges = <S>(wf: Workflow<S>, id: NodeId): NodeId[] => {
  const node = wf.nodes[id];
  if (!node) return [];
  switch (node.type) {
    case "step":
      return [node.next];
    case "fanout":
      return [...node.steps, node.join];
    case "branch":
      return Object.values(node.edges);
    case "loop":
      return [node.body, node.next];
    case "suspend":
      return [node.next];
    case "terminal":
      return [];
  }
};

/** Everything reachable from a loop's `body` without passing through the loop. */
const forwardOf = <S>(wf: Workflow<S>, loopId: NodeId, from: NodeId): Set<NodeId> => {
  const forward = new Set<NodeId>();
  const queue: NodeId[] = [from];
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (id === loopId || forward.has(id) || !wf.nodes[id]) continue;
    forward.add(id);
    queue.push(...outEdges(wf, id));
  }
  return forward;
};

/**
 * The nodes inside `loopId`'s body: those reachable from its `body` that can
 * reach the loop node again without leaving. That is what "inside the loop"
 * means — a node that takes part in an iteration.
 *
 * This is the boundary convention, and it is what makes a loop checkable. An
 * edge from a node in this set to `loopId` is the loop's iteration boundary,
 * not a back edge, and it is the ONLY edge allowed to leave the set. Anything
 * a body node points at that cannot come back is an escape, because the loop
 * node's own `next` is the only way past the loop.
 */
export const loopBody = <S>(wf: Workflow<S>, loopId: NodeId): Set<NodeId> => {
  const node = wf.nodes[loopId];
  if (node?.type !== "loop") return new Set();
  const forward = forwardOf(wf, loopId, node.body);

  // Walk the edges backwards from the loop: whoever reaches it is inside it.
  const body = new Set<NodeId>();
  const queue = [...forward].filter((id) => outEdges(wf, id).includes(loopId));
  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (body.has(id)) continue;
    body.add(id);
    for (const from of forward) {
      if (!body.has(from) && outEdges(wf, from).includes(id)) queue.push(from);
    }
  }
  return body;
};

const loopBodies = <S>(wf: Workflow<S>): Map<NodeId, Set<NodeId>> =>
  new Map(
    Object.keys(wf.nodes)
      .filter((id) => wf.nodes[id]?.type === "loop")
      .map((id) => [id, loopBody(wf, id)] as const),
  );

export type Edge = { from: NodeId; to: NodeId };

export type GraphReport = {
  reachable: NodeId[];
  terminals: NodeId[];
  /** Edge targets that name a node the graph does not define. */
  danglingEdges: Edge[];
  /** Declared nodes no path from `start` can reach. */
  unreachable: NodeId[];
  /** Fanout targets that are not `step` nodes. */
  badFanoutTargets: Edge[];
  /** Edges that close a loop the graph never declared. */
  backEdges: Edge[];
  /**
   * Malformed `loop` nodes, already rendered. Each reason has its own shape —
   * a bound, an escaping edge, a terminal inside a body — so they are one list
   * of sentences rather than one list per shape.
   */
  loopDefects: string[];
};

/**
 * Depth-first walk collecting every edge whose target is already on the
 * current path. Those are back edges, and a graph with one is cyclic — except
 * for a body node's edge to its own loop, which is the declared iteration
 * boundary and is skipped rather than reported.
 */
const findBackEdges = <S>(wf: Workflow<S>, bodies: Map<NodeId, Set<NodeId>>): Edge[] => {
  const backEdges: Edge[] = [];
  const onPath = new Set<NodeId>();
  const settled = new Set<NodeId>();

  const walk = (id: NodeId): void => {
    if (!wf.nodes[id] || settled.has(id)) return;
    onPath.add(id);
    for (const to of outEdges(wf, id)) {
      if (bodies.get(to)?.has(id)) continue; // the loop's own iteration boundary
      if (onPath.has(to)) backEdges.push({ from: id, to });
      else walk(to);
    }
    onPath.delete(id);
    settled.add(id);
  };

  walk(wf.start);
  return backEdges;
};

/**
 * Everything that can be wrong with a `loop` node. The bound is checked here
 * and nowhere else, so "an unbounded loop is unrepresentable" is one rule with
 * one enforcement point that the compiler refuses to build past.
 */
const findLoopDefects = <S>(wf: Workflow<S>, bodies: Map<NodeId, Set<NodeId>>): string[] => {
  const defects: string[] = [];

  for (const [id, body] of bodies) {
    const node = wf.nodes[id];
    if (node?.type !== "loop") continue;

    if (!Number.isInteger(node.max) || node.max < 1) {
      defects.push(
        `loop bound must be a positive integer: ${id} has max ${String(node.max)} — ` +
          `an unbounded loop has an infinite path space and cannot be enumerated`,
      );
    }
    if (node.body === id) {
      defects.push(`loop body is the loop itself: ${id}`);
      continue;
    }
    if (!wf.nodes[node.body]) continue; // the dangling-edge check owns this one
    if (body.size === 0) {
      defects.push(
        `loop body never returns to the loop: ${id} -> ${node.body} has no path back to ${id} — ` +
          `an edge naming ${id} is what makes a node part of the body`,
      );
      continue;
    }

    if (body.has(node.next)) {
      defects.push(`loop exit re-enters its own body: ${id} -> ${node.next}`);
    }
    for (const inside of body) {
      for (const to of outEdges(wf, inside)) {
        if (to === id || body.has(to) || !wf.nodes[to]) continue;
        defects.push(
          `loop body escapes: ${inside} -> ${to} leaves the body of ${id} — ` +
            `the only edge out of a loop body is ${id} itself`,
        );
      }
    }
    for (const [outside, node2] of Object.entries(wf.nodes)) {
      if (outside === id || body.has(outside) || !node2) continue;
      for (const to of outEdges(wf, outside)) {
        if (body.has(to)) {
          defects.push(`loop body entered from outside: ${outside} -> ${to} is inside the body of ${id}`);
        }
      }
    }
  }
  return defects;
};

export const inspectGraph = <S>(wf: Workflow<S>): GraphReport => {
  const reachable: NodeId[] = [];
  const seen = new Set<NodeId>();
  const danglingEdges: Edge[] = [];
  const badFanoutTargets: Edge[] = [];
  const queue: NodeId[] = [wf.start];

  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = wf.nodes[id];
    if (!node) continue; // recorded as dangling by whoever pointed here
    reachable.push(id);
    if (node.type === "fanout") {
      for (const to of node.steps) {
        if (wf.nodes[to] && wf.nodes[to]?.type !== "step") badFanoutTargets.push({ from: id, to });
      }
    }
    for (const to of outEdges(wf, id)) {
      if (!wf.nodes[to]) danglingEdges.push({ from: id, to });
      else queue.push(to);
    }
  }
  if (!wf.nodes[wf.start]) danglingEdges.push({ from: "<start>", to: wf.start });

  const bodies = loopBodies(wf);

  return {
    reachable,
    terminals: reachable.filter((id) => wf.nodes[id]?.type === "terminal"),
    danglingEdges,
    unreachable: Object.keys(wf.nodes).filter((id) => !seen.has(id)),
    badFanoutTargets,
    backEdges: findBackEdges(wf, bodies),
    loopDefects: findLoopDefects(wf, bodies),
  };
};

/** Human-readable reasons the graph is malformed. Empty means well-formed. */
export const graphDefects = <S>(wf: Workflow<S>): string[] => {
  const r = inspectGraph(wf);
  return [
    ...r.danglingEdges.map((e) => `dangling edge: ${e.from} -> ${e.to} (no such node)`),
    ...r.badFanoutTargets.map(
      (e) => `fanout target is not a step: ${e.from} -> ${e.to} (${wf.nodes[e.to]?.type})`,
    ),
    ...r.loopDefects,
    ...r.backEdges.map(
      (e) =>
        `back edge: ${e.from} -> ${e.to} — repetition goes through a bounded loop node, ` +
        `not a raw back edge`,
    ),
    ...r.unreachable.map((id) => `unreachable node: ${id}`),
    ...(r.terminals.length === 0 ? ["no terminal is reachable from start"] : []),
  ];
};

/**
 * Pick one of a closed set of alternatives at a choice point. `id` names the
 * choice point for diagnostics and for the determinism check below.
 */
export type Choose = <T>(id: string, options: readonly T[]) => T;

type ChoicePoint = { id: string; index: number; count: number };

/**
 * Walk every reachable path through a workflow, once each.
 *
 * `runOnce` runs the graph with the `choose` it is handed wired into whatever
 * decides: a journal standing in for the models, an effect executor standing
 * in for the VCS. The walk is a depth-first traversal of the decision tree —
 * run with every choice at its first option, then re-run forcing the last
 * choice point to its next option, and so on until none is left. Unreachable
 * combinations are never run, which is what keeps a graph with three bounded
 * loops to four figures of paths instead of six.
 *
 * The one requirement: the order of choice points must be a function of the
 * choices already made. A `fanout` breaks that, because its sub-steps race, so
 * this walks sequential graphs only. It says so rather than quietly producing
 * a wrong count: a choice point whose id does not match the forced prefix
 * throws.
 */
export const enumeratePaths = async <R>(runOnce: (choose: Choose) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  let prefix: ChoicePoint[] = [];

  for (;;) {
    const taken: ChoicePoint[] = [];
    const choose: Choose = <T>(id: string, options: readonly T[]): T => {
      if (options.length === 0) throw new Error(`enumerate-paths: choice point "${id}" has no options`);
      const forced = prefix[taken.length];
      if (forced !== undefined && forced.id !== id) {
        throw new Error(
          `enumerate-paths: choice point ${taken.length} was "${forced.id}" and is now "${id}" — ` +
            `the decision order must be a function of the decisions already made (no fanout)`,
        );
      }
      const index = forced?.index ?? 0;
      taken.push({ id, index, count: options.length });
      return options[index] as T;
    };

    results.push(await runOnce(choose));

    let i = taken.length - 1;
    while (i >= 0 && (taken[i] as ChoicePoint).index + 1 >= (taken[i] as ChoicePoint).count) i -= 1;
    if (i < 0) return results;
    const pivot = taken[i] as ChoicePoint;
    prefix = [...taken.slice(0, i), { ...pivot, index: pivot.index + 1 }];
  }
};
