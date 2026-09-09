import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { svgEl } from "../dom/el";
import { truncate } from "../dom/format";
import { LABEL_MAX, NODE_H, NODE_W, layoutDag } from "./dag-layout";
import type { DagLayout } from "./dag-layout";

type Point = { x: number; y: number };

function nodeLabel(node: RunNode): string {
  return node.label || node.id;
}

function edgePath(from: Point, to: Point, sourceDone: boolean): SVGElement {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const cx = (x1 + x2) / 2;
  return svgEl("path", {
    class: sourceDone ? "edge done" : "edge",
    d: `M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`,
  });
}

function svgText(attrs: Record<string, string>, text: string): SVGElement {
  const node = svgEl("text", attrs);
  node.textContent = text;
  return node;
}

function nodeGroup(
  node: RunNode,
  nodePos: Point,
  selected: boolean,
  isCyclic: boolean,
  onSelect: (nodeId: string) => void,
): SVGElement {
  const label = nodeLabel(node);
  const group = svgEl("g", {
    class: `node ${node.status}${selected ? " selected" : ""}`,
    transform: `translate(${nodePos.x} ${nodePos.y})`,
    tabindex: "0",
    role: "button",
    "aria-label": `${label}, ${node.status}`,
  });
  group.appendChild(svgEl("rect", { width: String(NODE_W), height: String(NODE_H) }));
  group.appendChild(
    svgEl("rect", { class: "mark", x: "12", y: "14", width: "6", height: String(NODE_H - 28) }),
  );
  group.appendChild(svgText({ x: "28", y: "24" }, truncate(label, LABEL_MAX)));
  const target = node.profile ?? node.adapter;
  const statusLine = target === null ? node.status : `${node.status} · ${target}`;
  group.appendChild(svgText({ class: "st", x: "28", y: "43" }, statusLine));
  if (isCyclic) {
    group.appendChild(
      svgText({ class: "cycle", x: String(NODE_W - 8), y: "14", "text-anchor": "end" }, "cycle"),
    );
  }
  group.addEventListener("click", () => onSelect(node.id));
  group.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onSelect(node.id);
  });
  return group;
}

function appendEdges(svg: SVGElement, run: RunState, layout: DagLayout): void {
  const byId = new Map<string, RunNode>();
  for (const node of run.nodes) {
    byId.set(node.id, node);
  }
  for (const [fromId, toId] of run.edges) {
    const from = layout.pos[fromId];
    const to = layout.pos[toId];
    if (from === undefined || to === undefined) {
      continue;
    }
    svg.appendChild(edgePath(from, to, byId.get(fromId)?.status === "done"));
  }
}

/**
 * The run's DAG as an `<svg>`: edges first (so nodes paint over them), then one focusable
 * `role="button"` group per node. Click, Enter or Space hand the node id to `onSelect`.
 */
export function renderGraph(
  run: RunState,
  selectedId: string | null,
  onSelect: (nodeId: string) => void,
): SVGSVGElement {
  const layout = layoutDag(run.nodes, run.edges);
  const svg = svgEl("svg", {
    width: String(layout.width),
    height: String(layout.height),
    role: "img",
    "aria-label": "Task graph",
  });
  appendEdges(svg, run, layout);
  for (const node of run.nodes) {
    const nodePos = layout.pos[node.id];
    if (nodePos === undefined) {
      continue;
    }
    const isCyclic = layout.cyclic.includes(node.id);
    svg.appendChild(nodeGroup(node, nodePos, selectedId === node.id, isCyclic, onSelect));
  }
  return svg;
}
