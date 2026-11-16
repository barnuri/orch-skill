import { nodeUsage, runUsage } from "../../shared/run-usage";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { fmtDur, fmtTokens, fmtUsd, truncate } from "./format";
import { modelPick, pickLabel, shortModel } from "./model-pick";
import { holdReason, needsUserReason } from "./node-flags";

/** One value the UI always shows: `present` false means `text` is a placeholder, `title` says why. */
export interface Metric {
  text: string;
  title: string;
  present: boolean;
}

export interface DurationMetric extends Metric {
  /** ISO start when the text must tick every second, else null. */
  liveSince: string | null;
}

export const NO_MODEL_TEXT = "model not reported";
export const NO_USAGE_TEXT = "no usage reported";
export const NOT_STARTED_TEXT = "not started";

export const NO_ACTUAL_TEXT = "actual model —";
const ARROW = " → ";
const ALIAS_MIN_CHARS = 4;

function nonEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

/**
 * The requested alias and the model that really served the node, or null when the node has no
 * `actual_model`, names no alias, or the two are the same model.
 */
export function aliasActual(node: RunNode): { alias: string; actual: string } | null {
  const actual = nonEmpty(node.actual_model);
  const alias = nonEmpty(node.model_id) ?? nonEmpty(node.model);
  if (actual === null || alias === null || alias === actual || shortModel(alias) === shortModel(actual)) {
    return null;
  }
  return { alias, actual };
}

/** `alias → actual` in short names; the alias is cut first so the actual model stays readable. */
export function aliasActualText(pair: { alias: string; actual: string }, max: number = Number.POSITIVE_INFINITY): string {
  const actual = shortModel(pair.actual);
  const alias = shortModel(pair.alias);
  const room = max - actual.length - ARROW.length;
  return `${alias.length <= room ? alias : truncate(alias, Math.max(ALIAS_MIN_CHARS, room))}${ARROW}${actual}`;
}

/** The model that really served the node, or the muted `actual model —` placeholder. */
export function actualModelMetric(node: RunNode): Metric {
  const actual = nonEmpty(node.actual_model);
  return actual === null
    ? { text: NO_ACTUAL_TEXT, present: false, title: "No served model was read from the node's session yet." }
    : { text: actual, present: true, title: `${actual}: the model that served the node, read from its session` };
}

/**
 * The card's model row. `alias → actual` when the session reports a served model that differs
 * from the requested alias; otherwise the pick alone. `max` fits the arrow form to a card row.
 */
export function modelMetric(node: RunNode, max: number = Number.POSITIVE_INFINITY): Metric {
  const pair = aliasActual(node);
  if (pair !== null) {
    return { text: aliasActualText(pair, max), present: true, title: `${pair.alias} → ${pair.actual}: the requested alias, then the model that served the node` };
  }
  const pick = modelPick(node);
  if (pick === null) {
    const served = nonEmpty(node.actual_model);
    if (served !== null) {
      return { text: shortModel(served), present: true, title: `${served}: the model that served the node, read from its session` };
    }
    return {
      text: NO_MODEL_TEXT,
      present: false,
      title: "No model was recorded for this node. `node add --model M` or `node report --model M` sets it.",
    };
  }
  const source = pick.isAuto
    ? pick.isExpected
      ? "the hub expected this model before dispatch"
      : "the model that served the node, reported by the hub"
    : node.report?.model === pick.model
      ? "reported by the coordinator"
      : "the model of the node's profile";
  return { text: pickLabel(pick), present: true, title: `${pick.model}: ${source}` };
}

function inlineReason(node: RunNode): string {
  return node.job_id === null
    ? "ran inline in the coordinator session"
    : `the harness reported no usage for job ${node.job_id}`;
}

export function usageMetric(node: RunNode): Metric {
  const usage = nodeUsage(node);
  const origin =
    usage.source === "report"
      ? "reported by the coordinator"
      : usage.source === "session"
        ? `from opencode session ${node.session_stats?.session ?? ""}`.trim()
        : "reported by the harness";
  if (usage.usd !== null) {
    const tokens = usage.tokens === null ? "" : `, ${fmtTokens(usage.tokens)}`;
    return { text: fmtUsd(usage.usd), present: true, title: `${fmtUsd(usage.usd)}${tokens}: ${origin}` };
  }
  if (usage.tokens !== null) {
    return { text: fmtTokens(usage.tokens), present: true, title: `${fmtTokens(usage.tokens)}: ${origin}; no dollar cost was reported` };
  }
  return { text: NO_USAGE_TEXT, present: false, title: `${inlineReason(node)}: no usage was reported` };
}

