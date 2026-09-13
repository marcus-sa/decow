/**
 * The AUTHORED graph, as data a drawing can be made from.
 *
 * The compiler emits nested Mastra workflows with per-path ids: a node
 * reachable from two branch edges is compiled twice, under two names, and
 * neither name is the node's. Drawing that would draw the compile rather than
 * the graph, and a person reading it would be reading an artifact of how
 * continuations are threaded onto a chain builder.
 *
 * So the projection reads the node map, through the harness's own
 * `inspectGraph` and `loopBody` — the same walk the compiler admits a graph
 * with — and reports the ids the author wrote. Everything downstream keys on
 * those: the trace does, the run events do, and the drawing does.
 *
 * One thing a graph cannot tell you and this projection therefore does not
 * claim: the closed set a `suspend` node's REASON is drawn from. `reason` is
 * `(s: S) => string`, a function of state, so the set it ranges over lives in
 * the consumer's own enum and not in the node. What IS readable is the answer
 * space — `resumeSchema` is a value — and that is the half a person needs in
 * front of them, because it is the half they have to choose from.
 */

import { inspectGraph, loopBody } from "@des/core/harness";
import type { NodeId, Workflow } from "@des/core/workflow";
import { z } from "zod";

export const NODE_KINDS = ["leaf", "step", "branch", "suspend", "loop", "terminal", "fanout"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** The closed set a person answers a suspension from. */
export type ResumeOptions = {
  /** The JSON Schema of the whole answer, from `resumeSchema`. */
  schema: unknown;
  /** The field the closed enum sits on, when the answer has one. */
  field?: string;
  /** The enum's members, which are the buttons a person is offered. */
  options?: string[];
};

export type ProjectedNode = {
  id: NodeId;
  kind: NodeKind;
  /** Where control goes next, for the node types that name one target. */
  next?: NodeId;
  /** A branch's edge table, verbatim. Its keys are the closed decision space. */
  edges?: Record<string, NodeId>;
  /** A loop's body node and its required bound. */
  body?: NodeId;
  max?: number;
  /** A fanout's sub-steps and the node they join at. */
  steps?: NodeId[];
  join?: NodeId;
  /** A suspend node's answer space. */
  resume?: ResumeOptions;
  /**
   * The `StepDef` id a leaf calls, which is also the `stepId` its attempts
   * report. Present only on a node built by `leaf`, so it is both "this node
   * is a model call" and the key that joins it to what those calls decided.
   */
  stepId?: string;
};

export type ProjectedEdge = {
  from: NodeId;
  to: NodeId;
  /** The branch key this edge is taken on, when it comes from a branch. */
  key?: string;
};

export type GraphProjection = {
  start: NodeId;
  nodes: ProjectedNode[];
  edges: ProjectedEdge[];
  /** Per loop id, the nodes inside its body. A drawing puts a box round them. */
  loops: Record<NodeId, NodeId[]>;
  /** Node ids in the order the walk reached them, for a stable layout. */
  reachable: NodeId[];
  /** What `graphDefects` would refuse this graph for. Empty for a live graph. */
  defects: string[];
};

/**
 * The closed enum a JSON Schema offers, when it offers exactly one.
 *
 * Every suspend node in this repository answers `{ decision: <enum> }`, some
 * with a free-text field beside it, and what a person is offered is that
 * enum's members. Reading it out of the schema rather than out of a second
 * declaration is what keeps the buttons and the parse in agreement: the
 * answer the UI posts is by construction one the node's own `resumeSchema`
 * accepts.
 */
export const resumeOptionsOf = (schema: z.ZodType<unknown>): ResumeOptions => {
  const json = z.toJSONSchema(schema, { target: "draft-07", unrepresentable: "any" }) as {
    properties?: Record<string, { enum?: unknown }>;
  };
  for (const [field, property] of Object.entries(json.properties ?? {})) {
    const values = property.enum;
    if (Array.isArray(values) && values.every((v) => typeof v === "string")) {
      return { schema: json, field, options: values };
    }
  }
  return { schema: json };
};

/** Every edge out of a node, with the branch key that takes it. */
const edgesOf = <S>(wf: Workflow<S>, id: NodeId): ProjectedEdge[] => {
  const node = wf.nodes[id];
  if (node === undefined) return [];
  switch (node.type) {
    case "step":
    case "suspend":
      return [{ from: id, to: node.next }];
    case "branch":
      return Object.entries(node.edges).map(([key, to]) => ({ from: id, to, key }));
    case "loop":
      return [
        { from: id, to: node.body, key: "body" },
        { from: id, to: node.next, key: "done" },
      ];
    case "fanout":
      return [...node.steps.map((to) => ({ from: id, to })), { from: id, to: node.join }];
    case "terminal":
      return [];
  }
};

const nodeOf = <S>(wf: Workflow<S>, id: NodeId): ProjectedNode => {
  const node = wf.nodes[id];
  if (node === undefined) return { id, kind: "step" };
  switch (node.type) {
    case "step":
      return {
        id,
        kind: node.leaf === undefined ? "step" : "leaf",
        next: node.next,
        ...(node.leaf === undefined ? {} : { stepId: node.leaf }),
      };
    case "branch":
      return { id, kind: "branch", edges: { ...node.edges } };
    case "loop":
      return { id, kind: "loop", body: node.body, max: node.max, next: node.next };
    case "suspend":
      return { id, kind: "suspend", next: node.next, resume: resumeOptionsOf(node.resumeSchema) };
    case "fanout":
      return { id, kind: "fanout", steps: [...node.steps], join: node.join };
    case "terminal":
      return { id, kind: "terminal" };
  }
};

export const project = <S>(wf: Workflow<S>): GraphProjection => {
  const report = inspectGraph(wf);
  const ids = report.reachable;
  return {
    start: wf.start,
    nodes: ids.map((id) => nodeOf(wf, id)),
    edges: ids.flatMap((id) => edgesOf(wf, id)).filter((edge) => wf.nodes[edge.to] !== undefined),
    loops: Object.fromEntries(
      ids
        .filter((id) => wf.nodes[id]?.type === "loop")
        .map((id) => [id, [...loopBody(wf, id)]] as const),
    ),
    reachable: ids,
    defects: [
      ...report.danglingEdges.map((e) => `dangling edge: ${e.from} -> ${e.to}`),
      ...report.unreachable.map((id) => `unreachable node: ${id}`),
      ...report.loopDefects,
      ...report.backEdges.map((e) => `back edge: ${e.from} -> ${e.to}`),
    ],
  };
};

/** The suspend node a parked run is sitting on: the last one in its trace. */
export const parkedAt = <S>(wf: Workflow<S>, trace: readonly NodeId[]): NodeId | undefined =>
  [...trace].reverse().find((id) => wf.nodes[id]?.type === "suspend");
