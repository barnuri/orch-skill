// `announce`: show orch activity in Herdr (display-only metadata) and in the status line files.
// Port of scripts/announce.sh. Never fails the caller. See references/status-bridge.md.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, chmodSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { orchHome } from "../state/home.ts";
import { pidAlive, psCommand, sleep, spawnOrch } from "../state/proc.ts";

const LOG_CAP = 102400;

type Opts = { runId: string; ttl: number; dry: boolean; clear: boolean; quiet: boolean };

function agentSessionId(): string {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.OPENCODE_SESSION_ID || `pid-${process.ppid}`;
}
function agentHarness(): string {
  if (process.env.CLAUDE_CODE_SESSION_ID) return "claude";
  if (process.env.OPENCODE_SESSION_ID) return "opencode";
  return "unknown";
}

/** A session shows orch activity only when it is part of a run: it is the run's coordinator (session id or pane),
 *  or it owns one of the run's nodes, or the caller named the run explicitly. Any other session sees nothing,
 *  so a session that stopped using orch no longer shows "orch" because some other run or monitor is alive. */
export function attributed(s: any, id: string, runId: string, sid: string, pane: string): boolean {
  if (runId !== "") return runId === id;
  const c = s.coordinator ?? {};
  if (sid !== "" && c.session_id === sid) return true;
  if (pane !== "" && c.pane_id === pane) return true;
  return (s.nodes ?? []).some((n: any) => sid !== "" && (n.session === sid || n.owner_id === sid));
}

export function scan(home: string, runId: string, sid = "", pane = "") {
  let running = 0, done = 0, total = 0, loops = 0, watches = 0;
  const each = (kind: string) => {
    const root = join(home, kind);
    if (!existsSync(root)) return [] as any[];
    const rows: any[] = [];
    for (const id of readdirSync(root)) {
      try {
        rows.push([id, JSON.parse(readFileSync(join(root, id, "state.json"), "utf8"))]);
      } catch {}
    }
    return rows;
  };
  const mine = new Set<string>();
  for (const [id, s] of each("runs")) {
    if (s.status !== "running" || !attributed(s, id, runId, sid, pane)) continue;
    mine.add(id);
    const nodes: any[] = s.nodes ?? [];
    running += nodes.filter((n) => n.status === "running").length;
    done += nodes.filter((n) => n.status === "done").length;
    total += nodes.length;
  }
  // Loops and monitors count only when they belong to one of this session's runs and the run has work running.
  const own = (s: any): boolean => mine.has(String(s.run_id ?? s.run ?? "")) && running > 0;
  for (const [, s] of each("loops")) if (s.status === "running" && (pidAlive(s.pid) || s.demo === true) && own(s)) loops++;
  for (const [, s] of each("watches")) if (s.status === "running" && pidAlive(s.pid) && own(s)) watches++;
  return { running, done, total, loops, watches };
}

function writeAtomic(path: string, body: string): void {
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.tmp.${Math.random().toString(36).slice(2, 8)}`);
    writeFileSync(tmp, body + "\n", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch {}
}

async function runLimitedFile(secs: number, argv: string[], outFile: string | null): Promise<void> {
  try {
    const fd = outFile ? openSync(outFile, "w", 0o600) : -1;
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: fd >= 0 ? fd : "ignore", stderr: "ignore", timeout: secs * 1000, killSignal: "SIGALRM" });
    await p.exited;
    if (fd >= 0) closeSync(fd);
  } catch {}
}

// One announce pass. Returns the number of busy things (running nodes + loops + watches).
async function announceOnce(o: Opts, env: NodeJS.ProcessEnv): Promise<number> {
  const home = orchHome(env);
  const say = (s: string) => {
    if (!o.quiet) process.stdout.write(s + "\n");
  };
  let sid = env.ANNOUNCE_SID || agentSessionId();
  if (!sid || sid === "unknown") sid = `pid-${process.ppid}`;
  const pane = env.HERDR_PANE_ID ?? "";
  const { running, done, total, loops, watches } = scan(home, o.runId, sid, pane);
  const busy = running + loops + watches;
  let summary = "";
  let active = false;
  if (!o.clear && busy > 0) {
    active = true;
    summary = `orch: ${running} running, ${done}/${total} done`;
    if (loops > 0) summary += ` · ${loops} loop${loops > 1 ? "s" : ""}`;
    if (watches > 0) summary += ` · ${watches} monitor${watches > 1 ? "s" : ""}`;
    summary = summary.slice(0, 120);
  }
  const harness = env.ANNOUNCE_HARNESS ?? agentHarness();
  const now = Math.floor(Date.now() / 1000);
  const json = JSON.stringify({ active, updated_at: now, running, done, total, summary, pane, harness });
  const wf = JSON.stringify({ active, updated_at: now });

  let bin = "";
  if (env.HERDR_ENV === "1" && pane) {
    if (env.HERDR_BIN_PATH && existsSync(env.HERDR_BIN_PATH)) bin = env.HERDR_BIN_PATH;
    else bin = Bun.which("herdr", { PATH: process.env.PATH ?? "" }) ?? "";
  }
  const timeout = Number(env.ANNOUNCE_HERDR_TIMEOUT ?? 5) || 5;
  if (bin) {
    let label = "orch";
    try {
      const tmpc = join(tmpdir(), `orch-pane-${process.pid}-${sid}.out`);
      await runLimitedFile(timeout, [bin, "pane", "current"], tmpc);
      const a = JSON.parse(readFileSync(tmpc, "utf8"))?.result?.pane?.agent;
      if (a) label = a;
    } catch {}
    try { unlinkSync(join(tmpdir(), `orch-pane-${process.pid}-${sid}.out`)); } catch {}
    const args = active
      ? ["pane", "report-metadata", pane, "--source", "user:orch", "--agent", label, "--state-label", `idle=${summary}`, "--state-label", `working=${summary}`, "--token", `orch=${summary}`, "--ttl-ms", String(o.ttl * 1000)]
      : ["pane", "report-metadata", pane, "--source", "user:orch", "--agent", label, "--clear-state-labels", "--clear-token", "orch", "--clear-title"];
    if (o.dry) say(`herdr: ${bin} ${args.join(" ")}`);
    else await runLimitedFile(timeout, [bin, ...args], null);
  } else if (o.dry) say("herdr: skipped (not in Herdr or no binary)");

  const adir = join(home, "activity");
  const wdir = join(env.HOME || homedir(), ".claude", "workflow-active");
  const w = (path: string, body: string) => {
    if (o.dry) {
      say(`file: ${path}`);
      say(`  ${body}`);
    } else writeAtomic(path, body);
  };
  w(join(adir, `${sid}.json`), json);
  if (harness === "claude") w(join(wdir, sid), wf);
  if (o.dry) say(`summary: ${summary || "<none, clears>"}`);
  return busy;
}

function pidfile(home: string) { return join(home, "announce.pid"); }
function readPid(home: string): string {
  try {
    return readFileSync(pidfile(home), "utf8").trim();
  } catch {
    return "";
  }
}
function pidIsDaemon(pid: string): boolean {
  if (!pid || !pidAlive(pid)) return false;
  return (psCommand(Number(pid)) ?? "").includes("announce");
}

function dlog(home: string, msg: string): void {
  const f = join(home, "announce.log");
  try {
    if (existsSync(f) && statSync(f).size > LOG_CAP) {
      const b = readFileSync(f);
      writeFileSync(f, b.subarray(b.length - 50000));
    }
    appendFileSync(f, `${new Date().toISOString().replace(/\.\d+Z$/, "Z")} ${msg}\n`);
  } catch {}
}

function claimPidfile(home: string): boolean {
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(pidfile(home), `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {}
  const cur = readPid(home);
  if (cur !== String(process.pid) && pidIsDaemon(cur)) return false;
  try {
    writeFileSync(pidfile(home), `${process.pid}\n`);
  } catch {}
  return readPid(home) === String(process.pid);
}

