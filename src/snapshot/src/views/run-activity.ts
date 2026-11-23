import type { RunEvent } from "../../../shared/types/run-event";
import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { el } from "../dom/el";
import { markAgo } from "../dom/live-clock";
import { fmtTime } from "../dom/format";
import { nodeFlags } from "./node-flags";

const MS_PER_MINUTE = 60_000;
const SHOWN_EVENTS = 50;

export function describeEvent(e: RunEvent): string {
  switch (e.kind) {
    case "status":
      return `${e.from ?? "—"} → ${e.to ?? "—"}${e.note !== null ? `: ${e.note}` : ""}`;
    case "note":
      return e.note ?? "note";
    case "ping":
      return e.note !== null ? `progress ${e.note}` : "ping";
    case "add":
      return "added";
    case "remove":
      return "removed";
    case "retry":
      return "reset for retry";
    case "run":
      return `run ${e.to ?? ""}`.trim();
    default:
      return e.kind;
  }
}

function minutesQuiet(node: RunNode, nowMs: number): number {
  const at = node.last_activity ?? node.updated ?? node.started;
  const t = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((nowMs - t) / MS_PER_MINUTE));
}

/** The warning above the graph when running nodes have gone quiet; null when none has. */
export function staleBanner(run: RunState, nowMs: number = Date.now()): HTMLElement | null {
  const stale = run.nodes.filter((n) => nodeFlags(n).stale);
  if (stale.length === 0) {
    return null;
  }
  const mins = Math.min(...stale.map((n) => minutesQuiet(n, nowMs)));
  const noun = stale.length === 1 ? "node is" : "nodes are";
  const names = stale.map((n) => n.label || n.id).join(", ");
  return el("div", { class: "notice warn run-stale-banner", role: "status" }, [
    el("b", { text: `${stale.length} ${noun} running but nothing has changed for ${mins} min. ` }),
    el("span", { text: `The orchestrator may have stopped updating. ${names}` }),
  ]);
}

/** Newest first, live: each row is time, node, change. */
export function renderActivity(events: readonly RunEvent[]): HTMLElement {
  const section = el("section", { class: "panel run-activity", "aria-label": "Activity" });
  section.appendChild(el("h2", { text: "Activity" }));
  if (events.length === 0) {
    section.appendChild(el("p", { class: "hint panel-empty", text: "No activity recorded yet." }));
    return section;
  }
  const items = [...events].reverse().slice(0, SHOWN_EVENTS).map((e) => {
    const ago = el("span", { class: "activity-ago muted" });
    markAgo(ago, e.at);
    ago.setAttribute("title", fmtTime(e.at));
    return el("li", { class: `activity-row kind-${e.kind}` }, [
      ago,
      el("span", { class: "activity-node mono", text: e.node ?? "run" }),
      el("span", { class: "activity-text", text: describeEvent(e) }),
    ]);
  });
  section.appendChild(el("ul", { class: "activity-list" }, items));
  return section;
}

/** Newest sign of life in the run, for "updated Ns ago"; null for a run with none. */
export function runUpdatedAt(run: RunState, events: readonly RunEvent[]): string | null {
  const stamps: string[] = [run.started];
  for (const n of run.nodes) {
    for (const s of [n.updated, n.last_activity, n.finished, n.started]) {
      if (s) {
        stamps.push(s);
      }
    }
  }
  const last = events.at(-1);
  if (last) {
    stamps.push(last.at);
  }
  return stamps.reduce((best, s) => (Date.parse(s) > Date.parse(best) ? s : best));
}
