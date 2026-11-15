import type { ActiveItem } from "../../../shared/types/active-item";

/** The header pill: shown only while a loop or monitor is active, on every page. */
export function renderActivePill(items: readonly ActiveItem[]): void {
  const pill = document.getElementById("active-pill");
  const text = document.getElementById("active-pill-text");
  if (pill === null || text === null) {
    return;
  }
  if (items.length === 0) {
    pill.hidden = true;
    return;
  }
  const loops = items.filter((item) => item.kind === "loop").length;
  const watches = items.length - loops;
  const attention = items.filter((item) => item.status !== "running").length;
  const parts: string[] = [];
  if (loops > 0) {
    parts.push(`${loops} ${loops === 1 ? "loop" : "loops"}`);
  }
  if (watches > 0) {
    parts.push(`${watches} ${watches === 1 ? "monitor" : "monitors"}`);
  }
  text.textContent = parts.join(" · ");
  pill.classList.toggle("needs-attention", attention > 0);
  pill.setAttribute("title", attention > 0 ? `${attention} need attention` : "All running");
  pill.hidden = false;
}
