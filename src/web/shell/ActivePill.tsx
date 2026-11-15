import type { ActiveItem } from "../../shared/types/active-item";

export function activePillText(items: readonly ActiveItem[]): string {
  const loops = items.filter((item) => item.kind === "loop").length;
  const watches = items.length - loops;
  const parts: string[] = [];
  if (loops > 0) {
    parts.push(`${loops} ${loops === 1 ? "loop" : "loops"}`);
  }
  if (watches > 0) {
    parts.push(`${watches} ${watches === 1 ? "monitor" : "monitors"}`);
  }
  return parts.join(" · ");
}

/** The header pill: shown only while a loop or monitor is active, on every page. */
export function ActivePill({ items }: { items: readonly ActiveItem[] }) {
  if (items.length === 0) {
    return null;
  }
  const failed = items.filter((item) => item.status === "failed").length;
  const attention = items.filter((item) => item.status !== "running").length;
  const tone = failed > 0 ? " needs-attention" : attention > 0 ? " is-lost" : "";
  return (
    <a
      className={`active-pill${tone}`}
      id="active-pill"
      href="#/"
      title={attention > 0 ? `${attention} need attention` : "All running"}
    >
      <span className="dot" />
      <span id="active-pill-text">{activePillText(items)}</span>
    </a>
  );
}
