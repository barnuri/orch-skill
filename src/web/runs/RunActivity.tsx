import type { RunEvent } from "../../shared/types/run-event";
import type { RunState } from "../../shared/types/run-state";
import { fmtTime, rel } from "../lib/format";
import { describeEvent, feedRows, staleSummary } from "../lib/run-activity";
import { useNow } from "./use-now";

/** "<prefix><n>m ago", re-rendered once a second off the shared ticker. */
export function Ago({ iso, prefix = "" }: { iso: string; prefix?: string }) {
  useNow(true);
  return <>{`${prefix}${rel(iso)}`}</>;
}

/** The warning above the graph when running nodes have gone quiet. */
export function StaleBanner({ run }: { run: RunState }) {
  useNow(run.nodes.some((node) => node.stale === true));
  const summary = staleSummary(run, Date.now());
  if (summary === null) {
    return null;
  }
  return (
    <div className="notice warn run-stale-banner" role="status">
      <b>{summary.headline}</b>
      <span>{summary.detail}</span>
    </div>
  );
}

/** Newest first, live: each row is time, node, change. */
export function ActivityFeed({ events }: { events: readonly RunEvent[] }) {
  const rows = feedRows(events);
  return (
    <section className="panel run-activity" aria-label="Activity">
      <h2>Activity</h2>
      {rows.length === 0 ? (
        <p className="hint panel-empty">No activity recorded yet.</p>
      ) : (
        <ul className="activity-list">
          {rows.map((e) => (
            <li key={e.n} className={`activity-row kind-${e.kind}`}>
              <span className="activity-ago muted" title={fmtTime(e.at)}>
                <Ago iso={e.at} />
              </span>
              <span className="activity-node mono">{e.node ?? "run"}</span>
              <span className="activity-text">{describeEvent(e)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
