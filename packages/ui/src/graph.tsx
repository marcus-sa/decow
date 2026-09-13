/**
 * The authored graph, drawn.
 *
 * JointJS holds the cells and paints them; `./layout.ts` decides where they
 * go. Nothing here knows about the compiler: every id it draws is one the
 * author wrote, because that is all the projection carries.
 *
 * A node is a rectangle, a branch's edges carry the key they are taken on, a
 * loop's body sits in a dashed box with the bound written on it, and a run
 * paints itself over the top — every node it entered, the one it is on, and
 * the iteration counter on anything it entered twice.
 *
 * AN EDGE LABEL GOES WHERE DAGRE PUT IT, not at the edge's midpoint. Several
 * edges routinely share an endpoint — every loop-exit edge converges on the
 * loop node — and their midpoints then coincide, which is how `exhausted`,
 * `cannot-decompose` and `invalid` ended up painted on top of one another.
 * `layout.ts` gives dagre each label's size, dagre reserves a rank for it and
 * answers with a point, and `getLabelPosition` turns that point into the
 * distance-and-offset a JointJS label is addressed by.
 *
 * JOINTJS IS IMPORTED INSIDE THE EFFECT, not at module scope. This route is
 * server-rendered like every other one, and a drawing library that wants a
 * document has nothing to do on a server. The type import is erased, so the
 * server bundle never loads it and the client loads it once, when there is
 * something to draw on.
 */

import { useEffect, useRef } from "react";
import type { dia } from "@joint/core";
import type { GraphProjection, ProjectedNode } from "@des/server";
import { clusterId, layout, NODE_HEIGHT, NODE_WIDTH, type Layout } from "./layout.ts";

/** What a node is doing right now, when the drawing is of a live run. */
export type NodeState = "idle" | "visited" | "current";

export type GraphViewProps = {
  projection: GraphProjection;
  /** Per node id, what the run has done with it. Empty for a static drawing. */
  states?: Record<string, NodeState>;
  /** Per node id, how many times the run entered it. Loops earn this. */
  iterations?: Record<string, number>;
  /** Called with the node a reader clicked, when anything cares. */
  onSelect?: (id: string) => void;
};

/** The JointJS module, as the effect loads it. */
type Joint = typeof import("@joint/core");

/** One colour per node kind, and one per state. The state wins. */
const FILL: Record<ProjectedNode["kind"], string> = {
  leaf: "#1d2b4a",
  step: "#17222f",
  branch: "#2a2235",
  suspend: "#3a2a16",
  loop: "#18262166",
  terminal: "#16241c",
  fanout: "#17222f",
};

const STROKE: Record<ProjectedNode["kind"], string> = {
  leaf: "#4d7fd6",
  step: "#3c5468",
  branch: "#8a6fb0",
  suspend: "#d19a3d",
  loop: "#4f7f63",
  terminal: "#4f9e73",
  fanout: "#3c5468",
};

const STATE_STROKE: Record<NodeState, string | undefined> = {
  idle: undefined,
  visited: "#7fd6a1",
  current: "#ffd166",
};

/** The label under a node's id: what kind of thing it is, in one word. */
const subtitle = (node: ProjectedNode, iterations?: number): string => {
  const count = iterations === undefined || iterations < 2 ? "" : ` ×${iterations}`;
  switch (node.kind) {
    case "leaf":
      return `leaf · ${node.stepId ?? ""}${count}`;
    case "loop":
      return `loop · max ${node.max ?? "?"}${count}`;
    case "branch":
      return `branch · ${Object.keys(node.edges ?? {}).length} edges${count}`;
    default:
      return `${node.kind}${count}`;
  }
};

