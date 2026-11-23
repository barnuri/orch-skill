import type { RunProjection } from "../../../skills/orch/core/runs/projection";

/** Run page: the projection's next actions in its priority order, five at a time. Nothing when there are none. */
export function NextActions({ actions, onSelect }: { actions: RunProjection["next_actions"]; onSelect?: (id: string) => void }) {
  if (actions.length === 0) {
    return null;
  }
  return (
    <section className="run-next" aria-label="Next actions">
      <h2>Next</h2>
      <ol>
        {actions.slice(0, 5).map((a, i) => (
          <li key={i} data-kind={a.kind}>
            {a.node !== null ? (
              <button type="button" className="chip" onClick={() => onSelect?.(a.node!)}>
                {a.node}
              </button>
            ) : null}{" "}
            {a.text}
          </li>
        ))}
      </ol>
      {actions.length > 5 ? <p className="muted">{actions.length - 5} more in the projection</p> : null}
    </section>
  );
}
