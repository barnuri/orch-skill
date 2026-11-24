import { useState } from "react";
import type { ProjectionRequirement } from "../../../skills/orch/core/runs/projection";

/** localStorage key for the requirements panel open state. Absent means collapsed. */
export const REQUIREMENTS_OPEN_KEY: string = "orch.run.requirements.open";

function readOpen(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(REQUIREMENTS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(REQUIREMENTS_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage can be blocked; the panel still toggles for this page view.
  }
}

// One tone per lifecycle step: open and in progress still need work, implemented waits for an independent verifier.
const TONE: Record<string, string> = {
  done: "ok",
  handled: "ok",
  superseded: "ok",
  waived: "ok",
  verifying: "info",
  implemented: "info",
  in_progress: "warn",
  partly: "warn",
  open: "err",
  not: "err",
};

const STEPS: ReadonlyArray<[string, string]> = [
  ["open", "open"],
  ["in_progress", "in progress"],
  ["implemented", "implemented"],
  ["verifying", "verifying"],
  ["done", "done"],
];

/** "2 open · 1 in progress · 1 verifying · 20 done": one count per lifecycle step that has any. */
export function lifecycleSummary(requirements: readonly ProjectionRequirement[]): string {
  const counts = STEPS.map(([bucket, label]) => [label, requirements.filter((r) => r.bucket === bucket).length] as const).filter(([, n]) => n > 0);
  return counts.map(([label, n]) => `${n} ${label}`).join(" · ");
}

/** Run page: one row per requirement with a status chip, linked nodes (done / handoff / unverified) and evidence. Nothing when there is no ledger. */
export function RequirementsPanel({
  requirements,
  onSelect,
}: {
  requirements: readonly ProjectionRequirement[];
  onSelect?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<boolean>(readOpen);
  if (requirements.length === 0) {
    return null;
  }
  const open = requirements.filter((r) => !r.ok).length;
  const toggle = () => {
    setExpanded((prev) => {
      writeOpen(!prev);
      return !prev;
    });
  };
  return (
    <section className="requirements-panel" aria-label="Requirements" data-expanded={expanded}>
      <h2>
        <button type="button" className="requirements-toggle" aria-expanded={expanded} onClick={toggle}>
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> Requirements{" "}
          <span className="muted" aria-live="polite">
            {open === 0 ? "all closed" : `${open} of ${requirements.length} open (${lifecycleSummary(requirements)})`}
          </span>
        </button>
      </h2>
      {expanded ? (
      <ul>
        {requirements.map((r) => (
          <li key={r.id} data-status={r.status} className={`req-${TONE[r.status] ?? "err"}`}>
            <span
              className={`chip req-${TONE[r.status] ?? "err"}`}
              data-testid={`req-status-${r.id}`}
            >
              {r.status}
            </span>{" "}
            <b>{r.id}</b> {r.text}
            {r.reason ? <span className="muted"> ({r.reason})</span> : null}
            <div className="req-nodes">
              {r.nodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="chip"
                  aria-label={`${n.id}: ${n.status}${n.handoff ? "" : ", no handoff"}${n.unverified ? ", unverified" : ""}`}
                  title={`${n.status}${n.handoff ? "" : ", no handoff"}${n.unverified ? ", unverified" : ""}`}
                  onClick={() => onSelect?.(n.id)}
                >
                  {n.id}{" "}
                  {n.done && n.handoff && !n.unverified
                    ? "✓"
                    : n.done
                      ? "⚠"
                      : n.status}
                </button>
              ))}
            </div>
            {r.evidence.length > 0 ? (
              <ul className="req-evidence">
                {r.evidence.map((e, i) => (
                  <li key={i} className="muted">
                    {e.note}
                    {e.file ? ` · ${e.file}` : ""}
                    {e.test ? ` · ${e.test}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
      ) : null}
    </section>
  );
}
