import { useMemo, useState, type KeyboardEvent } from "react";
import type { RunState } from "../../shared/types/run-state";
import { Chip } from "../components/Chip";
import { fmtTime, rel } from "../lib/format";
import { resultLabel } from "../lib/node-flags";
import { COLUMNS, DEFAULT_COLS, effectiveCols, fmtCost, fmtTok, mainRow, nodeRow, saveCols, sortRows, toCsv, toMarkdown, visibleNodes, type RunView, type RunWithCoordinator, type Sort, type TableRow } from "../lib/run-table";
import { isFilterActive, type NodeFilter } from "./run-filter";
import { ModelIcon } from "./ModelIcon";
import { useNow } from "./use-now";
import { viewStateFor } from "./GraphViewport";
import { saveGraphHideDone } from "../lib/graph-prefs";
import { RetryNodeButton } from "./NodePanel";

/** Graph | Table switch. */
export function ViewSwitch({ view, onChange }: { view: RunView; onChange: (view: RunView) => void }) {
  return (
    <div className="view-switch" role="group" aria-label="Run view">
      {(["graph", "table"] as const).map((v) => (
        <button key={v} type="button" className={`btn${view === v ? " is-on" : ""}`} aria-pressed={view === v} onClick={() => onChange(v)}>
          {v === "graph" ? "Graph" : "Table"}
        </button>
      ))}
    </div>
  );
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Cell({ row, col, nowMs, runId }: { row: TableRow; col: string; nowMs: number; runId: string }) {
  switch (col) {
    case "status":
      return <Chip status={row.status} />;
    case "warn":
      return row.node === null || row.warnings.length === 0 ? <span className="muted">—</span> : (
        <span className="rt-warn">
          {row.warnings.map((w) => (
            <Chip key={w.key} status={w.status} title={w.text}>
              {w.key === "needs" ? "needs you" : w.key}
            </Chip>
          ))}
          {row.node.status === "error" ? <RetryNodeButton runId={runId} node={row.node} /> : null}
        </span>
      );
    case "id":
      return (
        <>
          <span className="mono rt-id">{row.idText}</span>
          {row.kind === "main" ? <span className="rt-badge">orchestrator</span> : null}
          <span className="rt-goal" title={row.node?.label ?? row.goal}>{row.goal}</span>
        </>
      );
    case "result":
      return row.verdict === "" ? <span className="muted">—</span> : (
        <>
          <span className={`rt-verdict v-${row.verdict}`} role="img" aria-label={resultLabel(row.verdict)}>{row.verdict}</span> <span className="rt-sum" title={row.summary}>{row.summary}</span>
        </>
      );
    case "model":
      return row.model === "" ? <span className="muted">—</span> : (
        <span className="rt-model">
          <ModelIcon family={row.family} size={12} /> {row.model}
        </span>
      );
    case "started":
      return <>{row.startedMs === null ? "—" : fmtTime(new Date(row.startedMs).toISOString())}</>;
    case "duration":
      return <>{row.durationText}</>;
    case "activity":
      return <>{row.activityMs === null ? "—" : rel(new Date(row.activityMs).toISOString())}</>;
    case "attempts":
      return <>{row.attempts ?? "—"}</>;
    case "tokens":
      return <>{fmtTok(row.tokens)}</>;
    case "cost":
      return <>{fmtCost(row.cost)}</>;
    case "ctx":
      return <>{row.ctx === null ? "—" : `${Math.round(row.ctx / 1000)}k`}</>;
    case "handoff":
      return <>{row.handoff === null ? "—" : row.handoff ? "yes" : "no"}</>;
    case "role": return <>{row.role || "—"}</>;
    case "tier": return <>{row.tier || "—"}</>;
    case "profile": return <>{row.profile || "—"}</>;
    case "owner": return <>{row.owner || "—"}</>;
    case "waiting": return <>{row.waiting || "—"}</>;
    default:
      return null;
  }
}

interface Props {
  run: RunWithCoordinator;
  filter: NodeFilter;
  harnessByProfile: Readonly<Record<string, string>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** One row per node plus the pinned main-session row. Same filter and Hide done as the graph. */
export function RunTable({ run, filter, harnessByProfile, selectedId, onSelect }: Props) {
  const nowMs = useNow(run.status === "running" || run.nodes.some((n) => n.status === "running"));
  const phone = typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)").matches === true;
  const [cols, setCols] = useState<string[]>(() => effectiveCols(phone));
  const [sort, setSort] = useState<Sort | null>(null);
  const [, redraw] = useState(0);
  const [note, setNote] = useState("");
  const view = viewStateFor(run.run_id);
  const nodes = visibleNodes(run, filter, harnessByProfile, view.hideDone, selectedId, isFilterActive(filter));
  const rows = useMemo(
    () => sortRows([mainRow(run), ...nodes.map((n) => nodeRow(run, n, nowMs, harnessByProfile))], sort),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, nodes.map((n) => n.id).join("|"), sort, nowMs, harnessByProfile],
  );
  const nodeRows = rows.filter((r) => r.kind === "node");
  const shown = COLUMNS.filter((c) => cols.includes(c.key));
  const toggleCol = (key: string): void => {
    const next = cols.includes(key) ? cols.filter((k) => k !== key) : COLUMNS.map((c) => c.key).filter((k) => k === key || cols.includes(k));
    if (next.length > 0) {
      setCols(next);
      saveCols(next);
    }
  };
  const sortBy = (key: string): void => setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));
  const key = (event: KeyboardEvent<HTMLTableRowElement>, row: TableRow): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.kind === "node") { onSelect(row.id); }
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const sib = event.key === "ArrowDown" ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling;
      if (sib instanceof HTMLElement && sib.tabIndex >= 0) { sib.focus(); }
    }
  };
  return (
    <div className="run-table-wrap">
      <div className="rt-tools">
        <span className="muted rt-count" role="status">{`${nodeRows.length} of ${run.nodes.length} nodes`}</span>
        <button
          type="button"
          className={`btn${view.hideDone ? " is-on" : ""}`}
          aria-pressed={view.hideDone}
          onClick={() => {
            view.hideDone = !view.hideDone;
            saveGraphHideDone(view.hideDone);
            redraw((n) => n + 1);
          }}
        >
          {view.hideDone ? "Show done" : "Hide done"}
        </button>
        <details className="rt-cols">
          <summary className="btn">Columns</summary>
          <div className="rt-cols-menu">
            {COLUMNS.map((c) => (
              <label key={c.key}>
                <input type="checkbox" checked={cols.includes(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}
              </label>
            ))}
            <button type="button" className="btn" onClick={() => { setCols([...DEFAULT_COLS]); saveCols(DEFAULT_COLS); }}>Reset</button>
          </div>
        </details>
        <button type="button" className="btn" onClick={() => download(`${run.run_id}.csv`, toCsv(rows))}>Export CSV</button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(toMarkdown(rows)).then(() => setNote("Copied"), () => setNote("Copy blocked"));
          }}
        >
          Copy markdown
        </button>
        {note === "" ? null : <span className="muted" role="status">{note}</span>}
      </div>
      <div className="rt-scroll">
        <table className="run-table" role="grid" aria-label="Run nodes" aria-rowcount={rows.length + 1}>
          <thead>
            <tr role="row">
              {shown.map((c) => (
                <th key={c.key} role="columnheader" scope="col" aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                  <button type="button" className="rt-sort" onClick={() => sortBy(c.key)}>
                    {c.label}
                    {sort?.key === c.key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr
                key={row.id}
                role="row"
                aria-rowindex={i + 2}
                aria-selected={row.kind === "node" ? selectedId === row.id : undefined}
                tabIndex={0}
                className={`rt-row ${row.kind === "main" ? "rt-main" : ""}${selectedId === row.id ? " selected" : ""}`}
                data-kind={row.kind}
                data-node={row.kind === "node" ? row.id : undefined}
                data-verdict={row.verdict === "" ? undefined : row.verdict}
                onClick={() => row.kind === "node" && onSelect(row.id)}
                onKeyDown={(e) => key(e, row)}
              >
                {shown.map((c) => (
                  <td key={c.key} role="gridcell">
                    <Cell row={row} col={c.key} nowMs={nowMs} runId={run.run_id} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
