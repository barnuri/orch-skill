import type { RunNode } from "../../../shared/types/run-node";
import type { RunState } from "../../../shared/types/run-state";
import { nodeUsage } from "../../../shared/run-usage";
import { chip, el } from "../dom/el";
import { fmtTokens, fmtUsd, rel } from "../dom/format";
import { ownerStateLabel } from "./node-flags";

/** Graph | Table view of the run page, kept like the other run UI prefs and in the hash query. */
export type RunViewMode = "graph" | "table";
export const RUN_VIEW_KEY = "orch.graph.view";

export function readRunView(hash: string = location.hash): RunViewMode {
  const cut = hash.indexOf("?");
  const fromHash = cut < 0 ? null : new URLSearchParams(hash.slice(cut + 1)).get("view");
  if (fromHash === "table" || fromHash === "graph") {
    return fromHash;
  }
  try {
    return localStorage.getItem(RUN_VIEW_KEY) === "table" ? "table" : "graph";
  } catch {
    return "graph";
  }
}

function writeRunView(view: RunViewMode): void {
  try {
    localStorage.setItem(RUN_VIEW_KEY, view);
  } catch {
    // blocked storage: the switch still works for this page
  }
  const cut = location.hash.indexOf("?");
  const base = cut < 0 ? location.hash : location.hash.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? "" : location.hash.slice(cut + 1));
  params.set("view", view);
  history.replaceState(history.state, "", `${location.pathname}${location.search}${base}?${params.toString()}`);
}

interface Col {
  key: string;
  label: string;
  value: (n: RunNode) => string | number | null;
}

