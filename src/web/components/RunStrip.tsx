import { rel } from "../lib/format";

export interface StripRun {
  status: string;
  started_at: string;
}

const MAX_BARS = 12;
const WORDS: Readonly<Record<string, string>> = { ok: "ok", failed: "failed", lost: "lost", running: "running" };

/** One spoken summary for a strip: "2 ok, 1 failed". */
export function stripSummary(shown: readonly StripRun[]): string {
  const counts = new Map<string, number>();
  for (const run of shown) {
    counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
  }
  return [...counts].map(([status, n]) => `${n} ${WORDS[status] ?? status}`).join(", ");
}

/** The most recent runs as small bars, oldest on the left. Input is newest first. */
export function RunStrip({ runs }: { runs: readonly StripRun[] }) {
  const shown = runs.slice(0, MAX_BARS).reverse();
  if (shown.length === 0) {
    return <span className="strip-none">no runs yet</span>;
  }
  return (
    <span className="strip" role="img" aria-label={`Last ${shown.length} runs: ${stripSummary(shown)}`}>
      {shown.map((run, index) => (
        <span
          key={`${run.started_at}-${index}`}
          className={`strip-bar is-${WORDS[run.status] ?? "lost"}`}
          title={`${WORDS[run.status] ?? run.status} · ${rel(run.started_at)}`}
        />
      ))}
    </span>
  );
}
