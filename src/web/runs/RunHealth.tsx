import type { HealthSummary, NodeHealth, NodeHealthState, RunHealth } from "../../shared/types/run-health";

/** Only the states worth a badge; `ok` has none. Red is kept for `dead`. */
const LABEL: Record<Exclude<NodeHealthState, "ok">, string> = {
  stalled: "stalled",
  dead: "dead",
  unowned: "unowned",
  "no-report": "no report",
  "needs-user": "needs you",
  held: "held",
};

const ORDER: readonly Exclude<NodeHealthState, "ok">[] = ["dead", "stalled", "no-report", "unowned", "needs-user", "held"];

/** HH:MM in local time; null for a missing or unreadable stamp. */
export function hhmm(iso: string | null): string | null {
  if (iso === null || iso === "") {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function badgeText(node: NodeHealth): string {
  if (node.health === "ok") {
    return "";
  }
  const since = hhmm(node.last_activity);
  return node.health === "stalled" && since !== null ? `stalled · no activity since ${since}` : LABEL[node.health];
}

export const flaggedNodes = (health: RunHealth | null): NodeHealth[] => (health === null ? [] : health.nodes.filter((node) => node.health !== "ok"));

/** One node's health badge; nothing for a healthy node. */
export function HealthBadge({ node }: { node: NodeHealth }) {
  if (node.health === "ok") {
    return null;
  }
  const title = [node.note, node.owner_id === null ? null : `owner ${node.owner_id}`, node.idle_min === null ? null : `idle ${node.idle_min} min`]
    .filter((t): t is string => t !== null && t !== "")
    .join(" · ");
  return (
    <span className={`chip health-badge health-${node.health}`} title={title === "" ? undefined : title} data-health={node.health}>
      {badgeText(node)}
    </span>
  );
}

/** Run page: one badge per node that is not ok, each naming its node; a click selects the node. */
export function NodeHealthStrip({ health, onSelect }: { health: RunHealth | null; onSelect?: (id: string) => void }) {
  const flagged = flaggedNodes(health);
  if (flagged.length === 0) {
    return null;
  }
  return (
    <div className="node-health" role="list" aria-label="Node health">
      {flagged.map((node) => (
        <button key={node.id} type="button" role="listitem" className="node-health-item" onClick={() => onSelect?.(node.id)}>
          <span className="node-health-id mono">{node.id}</span>
          <HealthBadge node={node} />
        </button>
      ))}
    </div>
  );
}

export function readyText(health: RunHealth | null): string | null {
  if (health === null || health.ready.length === 0 || health.slots <= 0) {
    return null;
  }
  const n = health.ready.length;
  return `${n} ${n === 1 ? "node" : "nodes"} ready to start: ${health.ready.join(", ")}`;
}

/** Run-level notice: waiting nodes whose dependencies are done while a slot is free. */
export function ReadyNotice({ health }: { health: RunHealth | null }) {
  const text = readyText(health);
  if (text === null) {
    return null;
  }
  return (
    <div className="notice info run-ready" role="status">
      {text}
    </div>
  );
}

/** Runs list: per-state counts, e.g. "1 dead", "2 stalled". */
export function RunHealthSummary({ health }: { health: RunHealth | null }) {
  const flagged = flaggedNodes(health);
  const ready = readyText(health);
  if (flagged.length === 0 && ready === null) {
    return null;
  }
  return (
    <span className="run-health">
      {ORDER.map((state) => {
        const n = flagged.filter((node) => node.health === state).length;
        return n === 0 ? null : (
          <span key={state} className={`chip health-badge health-${state}`} title={flagged.filter((node) => node.health === state).map((node) => node.id).join(", ")}>
            {`${n} ${LABEL[state]}`}
          </span>
        );
      })}
      {ready === null ? null : (
        <span className="chip health-badge health-ready" title={ready}>{`${health?.ready.length ?? 0} ready`}</span>
      )}
    </span>
  );
}

/** Header: nodes needing attention across the running runs; hidden when there are none. */
export function HealthPill({ summary }: { summary: HealthSummary | null }) {
  if (summary === null) {
    return null;
  }
  const flagged = summary.stalled + summary.dead + summary.unowned + summary.no_report;
  if (flagged === 0) {
    return null;
  }
  const only = summary.flagged_runs.length === 1 ? summary.flagged_runs[0] : undefined;
  const href = only === undefined ? "#/" : `#/run/${encodeURIComponent(only)}`;
  const words = `${flagged === 1 ? "node needs" : "nodes need"} attention`;
  return (
    <a
      className={`active-pill health-pill${summary.dead > 0 ? " needs-attention" : " is-lost"}`}
      id="health-pill"
      href={href}
      title={`${summary.stalled} stalled, ${summary.dead} dead, ${summary.unowned} unowned, ${summary.no_report} without a report`}
      aria-label={`${flagged} ${words}`}
    >
      <span className="dot" />
      <span>
        {flagged}
        <span className="health-pill-words">{` ${words}`}</span>
      </span>
    </a>
  );
}
