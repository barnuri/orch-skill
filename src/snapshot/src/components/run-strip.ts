import { el } from "../dom/el";
import { rel } from "../dom/format";

export interface StripRun {
  status: string;
  started_at: string;
}

const MAX_BARS = 12;
const WORDS: Record<string, string> = { ok: "ok", failed: "failed", lost: "lost", running: "running" };

/**
 * The most recent runs as small bars, oldest on the left, so the health of a schedule reads at a
 * glance. Input is newest first. Each bar has a title; the group has one spoken summary.
 */
export function runStrip(runs: readonly StripRun[]): HTMLElement {
  const shown = runs.slice(0, MAX_BARS).reverse();
  if (shown.length === 0) {
    return el("span", { class: "strip-none", text: "no runs yet" });
  }
  const counts = new Map<string, number>();
  for (const run of shown) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  }
  const summary = [...counts].map(([status, n]) => `${n} ${WORDS[status] ?? status}`).join(", ");
  const strip = el("span", { class: "strip", role: "img", "aria-label": `Last ${shown.length} runs: ${summary}` });
  for (const run of shown) {
    strip.appendChild(
      el("span", { class: `strip-bar is-${WORDS[run.status] ?? "lost"}`, title: `${WORDS[run.status] ?? run.status} · ${rel(run.started_at)}` }),
    );
  }
  return strip;
}
