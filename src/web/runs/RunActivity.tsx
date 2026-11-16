import type { RunEvent } from "../../shared/types/run-event";
import type { RunState } from "../../shared/types/run-state";
import { useState } from "react";
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

/** Rows shown before "Show more". */
export const ACTIVITY_PREVIEW = 5;

/** Newest first, live: each row is time, node, change. The last ACTIVITY_PREVIEW rows show until "Show more". */
export function ActivityFeed({ events }: { events: readonly RunEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const rows = feedRows(events);
  const shown = expanded ? rows : rows.slice(0, ACTIVITY_PREVIEW);
  const hidden = rows.length - shown.length;
  return (
    <section className="panel run-activity" aria-label="Activity">
      <h2>Activity</h2>
      {rows.length === 0 ? (
        <p className="hint panel-empty">No activity recorded yet.</p>
      ) : (
        <>
          <ul className="activity-list">
            {shown.map((e) => (
              <li key={e.n} className={`activity-row kind-${e.kind}`}>
                <span className="activity-ago muted" title={fmtTime(e.at)}>
                  <Ago iso={e.at} />
                </span>
                <span className="activity-node mono">{e.node ?? "run"}</span>
                <span className="activity-text">{describeEvent(e)}</span>
              </li>
            ))}
          </ul>
          {rows.length > ACTIVITY_PREVIEW ? (
            <button
              className="btn activity-more"
              type="button"
              aria-expanded={expanded}
              onClick={() => {
                setExpanded((value) => !value);
              }}
            >
              {expanded ? "Show less" : `Show more (${hidden} more)`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
