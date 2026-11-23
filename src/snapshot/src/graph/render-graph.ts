import type { TimedRun } from "../../../shared/node-timing";
import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { svgEl } from "../dom/el";
import { markAgo, markLive } from "../dom/live-clock";
import { AFTER_THE_FACT, UNOWNED_TITLE, healthClass, needsUserReason, nodeFlags, ownerChip, resultChip } from "../views/node-flags";
import { truncate } from "../dom/format";
import {
  NODE_H,
  NODE_W,
  ORCH_NODE_H,
  ORCH_NODE_W,
  layoutDag,
} from "./dag-layout";
import type { DagLayout } from "./dag-layout";
import { harnessMarkGroup } from "./harness-mark";
import { paletteClass } from "../../../shared/status-palette";
import { modelPick } from "./model-pick";
import { cardUsageMetric, durationMetric, modelMetric, roleTierMetric, waitReason, waitingOnDeps } from "./node-metrics";
import type { Metric } from "./node-metrics";
import { profilePalette } from "./profile-color";
import type { ProfilePalette } from "./profile-color";

type Point = { x: number; y: number };

const HARNESS_MARK_SIZE: number = 15;
// Shorter than the bare node width allows: the harness glyph now sits in the top-right corner.
const LABEL_MAX: number = 19;

// Every node always carries seven rows: label, status and attempt, model, then below a hairline the
// duration, the usage and cost, role and tier, and the health line. A missing value is drawn as a muted
// placeholder, never left out, so a card reads the same whatever the node recorded.
const STATUS_Y: number = 42;
const MODEL_Y: number = 58;
const METRICS_RULE_Y: number = 67;
const DURATION_Y: number = 83;
const USAGE_Y: number = 98;
const ROLE_TIER_Y: number = 113;
const META_LEFT_X: number = 14;
const META_RIGHT_X: number = NODE_W - 12;
/** Advance width of the 11px monospace the lower rows use. */
const META_CHAR_PX: number = 6.6;
const META_MIN_CHARS: number = 6;
const META_MAX_CHARS: number = Math.floor((NODE_W - META_LEFT_X - (NODE_W - META_RIGHT_X)) / META_CHAR_PX);
/** Baseline of the stage labels, inside the canvas's top padding. */
const HEALTH_Y: number = 129;
const STAGE_LABEL_Y: number = 16;

/** `HH:MM` of an ISO time, local clock; null when the value is not a time. */
export function retryClock(iso: string | null | undefined): string | null {
  const ms = iso === undefined || iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toTimeString().slice(0, 5);
}

/**
 * The status row: `done · attempt 1/5`. A running node with progress reads `running 3/10 · attempt 1/5`;
 * an errored node with a retry time reads `error 2/5 · retry 14:02`. Fits the node's width.
 */
export function statusLine(node: RunNode, maxAttempts: number): string {
  const progress = node.status === "running" && node.progress !== undefined && node.progress !== null && node.progress !== "" ? node.progress : null;
  const retry = node.status === "error" ? retryClock(node.next_retry_at) : null;
  const text =
    retry === null
      ? `${node.status}${progress === null ? "" : ` ${progress}`} · ${attemptLine(node, maxAttempts)}`
      : `${node.status} ${(node.attempts ?? []).length + 1}/${maxAttempts === -1 ? "∞" : maxAttempts} · retry ${retry}`;
  return truncate(text, Math.max(META_MIN_CHARS, META_MAX_CHARS));
}

export function attemptLine(node: RunNode, maxAttempts: number): string {
  const current = (node.attempts ?? []).length + 1;
  if (maxAttempts === -1) {
    return `attempt ${current}/∞`;
  }
  if (current > maxAttempts) {
    return `manual retry ${current}`;
  }
  return `attempt ${current}/${maxAttempts}`;
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
    "aria-label": `orch orchestrator, run ${run.status}`,
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
  const session = run.harness_session !== "" ? truncate(run.harness_session, 14) : "orchestrator";
  group.appendChild(
    svgText({ class: "orch-sub", x: String(ORCH_NODE_W / 2), y: String(ORCH_NODE_H - 24), "text-anchor": "middle" }, session),
  );
  return group;
}

function metricText(metric: Metric, base: string, x: number, y: number, max: number, anchor: string = "start"): SVGElement {
  const text = svgText(
    { class: `${base}${metric.present ? "" : " missing"}`, x: String(x), y: String(y), "text-anchor": anchor },
    truncate(metric.text, max),
  );
  const title = svgEl("title", {});
  title.textContent = metric.title;
  text.appendChild(title);
  return text;
}

/** Duration (live while running), role and tier, and usage, under a hairline. Always all drawn. */
function appendMetrics(group: SVGElement, node: RunNode, run: TimedRun | null): void {
  group.appendChild(
    svgEl("line", {
      class: "metrics-rule",
      x1: String(META_LEFT_X),
      y1: String(METRICS_RULE_Y),
      x2: String(META_RIGHT_X),
      y2: String(METRICS_RULE_Y),
    }),
  );
  const duration = durationMetric(node, run);
  const durationText = metricText(duration, "metric dur", META_LEFT_X, DURATION_Y, META_MAX_CHARS);
  if (duration.liveSince !== null) {
    markLive(durationText, duration.liveSince);
  }
  group.appendChild(durationText);
  group.appendChild(metricText(cardUsageMetric(node), "metric cost", META_LEFT_X, USAGE_Y, META_MAX_CHARS));
  group.appendChild(metricText(roleTierMetric(node), "metric role", META_LEFT_X, ROLE_TIER_Y, META_MAX_CHARS));
  appendHealth(group, node);
}

