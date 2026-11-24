// Process helpers shared by the loop, watch, schedule and announce commands. Bun built-ins only.
import { closeSync, openSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const BIN_ORCH = join(import.meta.dir, "..", "..", "scripts", "dispatch.ts");
export const dispatchPath = (): string => process.env.ORCH_DISPATCH || BIN_ORCH;
export const HERDR_PID_WAIT_SECS = 15;

export function pidAlive(pid: unknown): boolean {
  const n = Number(pid);
  if (!pid || !Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export function psCommand(pid: number): string | null {
  const r = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().trim();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isUint(s: unknown): boolean {
  return typeof s === "string" && /^\d+$/.test(s);
}

// parse_duration: 10s | 5m | 2h | 1d | N -> seconds, or null.
export function parseDuration(spec: string): number | null {
  const m = /^(\d+)([smhd]?)$/.exec(spec);
  if (!m) return null;
  const unit = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}

// Runs argv with a time limit; stdout and stderr are returned together.
export async function runLimited(secs: number, argv: string[], opts: { env?: Record<string, string | undefined> } = {}): Promise<{ code: number; out: string }> {
  const bin = argv[0]!.includes("/") ? argv[0]! : (Bun.which(argv[0]!, { PATH: (opts.env ?? process.env).PATH ?? "" }) ?? argv[0]!);
  const p = Bun.spawn([bin, ...argv.slice(1)], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    timeout: secs * 1000,
    killSignal: "SIGALRM",
    env: (opts.env ?? process.env) as any,
  });
  // A killed shell can leave a grandchild holding the pipes: stop reading shortly after the process ends.
  let o = "", e = "";
  const rd = async (s: ReadableStream, set: (t: string) => void) => { for await (const c of s as any) set(new TextDecoder().decode(c)); };
  const readers = Promise.all([rd(p.stdout as any, (t) => (o += t)), rd(p.stderr as any, (t) => (e += t))]);
  const code = await p.exited;
  await Promise.race([readers, Bun.sleep(200)]);
  return { code: code ?? 128 + 14, out: o + e };
}

// A new session, stdio to <log>. Returns the pid. The child is not waited for.
export function spawnDetached(argv: string[], log: string | null, env?: Record<string, string | undefined>): number {
  const fd = log ? openSync(log, "w") : -1;
  const p = Bun.spawn(argv, {
    detached: true,
    stdin: "ignore",
    stdout: fd >= 0 ? fd : "ignore",
    stderr: fd >= 0 ? fd : "ignore",
    env: (env ?? process.env) as any,
  });
  p.unref();
  if (fd >= 0) closeSync(fd);
  return p.pid;
}

export function spawnOrch(args: string[], log: string | null, env?: Record<string, string | undefined>): number {
  return spawnDetached([process.execPath, BIN_ORCH, ...args], log, env);
}

// Runs the dispatch entry in a child process.
export async function dispatchSh(args: string[], opts: { env?: Record<string, string | undefined>; inheritErr?: boolean; logFile?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, dispatchPath(), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: opts.inheritErr ? "inherit" : "pipe",
    env: (opts.env ?? process.env) as any,
  });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), p.stderr ? new Response(p.stderr).text() : Promise.resolve("")]);
  return { code: (await p.exited) ?? 1, out: o, err: e };
}

// Sync atomic JSON read-modify-write (a reader never sees a half-written file).
export function readJsonSync<T = any>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
export function writeJsonSync(file: string, v: unknown): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  renameSync(tmp, file);
}
export function patchJsonSync(file: string, fn: (o: any) => void): void {
  const o = readJsonSync(file);
  fn(o);
  writeJsonSync(file, o);
}
export function readJsonOr<T = any>(file: string, d: T): T {
  try {
    return readJsonSync<T>(file);
  } catch {
    return d;
  }
}
export function mtimeSecs(file: string): number | null {
  try {
    return Math.floor(statSync(file).mtimeMs / 1000);
  } catch {
    return null;
  }
}
export function hex4(): string {
  return Math.floor(Math.random() * 65536).toString(16).padStart(4, "0");
}
export function stampUtc(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}
export function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}
export { dirname, existsSync };

// job_status of dispatch.ts: running | done exit=N | done exit=unknown (...), or null for an unknown job.
export function jobStatus(jobsHome: string, id: string): string | null {
  const dir = join(jobsHome, id);
  if (!existsSync(dir)) return null;
  const readTrim = (f: string) => {
    try {
      return readFileSync(join(dir, f), "utf8").trim();
    } catch {
      return null;
    }
  };
  const ec = readTrim("exit_code");
  if (ec !== null) return `done exit=${ec}`;
  const pid = readTrim("pid");
  if (pid && pidAlive(pid)) return "running";
  const ec2 = readTrim("exit_code");
  if (ec2 !== null) return `done exit=${ec2}`;
  if (!pid) {
    let paneSet = false;
    try {
      paneSet = statSync(join(dir, "herdr_pane")).size > 0;
    } catch {}
    const launched = mtimeSecs(join(dir, "herdr-launch.sh"));
    if (paneSet && launched !== null && Math.floor(Date.now() / 1000) - launched < HERDR_PID_WAIT_SECS) return "running";
  }
  return "done exit=unknown (job process gone without an exit code: killed?)";
}

// Every descendant pid of `pid` (children first found first), read from `ps`. A job's real process (opencode, claude)
// is often a child outside the job pid's process group, so a group kill alone leaves it running.
export function descendants(pid: number): number[] {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return [];
  const kids = new Map<number, number[]>();
  for (const line of r.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [p, pp] = [Number(m[1]), Number(m[2])];
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  const all: number[] = [];
  const queue = [pid];
  while (queue.length) for (const k of kids.get(queue.shift()!) ?? []) if (!all.includes(k)) (all.push(k), queue.push(k));
  return all;
}

// Signals the pid, its process group and the given descendants. Returns the pids it signalled.
export function signalTree(pid: number, sig: NodeJS.Signals, tree: number[] = descendants(pid)): number[] {
  try { process.kill(-pid, sig); } catch { /* not a group leader */ }
  const hit: number[] = [];
  for (const p of [...tree].reverse().concat(pid)) { try { process.kill(p, sig); hit.push(p); } catch { /* gone */ } }
  return hit;
}