const ms = (iso: string | null | undefined): number | null => {
  const t = iso === null || iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const COLS: Col[] = [
  { key: "status", label: "Status", value: (n) => n.status },
  { key: "id", label: "Node", value: (n) => n.id },
  { key: "result", label: "Result", value: (n) => n.result?.verdict ?? "" },
  { key: "role", label: "Role", value: (n) => n.role ?? "" },
  { key: "tier", label: "Tier", value: (n) => n.tier ?? "" },
  { key: "profile", label: "Profile", value: (n) => n.profile ?? n.adapter ?? "" },
  { key: "model", label: "Model", value: (n) => n.actual_model ?? n.main_model ?? n.model ?? "" },
  { key: "owner", label: "Owner", value: (n) => [n.owner ?? "", ownerStateLabel(n)].filter((x) => x !== "").join(" · ") },
  { key: "waiting", label: "Waiting on / needs you", value: (n) => n.needs_user ?? n.hold ?? "" },
  { key: "started", label: "Started", value: (n) => ms(n.started_at ?? n.started) },
  { key: "activity", label: "Last activity", value: (n) => ms(n.last_activity ?? n.updated) },
  { key: "attempts", label: "Attempts", value: (n) => (n.attempts?.length ?? 0) + 1 },
  { key: "tokens", label: "Tokens", value: (n) => nodeUsage(n).tokens },
  { key: "cost", label: "Cost", value: (n) => nodeUsage(n).usd },
  { key: "ctx", label: "Peak ctx", value: (n) => n.session_stats?.peak_context ?? null },
  { key: "handoff", label: "Handoff", value: (n) => (n.handoff_present === undefined ? null : n.handoff_present ? "yes" : "no") },
];

function show(col: Col, n: RunNode): string {
  const v = col.value(n);
  if (v === null || v === "") {
    return "—";
  }
  switch (col.key) {
    case "started":
    case "activity":
      return rel(new Date(Number(v)).toISOString());
    case "tokens":
      return fmtTokens(Number(v));
    case "cost":
      return fmtUsd(Number(v));
    case "ctx":
      return `${Math.round(Number(v) / 1000)}k`;
    case "result":
      return `${String(v)}${n.result?.summary ? `: ${n.result.summary}` : ""}`;
    default:
      return String(v);
  }
}

let sortKey: string | null = null;
let sortDir: 1 | -1 = 1;

/** One row per node plus the pinned main-session row; click a row to open the node panel. */
export function renderRunTable(run: RunState, selectedId: string | null, onSelect: (id: string) => void): HTMLElement {
  const wrap = el("div", { class: "run-table-wrap" });
  const draw = (): void => {
    const col = COLS.find((c) => c.key === sortKey);
    const nodes = [...run.nodes];
    if (col !== undefined) {
      nodes.sort((a, b) => {
        const x = col.value(a);
        const y = col.value(b);
        if (x === null) { return y === null ? 0 : 1; }
        if (y === null) { return -1; }
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sortDir;
      });
    }
    const head = el("tr", { role: "row" }, COLS.map((c) => {
      const th = el("th", { role: "columnheader", scope: "col", "aria-sort": sortKey === c.key ? (sortDir === 1 ? "ascending" : "descending") : "none" });
      const b = el("button", { type: "button", class: "rt-sort", text: c.label });
      b.addEventListener("click", () => {
        if (sortKey === c.key) { sortDir = sortDir === 1 ? -1 : 1; } else { sortKey = c.key; sortDir = 1; }
        draw();
      });
      th.appendChild(b);
      return th;
    }));
    const coordinator = (run as RunState & { coordinator?: { session_id?: string; harness?: string } | null }).coordinator;
    const pending = run.coordinator_state?.pending_asks ?? 0;
    const state = run.coordinator_state;
    const mainStatus = state !== null && state !== undefined && !state.reachable ? "unreachable" : run.status === "running" && run.paused !== true ? "running" : "idle";
    const main = el("tr", { role: "row", class: "rt-row rt-main", "data-kind": "main", tabindex: "0" }, [
      el("td", { role: "gridcell" }, [chip(mainStatus)]),
      el("td", { role: "gridcell", colspan: String(COLS.length - 1), text: `orchestrator · ${coordinator?.session_id ?? run.harness_session} · ${coordinator?.harness ?? "harness —"} · ${pending} pending orchestrator question${pending === 1 ? "" : "s"}` }),
    ]);
    const body = nodes.map((n, i) => {
      const tr = el("tr", { role: "row", class: `rt-row${selectedId === n.id ? " selected" : ""}`, "data-kind": "node", "data-node": n.id, tabindex: "0", "aria-rowindex": String(i + 3), "aria-selected": String(selectedId === n.id) },
        COLS.map((c) => el("td", { role: "gridcell" }, [c.key === "status" ? chip(n.status) : c.key === "id" ? el("span", { text: `${n.id} ${(n.label.split("\n")[0] ?? "").trim()}`, title: n.label }) : show(c, n)])));
      tr.addEventListener("click", () => onSelect(n.id));
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(n.id); }
        const sib = e.key === "ArrowDown" ? tr.nextElementSibling : e.key === "ArrowUp" ? tr.previousElementSibling : null;
        if (sib instanceof HTMLElement) { e.preventDefault(); sib.focus(); }
      });
      return tr;
    });
    const table = el("table", { class: "run-table", role: "grid", "aria-label": "Run nodes", "aria-rowcount": String(nodes.length + 2) }, [
      el("thead", {}, [head]),
      el("tbody", {}, [main, ...body]),
    ]);
    wrap.replaceChildren(el("div", { class: "muted rt-count", role: "status", text: `${nodes.length} of ${run.nodes.length} nodes` }), el("div", { class: "rt-scroll" }, [table]));
  };
  draw();
  return wrap;
}

/** The Graph | Table switch; calls `onChange` after saving the choice. */
export function renderViewSwitch(view: RunViewMode, onChange: (v: RunViewMode) => void): HTMLElement {
  const group = el("div", { class: "view-switch", role: "group", "aria-label": "Run view" });
  for (const v of ["graph", "table"] as const) {
    const b = el("button", { type: "button", class: `btn${view === v ? " is-on" : ""}`, "aria-pressed": String(view === v), text: v === "graph" ? "Graph" : "Table" });
    b.addEventListener("click", () => {
      writeRunView(v);
      onChange(v);
    });
    group.appendChild(b);
  }
  return group;
}
