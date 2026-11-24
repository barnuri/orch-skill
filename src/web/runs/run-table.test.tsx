import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import { installDom } from "../test/dom";

const uninstall = installDom();
const { render, screen, cleanup, fireEvent } = await import("@testing-library/react");
const { EMPTY_FILTER, matchesFilter, hashWithFilter, parseFilter } = await import("./run-filter");
const T = await import("../lib/run-table");
const { RunTable, ViewSwitch } = await import("./RunTable");
const { ToastProvider } = await import("../components/Toast");

afterEach(cleanup);
afterAll(uninstall);

const node = (over: Partial<RunNode>): RunNode => ({ id: "a", label: "A\nsecond line", status: "waiting", profile: null, adapter: null, job_id: null, started: null, finished: null, error: null, log_tail: [], ...over });
const NODES = [
  node({ id: "b", status: "done", result: { verdict: "full", summary: "ok", follow_up: "none", at: "" }, session_stats: { session: "s", cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write: 0 }, created: "", updated: "", duration_s: 1, busy: false, peak_context: 5000 } }),
  node({ id: "a", status: "running", started: "2026-11-16T08:00:00Z" }),
  node({ id: "c", status: "error", result: { verdict: "blocked", summary: "x", follow_up: "y", at: "" } }),
];
const run = { run_id: "r1", title: "", harness_session: "ses_main", started: "2026-11-16T08:00:00Z", finished: null, status: "running" as const, nodes: NODES, edges: [] as [string, string][], coordinator_state: { pane_id: "p", reachable: true, unreachable_since: null, unreachable_reason: null, pending_asks: 2, last_repoint: null, candidates: [] }, coordinator: { session_id: "ses_main", harness: "opencode" } };

