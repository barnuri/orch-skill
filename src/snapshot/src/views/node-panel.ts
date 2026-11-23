import type { TimedRun } from "../../../shared/node-timing";
import type { NodeCost } from "../../../shared/types/node-cost";
import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { ApiClient } from "../api/api-client";
import { chip, el } from "../dom/el";
import { fmtTime, fmtTokens, fmtUsd } from "../dom/format";
import { markAgo, markLive } from "../dom/live-clock";
import { attemptLine } from "../graph/render-graph";
import { actualModelMetric, aliasActual, aliasActualText, durationMetric, modelMetric, roleTierText, usageMetric, waitReason, waitingOnDeps } from "../graph/node-metrics";
import type { Metric } from "../graph/node-metrics";
import { poll } from "../poll";
import { toast } from "../ui/toast";
import { renderNodeTranscript } from "./node-transcript";
import { modelPick, pickLabel } from "../graph/model-pick";
import { stripAnsi } from "../dom/ansi";
import { selectionTimeline } from "./selection-timeline";
import { AFTER_THE_FACT, UNOWNED_TITLE, handoffText, nodeFlags, ownerChip, ownerIdShort, ownerText } from "./node-flags";

const NODE_PANEL_ID: string = "node-panel";
const SELECTED_CLASS: string = "just-selected";
/** Lines of each earlier attempt's log kept in the panel; the full log is in Output. */
const ATTEMPT_TAIL_LINES: number = 8;
const api = new ApiClient();

function detailRow(list: HTMLElement, key: string, value: string, cls: string = ""): HTMLElement {
  list.appendChild(el("dt", { text: key }));
  const dd = el("dd", { class: cls, text: value });
  list.appendChild(dd);
  return dd;
}

/** A row whose value may be a placeholder: muted, with the reason in its tooltip. */
function metricRow(list: HTMLElement, key: string, metric: Metric, cls: string = ""): HTMLElement {
  const dd = detailRow(list, key, metric.text, `${cls}${metric.present ? "" : " missing"}`.trim());
  dd.setAttribute("title", metric.title);
  return dd;
}

function fmtCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

/**
 * The cost rows. `cost_basis` is the harness's own word for what the figure means — in practice
 * `list`, i.e. list price, which is not what a subscription is billed. Saying so is the whole
 * point of carrying the field: a bare dollar amount would read as money actually charged.
 */
function appendCostRows(list: HTMLElement, cost: NodeCost): void {
  detailRow(list, "cost", `${fmtUsd(cost.usd)} ${cost.cost_basis} price`);
  detailRow(
    list,
    "tokens",
    `${fmtCount(cost.input_tokens)} in · ${fmtCount(cost.output_tokens)} out`,
    "mono",
  );
  if (cost.cache_read_tokens > 0 || cost.cache_creation_tokens > 0) {
    detailRow(
      list,
      "cache",
      `${fmtCount(cost.cache_read_tokens)} read · ${fmtCount(cost.cache_creation_tokens)} written`,
      "mono",
    );
  }
  // Only worth a breakdown when more than one model was touched; otherwise it restates the rows
  // above with the model id the profile already names. One row, not one per model: the panel's
  // key column is a fixed 84px and a model id does not fit in it.
  if (cost.models.length < 2) {
    return;
  }
  const lines = cost.models
    .map((model) => `${model.model}  ${fmtUsd(model.usd)}`)
    .join("\n");
  detailRow(list, "models", lines, "mono cost-models");
}

function compactCost(cost: NodeCost | null | undefined): string {
  if (cost === undefined || cost === null) {
    return "no usage reported";
  }
  if (Number.isFinite(cost.usd) && cost.usd > 0) {
    return fmtUsd(cost.usd);
  }
  const tokens = cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_creation_tokens;
  return tokens > 0 ? fmtTokens(tokens) : "no usage reported";
}

function appendActivityRows(list: HTMLElement, node: RunNode): void {
  const flags = nodeFlags(node);
  const owner = ownerText(node);
  if (node.owner_state) {
    detailRow(list, "owner state", node.owner_state);
  }
  detailRow(list, "owner", owner === null ? "not recorded" : `owned by ${owner}`, owner === null ? "missing" : "");
  const last = node.status === "running" ? (node.last_activity ?? node.updated ?? node.started) : null;
  if (last !== null && last !== undefined) {
    const row = detailRow(list, "activity", "");
    markAgo(row, last, "last activity ");
  }
  if (node.progress) {
    detailRow(list, "progress", node.progress, "mono");
  }
  for (const note of (node.notes ?? []).slice(-3)) {
    detailRow(list, "note", `${note.text} (${fmtTime(note.at)})`);
  }
  if (flags.afterTheFact) {
    detailRow(list, "recorded", AFTER_THE_FACT, "missing");
  }
}

