import { el } from "../dom/el";

/** Placeholder rows with the height of the real ones, shown while the first poll is in flight. */
export function skeletonRows(count: number): HTMLElement {
  const box = el("div", { class: "runs", "aria-busy": "true", "aria-label": "Loading" });
  for (let i = 0; i < count; i += 1) {
    box.appendChild(el("div", { class: "skeleton-row" }));
  }
  return box;
}
