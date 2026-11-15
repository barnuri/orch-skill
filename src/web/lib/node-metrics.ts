import { nodeUsage, runUsage } from "../../shared/run-usage";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { fmtDur, fmtTokens, fmtUsd, truncate } from "./format";
import { modelPick, pickLabel } from "./model-pick";

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

export function modelMetric(node: RunNode): Metric {
  const pick = modelPick(node);
  if (pick === null) {
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
  const origin = usage.source === "report" ? "reported by the coordinator" : "reported by the harness";
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
  if (status === "running" && started !== null) {
    return { text: fmtDur(started), present: true, liveSince: started, title: `running since ${started}` };
  }
  if (started === null) {
    if (status === "waiting" || status === "skipped" || status === "running") {
      const why = status === "waiting" ? "waiting for its dependencies or dispatch" : status === "skipped" ? "skipped before it started" : "marked running without a start time";
      return { text: status === "running" ? "running" : NOT_STARTED_TEXT, present: false, liveSince: null, title: why };
    }
    return { text: "duration unknown", present: false, liveSince: null, title: "this node was never marked running, so no start time was recorded" };
  }
  if (finished === null) {
    return { text: "duration unknown", present: false, liveSince: null, title: "this node has a start time but no finish time" };
  }
  const inline = node.job_id === null ? "; ran inline, so this is the time between its node update calls" : "";
  return { text: fmtDur(started, finished), present: true, liveSince: null, title: `${started} to ${finished}${inline}` };
}

/** `role · tier`, or null when neither is set. */
export function roleTierText(node: RunNode): string | null {
  const raw: (string | null)[] = [node.role ?? null, node.tier ?? null];
  const parts = raw.filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
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
