import { TOAST_MS } from "../constants";
import { el } from "../dom/el";

type ToastKind = "ok" | "error";

const TOASTS_ID: string = "toasts";

// Transient feedback for save outcomes. The host is the shell's `#toasts` live region, so screen
// readers announce the text without focus moving; the node removes itself after TOAST_MS.
export function toast(kind: ToastKind, text: string): void {
  const host = document.getElementById(TOASTS_ID);
  if (host === null) {
    return;
  }
  const node = el("div", { class: `toast ${kind}`, text });
  host.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, TOAST_MS);
}