/** A node blocked on the user carries its own "needs you" chip, the reason in its tooltip. */
function needsYouChip(reason: string): SVGElement {
  const chip = svgEl("g", { class: "needs-you-chip", transform: `translate(${META_LEFT_X} ${HEALTH_Y - 11})`, "data-needs-user": "" });
  const title = svgEl("title", {});
  title.textContent = `needs you: ${reason}`;
  chip.appendChild(title);
  chip.appendChild(svgEl("rect", { width: "62", height: "15", rx: "7.5" }));
  chip.appendChild(svgText({ x: "31", y: "11", "text-anchor": "middle" }, "needs you"));
  return chip;
}

/** Bottom-right of the card: stale/unowned/after-the-fact as words, and the live last-activity age. */
function appendHealth(group: SVGElement, node: RunNode): void {
  const reason = needsUserReason(node);
  if (reason !== null) {
    group.appendChild(needsYouChip(reason));
    return;
  }
  const flags = nodeFlags(node);
  const ownerWord = ownerChip(node);
  const word = flags.stale ? "stale" : flags.unowned ? "unowned" : ownerWord !== null ? ownerWord.text : flags.afterTheFact ? "after the fact" : "";
  const last = node.status === "running" ? (node.last_activity ?? node.updated ?? node.started) : null;
  if (word === "" && (last === null || last === undefined)) {
    return;
  }
  const text = svgText(
    { class: healthClass(node), x: String(META_LEFT_X), y: String(HEALTH_Y) },
    word,
  );
  if (last !== null && last !== undefined) {
    markAgo(text, last, word !== "" ? `${word} · ` : "");
  }
  group.appendChild(text);
  if (word !== "") {
    const title = svgEl("title", {});
    title.textContent = flags.unowned ? UNOWNED_TITLE : word === "after the fact" ? AFTER_THE_FACT : "no activity for a while";
    group.appendChild(title);
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
  maxAttempts: number,
  waitingOn: readonly string[] = [],
  run: TimedRun | null = null,
): SVGElement {
  const label = nodeLabel(node);
  const profile = profileKey(node);
  const harness = harnessOf(node, harnessByProfile);
  const pick = modelPick(node);
  const model = modelMetric(node, META_MAX_CHARS);
  const usage = cardUsageMetric(node);
  const duration = durationMetric(node, run);
  const attempt = attemptLine(node, maxAttempts);
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
    }, ${model.present ? `model ${model.text}` : model.text}${
      pick?.tier != null ? `, tier ${pick.tier}` : ""
    }, ${duration.text}, ${usage.text}, ${roleTierMetric(node).text}, ${attempt}${needsUserReason(node) !== null ? ", needs you" : ""}`,
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
  const wait = waitReason(node, waitingOn, Math.max(META_MIN_CHARS, META_MAX_CHARS));
  const status = svgText({ class: "st", x: String(META_LEFT_X), y: String(STATUS_Y) }, wait === null ? statusLine(node, maxAttempts) : wait.text);
  if (wait !== null) {
    const title = svgEl("title", {});
    title.textContent = wait.title;
    status.appendChild(title);
  }
  group.appendChild(status);
  group.appendChild(
    metricText(model, pick?.isAuto === true ? "model auto" : "model", META_LEFT_X, MODEL_Y, META_MAX_CHARS),
  );
  if (pick?.isAuto === true) {
    const details = [pick.model, pick.tier, pick.role, pick.reason].filter((part) => part !== null);
    const title = svgEl("title", {});
    title.textContent = `${pick.isExpected ? "expected " : ""}${details.join(" · ")}`;
    group.appendChild(title);
  }
  appendMetrics(group, node, run);
  const verdict = resultChip(node);
  if (verdict !== null) {
    const chip = svgEl("g", {
      class: `result-chip result-${verdict.verdict} ${paletteClass(verdict.verdict)}`.trim(),
      transform: `translate(${META_RIGHT_X - 60} ${STATUS_Y - 11})`,
      "data-result": verdict.verdict,
    });
    const tip = svgEl("title", {});
    const followUp = verdict.followUp !== "" && verdict.followUp.toLowerCase() !== "none" ? `follow_up: ${verdict.followUp}` : "";
    tip.textContent = [verdict.summary, followUp].filter((t) => t !== "").join("\n") || verdict.verdict;
    chip.appendChild(tip);
    chip.appendChild(svgEl("rect", { width: "60", height: "15", rx: "7.5" }));
    chip.appendChild(svgText({ x: "30", y: "11", "text-anchor": "middle" }, verdict.verdict));
    group.appendChild(chip);
  }
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

/** Labels each column in the top padding: which stage, and how many of its nodes run at once. */
function appendStageLabels(svg: SVGElement, layout: DagLayout): void {
  if (layout.stages.length < 2) {
    return;
  }
  for (const stage of layout.stages) {
    const text = stage.count > 1 ? `stage ${stage.index + 1} · ${stage.count} parallel` : `stage ${stage.index + 1}`;
    svg.appendChild(svgText({ class: "stage-label", x: String(stage.x + 2), y: String(STAGE_LABEL_Y) }, text));
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
  maxAttempts: number = 5,
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
  appendStageLabels(svg, layout);
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
      nodeGroup(node, nodePos, selectedId === node.id, isCyclic, onSelect, palette, harnessByProfile, maxAttempts, waitingOnDeps(run, node.id), run),
    );
  }
  return svg;
}