/**
 * Elapsed time. Running nodes carry `liveSince` so the caller can tick them; waiting nodes read
 * "not started"; a finished node with no start stamp says so rather than showing a blank.
 */
export function durationMetric(node: RunNode): DurationMetric {
  const { status, started, finished } = node;
  const stats = node.session_stats ?? null;
  // Fallback when the node's own stamps cannot give a duration: the bound opencode session's span.
  const sessionDuration = (): DurationMetric | null =>
    stats === null || !(stats.duration_s > 0)
      ? null
      : { text: fmtDur(stats.created, stats.updated), present: true, liveSince: null, title: `${stats.created} to ${stats.updated}: the bound opencode session` };
  if (status === "running" && started !== null) {
    return { text: fmtDur(started), present: true, liveSince: started, title: `running since ${started}` };
  }
  if (started === null) {
    const fromSession = sessionDuration();
    if (fromSession !== null) {
      return fromSession;
    }
    if (status === "waiting" || status === "skipped" || status === "running") {
      const why = status === "waiting" ? "waiting for its dependencies or dispatch" : status === "skipped" ? "skipped before it started" : "marked running without a start time";
      return { text: status === "running" ? "running" : NOT_STARTED_TEXT, present: false, liveSince: null, title: why };
    }
    return { text: "duration unknown", present: false, liveSince: null, title: "this node was never marked running, so no start time was recorded" };
  }
  if (finished === null) {
    const fromSession = sessionDuration();
    if (fromSession !== null) {
      return fromSession;
    }
    return { text: "duration unknown", present: false, liveSince: null, title: "this node has a start time but no finish time" };
  }
  const inline = node.job_id === null ? "; ran inline, so this is the time between its node update calls" : "";
  return { text: fmtDur(started, finished), present: true, liveSince: null, title: `${started} to ${finished}${inline}` };
}

export const NO_ROLE_TEXT = "role —";
export const NO_TIER_TEXT = "tier —";

/**
 * The card's role and tier row, always drawn: `planning · balance`, with `role —` / `tier —` for a
 * value the node was not added with. Muted (not present) only when both are missing.
 */
export function roleTierMetric(node: RunNode): Metric {
  const role: string | null = node.role ?? null;
  const tier: string | null = node.tier ?? null;
  const text = `${role ?? NO_ROLE_TEXT} · ${tier ?? NO_TIER_TEXT}`;
  const missing = [role === null ? "role" : null, tier === null ? "tier" : null].filter((part): part is string => part !== null);
  const title =
    missing.length === 0
      ? `role ${role ?? ""} · tier ${tier ?? ""}`
      : `${role !== null ? `role ${role}; ` : tier !== null ? `tier ${tier}; ` : ""}no ${missing.join(" or ")} was recorded for this node. \`node add --role R --tier T\` sets them.`;
  return { text, present: role !== null || tier !== null, title };
}

export const NO_TOKENS_TEXT = "usage —";
export const NO_COST_TEXT = "cost —";

/**
 * The card's usage row, always both halves: tokens then dollar cost, `usage —` / `cost —` for the
 * half the node did not report. Muted only when neither was reported; the tooltip is usageMetric's.
 */
export function cardUsageMetric(node: RunNode): Metric {
  const usage = nodeUsage(node);
  const title = usageMetric(node).title;
  const tokens = usage.tokens === null ? NO_TOKENS_TEXT : fmtTokens(usage.tokens);
  const usd = usage.usd === null ? NO_COST_TEXT : fmtUsd(usage.usd);
  return { text: `${tokens} · ${usd}`, present: usage.tokens !== null || usage.usd !== null, title };
}

