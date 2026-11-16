#!/usr/bin/env bun
// orch-perf: measure a run and append the findings to .claude/skills/orch-perf/learnings.md.
// Self learning: every run adds one dated block with numbers; a metric that got worse than the
// previous block is marked WORSE, and a recurring problem is marked REPEATED.
// Usage: bun scripts/orch-perf.ts [run-id]
import { existsSync, readdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env["HARNESS_ORCH_HOME"] ?? join(process.env["HOME"] ?? "", ".harness-orch");
const runs = readdirSync(join(home, "runs")).filter((d) => existsSync(join(home, "runs", d, "state.json"))).sort();
const run = process.argv[2] ?? runs[runs.length - 1];
if (run === undefined) throw new Error("no run");
interface Node { id: string; status?: string; started?: string; finished?: string; dispatched_at?: string; started_at?: string; attempts?: unknown[]; cost?: { usd?: number }; profile?: string; error?: string; job_id?: string }
const state = JSON.parse(readFileSync(join(home, "runs", run, "state.json"), "utf8")) as { nodes: Node[] };
const secs = (a?: string, b?: string): number | null => { const x = Date.parse(a ?? ""), y = Date.parse(b ?? ""); return Number.isFinite(x) && Number.isFinite(y) && y >= x ? (y - x) / 1000 : null; };
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!; };

const done = state.nodes.filter((n) => n.status === "done");
const wall = done.map((n) => secs(n.started, n.finished)).filter((x): x is number => x !== null);
const queued = state.nodes.map((n) => secs(n.dispatched_at, n.started_at)).filter((x): x is number => x !== null);
const retried = state.nodes.filter((n) => (n.attempts?.length ?? 0) > 0).length;
const errors = state.nodes.filter((n) => n.status === "error");
const noHandoff = done.filter((n) => { const f = join(home, "runs", run, "out", n.id, "handoff.md"); return !existsSync(f) || statSync(f).size === 0; }).length;
const cost = state.nodes.reduce((s, n) => s + (n.cost?.usd ?? 0), 0);
const byProfile = new Map<string, { n: number; usd: number }>();
for (const n of state.nodes) { const p = n.profile ?? "-"; const e = byProfile.get(p) ?? { n: 0, usd: 0 }; e.n += 1; e.usd += n.cost?.usd ?? 0; byProfile.set(p, e); }
const inbox = join(home, "runs", run, "inbox", "orch");
let asks = 0, askLatency: number[] = [];
if (existsSync(inbox)) for (const f of readdirSync(inbox).filter((x) => x.endsWith(".json"))) {
  const a = JSON.parse(readFileSync(join(inbox, f), "utf8")) as { kind: string; at?: string; answered_at?: string };
  if (a.kind === "ask") { asks += 1; const l = secs(a.at, a.answered_at); if (l !== null) askLatency = [...askLatency, l]; }
}
const load = (() => { try { return readFileSync("/proc/loadavg", "utf8").split(" ")[0]; } catch { return "n/a"; } })();
const metrics: Record<string, number> = {
  nodes: state.nodes.length, done: done.length, errors: errors.length, retried, no_handoff_done: noHandoff,
  median_node_s: Math.round(median(wall)), median_queue_s: Math.round(median(queued)), asks, median_ask_latency_s: Math.round(median(askLatency)), cost_usd: Math.round(cost * 100) / 100,
};
const file = join(import.meta.dir, "..", ".claude", "skills", "orch-perf", "learnings.md");
const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
const last = [...prev.matchAll(/<!-- metrics (\{.*?\}) -->/g)].pop();
const before = last?.[1] ? (JSON.parse(last[1]) as Record<string, number>) : null;
const worse = ["errors", "retried", "no_handoff_done", "median_node_s", "median_queue_s", "median_ask_latency_s"].filter((k) => before !== null && (metrics[k] ?? 0) > (before[k] ?? 0));
const problems: string[] = [];
if (noHandoff > 0) problems.push(`${noHandoff} node(s) done without handoff (agents ending early)`);
if (errors.length > 0) problems.push(`${errors.length} node(s) in error: ${errors.slice(0, 5).map((n) => `${n.id}: ${(n.error ?? "").slice(0, 50)}`).join("; ")}`);
if (median(queued) > 60) problems.push(`median queue ${Math.round(median(queued))} s between dispatch and first activity`);
if (median(askLatency) > 120) problems.push(`median ask latency ${Math.round(median(askLatency))} s (coordinator slow to answer)`);
const repeated = problems.filter((p) => prev.includes(p.split(" ").slice(1, 5).join(" ")));
const block = [
  `\n## ${new Date().toISOString().slice(0, 16)} run ${run}`,
  `<!-- metrics ${JSON.stringify(metrics)} -->`,
  `- numbers: ${Object.entries(metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`,
  `- cost by profile: ${[...byProfile].map(([p, v]) => `${p} n=${v.n} $${v.usd.toFixed(2)}`).join("; ")}`,
  worse.length > 0 ? `- WORSE than the previous block: ${worse.join(", ")}` : "- no metric worse than the previous block",
  ...problems.map((p) => `- problem${repeated.includes(p) ? " REPEATED" : ""}: ${p}`),
  `- load average at measure time: ${load}`,
  "",
].join("\n");
appendFileSync(file, block);
console.log(block);