function flagChips(node: RunNode): HTMLElement[] {
  const flags = nodeFlags(node);
  const chips: HTMLElement[] = [];
  if (flags.stale) {
    chips.push(chip("stale"));
  }
  const owner = ownerChip(node);
  if (owner !== null) {
    const c = chip(owner.cls);
    c.textContent = owner.text;
    c.setAttribute("title", owner.title);
    chips.push(c);
  }
  if (flags.unowned) {
    const unowned = chip("unowned");
    unowned.setAttribute("title", UNOWNED_TITLE);
    chips.push(unowned);
  }
  return chips;
}

function detailList(node: RunNode, maxAttempts: number, waitingOn: readonly string[] = [], run: TimedRun | null = null): HTMLElement {
  const list = el("dl");
  detailRow(list, "id", node.id, "mono");
  detailRow(list, "status", node.status);
  const wait = waitReason(node, waitingOn);
  if (wait !== null) {
    detailRow(list, "why", wait.text, `wait-reason wait-${wait.kind}`).setAttribute("title", wait.title);
  }
  appendActivityRows(list, node);
  metricRow(list, "model", modelMetric(node), "mono");
  metricRow(list, "actual", actualModelMetric(node), "mono");
  const duration = durationMetric(node, run);
  const durationRow = metricRow(list, "duration", duration);
  if (duration.liveSince !== null) {
    markLive(durationRow, duration.liveSince);
  }
  metricRow(list, "usage", usageMetric(node), "mono");
  detailRow(list, "attempt", attemptLine(node, maxAttempts));
  const roleTier = roleTierText(node);
  detailRow(list, "role · tier", roleTier ?? "not set", roleTier === null ? "missing" : "");
  detailRow(list, "profile", node.profile ?? "—");
  detailRow(list, "owner id", ownerIdShort(node) ?? "—", "mono");
  const handoff = handoffText(node);
  if (handoff !== null) {
    detailRow(list, "handoff", handoff.text, handoff.missing ? "missing" : "");
  }
  detailRow(list, "adapter", node.adapter ?? "—");
  detailRow(list, "job", node.job_id ?? "—", "mono");
  detailRow(list, "session", node.session ?? "—", "mono");
  detailRow(list, "started", fmtTime(node.started));
  detailRow(list, "finished", fmtTime(node.finished));
  const cost = node.cost;
  if (cost !== undefined && cost !== null) {
    appendCostRows(list, cost);
  }
  appendReportRows(list, node);
  if (node.error !== null) {
    detailRow(list, "error", node.error, "err");
  }
  return list;
}

function appendReportRows(list: HTMLElement, node: RunNode): void {
  const report = node.report;
  if (report === undefined || report === null) {
    return;
  }
  const part = (value: number | null, label: string): string | null =>
    value === null ? null : `${value.toLocaleString()} ${label}`;
  const tokens = [part(report.input_tokens, "in"), part(report.output_tokens, "out"), part(report.cache_read_tokens, "cache read")]
    .filter((text): text is string => text !== null)
    .join(" · ");
  detailRow(list, "reported", `by the orchestrator (${report.reported_by}) at ${fmtTime(report.at)}`);
  if (report.usd !== null) {
    detailRow(list, "report cost", fmtUsd(report.usd));
  }
  if (tokens !== "") {
    detailRow(list, "report tokens", tokens, "mono");
  }
  if (report.note !== null) {
    detailRow(list, "note", report.note);
  }
}

/** The model block: the model that ran, large, with how Smart Auto chose it underneath. */
function modelBlock(node: RunNode): HTMLElement {
  const pick = modelPick(node);
  const pair = aliasActual(node);
  if (pick === null) {
    const metric = modelMetric(node);
    return el("section", { class: `model-pick${metric.present ? "" : " is-missing"}`, "aria-label": "Model", title: metric.title }, [
      el("div", { class: "model-pick-key", text: "Model" }),
      el("div", { class: `model-pick-name mono${metric.present ? "" : " missing"}`, text: metric.text }),
    ]);
  }
  const facts = [
    pick.tier !== null ? `tier ${pick.tier}` : null,
    pick.role,
    pick.reason,
  ].filter((part): part is string => part !== null);
  return el("section", { class: `model-pick${pick.isAuto ? " is-auto" : ""}`, "aria-label": "Model" }, [
    el("div", { class: "model-pick-key", text: pick.isAuto ? (pick.isExpected ? "Smart Auto · expected" : "Smart Auto picked") : "Model" }),
    el("div", {
      class: "model-pick-name mono",
      title: pair === null ? pick.model : `${pair.alias} → ${pair.actual}`,
      text: pair === null ? pickLabel(pick) : aliasActualText(pair),
    }),
    facts.length > 0 ? el("div", { class: "model-pick-facts", text: facts.join(" · ") }) : null,
    pick.selector !== null ? el("div", { class: "model-pick-sel mono", text: `via ${pick.selector}` }) : null,
  ]);
}

