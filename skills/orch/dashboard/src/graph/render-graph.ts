import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { svgEl } from "../dom/el";
import { truncate } from "../dom/format";
import {
  LABEL_MAX,
  NODE_H,
  NODE_W,
  ORCH_NODE_H,
  ORCH_NODE_W,
  layoutDag,
} from "./dag-layout";
import type { DagLayout } from "./dag-layout";
import { profileAccent, profileAccentSoft } from "./profile-color";

type Point = { x: number; y: number };

function nodeLabel(node: RunNode): string {
  return node.label || node.id;
}

function profileKey(node: RunNode): string | null {
  if (node.profile !== null && node.profile !== "") {
    return node.profile;
  }
  if (node.adapter !== null && node.adapter !== "") {
    return node.adapter;
  }
  return null;
}

function edgePath(from: Point, fromW: number, fromH: number, to: Point, sourceDone: boolean): SVGElement {
  const x1 = from.x + fromW;
  const y1 = from.y + fromH / 2;
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

function orchIcon(cx: number, cy: number): SVGElement {
  const icon = svgEl("g", { class: "orch-icon", transform: `translate(${cx} ${cy})` });
  icon.appendChild(svgEl("circle", { class: "hub", cx: "0", cy: "0", r: "5" }));
  const spokes: [number, number][] = [
    [-14, -10],
    [14, -10],
    [0, 14],
  ];
  for (const [sx, sy] of spokes) {
    icon.appendChild(svgEl("line", { class: "spoke", x1: "0", y1: "0", x2: String(sx), y2: String(sy) }));
    icon.appendChild(svgEl("circle", { class: "sat", cx: String(sx), cy: String(sy), r: "3.5" }));
  }
  return icon;
}

function orchNodeGroup(run: RunState, pos: Point): SVGElement {
  const group = svgEl("g", {
    class: `graph-orch orch-root ${run.status}`,
    transform: `translate(${pos.x} ${pos.y})`,
    role: "img",
    "aria-label": `orch coordinator, run ${run.status}`,
  });
  group.appendChild(
    svgEl("rect", {
      class: "orch-frame",
      width: String(ORCH_NODE_W),
      height: String(ORCH_NODE_H),
      rx: "8",
    }),
  );
  group.appendChild(orchIcon(ORCH_NODE_W / 2, ORCH_NODE_H / 2 - 6));
  group.appendChild(
    svgText({ class: "orch-title", x: String(ORCH_NODE_W / 2), y: String(ORCH_NODE_H - 10), "text-anchor": "middle" }, "orch"),
  );
  const session = run.harness_session !== "" ? truncate(run.harness_session, 14) : "coordinator";
  group.appendChild(
    svgText({ class: "orch-sub", x: String(ORCH_NODE_W / 2), y: String(ORCH_NODE_H - 24), "text-anchor": "middle" }, session),
  );
  return group;
}

function nodeGroup(
  node: RunNode,
  nodePos: Point,
  selected: boolean,
  isCyclic: boolean,
  onSelect: (nodeId: string) => void,
): SVGElement {
  const label = nodeLabel(node);
  const profile = profileKey(node);
  const accent = profile !== null ? profileAccent(profile) : "";
  const accentSoft = profile !== null ? profileAccentSoft(profile) : "";
  const classes = `node task-node ${node.status}${selected ? " selected" : ""}${profile !== null ? " has-profile" : ""}`;
  const group = svgEl("g", {
    class: classes,
    transform: `translate(${nodePos.x} ${nodePos.y})`,
    tabindex: "0",
    role: "button",
    "aria-label": `${label}, ${node.status}${profile !== null ? `, ${profile}` : ""}`,
  });
  if (profile !== null) {
    group.setAttribute("style", `--profile-accent: ${accent}; --profile-soft: ${accentSoft}`);
    group.setAttribute("data-profile", profile);
  }
  group.appendChild(svgEl("rect", { class: "frame", width: String(NODE_W), height: String(NODE_H), rx: "6" }));
  group.appendChild(
    svgEl("rect", { class: "mark", x: "0", y: "0", width: "5", height: String(NODE_H), rx: "6" }),
  );
  group.appendChild(svgText({ class: "label", x: "14", y: "24" }, truncate(label, LABEL_MAX)));
  const target = node.profile ?? node.adapter;
  const statusLine = target === null ? node.status : `${node.status} · ${target}`;
  group.appendChild(svgText({ class: "st", x: "14", y: "43" }, statusLine));
  if (isCyclic) {
    group.appendChild(
      svgText({ class: "cycle", x: String(NODE_W - 8), y: "14", "text-anchor": "end" }, "cycle"),
    );
  }
  group.addEventListener("click", () => {
    onSelect(node.id);
  });
  group.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onSelect(node.id);
  });
  return group;
}

function appendTaskEdges(svg: SVGElement, run: RunState, layout: DagLayout): void {
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
    svg.appendChild(edgePath(from, NODE_W, NODE_H, to, byId.get(fromId)?.status === "done"));
  }
}

function appendOrchEdges(svg: SVGElement, layout: DagLayout): void {
  if (layout.orch === null) {
    return;
  }
  for (const id of layout.entryIds) {
    const to = layout.pos[id];
    if (to === undefined) {
      continue;
    }
    svg.appendChild(edgePath(layout.orch, ORCH_NODE_W, ORCH_NODE_H, to, false));
  }
}

/**
 * The run's DAG as an `<svg>`: orch coordinator first, then task nodes coloured by profile.
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
  appendOrchEdges(svg, layout);
  appendTaskEdges(svg, run, layout);
  if (layout.orch !== null) {
    svg.appendChild(orchNodeGroup(run, layout.orch));
  }
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
