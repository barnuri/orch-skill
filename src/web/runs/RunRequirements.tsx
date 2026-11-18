import type { RequirementView } from "../../shared/types/run-requirements";

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
  if (requirements.length === 0) {
    return null;
  }
  const open = requirements.filter((r) => !r.ok).length;
  return (
    <section className="requirements-panel" aria-label="Requirements">
      <h2>
        Requirements{" "}
        <span className="muted" aria-live="polite">
          {open === 0 ? "all closed" : `${open} of ${requirements.length} open`}
        </span>
      </h2>
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
    </section>
  );
}
