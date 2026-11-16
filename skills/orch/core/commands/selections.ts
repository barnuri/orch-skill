// `orch node selections <run-id> <node-id>`. Ported from cmd_node_selections (lib/runs/runs.sh:790).
// Pulls the hub's selection events for every attempt of one node and appends the new ones to the node.
// Bun built-ins only. The hub call goes through fetch; the node patch goes through mutateRun.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRun } from "../state/store.ts";
import { orchHome, paths } from "../state/home.ts";
import { mutateRun } from "./node.ts";

export const NODE_SELECTIONS_USAGE = "dispatch.sh node selections <run-id> <node-id>";
export const SELECTION_PAGE_LIMIT = 500;
export const SELECTION_HISTORY_MAX = 500;
export const SELECTION_HTTP_TIMEOUT_MS = 5000;

const alt = (v: any, d: any) => (v === null || v === undefined || v === false ? d : v);
const seqKey = (e: any) => (e?.seq === null || e?.seq === undefined ? -Infinity : e.seq);

// orch_load_env_file: `<home>/env` lines NAME=value. A variable already set in the process wins.
export async function loadEnvFile(home: string): Promise<void> {
  const text = await readFile(join(home, "env"), "utf8").catch(() => null);
  if (text === null) return;
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const name = line.slice(0, i);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (process.env[name] !== undefined) continue;
    process.env[name] = line.slice(i + 1);
  }
}

// Mirrors `jq -c 'if type == "array" then . else (.events // []) end'`. Null: []. Other scalars: error.
function historyPage(body: string): any[] {
  const v = JSON.parse(body);
  if (Array.isArray(v)) return v;
  if (v === null) return [];
  if (typeof v !== "object") throw new Error("not history");
  const ev = alt(v.events, []);
  if (!Array.isArray(ev)) throw new Error("not history");
  return ev;
}

// The node_patch jq expression of cmd_node_selections, applied to one node object.
export function applySelections(node: any, events: any[], max = SELECTION_HISTORY_MAX): void {
  const last = alt(node.last_event_sequence, 0);
  const merged = [...alt(node.selection_history, []), ...events.filter((e) => e.seq > last)];
  const firstBySeq = new Map<any, any>();
  for (const e of merged) if (!firstBySeq.has(e.seq)) firstBySeq.set(e.seq, e);
  const all = [...firstBySeq.values()].sort((a, b) => seqKey(a) - seqKey(b));
  const hist = all.length > max ? all.slice(all.length - max) : all;
  node.selection_history = hist;
  // jq assigns both keys on every run: the last entry's value, else the current value (null when missing).
  const lastEntry = hist.length > 0 ? hist[hist.length - 1] : null;
  node.last_event_sequence = lastEntry ? lastEntry.seq ?? null : node.last_event_sequence ?? null;
  node.requested_selector = lastEntry ? lastEntry.requested_selector ?? null : node.requested_selector ?? null;

  const solverModels = hist.filter((e) => e.stage === "solver" && e.model != null);
  const lastSolverModel = solverModels.length > 0 ? solverModels[solverModels.length - 1].model : undefined;
  node.main_model = alt(lastSolverModel, alt(node.main_model, null));

  const byKey = new Map<string, any>();
  for (const e of hist) byKey.set(JSON.stringify([e.attempt_key ?? null, e.stage ?? null]), e);
  const active = new Set<any>();
  for (const e of byKey.values()) {
    if (e.state === "selected" || e.state === "started") active.add(e.stage);
  }
  node.active_stages = [...active].sort();

  const text = (m: any) => (typeof m === "string" ? m : JSON.stringify(m));
  const modelled = hist.filter((e) => e.model != null && !text(e.model).includes("smart-auto"));
  const solvers = modelled.filter((e) => e.stage === "solver");
  const cur = alt(solvers[solvers.length - 1], modelled[modelled.length - 1]);
  if (cur !== undefined) {
    node.actual_model = alt(cur.model, alt(node.actual_model, null));
    node.role = alt(cur.role, alt(node.role, null));
    node.tier = alt(node.tier, alt(cur.tier, null));
  }

  const effOf = (e: any) => alt(e.selected_effort, e.sent_effort ?? null);
  const eff = hist.filter((e) => effOf(e) !== null && effOf(e) !== undefined);
  if (eff.length > 0) {
    node.effort = effOf(eff[eff.length - 1]);
    const old: any[] = alt(node.effort_history, []);
    const hs = old.length > 0 ? alt(old[old.length - 1].seq, 0) : 0;
    const acc = [...old];
    for (const e of eff) {
      if (!(e.seq > hs)) continue;
      const entry = { seq: e.seq ?? null, at: e.ts_ms ?? null, effort: effOf(e) };
      const prev = acc.length > 0 ? acc[acc.length - 1].effort ?? null : null;
      if (JSON.stringify(prev) === JSON.stringify(entry.effort)) continue;
      acc.push(entry);
    }
    node.effort_history = acc.length > 50 ? acc.slice(acc.length - 50) : acc;
  }
}

// CLI handler: writes stdout/stderr and returns the exit code.
export async function nodeSelections(args: string[]): Promise<number> {
  const r = await nodeSelectionsText(orchHome(), args);
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  return r.code;
}

export async function nodeSelectionsText(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const [runId = "", nodeId = ""] = args;
  if (!runId || !nodeId || args.length > 2) {
    return { code: 2, out: "", err: `usage: ${NODE_SELECTIONS_USAGE}\n` };
  }
  const run = await loadRun(home, runId);
  if (!run) return { code: 2, out: "", err: `run ${runId}: unknown run\n` };
  const node = (run.nodes ?? []).find((n: any) => n.id === nodeId);
  if (!node) return { code: 2, out: "", err: `node ${nodeId}: not in this run\n` };

  await loadEnvFile(home);
  const hubUrl = process.env.LLM_HUB_URL ?? "";
  if (hubUrl === "") return { code: 2, out: "", err: "node selections: LLM_HUB_URL not set\n" };
  const hubKey = process.env.LLM_HUB_KEY ?? "";
  const headers: Record<string, string> = hubKey === "" ? {} : { Authorization: `Bearer ${hubKey}` };

  const since = alt(node.last_event_sequence, 0);
  const attempts = alt(node.attempts, []).length + 1;
  const base = hubUrl.replace(/\/+$/, "");
  let events: any[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const q = [
      ["worker", `${runId}/${nodeId}/${attempt}`],
      ["since_seq", String(since)],
      ["limit", String(SELECTION_PAGE_LIMIT)],
    ]
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    let body: string;
    try {
      const res = await fetch(`${base}/api/smart-auto/history?${q}`, {
        headers,
        signal: AbortSignal.timeout(SELECTION_HTTP_TIMEOUT_MS),
      });
      body = await res.text();
    } catch {
      return { code: 1, out: "", err: `node selections: request to ${hubUrl} failed\n` };
    }
    try {
      events = events.concat(historyPage(body));
    } catch {
      return { code: 1, out: "", err: "node selections: hub answered with something other than history\n" };
    }
  }

  const count = events.filter((e) => e.seq > since).length;
  const rc = await mutateRun(home, runId, (r) => {
    const n = (r.nodes ?? []).find((x: any) => x.id === nodeId);
    if (n) applySelections(n, events);
  });
  if (rc !== 0) return { code: 1, out: "", err: "" };
  return { code: 0, out: `selections: ${count} new\n`, err: "" };
}
