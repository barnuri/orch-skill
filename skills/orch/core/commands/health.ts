// `run health`: classifies every non-terminal node of a run, lists ready nodes and free slots, records
// what changed since the last pass, and nudges stalled opencode sessions. Port of lib/runs/health.sh.
// The last pass lives in <home>/health/<run>.json (+ .key).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { appendEvents, loadRun, type RunState } from "../state/store.ts";
import { isoToEpoch } from "../state/timing.ts";
import { loadProfilesDoc, settingFrom } from "../state/settings.ts";
import { acquireLock } from "../state/lock.ts";
import { BIN_ORCH, isUint, runLimited } from "../state/proc.ts";
import { nowIso } from "../state/clock.ts";
import { opencodeDbPath, sessionIndex, type Sess } from "./owners.ts";
import { nodeReady } from "./run.ts";
import { watchAliveStatus } from "./loops.ts";

export const RUN_HEALTH_USAGE = "dispatch.ts run health <run-id> [--json] [--nudge] | run health --ensure-monitors";
const STALL_MIN_DEFAULT = 15;
const EVERY_SEC_DEFAULT = 30;
const EVERY_SEC_MIN = 10;
const NUDGE_GAP_DEFAULT = 1800;
const INDEX_DAYS = 3;
const FULL_PASS_SECS = 300;
const BY = "health";

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s);
const nn = (v: any) => (v === undefined || v === "" ? null : v);
const iso = (e: number | null) => (e === null ? null : new Date(Math.floor(e) * 1000).toISOString().replace(".000Z", "Z"));
const hhmm = (e: number | null) => {
  if (e === null) return "?";
  const d = new Date(Math.floor(e) * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const nudgeGap = () => (isUint(process.env.ORCH_HEALTH_NUDGE_GAP_SECS) ? Number(process.env.ORCH_HEALTH_NUDGE_GAP_SECS) : NUDGE_GAP_DEFAULT);

export async function healthEverySec(home: string): Promise<number> {
  let v: string = process.env.ORCH_HEALTH_EVERY_SEC ?? "";
  if (!v) v = settingFrom(await loadProfilesDoc(home), "health_every_sec", String(EVERY_SEC_DEFAULT));
  let n = isUint(v) ? Number(v) : EVERY_SEC_DEFAULT;
  const min = isUint(process.env.ORCH_EVERY_MIN_SECS) && Number(process.env.ORCH_EVERY_MIN_SECS) >= 1 ? Number(process.env.ORCH_EVERY_MIN_SECS) : EVERY_SEC_MIN;
  if (n < min) n = min;
  return n;
}

async function stallMinutes(home: string): Promise<number> {
  const v = process.env.ORCH_STALL_MIN ?? settingFrom(await loadProfilesDoc(home), "stall_minutes", String(STALL_MIN_DEFAULT));
  return isUint(v) ? Number(v) : STALL_MIN_DEFAULT;
}

type Snap = Record<string, any>;

// The classification (HEALTH_JQ). prev is the last saved snapshot or {}.
export function classify(r: RunState, runId: string, now: number, stall: number, gap: number, ix: Sess[], prev: Snap, maxp: number): Snap {
  const S = new Map(ix.map((s) => [s.id, s]));
  const pn: Record<string, any> = prev._nodes ?? {};
  const st = Object.fromEntries(r.nodes.map((n) => [n.id, n.status]));
  const runn = r.nodes.filter((n) => n.status === "running");
  const running = runn.length;
  const slots = Math.max(0, maxp - running);
  const waiting = r.nodes.filter((n) => n.status === "waiting").map((n) => ({
    id: n.id, needs: nn(n.needs_user), hold: nn(n.hold), ready: nodeReady(r, n), gate: n.after_all ?? false,
    deps: (r.edges ?? []).filter((e: any) => e[1] === n.id).map((e: any) => e[0] as string),
  }));
  const ready = waiting.filter((w) => w.ready).map((w) => w.id);
  const nudged: Record<string, number> = prev._nudged ?? {};
  const rn = runn.map((n) => {
    const s = n.owner_kind === "session" && (n.owner_id ?? "") !== "" ? S.get(n.owner_id) ?? null : null;
    const noteat = ((n.notes ?? []) as any[]).map((x) => isoToEpoch(x.at)).filter((x): x is number => x !== null);
    const noteMax = noteat.length ? Math.max(...noteat) : null;
    const la = isoToEpoch(n.last_activity);
    const cands = s ? [s.updated, noteMax, la] : [isoToEpoch(n.updated), isoToEpoch(n.started), la, noteMax];
    const present = cands.filter((x): x is number => x !== null && x !== undefined);
    const last = present.length ? Math.max(...present) : null;
    const idle = last === null ? null : Math.floor((now - last) / 60);
    let h: string;
    if ((n.owner ?? "") === "" && (n.job_id ?? "") === "") h = "unowned";
    else if (n.owner_kind === "session" && (n.owner_id ?? "") !== "" && s === null && ix.length > 0 && (isoToEpoch(n.started) ?? 0) > now - INDEX_DAYS * 86400) h = "dead";
    else if (last !== null && now - last >= stall) h = "stalled";
    else if (s !== null && !s.busy && (n.report == null || n.report.reported_by === "owner-fill")) h = "no-report";
    else h = "ok";
    const note = h === "stalled" ? `no activity since ${hhmm(last)}` : h === "dead" ? `session ${n.owner_id} is gone`
      : h === "unowned" ? "running with no owner and no job" : h === "no-report" ? "session idle, node not reported" : null;
    return {
      id: n.id, status: n.status, health: h, owner_id: n.owner_id ?? null, last_activity: iso(last), idle_min: idle, note,
      _session: n.owner_kind === "session" && String(n.owner_id ?? "").startsWith("ses_") ? (n.owner_id as string) : null,
      _due: h === "ok" || h === "no-report" ? (last === null ? null : last + stall) : null,
    };
  });
  const wn = waiting.map((w) => {
    let nt: string;
    if (w.needs != null) nt = `needs the user: ${w.needs}`;
    else if (w.hold != null) nt = `held: ${w.hold}`;
    else if (w.ready) nt = "ready";
    else {
      const blockers = [
        ...w.deps.filter((d: string) => st[d] !== "done"),
        ...(w.gate ? r.nodes.filter((x) => x.id !== w.id && !(x.after_all ?? false) && x.status !== "done" && x.status !== "skipped").map((x) => x.id as string) : []),
      ];
      nt = "waiting on " + [...new Set(blockers)].sort().join(",");
    }
    return { id: w.id, status: "waiting", health: w.needs != null ? "needs-user" : w.hold != null ? "held" : "ok", owner_id: null, last_activity: null, idle_min: null, note: nt };
  });
  const changes: any[] = [];
  if (Object.keys(prev).length > 0) {
    for (const n of r.nodes) {
      const from = pn[n.id]?.status ?? "";
      if ((from === "running" || from === "waiting") && ["done", "error", "skipped"].includes(n.status)) changes.push({ kind: "finished", node: n.id, from, to: n.status, note: `${n.id} ${n.status}` });
    }
  }
  const newReady = ready.filter((i) => !((prev.ready ?? []) as string[]).includes(i));
  if (newReady.length > 0) changes.push({ kind: "ready", node: null, from: null, to: null, note: "ready: " + newReady.join(",") });
  for (const n of rn) {
    const before = pn[n.id]?.health ?? "ok";
    if (n.health !== "ok" && before !== n.health) changes.push({ kind: n.health, node: n.id, from: before, to: n.health, note: `${n.id} ${n.health}: ${n.note}` });
  }
  for (const n of rn) {
    const before = pn[n.id]?.health ?? "ok";
    if (n.health === "ok" && before !== "ok") changes.push({ kind: "recovered", node: n.id, from: before, to: "ok", note: `${n.id} recovered` });
  }
  const hm = Object.fromEntries(rn.map((n) => [n.id, n.health]));
  const dues = [
    ...rn.map((n) => n._due).filter((d): d is number => d !== null),
    ...rn.filter((n) => n.health === "stalled" && n._session !== null && nudged[n.id] != null).map((n) => nudged[n.id]! + gap),
  ];
  return {
    run: runId, status: r.status, at: iso(now), max_parallel: maxp, running, slots,
    nodes: [...rn.map(({ _session, _due, ...x }) => x), ...wn], ready, changes,
    _nodes: Object.fromEntries(r.nodes.map((n) => [n.id, { status: n.status, health: hm[n.id] ?? null }])),
    _nudge: rn.filter((n) => (n.health === "stalled" || n.health === "no-report") && n._session !== null && now - (nudged[n.id] ?? 0) >= gap).map((n) => ({
      node: n.id, session: n._session,
      text: n.health === "no-report"
        ? "Your session is idle and the node has no result. Write handoff.md into $ORCH_NODE_OUT, then record the result with dispatch.ts node result."
        : `You stopped mid-task at ${hhmm(isoToEpoch(n.last_activity))}. Continue the task to completion and reply only with the final report.`,
    })),
    _nudged: nudged,
    _due: dues.length ? Math.min(...dues) : null,
  };
}

// {node: {h, note}} for every running node, read-only (what `run wait` shows).
export async function healthMap(home: string, runId: string, stallMin: number): Promise<Record<string, { h: string; note: string | null }>> {
  const r = await loadRun(home, runId);
  if (!r) return {};
  const snap = classify(r, runId, Math.floor(Date.now() / 1000), stallMin * 60, nudgeGap(), sessionIndex(), {}, await maxParallel(home));
  return Object.fromEntries((snap.nodes as any[]).filter((n) => n.status === "running").map((n) => [n.id, { h: n.health, note: n.note }]));
}

async function maxParallel(home: string): Promise<number> {
  const d: any = await loadProfilesDoc(home);
  return d.defaults?.max_parallel || d.settings?.max_parallel || 15;
}

const healthDir = (home: string) => join(home, "health");

export function statKey(files: string[]): string {
  let s = "";
  for (const f of files) {
    try {
      const x = statSync(f);
      s += `${Math.floor(x.mtimeMs / 1000)}:${x.size} `;
    } catch { /* missing: no output, as stat */ }
  }
  return s;
}

async function appendHealthEvents(home: string, run: string, evs: Array<[string, string, string, string, string]>): Promise<void> {
  await appendEvents(home, run, evs.map(([kind, node, from, to, note]) => ({ at: nowIso(), kind, node: nn(node), from: nn(from), to: nn(to), note: nn(note), by: BY })));
}

async function sendNudges(home: string, run: string, line: Snap): Promise<string[]> {
  const bin = Bun.which("opencode", { PATH: process.env.PATH ?? "" });
  if (!bin) return (err("health: opencode not found, no nudge sent\n"), []);
  const sent: string[] = [];
  for (const n of line._nudge as any[]) {
    const body = JSON.stringify({ text: n.text, delivery: "queue" });
    const r = await runLimited(Number(process.env.ORCH_NUDGE_TIMEOUT ?? 10), [bin, "api", "POST", `/api/session/${n.session}/prompt`, "--data", body]);
    if (r.code === 0) {
      await appendHealthEvents(home, run, [["nudge", n.node, "", "", `nudged ${n.session}: ${n.text}`]]);
      err(`health: nudged ${n.node} (${n.session})\n`);
      sent.push(n.node);
    } else err(`health: nudge ${n.node} (${n.session}) failed: ${r.out.slice(0, 200)}\n`);
  }
  return sent;
}

// One pass: returns the snapshot (report + private fields) and saves it.
export async function healthPass(home: string, run: string, nudge: boolean): Promise<Snap | null> {
  const dir = healthDir(home);
  mkdirSync(dir, { recursive: true });
  const snapF = join(dir, `${run}.json`);
  const keyF = join(dir, `${run}.key`);
  const stateF = paths.runState(home, run);
  const files = [stateF, opencodeDbPath(), paths.runEvents(home, run)];
  const now = Math.floor(Date.now() / 1000);
  const stallMin = await stallMinutes(home);
  const gap = nudgeGap();
  const tail = `${stallMin} ${gap}`;
  const key = statKey(files) + tail;
  const prevSnap: Snap | null = existsSync(snapF) ? await Bun.file(snapF).json().catch(() => null) : null;
  if (prevSnap && existsSync(keyF)) {
    const [pk, pd, pa] = (await Bun.file(keyF).text()).replace(/\n$/, "").split("\t");
    const due = !pd || pd === "null" ? null : Math.floor(Number(pd));
    if (pk === key && now - (Number(pa) || 0) < FULL_PASS_SECS && (due === null || now < due) && (!nudge || !(prevSnap._nudge?.length > 0))) {
      const { nudged, ...rest } = prevSnap;
      return { ...rest, changes: [] };
    }
  }
  const r = await loadRun(home, run);
  if (!r) return null;
  const line = classify(r, run, now, stallMin * 60, gap, sessionIndex(), prevSnap ?? {}, await maxParallel(home));
  let sent: string[] = [];
  if (nudge && line._nudge.length > 0) {
    sent = await sendNudges(home, run, line);
    if (sent.length) {
      for (const n of sent) line._nudged[n] = now;
      line.nudged = sent;
      line._nudge = line._nudge.filter((x: any) => !sent.includes(x.node));
    }
  }
  if (line.changes.length > 0) await appendHealthEvents(home, run, line.changes.map((c: any) => ["health", c.node ?? "", c.from ?? "", c.to ?? "", c.note]));
  await Bun.write(`${snapF}.tmp.${process.pid}`, JSON.stringify(line) + "\n");
  await Bun.$`mv -f ${snapF}.tmp.${process.pid} ${snapF}`.quiet();
  const k2 = line.changes.length > 0 || sent.length > 0 ? statKey(files) + tail : key;
  await Bun.write(keyF, `${k2}\t${line._due ?? "null"}\t${now}\n`);
  return line;
}

function renderText(l: Snap): string {
  const o = [`run ${l.run} [${l.status}]: running ${l.running}/${l.max_parallel}, slots ${l.slots}`, `ready: ${l.ready.join(",")}`];
  for (const n of l.nodes) if (n.health !== "ok") o.push(`${n.health}: ${n.id}${n.owner_id ? ` (${n.owner_id})` : ""} — ${n.note}`);
  if (l.changes.length) o.push("changes: " + l.changes.map((c: any) => c.note).join("; "));
  if ((l.nudged ?? []).length > 0) o.push("nudged: " + l.nudged.join(","));
  if (l._nudge.length > 0 && (l.nudged ?? null) === null) o.push("would nudge (pass --nudge): " + l._nudge.map((n: any) => n.node).join(","));
  return o.join("\n") + "\n";
}

// ---- the per-run monitor ----------------------------------------------------------------------------

const monitorName = (run: string) => `health:${run}`;

export function healthMonitorFind(home: string, run: string): string | null {
  const root = join(home, "watches");
  if (!existsSync(root)) return null;
  for (const id of readdirSync(root).sort()) {
    const spec = join(root, id, "spec.json");
    let text = "";
    try { text = readFileSync(spec, "utf8"); } catch { continue; }
    if (!new RegExp(`"name": *"${monitorName(run)}"`).test(text)) continue;
    try { if (watchAliveStatus(id) === "running") return id; } catch { /* unreadable */ }
  }
  return null;
}

async function monitorStartLocked(home: string, run: string): Promise<string | null> {
  const found = healthMonitorFind(home, run);
  if (found) return found;
  const every = await healthEverySec(home);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `HARNESS_ORCH_HOME=${q(home)} ORCH_NO_ANNOUNCE=1 ORCH_EVENT_BY=${BY} ${q(process.execPath)} ${q(BIN_ORCH)} run health ${q(run)} --monitor`;
  const p = Bun.spawn([process.execPath, BIN_ORCH, "watch", "start", "--name", monitorName(run), cmd, "--every", `${every}s`, "--until", "^health: run .* ended", "--max-runtime", "7d"],
    { env: { ...process.env, WATCH_MAX_ACTIVE: "100000" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const o = (await new Response(p.stdout).text()).trim();
  if ((await p.exited) !== 0) return null;
  await appendHealthEvents(home, run, [["health", "", "", "", `monitor started (${o}, every ${every}s)`]]);
  return o;
}

// Single-flight per run.
export async function healthMonitorStart(home: string, run: string): Promise<string | null> {
  const lock = await acquireLock(home, `health-monitor-${run}`, 50, 100);
  if (!lock) return null;
  try { return await monitorStartLocked(home, run); } finally { await lock.release(); }
}

export async function healthMonitorAutostart(home: string, run: string): Promise<void> {
  const v = process.env.ORCH_HEALTH_MONITOR ?? "";
  if (["0", "false", "off"].includes(v)) return;
  if (!["1", "true", "on"].includes(v) && process.env.ORCH_NO_ANNOUNCE === "1") return;
  if (!run || !existsSync(paths.runState(home, run))) return;
  await healthMonitorStart(home, run).catch(() => null);
}

async function runningRuns(home: string): Promise<string[]> {
  const ids: string[] = [];
  const root = paths.runs(home);
  for (const d of existsSync(root) ? readdirSync(root).sort() : []) {
    const r = await Bun.file(join(root, d, "state.json")).json().catch(() => null);
    if (r && r.status === "running" && !String(r.run_id ?? "").startsWith("loop-")) ids.push(r.run_id);
  }
  return ids;
}

async function ensureMonitors(home: string): Promise<void> {
  for (const run of await runningRuns(home)) {
    if (healthMonitorFind(home, run)) continue;
    const id = await healthMonitorStart(home, run);
    if (id) out(`started ${id} for ${run}\n`);
  }
}

async function monitorTick(home: string, run: string): Promise<number> {
  const r = await loadRun(home, run);
  if (!r || r.status !== "running") {
    if (r) await appendHealthEvents(home, run, [["health", "", "", "", `monitor stopped (run ${r.status || "gone"})`]]);
    out(`health: run ${run} ended (${r?.status || "gone"})\n`);
    return 0;
  }
  const auto = settingFrom(await loadProfilesDoc(home), "auto_nudge", "true") !== "false";
  const line = await healthPass(home, run, auto);
  if (!line) return 1;
  for (const c of line.changes) out(c.note + "\n");
  return 0;
}

export async function runHealth(args: string[]): Promise<number> {
  let run = "";
  let json = false, nudge = false, monitor = false, ensure = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--nudge") nudge = true;
    else if (a === "--monitor") monitor = true;
    else if (a === "--ensure-monitors") ensure = true;
    else if (a.startsWith("-")) return (err(`run health: unknown argument ${a}\n  usage: ${RUN_HEALTH_USAGE}\n`), 2);
    else if (run) return (err(`usage: ${RUN_HEALTH_USAGE}\n`), 2);
    else run = a;
  }
  const home = orchHome();
  if (ensure) {
    await ensureMonitors(home);
    if (!run) return 0;
  }
  if (!run) return (err(`usage: ${RUN_HEALTH_USAGE}\n`), 2);
  if (monitor) return monitorTick(home, run);
  if (!(await loadRun(home, run))) return (err(`run ${run}: unknown run\n`), 2);
  const line = await healthPass(home, run, nudge);
  if (!line) return 1;
  if (json) {
    const { _nodes, _nudged, _due, _nudge, ...rest } = line;
    out(JSON.stringify({ ...rest, would_nudge: _nudge.map((n: any) => n.node) }) + "\n");
  } else out(renderText(line));
  return 0;
}
