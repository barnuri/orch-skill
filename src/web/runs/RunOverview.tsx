import { useState } from "react";
import type { ReactNode } from "react";
import type { RunOverview } from "../../shared/types/run-overview";
import { useRunOverview } from "./queries";
import { API_BASE } from "../lib/constants";

/** localStorage key for the overview panel open state. Absent means collapsed. */
export const OVERVIEW_OPEN_KEY: string = "orch.run.overview.open";

/** URL of the server-generated `<run>/overview.html` page. */
export function overviewPageHref(runId: string): string {
  return `${API_BASE}/runs/${encodeURIComponent(runId)}/overview.html`;
}

function readOpen(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(OVERVIEW_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(OVERVIEW_OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage can be blocked; the panel still toggles for this page view.
  }
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  if (rows.length === 0) {
    return <p className="muted">none</p>;
  }
  return (
    <table className="overview-table">
      <thead>
        <tr>
          {head.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i}>
            {cells.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The overview sections: repos, commits, pull requests, models, skills, nodes and handoffs. Pure: no fetching. */
export function OverviewSections({ overview, onSelect }: { overview: RunOverview; onSelect?: (id: string) => void }) {
  const unavailable = overview.pull_requests_unavailable;
  return (
    <div className="overview-sections">
      <h3>Repos</h3>
      <Table
        head={["repo", "nodes", "commits"]}
        rows={overview.repos.map((r) => [r.repo, r.nodes.join(", "), String(r.commits)])}
      />
      <h3>Commits (first 20 per repo)</h3>
      <Table
        head={["repo", "commit"]}
        rows={overview.commits.map((c) => [c.repo, <code key="c">{c.sha}</code>])}
      />
      <h3>Pull requests</h3>
      <Table
        head={["repo", "pull request"]}
        rows={[
          ...overview.pull_requests.map((p) => [p.repo, <a key="p" href={p.url} target="_blank" rel="noreferrer">{p.url}</a>]),
          ...unavailable.map((repo) => [repo, <span key="u" className="muted">gh unavailable: not checked</span>]),
        ]}
      />
      <h3>Models</h3>
      <Table head={["model", "nodes"]} rows={overview.models.map((m) => [m.name, String(m.nodes)])} />
      <h3>Skills</h3>
      <Table head={["skill", "nodes"]} rows={overview.skills.map((s) => [s.name, String(s.nodes)])} />
      <h3>Nodes</h3>
      <Table
        head={["node", "label", "status", "profile", "model", "repo", "skills"]}
        rows={overview.nodes.map((n) => [
          <button key="n" type="button" className="chip" onClick={() => onSelect?.(n.id)}>
            {n.id}
          </button>,
          n.label,
          n.status,
          n.profile,
          n.model,
          n.repo,
          n.skills.join(", "),
        ])}
      />
      <h3>Handoffs</h3>
      <Table
        head={["node", "status", "handoff.md"]}
        rows={overview.handoffs.map((h) => [
          <button key="h" type="button" className="chip" onClick={() => onSelect?.(h.id)}>
            {h.id}
          </button>,
          h.status,
          h.state === "yes" ? `yes (${h.bytes} bytes)` : h.state,
        ])}
      />
    </div>
  );
}

/** Run page: collapsed by default. The overview is fetched only when the panel is opened. */
export function RunOverview({ runId, onSelect }: { runId: string; onSelect?: (id: string) => void }) {
  const [expanded, setExpanded] = useState<boolean>(readOpen);
  const query = useRunOverview(runId, expanded);
  const toggle = () => {
    setExpanded((prev) => {
      writeOpen(!prev);
      return !prev;
    });
  };
  return (
    <section className="overview-panel" aria-label="Overview" data-expanded={expanded}>
      <h2>
        <button type="button" className="overview-toggle" aria-expanded={expanded} onClick={toggle}>
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> Overview
        </button>
        {expanded ? (
          <>
            <button type="button" className="btn overview-refresh" disabled={query.isFetching} onClick={() => void query.refetch()}>
              {query.isFetching ? "Loading…" : "Refresh"}
            </button>
            <a className="overview-page" href={overviewPageHref(runId)} target="_blank" rel="noreferrer">
              Open page
            </a>
          </>
        ) : null}
      </h2>
      {expanded ? (
        query.data ? (
          <OverviewSections overview={query.data} onSelect={onSelect} />
        ) : query.isError ? (
          <div className="notice" role="alert">
            {`Could not load the overview: ${query.error instanceof Error ? query.error.message : "request failed"}`}
          </div>
        ) : (
          <p className="muted">Loading overview…</p>
        )
      ) : null}
    </section>
  );
}
