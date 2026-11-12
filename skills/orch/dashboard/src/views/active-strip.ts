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

function stat(label: string, value: string, extra: Record<string, string> = {}, danger = false): HTMLElement {
  return el("div", { class: "stat" }, [
    el("div", { class: "stat-label", text: label }),
    el("div", { class: `stat-value${danger ? " is-er" : ""}`, text: value, ...extra }),
  ]);
}

function runtimeMeter(item: ActiveItem): HTMLElement {
  const meter = el("div", { class: "meter", role: "presentation" });
  const bar = el("span");
  const started = Date.parse(item.started) / 1000;
  const span = item.deadline - started;
  const done = Math.min(1, Math.max(0, (Date.now() / 1000 - started) / span));
  bar.style.width = `${(done * 100).toFixed(1)}%`;
  meter.appendChild(bar);
  return meter;
}

function loopCard(item: ActiveItem): HTMLElement[] {
  const max = item.max ?? 0;
  const iteration = item.iteration ?? 0;
  const failed = item.last_exit !== null && item.last_exit !== undefined && item.last_exit !== 0;
  return [
    el("div", { class: "active-stats" }, [
      stat("Iteration", max > 0 ? `${iteration}/${max}` : String(iteration)),
      stat("Next tick", item.status === "running" ? until(item.next ?? 0) : "—", { [COUNTDOWN_ATTR]: String(item.next ?? 0) }),
      stat("Last exit", item.last_exit === null || item.last_exit === undefined ? "—" : String(item.last_exit), {}, failed),
    ]),
    runtimeMeter(item),
    el("div", { class: "active-note", text: `every ${everyLabel(item.interval)} · ${item.session === "resume" ? "one resumed session" : item.session === "id" ? "a chosen session" : "fresh session each tick"}${item.when_idle ? ` · waits for idle (${item.skipped ?? 0} skipped)` : ""}` }),
  ];
}

function watchCard(item: ActiveItem): HTMLElement[] {
  return [
    el("div", { class: "active-stats" }, [
      stat("Events", String(item.events ?? 0)),
      stat("Last event", rel(item.last_event ?? null)),
      stat("Runs", everyLabel(item.interval)),
    ]),
    runtimeMeter(item),
    el("div", { class: "active-note mono", text: item.cmd ?? "" }),
  ];
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

function card(item: ActiveItem): HTMLElement {
  const needs = item.status !== "running";
  const tone = item.status === "failed" ? " is-failed" : item.status === "lost" ? " is-lost" : "";
  const node = el("div", { class: `active-card is-${item.kind}${tone}`, role: "listitem" }, [
    el("div", { class: "active-head" }, [
      el("span", { class: `tag ${item.kind}`, text: item.kind === "loop" ? "Loop" : "Watch" }),
      el("span", { class: "active-name", text: item.name, title: item.name }),
      el("span", { class: `chip ${needs ? item.status : "running"}`, text: needs ? item.status : "live" }),
    ]),
    el("div", { class: "active-id", text: item.id }),
    ...(item.kind === "loop" ? loopCard(item) : watchCard(item)),
  ]);
  const button = el("button", { class: "btn danger active-stop", type: "button", text: "Stop" });
  button.setAttribute("aria-label", `Stop ${item.kind} ${item.name}`);
  button.addEventListener("click", () => {
    void stop(item, button);
  });
  node.appendChild(el("div", { class: "active-actions" }, [button]));
  node.setAttribute(DEADLINE_ATTR, String(item.deadline));
  return node;
}

/** Running loops and monitors as cards, or null when there are none to show. */
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
  const grid = el("div", { class: "active-grid", role: "list" });
  for (const item of items) {
    grid.appendChild(card(item));
  }
  section.appendChild(grid);
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