function retryNode(runId: string, node: RunNode, button: HTMLButtonElement): void {
  button.disabled = true;
  void api.retryNode(runId, node.id).then((result) => {
    button.disabled = false;
    if (result.kind === "ok") {
      toast("ok", `Retrying ${node.id}`);
      void poll();
      return;
    }
    if (result.kind === "error") {
      toast("error", result.body?.error ?? "Retry failed");
      return;
    }
    toast("error", "Retry failed");
  });
}

function retryButton(run: RunState, node: RunNode): HTMLButtonElement | null {
  if (node.status !== "error") {
    return null;
  }
  const button = el("button", { class: "btn primary", type: "button", text: "Retry" });
  button.addEventListener("click", () => {
    retryNode(run.run_id, node, button);
  });
  return button;
}

function attemptsHistory(node: RunNode): HTMLElement | null {
  const attempts = node.attempts ?? [];
  if (attempts.length === 0) {
    return null;
  }
  const items = attempts.map((attempt, index) => {
    const tail = (attempt.log_tail ?? []).slice(-ATTEMPT_TAIL_LINES);
    const lines = [
      attempt.profile ?? attempt.adapter ?? "—",
      attempt.model_id ?? attempt.model ?? "model not reported",
      attempt.actual_model != null && attempt.actual_model !== (attempt.model_id ?? attempt.model) ? `→ ${attempt.actual_model}` : "",
      compactCost(attempt.cost),
      attempt.finished === null ? "not finished" : fmtTime(attempt.finished),
      attempt.error,
      attempt.retry_mode ?? "",
      attempt.retry_session ?? "",
      attempt.reason ?? "",
    ].filter((part): part is string => typeof part === "string" && part !== "");
    return el("li", { class: `attempt-item${attempt.error !== null ? " has-error" : ""}` }, [
      el("div", { class: "attempt-head" }, [
        el("span", { class: "attempt-no mono", text: `#${index + 1}` }),
        el("span", { class: "attempt-meta mono", text: lines.join(" · ") }),
      ]),
      tail.length > 0
        ? el("pre", { class: "transcript attempt-tail", text: stripAnsi(tail.join("\n")) })
        : null,
    ]);
  });
  return el("section", { class: "attempts", "aria-label": "Attempts history" }, [
    el("h3", { class: "panel-log-title", text: `Attempts — ${attempts.length}` }),
    el("ol", {}, items),
  ]);
}

/** Node details panel below the graph: selected node's details + log tail, or a hint when none is. */
export function renderNodePanel(run: RunState, selectedId: string | null, maxAttempts: number = 5): HTMLElement {
  const node = run.nodes.find((candidate) => candidate.id === selectedId);
  const panel = el("aside", {
    class: "panel node-panel",
    id: NODE_PANEL_ID,
    "aria-live": "polite",
  });
  if (node === undefined) {
    const hint =
      run.nodes.length > 0
        ? "Select a node in the graph to see its profile, job and log."
        : "This run has no nodes yet.";
    panel.appendChild(el("h2", { text: "Node details" }));
    panel.appendChild(el("p", { class: "hint panel-empty", text: hint }));
    return panel;
  }
  panel.classList.add("has-node");
  panel.appendChild(
    el("h2", { class: "node-panel-head" }, [
      el("span", { class: "node-panel-title", text: node.label || node.id }),
      chip(node.status),
      ...flagChips(node),
      el("span", { class: "node-panel-spacer" }),
      retryButton(run, node),
    ]),
  );
  const grid = el("div", { class: "panel-grid" });
  const details = el("div", { class: "panel-details" });
  details.appendChild(modelBlock(node));
  details.appendChild(detailList(node, maxAttempts, waitingOnDeps(run, node.id), run));
  const attempts = attemptsHistory(node);
  if (attempts !== null) {
    details.appendChild(attempts);
  }
  const selections = selectionTimeline(node);
  if (selections !== null) {
    details.appendChild(selections);
  }
  grid.append(details, renderNodeTranscript(node));
  panel.appendChild(grid);
  return panel;
}

/**
 * The graph fills the viewport, so a freshly rendered panel sits below the fold and a click
 * looks like it did nothing. Scroll it just into view and replay a one-shot border flash.
 */
export function revealNodePanel(): void {
  const panel = document.getElementById(NODE_PANEL_ID);
  if (panel === null) {
    return;
  }
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  panel.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "nearest" });
  // The panel is rebuilt on every render, so the class is always fresh — but re-adding it
  // after a reflow keeps the flash replaying when the same panel is reused.
  panel.classList.remove(SELECTED_CLASS);
  void panel.offsetWidth;
  panel.classList.add(SELECTED_CLASS);
}
