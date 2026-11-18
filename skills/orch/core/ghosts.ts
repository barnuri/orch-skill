// Ghost runners: orch loop, watch and job processes whose home or record no longer says they should run.
// Pure classification lives here (tests feed fake ps rows). `scanRunners` and `killGhosts` are the thin
// process wrappers. A runner that is running with its own pid and a state file touched in the last 5
// minutes is never a ghost.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, isAbsolute, join, relative, basename, sep } from "node:path";
import { paths } from "./state/home.ts";
import { psCommand } from "./state/proc.ts";

export type RunnerKind = "loop" | "watch" | "job" | "serve";
export type GhostReason = "home-missing" | "record-missing" | "record-not-running" | "pid-mismatch" | "run-finished" | "temp-test-home";

export const HEARTBEAT_LIVE_SECS = 300;
export const TEMP_HOME_MAX_AGE_SECS = 1800;
export const TEMP_HOME_MAX_RUNTIME_SECS = 900;
export const TEMP_HOME_PATTERN = /orch-t-|wdpill-|orch-test/;
/** Pauses before the second and third look at a ghost candidate. */
export const REJUDGE_WAITS_MS = [2000, 4000];
export const SELF_CHECK_BACKOFF_SECS = [1, 4, 16];

export interface RunnerProc {
  pid: number;
  kind: RunnerKind;
  /** Loop or watch id, or the job directory for a job. Empty for serve. */
  id: string;
  /** HARNESS_ORCH_HOME from the process environment, or null when the process did not set it. */
  home: string | null;
  command: string;
}

export interface RecordFacts {
  status: string | null;
  pid: number | null;
  /** state.json mtime, epoch seconds. */
  heartbeat: number | null;
  /** The run status of the runner's run, when it has one. */
  runStatus: string | null;
}

export interface Facts {
  homeExists: boolean;
  /** null when the record file is missing. */
  record: RecordFacts | null;
  /** Age of the home dir in seconds, or null when unknown. */
  homeAgeSecs: number | null;
}

export interface Judgement {
  pid: number;
  kind: RunnerKind;
  id: string;
  home: string | null;
  ghost: boolean;
  reason: GhostReason | null;
}

