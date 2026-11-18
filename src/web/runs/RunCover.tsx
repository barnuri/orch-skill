import type { RunState } from "../../shared/types/run-state";
import type { RunSummary } from "../../shared/types/run-summary";

const href = (id: string): string => `#/run/${encodeURIComponent(id)}`;

/** Header link of a covered run: `→ run <new-run title>`. */
export function CoveredByLink({ run, runs }: { run: RunState; runs: readonly RunSummary[] }) {
  if (run.status !== "covered" || !run.covered_by) {
    return null;
  }
  const target = runs.find((r) => r.run_id === run.covered_by);
  return (
    <a className="covered-link" href={href(run.covered_by)} title={run.covered_note ?? undefined}>
      {`→ run ${target?.title || run.covered_by}`}
    </a>
  );
}

/** On the new run: every run that took its tasks from other runs, with carried node ids and the map. */
export function CoversBlock({ runId, runs }: { runId: string; runs: readonly RunSummary[] }) {
  const covered: RunSummary[] = runs.filter((r) => r.status === "covered" && r.covered_by === runId);
  if (covered.length === 0) {
    return null;
  }
  return (
    <section className="covers-block" aria-label="Covers">
      <h3>Covers</h3>
      <ul>
        {covered.map((r) => {
          const nodes = r.covered_nodes ?? [];
          const map = Object.entries(r.covered_map ?? {});
          return (
            <li key={r.run_id}>
              <a href={href(r.run_id)}>{`← run ${r.title || r.run_id}`}</a>
              {r.covered_note ? <span className="muted">{` ${r.covered_note}`}</span> : null}
              <div className="mono covers-nodes">{`carried ${nodes.length}: ${nodes.join(", ") || "-"}`}</div>
              {map.length > 0 ? <div className="mono covers-map">{`map: ${map.map(([o, n]) => `${o} → ${n}`).join(", ")}`}</div> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
