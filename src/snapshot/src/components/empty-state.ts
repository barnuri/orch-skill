import { el } from "../dom/el";

/** A 600-weight title and one sentence that names the fix, with an optional action. */
export function emptyState(title: string, text: Node | string, action?: HTMLElement): HTMLElement {
  const box = el("div", { class: "empty-state" }, [
    el("div", { class: "empty-title", text: title }),
    el("div", { class: "empty-text" }, [text]),
  ]);
  if (action !== undefined) {
    box.appendChild(el("div", { class: "empty-actions" }, [action]));
  }
  return box;
}