/** `role · tier`, or null when neither is set. */
export function roleTierText(node: RunNode): string | null {
  const raw: (string | null)[] = [node.role ?? null, node.tier ?? null];
  const parts = raw.filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The effort the node ran with, from its newest selection event: confirmed, else sent, else
 * selected, else requested. Null when no selection event carries an effort.
 */
export function effortText(node: RunNode): string | null {
  const history = node.selection_history ?? [];
  const latest = history.reduce<(typeof history)[number] | null>((best, event) => (best === null || event.seq > best.seq ? event : best), null);
  if (latest === null) {
    return null;
  }
  return nonEmpty(latest.confirmed_effort) ?? nonEmpty(latest.sent_effort) ?? nonEmpty(latest.selected_effort) ?? nonEmpty(latest.requested_effort);
}

export interface RunTotals {
  duration: DurationMetric;
  usage: Metric;
  done: number;
  total: number;
}

export function runTotals(run: Pick<RunState, "started" | "finished" | "nodes">): RunTotals {
  const usage = runUsage(run.nodes);
  const done = run.nodes.filter((node) => node.status === "done").length;
  const live = run.finished === null || run.finished === undefined;
  const duration: DurationMetric = {
    text: fmtDur(run.started, run.finished ?? undefined),
    present: true,
    liveSince: live ? run.started : null,
    title: live ? `running since ${run.started}` : `${run.started} to ${run.finished}`,
  };
  return { duration, usage: usageTotalMetric(usage), done, total: run.nodes.length };
}

export function usageTotalMetric(usage: ReturnType<typeof runUsage>): Metric {
  const of = `${usage.reporting} of ${usage.total} nodes reported usage`;
  if (usage.usd !== null) {
    return { text: fmtUsd(usage.usd), present: true, title: `${of}${usage.tokens === null ? "" : `, ${fmtTokens(usage.tokens)}`}` };
  }
  if (usage.tokens !== null) {
    return { text: fmtTokens(usage.tokens), present: true, title: `${of}; no dollar cost was reported` };
  }
  return { text: NO_USAGE_TEXT, present: false, title: `${of}` };
}

/** Run totals for a list row, from the server summary where only sums are known. */
export function summaryUsageMetric(summary: { usd?: number | null; tokens?: number | null }): Metric {
  const usd = summary.usd ?? null;
  const tokens = summary.tokens ?? null;
  if (usd !== null) {
    return { text: fmtUsd(usd), present: true, title: `${fmtUsd(usd)}${tokens === null ? "" : `, ${fmtTokens(tokens)}`} across the run` };
  }
  if (tokens !== null) {
    return { text: fmtTokens(tokens), present: true, title: `${fmtTokens(tokens)} across the run; no dollar cost was reported` };
  }
  return { text: NO_USAGE_TEXT, present: false, title: "No node in this run reported usage" };
}

/** Width, in characters, of the lower rows of a graph node card (11px monospace). */
export const META_MAX_CHARS: number = 26;
const META_MIN_CHARS: number = 6;

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

/** The status row of a node card: `done · attempt 1/5`. Fits the node's width. */
export function statusLine(node: RunNode, maxAttempts: number): string {
  return truncate(`${node.status} · ${attemptLine(node, maxAttempts)}`, Math.max(META_MIN_CHARS, META_MAX_CHARS));
}

export const READY_NOT_STARTED_TEXT = "ready, not started";

/** The unfinished (waiting or running) dependencies of a node, in edge order. */
export function waitingOnDeps(run: Pick<RunState, "nodes" | "edges">, id: string): string[] {
  const statusById = new Map(run.nodes.map((node) => [node.id, node.status]));
  return run.edges.filter(([from, to]) => to === id && (statusById.get(from) === "waiting" || statusById.get(from) === "running")).map(([from]) => from);
}

/** Why a waiting node has not started, and the full text for its tooltip. */
export interface WaitReason {
  kind: "deps" | "needs-user" | "held" | "ready";
  text: string;
  title: string;
}

/**
 * Why a waiting node has not started, first match wins: an unfinished dependency, the user, a
 * coordinator hold, else ready. `max` truncates `text` (the card row); null for a node not waiting.
 */
export function waitReason(node: RunNode, waitingOn: readonly string[], max: number = Number.POSITIVE_INFINITY): WaitReason | null {
  if (node.status !== "waiting") {
    return null;
  }
  const fit = (text: string): string => (Number.isFinite(max) ? truncate(text, max) : text);
  if (waitingOn.length > 0) {
    return { kind: "deps", text: fit(`waiting on ${waitingOn[0]}${waitingOn.length > 1 ? ` +${waitingOn.length - 1}` : ""}`), title: `Waiting on: ${waitingOn.join(", ")}` };
  }
  const needs = needsUserReason(node);
  if (needs !== null) {
    return { kind: "needs-user", text: fit(`needs you: ${needs}`), title: `Needs you: ${needs}` };
  }
  const hold = holdReason(node);
  if (hold !== null) {
    return { kind: "held", text: fit(`held: ${hold}`), title: `Held by the coordinator: ${hold}` };
  }
  return { kind: "ready", text: fit(READY_NOT_STARTED_TEXT), title: "Every dependency is done; the coordinator has not started it yet" };
}
