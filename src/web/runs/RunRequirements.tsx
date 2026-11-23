import { useState } from "react";
import type { RequirementView } from "../../shared/types/run-requirements";

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

const TONE: Record<string, string> = {
  handled: "ok",
  superseded: "ok",
  waived: "ok",
  partly: "warn",
  not: "err",
};

/** Run page: one row per requirement with a status chip, linked nodes (done / handoff / unverified) and evidence. Nothing when there is no ledger. */
export function RequirementsPanel({
  requirements,
  onSelect,
}: {
  requirements: readonly RequirementView[];
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
            {open === 0 ? "all closed" : `${open} of ${requirements.length} open`}
          </span>
        </button>
      </h2>
      {expanded ? (
      <ul>
        {requirements.map((r) => (
          <li key={r.id} data-status={r.status}>
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
