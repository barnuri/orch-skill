import { el } from "../dom/el";

export type KpiTone = "neutral" | "acc" | "ok" | "er" | "pu";

/** A small label, one large mono number and exactly one meta line. */
export function kpiTile(label: string, value: string, meta: string, tone: KpiTone = "neutral"): HTMLElement {
  return el("div", { class: `kpi${tone === "neutral" ? "" : ` is-${tone}`}` }, [
    el("div", { class: "kpi-label", text: label }),
    el("div", { class: "kpi-value", text: value }),
    el("div", { class: "kpi-meta", text: meta }),
  ]);
}