describe("run table", () => {
  test("filter parity: table nodes equal graph filter nodes", () => {
    for (const filter of [EMPTY_FILTER, { ...EMPTY_FILTER, verdict: "blocked" as const }, { ...EMPTY_FILTER, status: "done" as const }, { ...EMPTY_FILTER, q: "a" }]) {
      const active = JSON.stringify(filter) !== JSON.stringify(EMPTY_FILTER);
      const tableIds = T.visibleNodes(run, filter, {}, false, null, active).map((n) => n.id);
      expect(tableIds).toEqual(NODES.filter((n) => matchesFilter(run, n, filter, {})).map((n) => n.id));
    }
    expect(T.visibleNodes(run, EMPTY_FILTER, {}, true, null, false).map((n) => n.id)).toEqual(["a", "c"]);
    expect(T.visibleNodes(run, EMPTY_FILTER, {}, true, "b", false).map((n) => n.id)).toEqual(["b", "a", "c"]);
  });

  test("Hide done also hides covered nodes, in the table as in the graph", () => {
    expect(["done", "skipped", "covered"].every(T.hiddenByHideDone)).toBe(true);
    expect(["running", "waiting", "error", "stopped", "blocked-user"].some(T.hiddenByHideDone)).toBe(false);
  });
  test("verdict filter treats no result as unknown and round-trips the hash with view", () => {
    expect(matchesFilter(run, NODES[1] as RunNode, { ...EMPTY_FILTER, verdict: "unknown" }, {})).toBe(true);
    const hash = T.hashWithView(hashWithFilter("#/run/r1", { ...EMPTY_FILTER, verdict: "partial" }), "table");
    expect(parseFilter(hash).verdict).toBe("partial");
    expect(T.parseViewParam(hash)).toBe("table");
    expect(T.parseViewParam(hashWithFilter(hash, { ...EMPTY_FILTER, q: "x" }))).toBe("table");
  });
  test("main row is present and pinned first, even when sorted", () => {
    const rows = [T.mainRow(run), ...NODES.map((n) => T.nodeRow(run, n, Date.now(), {}))];
    for (const dir of ["asc", "desc"] as const) {
      const sorted = T.sortRows(rows, { key: "id", dir });
      expect(sorted[0]?.kind).toBe("main");
    }
    expect(T.mainRow(run).waiting).toBe("2 pending orchestrator questions");
    expect(T.sortRows(rows, { key: "id", dir: "asc" }).slice(1).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(T.sortRows(rows, { key: "ctx", dir: "desc" }).slice(1).map((r) => r.id)[0]).toBe("b");
    expect(T.mainStatus({ ...run, coordinator_state: { ...run.coordinator_state, reachable: false } })).toBe("unreachable");
  });
  test("csv and markdown", () => {
    const rows = [T.mainRow(run), T.nodeRow(run, NODES[0] as RunNode, Date.now(), {})];
    expect(T.toCsv(rows).split("\n")[0]).toContain("verdict");
    expect(T.toMarkdown(rows)).toContain("| --- |");
  });
  test("view and column prefs persist", () => {
    const mem: Record<string, string> = {};
    const st = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => void (mem[k] = v) };
    expect(T.loadRunView(st)).toBe("graph");
    T.saveRunView("table", st);
    expect(T.loadRunView(st)).toBe("table");
    T.saveCols(["id", "cost"], st);
    expect(T.loadCols(st)).toEqual(["id", "cost"]);
    expect(T.effectiveCols(true, st)).toEqual(["id", "cost"]);
    const empty = { getItem: () => null, setItem: () => undefined };
    expect(T.effectiveCols(true, empty)).not.toContain("model");
    expect(T.effectiveCols(false, empty)).toContain("model");
  });
  test("ARIA grid, pinned row, click selects node, sort header", () => {
    const picked: string[] = [];
    render(<ToastProvider><RunTable run={run} filter={EMPTY_FILTER} harnessByProfile={{}} selectedId={null} onSelect={(id) => picked.push(id)} /></ToastProvider>);
    expect(screen.getByRole("grid")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(5);
    expect(rows[1]?.getAttribute("data-kind")).toBe("main");
    expect(screen.getByText("3 of 3 nodes")).toBeTruthy();
    fireEvent.click(rows[1] as HTMLElement);
    expect(picked).toEqual([]);
    fireEvent.keyDown(rows[3] as HTMLElement, { key: "Enter" });
    expect(picked.length).toBe(1);
    const head = screen.getAllByRole("columnheader")[1] as HTMLElement;
    fireEvent.click(head.querySelector("button") as HTMLElement);
    expect(head.getAttribute("aria-sort")).toBe("ascending");
  });
  test("view switch is a pressed-state group", () => {
    const seen: string[] = [];
    render(<ViewSwitch view="graph" onChange={(v) => seen.push(v)} />);
    expect(screen.getByText("Graph").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("Table"));
    expect(seen).toEqual(["table"]);
  });
  test("rowWarnings: error, needs you, held, stale and unowned, most urgent first; none when clean", () => {
    expect(T.rowWarnings(node({ id: "z", status: "done" }))).toEqual([]);
    const all = T.rowWarnings(node({ id: "z", status: "error", error: "boom", needs_user: "pick a model", hold: "wait for stg" }));
    expect(all.map((w) => w.key)).toEqual(["error", "needs", "hold"]);
    expect(all[0]?.text).toBe("boom");
    expect(all[1]?.text).toBe("needs you: pick a model");
    const running = T.rowWarnings(node({ id: "y", status: "running", stale: true, owner: null, job_id: null }));
    expect(running.map((w) => w.key)).toEqual(["stale", "unowned"]);
  });
  test("table warning cell shows the chips and a Retry action on an error node", () => {
    const errRun = { ...run, nodes: [node({ id: "c", status: "error", error: "boom", needs_user: "pick" })] };
    render(<ToastProvider><RunTable run={errRun} filter={EMPTY_FILTER} harnessByProfile={{}} selectedId={null} onSelect={() => undefined} /></ToastProvider>);
    expect(screen.getAllByText("error").length).toBe(2);
    expect(screen.getByText("needs you")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
