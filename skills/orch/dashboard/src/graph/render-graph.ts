import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { svgEl } from "../dom/el";
import { fmtDur, fmtUsd, truncate } from "../dom/format";
import {
  NODE_H,
  NODE_W,
  ORCH_NODE_H,
  ORCH_NODE_W,
  layoutDag,
} from "./dag-layout";
import type { DagLayout } from "./dag-layout";
import { harnessMarkGroup } from "./harness-mark";
import { profilePalette } from "./profile-color";
import type { ProfilePalette } from "./profile-color";

type Point = { x: number; y: number };

const HARNESS_MARK_SIZE: number = 15;
// Shorter than the bare node width allows: the harness glyph now sits in the top-right corner.
const LABEL_MAX: number = 19;

// Row 2 is `status · profile`, row 3 the measurements. The metrics earned their own row once
// there were two of them: fitting cost and duration beside the pair needs a 260px node, 44%
// wider than the original, where a third row keeps it at 200 and leaves row 2 uncramped.
const META_Y: number = 43;
const META_LEFT_X: number = 14;
const METRICS_Y: number = 62;
const METRICS_RIGHT_X: number = NODE_W - 12;
const METRICS_RULE_Y: number = 50;
/** Advance width of the 11px monospace both lower rows use. */
const META_CHAR_PX: number = 6.6;
const META_MIN_CHARS: number = 6;
/** What `fmtDur` returns when it has nothing to measure. */
const EM_DASH: string = "—";

/** The node's elapsed time, or null when it has not started or the timestamps are unusable. */
export function durationOf(node: RunNode): string | null {
  if (node.started === null || node.started === "") {
    return null;
  }
  const text = fmtDur(node.started, node.finished);
  return text === EM_DASH ? null : text;
}

/**
 * The node's cost, or null when its harness reported none — which is every adapter but claude,
 * and claude too when jq was unavailable at dispatch.
 */
export function costOf(node: RunNode): string | null {
  const usd = node.cost?.usd;
  if (usd === undefined || !Number.isFinite(usd)) {
    return null;
  }
  const text = fmtUsd(usd);
  return text === EM_DASH ? null : text;
}

/**
 * Row 2's string. It has the node's full width to itself now that the measurements sit on their
 * own row, so this only guards against a profile name longer than the node.
 */
export function metaLine(node: RunNode): string {
  const target = node.profile ?? node.adapter;
  const full = target === null || target === "" ? node.status : `${node.status} · ${target}`;
  const available = NODE_W - META_LEFT_X - (NODE_W - METRICS_RIGHT_X);
  return truncate(full, Math.max(META_MIN_CHARS, Math.floor(available / META_CHAR_PX)));
}

function nodeLabel(node: RunNode): string {
  return node.label || node.id;
}

/**
 * The node's harness. `adapter` is recorded at dispatch and so is authoritative; a node still
 * waiting on its profile has none yet, and falls back to the profile's configured harness.
 */
function harnessOf(node: RunNode, byProfile: Record<string, string>): string | null {
  if (node.adapter !== null && node.adapter !== "") {
    return node.adapter;
  }
  if (node.profile !== null && node.profile !== "") {
    return byProfile[node.profile] ?? null;
  }
  return null;
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

/**
 * Row 3: cost on the left, duration on the right, with a hairline above separating measurements
 * from identity. Drawn only when there is something to measure, so a waiting node keeps two rows
 * of content and simply has empty space where the numbers will appear.
 */
function appendMetrics(group: SVGElement, cost: string | null, duration: string | null): void {
  if (cost === null && duration === null) {
    return;
  }
  group.appendChild(
    svgEl("line", {
      class: "metrics-rule",
      x1: String(META_LEFT_X),
      y1: String(METRICS_RULE_Y),
      x2: String(METRICS_RIGHT_X),
      y2: String(METRICS_RULE_Y),
    }),
  );
  if (cost !== null) {
    group.appendChild(
      svgText({ class: "metric cost", x: String(META_LEFT_X), y: String(METRICS_Y) }, cost),
    );
  }
  if (duration !== null) {
    group.appendChild(
      svgText(
        { class: "metric dur", x: String(METRICS_RIGHT_X), y: String(METRICS_Y), "text-anchor": "end" },
        duration,
      ),
    );
  }
}

function nodeGroup(
  node: RunNode,
  nodePos: Point,
  selected: boolean,
  isCyclic: boolean,
  onSelect: (nodeId: string) => void,
  palette: ProfilePalette,
  harnessByProfile: Record<string, string>,
): SVGElement {
  const label = nodeLabel(node);
  const profile = profileKey(node);
  const harness = harnessOf(node, harnessByProfile);
  const duration = durationOf(node);
  const cost = costOf(node);
  const accent = profile !== null ? palette.accent(profile) : "";
  const accentSoft = profile !== null ? palette.soft(profile) : "";
  const classes = `node task-node ${node.status}${selected ? " selected" : ""}${profile !== null ? " has-profile" : ""}`;
  const group = svgEl("g", {
    class: classes,
    transform: `translate(${nodePos.x} ${nodePos.y})`,
    tabindex: "0",
    role: "button",
    "aria-label": `${label}, ${node.status}${profile !== null ? `, ${profile}` : ""}${
      harness !== null ? `, ${harness}` : ""
    }${duration !== null ? `, ${duration}` : ""}${cost !== null ? `, ${cost} list price` : ""}`,
  });
  if (profile !== null) {
    // Through the CSSOM, not a `style` attribute: the shell's CSP has no 'unsafe-inline', so an
    // inline style string is refused outright and every node loses its profile colour.
    group.style.setProperty("--profile-accent", accent);
    group.style.setProperty("--profile-soft", accentSoft);
    group.setAttribute("data-profile", profile);
  }
  group.appendChild(svgEl("rect", { class: "frame", width: String(NODE_W), height: String(NODE_H), rx: "6" }));
  group.appendChild(
    svgEl("rect", { class: "mark", x: "0", y: "0", width: "5", height: String(NODE_H), rx: "6" }),
  );
  group.appendChild(svgText({ class: "label", x: "14", y: "24" }, truncate(label, LABEL_MAX)));
  // Top-right, clear of both text rows. Same glyph for every node on the same harness.
  if (harness !== null) {
    group.appendChild(harnessMarkGroup(harness, NODE_W - HARNESS_MARK_SIZE - 9, 8, HARNESS_MARK_SIZE));
  }
  group.appendChild(
    svgText({ class: "st", x: String(META_LEFT_X), y: String(META_Y) }, metaLine(node)),
  );
  appendMetrics(group, cost, duration);
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
  harnessByProfile: Record<string, string> = {},
): SVGSVGElement {
  const layout = layoutDag(run.nodes, run.edges);
  const palette = profilePalette(
    run.nodes.map(profileKey).filter((name): name is string => name !== null),
  );
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
    svg.appendChild(
      nodeGroup(node, nodePos, selectedId === node.id, isCyclic, onSelect, palette, harnessByProfile),
    );
  }
  return svg;
}