// realpath of a path that may not exist: resolves the nearest existing ancestor, then re-appends the rest.
function realish(p: string): string {
  const rest: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

// A temp home is a directory directly under the temp dir whose name matches the pattern. Both sides are
// compared as realpaths (macOS /var is /private/var).
export function isTempHome(home: string, tmp: string): boolean {
  if (!isAbsolute(home)) return false;
  const rel = relative(realish(tmp), realish(home));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  return TEMP_HOME_PATTERN.test(rel.split(sep)[0]!);
}

// Pure. Order matters: the live check comes first, so a live runner is never a ghost.
export function classifyRunner(p: RunnerProc, f: Facts, opt: { now: number; tmp: string }): Judgement {
  const base = { pid: p.pid, kind: p.kind, id: p.id, home: p.home };
  const r = f.record;
  if (r && f.homeExists && r.status === "running" && r.pid === p.pid && (p.kind === "job" || (r.heartbeat !== null && opt.now - r.heartbeat <= HEARTBEAT_LIVE_SECS))) {
    return { ...base, ghost: false, reason: null };
  }
  const ghost = (reason: GhostReason) => ({ ...base, ghost: true, reason });
  if (p.kind === "serve") {
    if (p.home !== null && !f.homeExists) return ghost("home-missing");
    return { ...base, ghost: false, reason: null };
  }
  if (p.home === null || !f.homeExists) return ghost("home-missing");
  if (!r) return ghost("record-missing");
  if (r.status !== "running") return ghost("record-not-running");
  if (p.kind !== "job" && r.pid !== p.pid) return ghost("pid-mismatch");
  if (r.runStatus === "done" || r.runStatus === "cancelled") return ghost("run-finished");
  if (isTempHome(p.home, opt.tmp) && f.homeAgeSecs !== null && f.homeAgeSecs > TEMP_HOME_MAX_AGE_SECS) return ghost("temp-test-home");
  return { ...base, ghost: false, reason: null };
}

// The runner's hard max-runtime cap. A temp home is capped at 15 minutes whatever the spec says.
export function effectiveDeadline(specDeadline: number, startEpoch: number, home: string | null, tmp: string): number {
  if (home !== null && isTempHome(home, tmp)) return Math.min(specDeadline, startEpoch + TEMP_HOME_MAX_RUNTIME_SECS);
  return specDeadline;
}

// Runner self-check. `check` returns a reason when the runner's own record or home is wrong, else null.
// Retries wait 1 s, 4 s, then 16 s. Returns the reason that survived the last retry, or null.
export async function confirmMiss(check: () => string | null, sleep: (secs: number) => Promise<void>): Promise<string | null> {
  let reason = check();
  if (reason === null) return null;
  for (const s of SELF_CHECK_BACKOFF_SECS) {
    await sleep(s);
    reason = check();
    if (reason === null) return null;
  }
  return reason;
}

// One stat plus one small read of the runner's own record. Never lists a directory.
// `recordFile` is state.json for loop and watch, and the job dir for job (exit_code absent = running).
export function selfCheckReason(kind: RunnerKind, home: string, recordFile: string, pid: number): string | null {
  if (!existsSync(home)) return "home-missing";
  if (kind === "job") {
    if (!existsSync(recordFile)) return "record-missing";
    return existsSync(join(recordFile, "exit_code")) ? "record-not-running" : null;
  }
  let rec: any;
  try {
    rec = JSON.parse(readFileSync(recordFile, "utf8"));
  } catch {
    return existsSync(recordFile) ? null : "record-missing";
  }
  if (rec.status !== "running") return "record-not-running";
  if (Number(rec.pid) !== pid) return "pid-mismatch";
  return null;
}

// ---- thin process wrappers ----

// Executable is bun or node (any path, optional `run` or flags) or the script itself; the script is dispatch.ts or cli.ts.
// No quotes before the script, so `node -e "...dispatch.ts loop __run"` text does not match.
export const RUNNER_RE = /^(?:(?:\S*\/)?(?:bun|node|tsx)(?:\s+(?:run|--?[\w-]+))*\s+(?:[^"']*?[\s/])?|(?:\S*\/)?)(?:dispatch|cli)\.ts\s+(loop __run|watch __run|job-run|serve)\b\s*(\S*)/;

// Parses `ps -axo pid=,command=` output. Pure: the fake-ps fixture feeds this directly.
export function parseRunnerLines(psOut: string, homeOf: (pid: number) => string | null | undefined): RunnerProc[] {
  const out: RunnerProc[] = [];
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[2]!;
    const r = RUNNER_RE.exec(command);
    if (!r) continue;
    const home = homeOf(pid);
    if (home === undefined) continue; // home unknown (unreadable or ambiguous): never judged, never a ghost
    const what = r[1]!;
    const kind: RunnerKind = what === "loop __run" ? "loop" : what === "watch __run" ? "watch" : what === "job-run" ? "job" : "serve";
    out.push({ pid, kind, id: r[2] ?? "", home, command });
  }
  return out;
}

// HARNESS_ORCH_HOME from `ps eww` output (macOS) or a NUL-separated /proc environ (Linux).
// Returns the home, null when the variable is absent, undefined when the value is ambiguous.
// ps eww joins the environment with spaces: the value ends at the next ` VAR=` token. A value with
// spaces is accepted only when it exists on disk.
export function homeFromEnv(text: string): string | null | undefined {
  if (text.includes("\0")) {
    for (const e of text.split("\0")) if (e.startsWith("HARNESS_ORCH_HOME=")) return e.slice(18) || undefined;
    return null;
  }
  const m = /(?:^|\s)HARNESS_ORCH_HOME=/.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/\s[A-Za-z_][A-Za-z0-9_]*=/);
  const v = (end < 0 ? rest : rest.slice(0, end)).trim();
  if (!v) return undefined;
  if (/\s/.test(v) && !existsSync(v)) return undefined;
  return v;
}

// The environment is visible when it carries a common variable.
function envVisible(text: string): boolean {
  return /(?:^|[\s\0])(?:PATH|HOME|USER)=/.test(text);
}

// Home of a runner pid. undefined = cannot tell (unreadable env, ambiguous): never judged.
export function homeOfPid(pid: number): string | null | undefined {
  try {
    let text: string;
    if (process.platform === "linux") text = readFileSync(`/proc/${pid}/environ`, "utf8");
    else {
      const r = Bun.spawnSync(["ps", "eww", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      if (r.exitCode !== 0) return undefined;
      text = r.stdout.toString();
    }
    if (!envVisible(text)) return undefined;
    const h = homeFromEnv(text);
    if (h === undefined) return undefined;
    return h ?? join(process.env.HOME || homedir(), ".harness-orch");
  } catch {
    return undefined;
  }
}

// Keeps only the rows of `ps -axo pid=,uid=,command=` owned by `uid`, as `pid command`.
export function ownUidLines(psOut: string, uid: number): string {
  const out: string[] = [];
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[2]) === uid) out.push(`${m[1]} ${m[3]}`);
  }
  return out.join("\n");
}

export function scanRunners(): RunnerProc[] {
  const r = Bun.spawnSync(["ps", "-axo", "pid=,uid=,command="], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0 || typeof process.getuid !== "function") return [];
  return parseRunnerLines(ownUidLines(r.stdout.toString(), process.getuid()), homeOfPid);
}

// The job dir from the command: the first token, or the longest token prefix that exists (path with spaces).
// null = gone. undefined = cannot tell (the path may contain spaces and no prefix exists).
function jobDirOf(p: RunnerProc): string | null | undefined {
  const m = /job-run\s+(.*)$/.exec(p.command);
  const toks = (m ? m[1]! : p.id).split(" ");
  for (let n = toks.length; n >= 1; n--) {
    const cand = toks.slice(0, n).join(" ");
    if (existsSync(cand)) return cand;
  }
  const first = toks[0] ?? "";
  if (!first.startsWith("/") || (p.home !== null && /\s/.test(p.home))) return undefined;
  return null;
}

// undefined = cannot read the record: the runner is not judged.
function readRecord(home: string, p: RunnerProc): RecordFacts | null | undefined {
  const sub = p.kind === "loop" ? "loops" : p.kind === "watch" ? "watches" : null;
  if (p.kind === "job") {
    const dir = jobDirOf(p);
    if (dir === undefined) return undefined;
    if (dir === null) return null;
    const done = existsSync(join(dir, "exit_code"));
    let pid: number | null = null;
    try {
      const n = Number(readFileSync(join(dir, "pid"), "utf8").trim());
      if (Number.isInteger(n) && n > 0) pid = n;
    } catch {}
    return { status: done ? "done" : "running", pid, heartbeat: null, runStatus: null };
  }
  if (!sub) return null;
  const file = join(home, sub, p.id, "state.json");
  if (!existsSync(file)) return null;
  let s: any = {};
  try {
    s = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  let heartbeat: number | null = null;
  try {
    heartbeat = Math.floor(statSync(file).mtimeMs / 1000);
  } catch {}
  let runStatus: string | null = null;
  if (p.kind === "loop") {
    try {
      runStatus = JSON.parse(readFileSync(paths.runState(home, p.id), "utf8")).status ?? null;
    } catch {}
  }
  return { status: s.status ?? null, pid: s.pid == null ? null : Number(s.pid), heartbeat, runStatus };
}

export function judgeAll(procs: RunnerProc[], now = Math.floor(Date.now() / 1000), tmp = tmpdir()): Judgement[] {
  return procs.map((p) => {
    const home = p.home;
    const homeExists = home !== null && existsSync(home);
    let homeAgeSecs: number | null = null;
    if (homeExists) {
      try {
        homeAgeSecs = now - Math.floor(statSync(home).birthtimeMs / 1000);
      } catch {}
    }
    const record = home !== null && homeExists && p.kind !== "serve" ? readRecord(home, p) : null;
    if (record === undefined) return { pid: p.pid, kind: p.kind, id: p.id, home: p.home, ghost: false, reason: null };
    return classifyRunner(p, { homeExists, record, homeAgeSecs }, { now, tmp });
  });
}

export const UNAMBIGUOUS: GhostReason[] = ["home-missing", "record-missing", "temp-test-home"];

// Fresh judgement of one runner (re-reads its home and record). null = cannot tell: cancels the kill.
export function rejudgeOne(p: RunnerProc): Judgement | null {
  const home = homeOfPid(p.pid);
  if (home === undefined) return null;
  return judgeAll([{ ...p, home }])[0] ?? null;
}

// Sends SIGTERM, waits up to 5 s, then SIGKILL. Only ghosts, only when the process still runs the same
// runner command (guards against pid reuse), and only when the same reason holds on every look: now and
// +2 s for a temp home, now, +2 s and +6 s for any other home. A changed reason, a live verdict or an
// unreadable home at any look cancels the kill.
export async function killGhosts(
  judged: Judgement[],
  procs: RunnerProc[],
  deps: {
    kill: (pid: number, sig: NodeJS.Signals) => void;
    alive: (pid: number) => boolean;
    sleep: (ms: number) => Promise<void>;
    still: (pid: number) => string | null;
    rejudge: (p: RunnerProc) => Judgement | null;
    tmp?: string;
  },
  log: (s: string) => void,
): Promise<number> {
  const tmp = deps.tmp ?? tmpdir();
  let cands = judged.filter((j) => j.ghost && j.reason !== null && procs.some((p) => p.pid === j.pid));
  const looks = (j: Judgement) => (j.home !== null && isTempHome(j.home, tmp) ? 1 : 2);
  for (let round = 0; round < REJUDGE_WAITS_MS.length && cands.length; round++) {
    if (!cands.some((j) => looks(j) > round)) break;
    await deps.sleep(REJUDGE_WAITS_MS[round]!);
    cands = cands.filter((j) => {
      if (looks(j) <= round) return true;
      const again = deps.rejudge(procs.find((p) => p.pid === j.pid)!);
      const keep = again !== null && again.ghost && again.reason === j.reason;
      if (!keep) log(`keep ${j.pid} (${j.kind} ${j.id}): ${j.reason} did not hold\n`);
      return keep;
    });
  }
  let killed = 0;
  for (const j of cands) {
    if (deps.still(j.pid) === null) continue;
    log(`kill ${j.pid} (${j.kind} ${j.id}): ${j.reason}\n`);
    deps.kill(j.pid, "SIGTERM");
    for (let i = 0; i < 50 && deps.alive(j.pid); i++) await deps.sleep(100);
    if (deps.alive(j.pid)) deps.kill(j.pid, "SIGKILL");
    killed++;
  }
  return killed;
}

// The command of a live pid that still matches a runner, else null.
export function stillSameCommand(pid: number): string | null {
  const c = psCommand(pid);
  return c !== null && RUNNER_RE.test(c) ? c : null;
}