/** Build every cell: the loop boxes first, then the nodes, then the edges. */
const cellsFor = (joint: Joint, props: GraphViewProps, placed: Layout): dia.Cell[] => {
  const { projection, states = {}, iterations = {} } = props;
  const { shapes } = joint;
  const cells: dia.Cell[] = [];

  for (const [loop, box] of placed.clusters) {
    const node = projection.nodes.find((n) => n.id === loop);
    cells.push(
      new shapes.standard.Rectangle({
        id: clusterId(loop),
        position: { x: box.x, y: box.y },
        size: { width: box.width, height: box.height },
        attrs: {
          body: {
            fill: FILL.loop,
            stroke: STROKE.loop,
            strokeDasharray: "6 4",
            rx: 10,
            ry: 10,
          },
          label: {
            text: `${loop} · body, max ${node?.max ?? "?"}`,
            fill: "#7fb79a",
            fontSize: 11,
            fontFamily: "ui-monospace, monospace",
            // Pinned to the top of the box rather than its middle, where the
            // nodes it contains are.
            refY: 12,
            textVerticalAnchor: "top",
          },
        },
      }),
    );
  }

  for (const node of projection.nodes) {
    const at = placed.nodes.get(node.id);
    if (at === undefined) continue;
    const state = states[node.id] ?? "idle";
    cells.push(
      new shapes.standard.Rectangle({
        id: node.id,
        position: at,
        size: { width: NODE_WIDTH, height: NODE_HEIGHT },
        attrs: {
          body: {
            fill: FILL[node.kind],
            stroke: STATE_STROKE[state] ?? STROKE[node.kind],
            strokeWidth: state === "current" ? 3 : 1.5,
            rx: node.kind === "terminal" ? 20 : 6,
            ry: node.kind === "terminal" ? 20 : 6,
          },
          label: {
            text: `${node.id}\n${subtitle(node, iterations[node.id])}`,
            fill: state === "idle" ? "#c7d2de" : "#ffffff",
            fontSize: 11,
            fontFamily: "ui-monospace, monospace",
            lineHeight: 14,
          },
        },
      }),
    );
  }

  projection.edges.forEach((edge, at) => {
    if (!placed.nodes.has(edge.from) || !placed.nodes.has(edge.to)) return;
    const taken = states[edge.from] !== undefined && states[edge.to] !== undefined;
    const link = new shapes.standard.Link({
      source: { id: edge.from },
      target: { id: edge.to },
      attrs: {
        line: {
          stroke: taken ? "#7fd6a1" : "#3b4a5a",
          strokeWidth: taken ? 2 : 1.2,
          targetMarker: { type: "path", d: "M 8 -4 0 0 8 4 z" },
        },
      },
      labels:
        edge.key === undefined
          ? []
          : [
              {
                // A placeholder. `placeLabels` replaces it with the point
                // dagre chose, once the paper has a view to ask.
                position: { distance: 0.5 },
                attrs: {
                  text: {
                    text: edge.key,
                    fill: "#93a4b8",
                    fontSize: 10,
                    fontFamily: "ui-monospace, monospace",
                  },
                  rect: { fill: "#0b0d12", stroke: "none" },
                },
              },
            ],
    });
    // The projection's own index, so the label placement can find its point.
    link.set("edgeIndex", at);
    cells.push(link);
  });

  return cells;
};

/**
 * Move every edge label onto the point dagre chose for it.
 *
 * A JointJS label is addressed by a distance along the link and an offset from
 * it, not by a paper coordinate — so the paper coordinate is handed to the
 * LINK'S OWN VIEW, which knows the route it drew and converts. Absolute on
 * both axes, because the point may sit anywhere dagre's label rank put it.
 *
 * After `addCells`, because a view is what does the converting and a view
 * exists once the model has been added.
 */
const placeLabels = (paper: dia.Paper, placed: Layout): void => {
  for (const link of paper.model.getLinks()) {
    const at = link.get("edgeIndex") as number | undefined;
    const point = at === undefined ? undefined : placed.labels.get(at);
    if (point === undefined || !link.hasLabels()) continue;
    const view = paper.findViewByModel(link) as dia.LinkView | undefined;
    if (view === undefined) continue;
    link.label(0, {
      position: view.getLabelPosition(point.x, point.y, {
        absoluteDistance: true,
        absoluteOffset: true,
      }),
    });
  }
};

export const GraphView = (props: GraphViewProps): React.ReactElement => {
  const host = useRef<HTMLDivElement | null>(null);
  const { projection, states, iterations, onSelect } = props;

  // Rebuilt when the graph or what is painted on it changes, and not once per
  // render: a live run re-renders on every event, and a paper rebuilt sixty
  // times a second is a paper nobody can click.
  useEffect(() => {
    const el = host.current;
    if (el === null) return;
    let view: dia.Paper | undefined;
    let cancelled = false;

    void (async () => {
      const joint = await import("@joint/core");
      if (cancelled) return;
      const { dia: diagram, shapes } = joint;

      const model = new diagram.Graph({}, { cellNamespace: shapes });
      const placed = layout(projection);
      view = new diagram.Paper({
        el,
        model,
        width: placed.width,
        height: placed.height,
        gridSize: 1,
        interactive: false,
        background: { color: "transparent" },
        cellViewNamespace: shapes,
        defaultConnectionPoint: { name: "boundary" },
      });

      model.addCells(
        cellsFor(
          joint,
          {
            projection,
            ...(states === undefined ? {} : { states }),
            ...(iterations === undefined ? {} : { iterations }),
          },
          placed,
        ),
      );
      // The loop boxes are drawn first and would otherwise sit over the nodes
      // they contain; JointJS paints in insertion order, so push them back.
      for (const loop of placed.clusters.keys()) model.getCell(clusterId(loop))?.toBack();

      placeLabels(view, placed);

      if (onSelect !== undefined) {
        view.on("element:pointerclick", (cellView: dia.CellView) => {
          const id = String(cellView.model.id);
          if (!id.startsWith("cluster:")) onSelect(id);
        });
      }
      // The drawing is complete. A test waits on this rather than on a
      // timeout, because "the graph is drawn" is a fact and not a duration.
      el.setAttribute("data-drawn", "true");
    })();

    return () => {
      cancelled = true;
      view?.remove();
      el.removeAttribute("data-drawn");
    };
  }, [projection, states, iterations, onSelect]);

  return <div className="graph" data-testid="graph" ref={host} />;
};