async function daemonRun(home: string, base: Opts): Promise<number> {
  const interval = Number(process.env.ANNOUNCE_INTERVAL ?? 20) || 20;
  const idleSecs = Number(process.env.ANNOUNCE_IDLE_SECS ?? 600) || 600;
  if (!claimPidfile(home)) return 0;
  const onStop = () => {
    if (readPid(home) === String(process.pid)) try { writeFileSync(pidfile(home), ""); } catch {}
    dlog(home, `daemon ${process.pid} stopped`);
    process.exit(0);
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  dlog(home, `daemon ${process.pid} started (interval ${interval}s, idle ${idleSecs}s)`);
  let idleSince = Math.floor(Date.now() / 1000);
  for (;;) {
    if (readPid(home) !== String(process.pid)) { dlog(home, `daemon ${process.pid} lost the pidfile`); break; }
    const adir = join(home, "activity");
    const files = existsSync(adir) ? readdirSync(adir).filter((n) => n.endsWith(".json")) : [];
    let anyActive = false;
    for (const n of files) {
      const f = join(adir, n);
      let st;
      try { st = statSync(f); } catch { continue; }
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) continue;
      let j: any;
      try { j = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
      const sid = n.slice(0, -5);
      const pane = j.pane ?? "";
      try {
        await announceOnce({ ...base, quiet: true }, { ...process.env, ANNOUNCE_IN_DAEMON: "1", ANNOUNCE_SID: sid, ANNOUNCE_HARNESS: j.harness ?? "", HERDR_PANE_ID: pane, HERDR_ENV: pane ? "1" : "0" });
      } catch {}
    }
    for (const n of files) {
      try { if (JSON.parse(readFileSync(join(adir, n), "utf8")).active === true) anyActive = true; } catch {}
    }
    const now = Math.floor(Date.now() / 1000);
    if (anyActive) idleSince = now;
    else if (now - idleSince >= idleSecs) { dlog(home, `daemon ${process.pid} idle, exiting`); break; }
    await sleep(interval * 1000);
  }
  return 0;
}

function stopDaemon(home: string): void {
  const cur = readPid(home);
  if (pidIsDaemon(cur)) try { process.kill(Number(cur), "SIGTERM"); } catch {}
}

export async function announce(args: string[]): Promise<number> {
  const o: Opts = { runId: "", ttl: 120, dry: false, clear: false, quiet: false };
  let mode: "once" | "daemon" | "stop" = "once";
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--run": o.runId = args[++i] ?? ""; break;
      case "--ttl-sec": { const v = args[++i] ?? "120"; o.ttl = /^\d+$/.test(v) ? Number(v) : 120; break; }
      case "--dry-run": o.dry = true; break;
      case "--clear": o.clear = true; break;
      case "--quiet": o.quiet = true; break;
      case "--daemon": mode = "daemon"; break;
      case "--stop": mode = "stop"; break;
    }
  }
  const home = orchHome();
  try {
    if (mode === "daemon") return await daemonRun(home, o);
    if (mode === "stop") { stopDaemon(home); return 0; }
    const busy = await announceOnce(o, process.env);
    if (o.clear) stopDaemon(home);
    else if (!o.dry && !process.env.ANNOUNCE_IN_DAEMON && !process.env.ANNOUNCE_NO_DAEMON && busy > 0) {
      if (!pidIsDaemon(readPid(home))) {
        mkdirSync(home, { recursive: true });
        spawnOrch(["announce", "--daemon"], null);
      }
    }
  } catch {}
  return 0;
}
