/**
 * The workflow is a finite graph. Every path through it is enumerable before
 * it runs.
 *
 * 1. Only enums drive edges. `branch` reads a closed decision type; payload is
 *    never read by the graph.
 * 2. Every branch's edge table is exhaustive at compile time: a branch over a
 *    decision type D takes Record<D, NodeId>. Adding a decision value without
 *    an edge is a type error.
 * 3. Terminals are enumerated, not thrown.
 * 4. Effects are data. A step returns Effect[]; the runner executes them.
 *
 * No nondeterminism lives in this file. No Date.now, no Math.random, no
 * new Date. src/harness/no-nondeterminism.test.ts enforces that mechanically.
 */

import type { Effect, EffectResult } from "./effects.ts";

export type NodeId = string;

export type Terminal<S> =
  | { kind: "accepted"; state: S }
  | { kind: "rejected"; state: S; trail: unknown[] }
  | { kind: "needs-human"; state: S; reason: string };

export const TERMINAL_KINDS = ["accepted", "rejected", "needs-human"] as const;

export type Node<S> =
  | {
      type: "step";
      run: (s: S) => Promise<{ state: S; effects: Effect[] }>;
      absorb: (s: S, results: EffectResult[]) => S;
      next: NodeId;
    }
  | { type: "fanout"; steps: NodeId[]; join: NodeId }
  | { type: "branch"; on: (s: S) => string; edges: Record<string, NodeId> }
  | { type: "terminal"; done: (s: S) => Terminal<S> };

export type Workflow<S> = { start: NodeId; nodes: Record<NodeId, Node<S>> };

/**
 * The keys `after` changed relative to `before`, as a shallow patch.
 *
 * Fanout sub-steps each run against the same pre-fanout state and each return
 * a whole state, so a plain `{...acc, ...after}` would let the last sub-step's
 * unchanged copies overwrite every earlier sub-step's work. Diffing against
 * the common ancestor keeps each sub-step's own writes and nothing else.
 * See README "Deviations from the design".
 */
const changedKeys = <S>(before: S, after: S): Partial<S> => {
  if (before === after || typeof after !== "object" || after === null) return after as Partial<S>;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after as Record<string, unknown>)) {
    if (!Object.is((before as Record<string, unknown> | null)?.[key], value)) patch[key] = value;
  }
  return patch as Partial<S>;
};

/**
 * The load-bearing constructor. `edges` is `Record<D, NodeId>` over the
 * decision union, so dropping a decision member is a compile error.
 */
export const branch = <S, D extends string>(on: (s: S) => D, edges: Record<D, NodeId>): Node<S> => ({
  type: "branch",
  on,
  edges,
});

/**
 * The runner. The only errors it throws are graph bugs: a missing node or an
 * unhandled edge, both of which the enumeration test catches before any model
 * runs. Everything a step or an effect can decide is data.
 *
 * The returned trace is the provenance record, written as the runner
 * traverses. A model cannot claim to have reached a node it did not reach.
 */
export async function run<S>(
  wf: Workflow<S>,
  state: S,
  execute: (effects: Effect[]) => Promise<EffectResult[]>,
  trace: NodeId[] = [],
): Promise<{ result: Terminal<S>; trace: NodeId[] }> {
  let cursor = wf.start;
  for (;;) {
    const node = wf.nodes[cursor];
    if (!node) throw new Error(`graph bug: no node ${cursor}`);
    trace.push(cursor);
    switch (node.type) {
      case "step": {
        const out = await node.run(state);
        const results = await execute(out.effects);
        state = node.absorb(out.state, results);
        cursor = node.next;
        break;
      }
      case "fanout": {
        // Every sub-step sees the same pre-fanout state, and results merge
        // positionally, so completion order cannot change the trajectory.
        const before = state;
        const outs = await Promise.all(
          node.steps.map(async (id) => {
            const n = wf.nodes[id];
            if (n?.type !== "step") throw new Error(`graph bug: fanout target ${id} is not a step`);
            trace.push(id);
            const out = await n.run(before);
            return n.absorb(out.state, await execute(out.effects));
          }),
        );
        // Each sub-step contributes only what it changed. Two sub-steps writing
        // the same key is a graph-authoring mistake; the later one wins, in
        // declaration order, never in completion order.
        state = outs.reduce<S>((acc, s) => ({ ...acc, ...changedKeys(before, s) }), before);
        cursor = node.join;
        break;
      }
      case "branch": {
        const key = node.on(state);
        const next = node.edges[key];
        if (!next) throw new Error(`graph bug: ${cursor} has no edge for ${key}`);
        cursor = next;
        break;
      }
      case "terminal":
        return { result: node.done(state), trace };
    }
  }
}
