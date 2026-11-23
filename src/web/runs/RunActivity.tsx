import type { RunEvent } from "../../shared/types/run-event";
import type { RunState } from "../../shared/types/run-state";
import { useState } from "react";
import { loadGraphPrefs, saveGraphActivityExpanded } from "../lib/graph-prefs";
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
/** localStorage key for the Activities panel open state. Absent means collapsed. */
export const ACTIVITIES_OPEN_KEY: string = "orch.run.activities.open";

function readActivitiesOpen(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(ACTIVITIES_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeActivitiesOpen(open: boolean): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(ACTIVITIES_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage can be blocked; the panel still toggles for this page view.
  }
}

export function ActivityFeed({ events }: { events: readonly RunEvent[] }) {
  // One choice for all runs, restored on load.
  const [expanded, setExpanded] = useState(() => loadGraphPrefs().activityExpanded);
  const [open, setOpen] = useState<boolean>(readActivitiesOpen);
  const rows = feedRows(events);
  const shown = expanded ? rows : rows.slice(0, ACTIVITY_PREVIEW);
  const hidden = rows.length - shown.length;
  const toggle = () => {
    setOpen((prev) => {
      writeActivitiesOpen(!prev);
      return !prev;
    });
  };
  return (
    <section className="panel run-activity" aria-label="Activities" data-expanded={open}>
      <h2>
        <button type="button" className="requirements-toggle" aria-expanded={open} onClick={toggle}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> Activities{" "}
          <span className="muted">{rows.length}</span>
        </button>
      </h2>
      {!open ? null : rows.length === 0 ? (
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
      )}
    </section>
  );
}
