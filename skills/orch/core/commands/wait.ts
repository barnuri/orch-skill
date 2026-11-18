// `run wait <run-id> [--timeout SECS] [--stall-min N] [--json] [--follow] [--include-notes]`.
// Port of lib/runs/wait.sh. Blocks until the run needs its coordinator, then prints one line per event.
// The run's events.jsonl is read from a cursor first, then the state is diffed against the snapshot kept
// in the same cursor (runs/<run>/wait.cursor, or wait.follow.cursor for --follow; written only here).
import { copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { loadRun } from "../state/store.ts";
import { runSync } from "./runs.ts";
import { coordinatorAutoRecord, coordSweep } from "./inbox.ts";
import { healthMonitorFind, healthMonitorStart } from "./health.ts";
import { healthEverySec, healthMap, stallMinutes } from "../runs/health.ts";
import { nodeReady } from "./run.ts";
import { resultText } from "../runs/node.ts";

export const RUN_WAIT_USAGE = "dispatch.ts run wait <run-id> [--timeout SECS] [--stall-min N] [--json] [--follow] [--include-notes]";
const POLL_DEFAULT = 2;
const RESCAN_DEFAULT = 15;
const COORD_SWEEP_SECS = 20;
const WAKE = new Set(["stalled", "dead", "no-report"]);

type Ev = { kind: string; node: string | null; from?: string | null; to?: string | null; note?: string | null; result?: string | null };
type Snap = { status: string; nodes: Record<string, { s: string; needs: string | null; e: string | null }>; ready: string[] };
type Cursor = { n: number; snap?: Snap; health?: Record<string, string>; settled?: boolean };

const nn = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function quiet(fn: () => Promise<unknown>): Promise<void> {
  const o = process.stdout.write, e = process.stderr.write;
  (process.stdout as any).write = () => true;
  (process.stderr as any).write = () => true;
  try { await fn(); } catch {} finally { process.stdout.write = o; process.stderr.write = e; }
}
const uint = (v: string) => /^[0-9]+$/.test(v);

function snapNow(run: any): Snap {
  const nodes: Snap["nodes"] = {};
  for (const n of run.nodes) nodes[n.id] = { s: n.status, needs: nn(n.needs_user), e: nn(n.error) };
  return { status: run.status, nodes, ready: run.nodes.filter((n: any) => nodeReady(run, n)).map((n: any) => n.id) };
}

export function scan(run: any, evs: any[], cur: Cursor, hm: Record<string, { h: string; note: string | null }> | null, notes: boolean): { cursor: Cursor; events: Ev[] } {
  const now = snapNow(run);
  const running = run.nodes.filter((n: any) => n.status === "running").length;
  const h0 = cur.health ?? {};
  if (!cur.snap) return { cursor: { ...cur, snap: now, health: h0, settled: false }, events: [] };
  const snap: Snap = structuredClone(cur.snap);
  const health = { ...h0 };
  const out: Ev[] = [];
  const resOf = (id: string, to: unknown): string | null => {
    if (to !== "done") return null;
    const t = resultText(run.nodes.find((x: any) => x.id === id) ?? {}, 200);
    return t === "" ? "[unknown]" : t;
  };
  for (const e of evs) {
    if (typeof e !== "object" || e === null || e.node == null) continue;
    if (e.kind === "status") {
      if (snap.nodes[e.node]?.s === e.to) continue;
      snap.nodes[e.node] = { ...(snap.nodes[e.node] ?? { needs: null, e: null }), s: e.to };
      out.push({ kind: "status", node: e.node, from: e.from, to: e.to, note: e.to === "error" ? e.note ?? null : null, result: resOf(e.node, e.to) });
    } else if (e.kind === "needs-user") {
      const nu = (e.note ?? "cleared") === "cleared" ? null : e.note;
      if ((snap.nodes[e.node]?.needs ?? null) === nu) continue;
      snap.nodes[e.node] = { ...(snap.nodes[e.node] ?? { s: "", e: null }), needs: nu };
      if (nu !== null) out.push({ kind: "needs-user", node: e.node, note: nu });
    } else if ((e.kind === "health" || e.kind === "owner") && ["stalled", "dead", "no-report", "gone", "failed"].includes(e.to ?? "")) {
      const k = e.to === "gone" || e.to === "failed" ? "dead" : e.to;
      if (health[e.node] === k) continue;
      health[e.node] = k;
      out.push({ kind: k, node: e.node, note: e.note ?? null });
    } else if (e.kind === "health" && e.to === "ok") health[e.node] = "ok";
    else if (e.kind === "ask") out.push({ kind: "ask", node: e.node, note: e.note ?? null });
    else if (notes && (e.kind === "note" || e.kind === "ping")) out.push({ kind: "note", node: e.node, note: e.note ?? "ping" });
  }
  const diff: Ev[] = [];
  for (const [id, c] of Object.entries(now.nodes)) {
    const p = snap.nodes[id] ?? null;
    if (p !== null && p.s !== c.s) diff.push({ kind: "status", node: id, from: p.s, to: c.s, note: c.s === "error" ? c.e : null, result: resOf(id, c.s) });
    if (c.needs !== null && (p?.needs ?? null) !== c.needs) diff.push({ kind: "needs-user", node: id, note: c.needs });
  }
  const newReady = now.ready.filter((i) => !(snap.ready ?? []).includes(i));
  const hpOut: Ev[] = [];
  if (hm !== null) {
    for (const [id, x] of Object.entries(hm)) {
      if (WAKE.has(x.h) && health[id] !== x.h) hpOut.push({ kind: x.h, node: id, note: x.note });
      health[id] = x.h;
    }
  }
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(health)) if (now.nodes[k]?.s === "running") kept[k] = v;
  const ev1: Ev[] = [
    ...out,
    ...diff,
    ...(newReady.length ? [{ kind: "ready", node: null, note: newReady.join(",") }] : []),
    ...hpOut,
    ...(now.status !== "running" ? [{ kind: "run-ended", node: null, to: now.status, note: null }] : []),
  ];
  const idle = now.status === "running" && running === 0 && now.ready.length === 0;
  const settle: Ev[] = ev1.length === 0 && idle && !cur.settled ? [{ kind: "settled", node: null, note: "no running or ready nodes" }] : [];
  return {
    cursor: { ...cur, snap: now, health: kept, settled: settle.length > 0 ? true : idle ? cur.settled ?? false : false },
    events: [...ev1, ...settle],
  };
}

