#!/usr/bin/env bun
// List (and with --kill, stop) orphaned test processes: parent pid 1, test-process command, older than 10 min.
// Never matches target/release, launchd services, opencode, herdr or a node job (jobs/*/pid).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Proc = { pid: number; ppid: number; ageSec: number; command: string };

export const TEST_PATTERNS: RegExp[] = [
  /\/target\/debug\//,
  /\/llvm-cov-target\/debug\//,
  /bun -e "?const s = Bun\.serve\(/,
  /src\/server\/chats\/testing\/fake-claude[\w-]*\.ts/,
  /skills\/orch\/tests\/helpers\/smart-auto-hub\.ts/,
  /\/(?:private\/)?var\/folders\/[^ ]+\/T\//,
  /(?:^|[ =])\/tmp\//,
];
export const NEVER_PATTERNS: RegExp[] = [/target\/release/, /opencode/, /herdr/, /launchd/, /\.harness-orch\/deploy\//];
export const MIN_AGE_SEC = 600;

/** "[[dd-]hh:]mm:ss" from ps etime to seconds. */
export function parseEtime(s: string): number {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** Parse `ps -axo pid=,ppid=,etime=,command=`. */
export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: parseEtime(m[3]!), command: m[4]! });
  }
  return procs;
}

export function matchOrphans(procs: Proc[], jobPids: Set<number> = new Set(), minAge = MIN_AGE_SEC): Proc[] {
  return procs.filter((p) =>
    p.ppid === 1 && p.pid !== process.pid && p.ageSec >= minAge && !jobPids.has(p.pid) &&
    !NEVER_PATTERNS.some((r) => r.test(p.command)) && TEST_PATTERNS.some((r) => r.test(p.command)));
}

export function jobPidsFrom(home: string): Set<number> {
  const set = new Set<number>();
  const dir = join(home, "jobs");
  if (!existsSync(dir)) return set;
  for (const id of readdirSync(dir)) {
    try { const n = Number(readFileSync(join(dir, id, "pid"), "utf8").trim()); if (n > 0) set.add(n); } catch {}
  }
  return set;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (import.meta.main) {
  const kill = process.argv.includes("--kill");
  const home = process.env.HARNESS_ORCH_HOME ?? join(homedir(), ".harness-orch");
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,etime=,command="]).stdout.toString();
  const hits = matchOrphans(parsePs(ps), jobPidsFrom(home));
  const stamp = new Date().toISOString();
  for (const p of hits) console.log(`${stamp} orphan pid=${p.pid} age=${p.ageSec}s ${p.command.slice(0, 160)}`);
  console.log(`${stamp} ${hits.length} orphan(s)${kill ? ", killing" : ""}`);
  if (kill && hits.length) {
    for (const p of hits) try { process.kill(p.pid, "SIGTERM"); } catch {}
    await Bun.sleep(5000);
    for (const p of hits) if (alive(p.pid)) { try { process.kill(p.pid, "SIGKILL"); console.log(`${stamp} KILL pid=${p.pid}`); } catch {} }
  }
}
