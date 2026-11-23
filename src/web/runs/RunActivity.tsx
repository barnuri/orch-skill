import type { RunEvent } from "../../shared/types/run-event";
import type { RunState } from "../../shared/types/run-state";
import { useState } from "react";
import { RUN_ACTIVITIES_OPEN_KEY } from "../lib/constants";
import { saveGraphActivityExpanded } from "../lib/graph-prefs";
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
export function ActivityFeed({ events, compact = false }: { events: readonly RunEvent[]; compact?: boolean }) {
  // One choice for all runs, restored on load.
  const [open, setOpen] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(RUN_ACTIVITIES_OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [expanded, setExpanded] = useState(false);
  const rows = feedRows(events);
  const shown = expanded ? rows : rows.slice(0, ACTIVITY_PREVIEW);
  const hidden = rows.length - shown.length;
  return (
    <section className="run-strip run-activity" aria-label="Activity">
      <button
        type="button"
        className="run-strip-head"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          try {
            globalThis.localStorage?.setItem(RUN_ACTIVITIES_OPEN_KEY, next ? "1" : "0");
          } catch {
            // Storage is optional.
          }
        }}
      >
        <b>Activities</b>
        <span className="muted">{rows.length === 0 ? "none" : `${rows.length} events`}</span>
      </button>
      {open ? (rows.length === 0 ? (
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
                const next = !expanded;
                saveGraphActivityExpanded(next);
                setExpanded(next);
              }}
            >
              {expanded ? "Show less" : `Show more (${hidden} more)`}
            </button>
          ) : null}
        </>
      )) : null}
    </section>
  );
}