function render(runId: string, json: boolean, events: Ev[]): string {
  if (json) {
    const at = nowIso();
    return events.map((e) => JSON.stringify({ at, run: runId, kind: e.kind, node: e.node, from: e.from ?? null, to: e.to ?? null, note: e.note ?? null, ...(e.result ? { result: e.result } : {}) })).join("\n") + "\n";
  }
  return events
    .map((e) => {
      if (e.kind === "status") return `${e.node} ${e.from ?? "-"}->${e.to}` + (e.note ? `: ${e.note}` : "") + (e.result ? ` ${e.result}` : "");
      if (e.kind === "ready") return `ready: ${e.note}`;
      if (e.kind === "run-ended") return `run ended: ${e.to}`;
      if (e.kind === "settled") return `settled: ${e.note}`;
      if (e.kind === "monitor") return `monitor: ${e.note}`;
      if (e.node == null) return `${e.kind}: ${e.note ?? ""}`;
      return `${e.node} ${e.kind}: ${e.note ?? ""}`;
    })
    .join("\n") + "\n";
}

function stamp(f: string): string {
  try {
    const s = statSync(f);
    return `${Math.floor(s.mtimeMs / 1000)}:${s.size}`;
  } catch {
    return "";
  }
}

function readCursor(file: string): Cursor | null {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function checkMonitor(home: string, runId: string, evf: string): Promise<Ev[]> {
  if (["0", "false", "off"].includes(process.env.ORCH_HEALTH_MONITOR ?? "")) return [];
  if (!existsSync(evf) || !readFileSync(evf, "utf8").includes('"note":"monitor started')) return [];
  if ((await loadRun(home, runId))?.status !== "running" || healthMonitorFind(home, runId)) return [];
  const id = await healthMonitorStart(home, runId).catch(() => null);
  return [{ kind: "monitor", node: null, note: id ? `health monitor was dead, restarted ${id}` : "health monitor is dead and did not restart" }];
}

export async function runWait(args: string[]): Promise<number> {
  const home = orchHome();
  let runId = "", timeoutS = "0", stallArg = "", json = false, follow = false, notes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--timeout") timeoutS = args[++i] ?? "";
    else if (a === "--stall-min") stallArg = args[++i] ?? "";
    else if (a === "--json") json = true;
    else if (a === "--follow") follow = true;
    else if (a === "--include-notes") notes = true;
    else if (a.startsWith("-")) { process.stderr.write(`run wait: unknown argument ${a}\n  usage: ${RUN_WAIT_USAGE}\n`); return 2; }
    else if (runId) { process.stderr.write(`usage: ${RUN_WAIT_USAGE}\n`); return 2; }
    else runId = a;
  }
  if (!runId) { process.stderr.write(`usage: ${RUN_WAIT_USAGE}\n`); return 2; }
  if (!uint(timeoutS)) { process.stderr.write("run wait: --timeout must be whole seconds\n"); return 2; }
  const stallMin = stallArg === "" ? await stallMinutes(home) : Number(stallArg);
  if (stallArg !== "" && !(uint(stallArg) && stallMin > 0)) { process.stderr.write("run wait: --stall-min must be a positive whole number\n"); return 2; }
  if (!(await loadRun(home, runId))) { process.stderr.write(`run ${runId}: unknown run\n`); return 2; }

  const evf = paths.runEvents(home, runId);
  const sharedCursor = join(home, "runs", runId, "wait.cursor");
  const cursorFile = follow ? join(home, "runs", runId, "wait.follow.cursor") : sharedCursor;
  if (follow && !existsSync(cursorFile) && existsSync(sharedCursor)) { try { copyFileSync(sharedCursor, cursorFile); } catch {} }
  let rescan = Number(process.env.ORCH_WAIT_RESCAN_SECS ?? RESCAN_DEFAULT);
  if (!(Number.isInteger(rescan) && rescan >= 1)) rescan = RESCAN_DEFAULT;
  const poll = Number(process.env.ORCH_WAIT_POLL_SECS ?? POLL_DEFAULT);
  const every = process.env.ORCH_WAIT_HEALTH_SECS ? Number(process.env.ORCH_WAIT_HEALTH_SECS) : await healthEverySec(home);
  const timeout = Number(timeoutS);
  const deadline = timeout > 0 ? Math.floor(Date.now() / 1000) + timeout : 0;
  const lineCount = () => (existsSync(evf) ? (readFileSync(evf, "utf8").match(/\n/g) ?? []).length : 0);

  let cur: Cursor = readCursor(cursorFile) ?? ({} as Cursor);
  if (cur.n === undefined) cur = { n: lineCount() };
  let nextHealth = 0, nextSync = 0, nextScan = 0, nextBridge = 0, lastKey = "";
  const stateFile = paths.runState(home, runId);

  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    let hm: Record<string, { h: string; note: string | null }> | null = null;
    let extra: Ev[] = [];
    let run = await loadRun(home, runId);
    if (!run) { process.stderr.write(`run ${runId}: unknown run\n`); return 2; }
    if (now >= nextSync) {
      nextSync = now + rescan;
      if (run.nodes.some((n) => n.status === "running" && (n.job_id ?? "") !== "")) {
        await quiet(() => runSync([runId, "--no-retry"]));
        run = (await loadRun(home, runId)) ?? run;
      }
    }
    if (now >= nextScan) { nextScan = now + rescan; lastKey = ""; }
    if (now >= nextBridge) {
      nextBridge = now + COORD_SWEEP_SECS;
      if ((run as any).coordinator == null) await quiet(() => coordinatorAutoRecord(home, runId));
      await quiet(() => coordSweep(home, runId));
    }
    if (now >= nextHealth) {
      nextHealth = now + every;
      hm = await healthMap(home, run, stallMin).catch(() => null);
      extra = await checkMonitor(home, runId, evf);
      lastKey = "";
    }
    const key = `${stamp(stateFile)} ${stamp(evf)}`;
    if (key !== lastKey) {
      lastKey = key;
      const lines = existsSync(evf) ? readFileSync(evf, "utf8").split("\n") : [];
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      const total = lines.length;
      let n = cur.n ?? 0;
      if (total < n) n = 0;
      const evs = lines.slice(n, total).map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const fresh = (await loadRun(home, runId)) ?? run;
      const r = scan(fresh, evs, { ...cur, n }, hm, notes);
      const events = [...extra, ...r.events];
      if (events.length) process.stdout.write(render(runId, json, events));
      cur = { ...r.cursor, n: total };
      const tmp = `${cursorFile}.tmp.${process.pid}`;
      await Bun.write(tmp, JSON.stringify(cur) + "\n");
      await rename(tmp, cursorFile);
      if (events.length) {
        if (events.some((e) => e.kind === "run-ended")) return 0;
        if (!follow) return events.every((e) => e.kind === "settled") ? 3 : 0;
      }
    } else if (extra.length) {
      process.stdout.write(render(runId, json, extra));
      if (!follow) return 0;
    }
    if (deadline > 0 && Math.floor(Date.now() / 1000) >= deadline) {
      if (json) process.stdout.write(JSON.stringify({ at: nowIso(), run: runId, kind: "timeout", note: `no change in ${timeout}s` }) + "\n");
      else process.stdout.write(`no change (timed out after ${timeout}s)\n`);
      return 124;
    }
    await sleep(poll * 1000);
  }
}
