import type { ActiveItem } from "../../../shared/types/active-item";
import { ApiClient } from "../api/api-client";
import { el } from "../dom/el";
import { everyLabel, rel, until } from "../dom/format";
import { poll } from "../poll";
import { confirmDialog } from "../ui/confirm-dialog";
import { toast } from "../ui/toast";

const api = new ApiClient();

const COUNTDOWN_ATTR = "data-next";
const DEADLINE_ATTR = "data-deadline";

function cell(label: string, value: string, extra: Record<string, string> = {}, danger = false): HTMLElement {
  return el("div", { class: "active-cell" }, [
    el("span", { class: "active-cell-label", text: label }),
    el("span", { class: `active-cell-value${danger ? " is-er" : ""}`, text: value, ...extra }),
  ]);
}

function runtimeMeter(item: ActiveItem): HTMLElement {
  const meter = el("div", { class: "meter", role: "presentation", title: "Time used of the maximum runtime" });
  const bar = el("span");
  const started = Date.parse(item.started) / 1000;
  const span = item.deadline - started;
  const done = Math.min(1, Math.max(0, (Date.now() / 1000 - started) / span));
  bar.style.width = `${(done * 100).toFixed(1)}%`;
  meter.appendChild(bar);
  return meter;
}

function loopNote(item: ActiveItem): string {
  const session = item.session === "resume" ? "one resumed session" : item.session === "id" ? "a chosen session" : "fresh session each tick";
  return `every ${everyLabel(item.interval)} · ${session}${item.when_idle ? ` · waits for idle (${item.skipped ?? 0} skipped)` : ""}`;
}

/** The progress cell and the timing cell of one row, which differ for a loop and a monitor. */
function metrics(item: ActiveItem): HTMLElement[] {
  if (item.kind === "loop") {
    const max = item.max ?? 0;
    const iteration = item.iteration ?? 0;
    const failed = item.last_exit !== null && item.last_exit !== undefined && item.last_exit !== 0;
    const exit = item.last_exit === null || item.last_exit === undefined ? "no exit yet" : `last exit ${item.last_exit}`;
    const progress = el("div", { class: "active-cell" }, [
      el("span", { class: "active-cell-label", text: "iteration" }),
      el("span", { class: "active-cell-value", text: max > 0 ? `${iteration}/${max}` : String(iteration) }),
      runtimeMeter(item),
      el("span", { class: `active-cell-sub${failed ? " is-er" : ""}`, text: exit }),
    ]);
    return [progress, cell("next tick in", item.status === "running" ? until(item.next ?? 0) : "—", { [COUNTDOWN_ATTR]: String(item.next ?? 0) })];
  }
  const events = el("div", { class: "active-cell" }, [
    el("span", { class: "active-cell-label", text: "events" }),
    el("span", { class: "active-cell-value", text: String(item.events ?? 0) }),
    runtimeMeter(item),
    el("span", { class: "active-cell-sub", text: item.last_event ? `last ${rel(item.last_event)}` : "none yet" }),
  ]);
  return [events, cell("runs", everyLabel(item.interval))];
}

async function stop(item: ActiveItem, button: HTMLButtonElement): Promise<void> {
  const noun = item.kind === "loop" ? "loop" : "monitor";
  const confirmed = await confirmDialog({
    title: `Stop ${noun} ${item.name}?`,
    body:
      item.kind === "loop"
        ? "The loop ends after the current call is cut off. Its run is marked cancelled. You can start a new loop with the same prompt."
        : "The monitor and its command stop. Events already captured stay readable.",
    confirmLabel: `Stop ${noun}`,
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  button.disabled = true;
  const result = await api.stopActive(item.id);
  button.disabled = false;
  if (result.kind === "ok") {
    toast("ok", `${item.kind === "loop" ? "Loop" : "Monitor"} stopped`);
    void poll();
    return;
  }
  toast("error", result.kind === "error" ? (result.body?.error ?? "Stop failed") : "Stop failed");
}

function row(item: ActiveItem): HTMLElement {
  const needs = item.status !== "running";
  const tone = item.status === "failed" ? " is-failed" : item.status === "lost" ? " is-lost" : "";
  const title = el("div", { class: "active-title" }, [
    el("div", { class: "active-head" }, [
      el("span", { class: `tag ${item.kind}`, text: item.kind === "loop" ? "Loop" : "Watch" }),
      el("span", { class: "active-name", text: item.name, title: item.name }),
      el("span", { class: `chip ${needs ? item.status : "running"}`, text: needs ? item.status : "live" }),
    ]),
    el("div", { class: "active-id", text: item.id }),
    el("div", { class: item.kind === "loop" ? "active-note" : "active-note mono", text: item.kind === "loop" ? loopNote(item) : (item.cmd ?? ""), title: item.cmd ?? "" }),
  ]);
  const button = el("button", { class: "btn danger active-stop", type: "button", text: "Stop" });
  button.setAttribute("aria-label", `Stop ${item.kind} ${item.name}`);
  button.addEventListener("click", () => {
    void stop(item, button);
  });
  const node = el("div", { class: `active-row is-${item.kind}${tone}`, role: "listitem" }, [
    title,
    ...metrics(item),
    el("div", { class: "active-actions" }, [button]),
  ]);
  node.setAttribute(DEADLINE_ATTR, String(item.deadline));
  return node;
}

/** Running loops and monitors as ledger rows, or null when there are none to show. */
export function renderActiveStrip(items: readonly ActiveItem[]): HTMLElement | null {
  if (items.length === 0) {
    return null;
  }
  const loops = items.filter((item) => item.kind === "loop").length;
  const watches = items.length - loops;
  const attention = items.filter((item) => item.status !== "running").length;
  const parts = [`${loops} ${loops === 1 ? "loop" : "loops"}`, `${watches} ${watches === 1 ? "monitor" : "monitors"}`];
  if (attention > 0) {
    parts.push(`${attention} need attention`);
  }
  const section = el("section", { id: "active-strip", "aria-label": "Loops and monitors" }, [
    el("div", { class: "section-head" }, [
      el("h2", { class: "section-title", text: "Loops and monitors" }),
      el("span", { class: "section-meta", text: parts.join(" · ") }),
    ]),
  ]);
  const ledger = el("div", { class: "panel-box active-ledger", role: "list" });
  for (const item of items) {
    ledger.appendChild(row(item));
  }
  section.appendChild(ledger);
  return section;
}

/** Updates the countdowns in place each second, without rebuilding the strip. */
export function tickActiveStrip(): void {
  for (const node of document.querySelectorAll<HTMLElement>(`[${COUNTDOWN_ATTR}]`)) {
    const next = Number(node.getAttribute(COUNTDOWN_ATTR));
    if (next > 0) {
      node.textContent = until(next);
    }
  }
}
