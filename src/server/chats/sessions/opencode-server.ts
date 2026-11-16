import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isAlive, killGroup } from "./turn-files";

/**
 * Long-lived `opencode serve` processes that chat turns attach to with `opencode run --server <url>`, so a turn
 * skips the private-server start-up `--standalone` pays on every message. One server per profile; it is started
 * with the profile's env (which carries OPENCODE_CONFIG_CONTENT), because a server reads its config once. The
 * client sends its own working directory, so one server serves every chat folder.
 *
 * Restart-safe, like the chat turns (turn-files.ts): the server runs detached (own session and process group,
 * stdout on `<home>/chats/serve/<profile>.log`), and `<home>/chats/serve/<profile>.json` records its pid, url,
 * password, profile and config hash. That folder is written only by the dashboard server (like chats.db). A new
 * dashboard adopts a recorded server whose pid is alive, whose port answers and whose hash matches, so a dashboard
 * stop or restart neither kills the server nor the turns attached to it.
 *
 * A server is stopped only when its profile config changed (hash differs) and no turn is in flight on it, or
 * when it sat idle for SERVE_IDLE_MS. Turns in flight are leases: the pid of each attached turn's process, kept
 * in the record so a later dashboard still sees them. While a server is down, starting, or waiting to be replaced,
 * `get()` answers null and the turn runs `--standalone`.
 */
export interface OpencodeServer { url: string; password: string }

/** How long a server may sit with no turn before it is stopped. */
export const SERVE_IDLE_MS = 2 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const START_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1_000;
const POLL_MS = 50;
const BACKOFF_MS = [500, 2_000, 10_000, 30_000];
const LISTENING = /listening on (https?:\/\/\S+)/i;

export interface ServeRecord {
  pid: number;
  url: string | null;
  password: string;
  profile: string;
  hash: string;
  bin: string;
  started: string;
  last_used: string;
  /** Pids of the turn processes attached to this server right now. */
  turns: number[];
}

export interface ServeTarget {
  /** Orch state dir: the record lives in `<home>/chats/serve/`. */
  home: string;
  profile: string;
  /** What the server's config depends on (the profile's env); hashed with the binary. */
  config: Record<string, string | undefined>;
}

interface Entry {
  /** The record this dashboard last checked and found healthy (pid + url), so a turn does not probe every time. */
  verified: { pid: number; url: string } | null;
  starting: Promise<OpencodeServer | null> | null;
  failures: number;
  retryAt: number;
  /** Process handle of a server this dashboard spawned (null for an adopted one). */
  proc: ReturnType<typeof Bun.spawn> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Last spawn arguments, for the restart after a crash. */
  last: { bin: string; env: Record<string, string | undefined>; target: ServeTarget; hash: string } | null;
}

export function serveDir(home: string): string {
  return join(home, "chats", "serve");
}

function safeName(profile: string): string {
  return profile.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}

export function servePaths(home: string, profile: string): { record: string; log: string } {
  const base = join(serveDir(home), safeName(profile));
  return { record: `${base}.json`, log: `${base}.log` };
}

export function readServeRecord(path: string): ServeRecord | null {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<ServeRecord>;
    if (typeof doc.pid === "number" && typeof doc.hash === "string" && typeof doc.password === "string") {
      return { url: null, profile: "", bin: "", started: "", last_used: "", turns: [], ...doc } as ServeRecord;
    }
  } catch {
    // missing or half written
  }
  return null;
}

function writeRecord(path: string, rec: ServeRecord): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, path);
}

export function configHash(bin: string, config: Record<string, string | undefined>): string {
  return createHash("sha256").update(JSON.stringify([bin, Object.entries(config).filter(([, v]) => v !== undefined).sort()])).digest("hex").slice(0, 16);
}

/** Pids of the turns still running on the server (dead leases dropped). */
function liveTurns(rec: ServeRecord): number[] {
  return rec.turns.filter((pid) => isAlive(pid));
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

export class OpencodeServerPool {
  private readonly entries = new Map<string, Entry>();
  private readonly homes = new Set<string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly opts: { startTimeoutMs?: number; backoffMs?: readonly number[]; idleMs?: number; sweepMs?: number } = {}) {}

  static enabled(): boolean {
    return process.env.ORCH_CHAT_OPENCODE_SERVE !== "0";
  }

  private get idleMs(): number {
    return this.opts.idleMs ?? SERVE_IDLE_MS;
  }

  private entry(t: ServeTarget): Entry {
    const key = `${t.home}\0${t.profile}`;
    let e = this.entries.get(key);
    if (e === undefined) {
      e = { verified: null, starting: null, failures: 0, retryAt: 0, proc: null, restartTimer: null, last: null };
      this.entries.set(key, e);
    }
    return e;
  }

  private watch(home: string): void {
    if (this.homes.has(home)) {
      return;
    }
    this.homes.add(home);
    // A server left idle while no dashboard ran is stopped now; then on a timer.
    this.sweep();
    if (this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepMs ?? Math.min(SWEEP_EVERY_MS, Math.max(1_000, this.idleMs / 4)));
      this.sweepTimer.unref?.();
    }
  }

  /** A running server for this profile and config, or null (down, starting, being replaced): run standalone then. */
  async get(bin: string, env: Record<string, string | undefined>, target: ServeTarget): Promise<OpencodeServer | null> {
    if (this.stopped) {
      return null;
    }
    this.watch(target.home);
    const hash = configHash(bin, target.config);
    const e = this.entry(target);
    if (e.starting !== null) {
      const s = await e.starting;
      return s !== null && e.last?.hash === hash ? s : null;
    }
    const paths = servePaths(target.home, target.profile);
    const rec = readServeRecord(paths.record);
    if (rec !== null && rec.pid > 0 && isAlive(rec.pid)) {
      if (rec.hash !== hash) {
        // The profile changed. Never two servers for one profile: replace it once no turn runs on it.
        if (liveTurns(rec).length > 0) {
          return null;
        }
        await this.kill(target, rec);
      } else if (rec.url !== null) {
        if (e.verified?.pid === rec.pid && e.verified.url === rec.url) {
          return { url: rec.url, password: rec.password };
        }
        if (await answers(rec.url)) {
          e.verified = { pid: rec.pid, url: rec.url };
          e.failures = 0;
          return { url: rec.url, password: rec.password };
        }
        await this.kill(target, rec);
      } else {
        // Another dashboard is starting it (or it hung before listening): wait for the url, then give up on it.
        const ready = await this.waitForRecord(paths.record, rec.pid);
        if (ready !== null) {
          e.verified = { pid: rec.pid, url: ready.url };
          return ready;
        }
        await this.kill(target, rec);
      }
    }
    if (Date.now() < e.retryAt) {
      return null;
    }
    this.spawn(e, bin, env, target, hash);
    return e.starting === null ? null : e.starting;
  }

  private async waitForRecord(path: string, pid: number): Promise<OpencodeServer | null> {
    const end = Date.now() + (this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
    while (Date.now() < end && isAlive(pid)) {
      const r = readServeRecord(path);
      if (r === null || r.pid !== pid) {
        return null;
      }
      if (r.url !== null) {
        return { url: r.url, password: r.password };
      }
      await Bun.sleep(POLL_MS);
    }
    return null;
  }

  /** Records that the turn process `pid` runs on the profile's server, so nothing stops the server under it. */
  lease(target: Pick<ServeTarget, "home" | "profile">, pid: number): void {
    this.update(target, (rec) => ({ ...rec, turns: [...liveTurns(rec).filter((p) => p !== pid), pid], last_used: new Date().toISOString() }));
  }

  release(target: Pick<ServeTarget, "home" | "profile">, pid: number): void {
    this.update(target, (rec) => ({ ...rec, turns: liveTurns(rec).filter((p) => p !== pid), last_used: new Date().toISOString() }));
  }

  private update(target: Pick<ServeTarget, "home" | "profile">, fn: (rec: ServeRecord) => ServeRecord): void {
    const path = servePaths(target.home, target.profile).record;
    const rec = readServeRecord(path);
    if (rec === null || rec.pid <= 0) {
      return;
    }
    try {
      writeRecord(path, fn(rec));
    } catch {
      // the folder vanished: the lease is best effort
    }
  }

  /** PIDs of the live recorded servers in the homes this pool has served (tests and diagnostics). */
  pids(): number[] {
    const out: number[] = [];
    for (const home of this.homes) {
      for (const rec of this.records(home)) {
        if (rec.pid > 0 && rec.url !== null && isAlive(rec.pid)) {
          out.push(rec.pid);
        }
      }
    }
    return out;
  }

  private records(home: string): ServeRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(serveDir(home));
    } catch {
      return [];
    }
    return names.filter((n) => n.endsWith(".json")).flatMap((n) => {
      const r = readServeRecord(join(serveDir(home), n));
      return r === null ? [] : [r];
    });
  }

  /** Stops every server that had no turn for the idle time. */
  sweep(nowMs: number = Date.now()): void {
    for (const home of this.homes) {
      for (const rec of this.records(home)) {
        if (rec.pid <= 0 || !isAlive(rec.pid) || liveTurns(rec).length > 0) {
          continue;
        }
        const last = Date.parse(rec.last_used || rec.started);
        if (Number.isFinite(last) && nowMs - last > this.idleMs) {
          void this.kill({ home, profile: rec.profile }, rec);
        }
      }
    }
  }

  private backoff(failures: number): number {
    const steps = this.opts.backoffMs ?? BACKOFF_MS;
    return steps[Math.min(failures - 1, steps.length - 1)] ?? 0;
  }

  private spawn(e: Entry, bin: string, env: Record<string, string | undefined>, target: ServeTarget, hash: string): void {
    const paths = servePaths(target.home, target.profile);
    const password = randomBytes(24).toString("base64url");
    let proc: ReturnType<typeof Bun.spawn>;
    let fd: number | null = null;
    e.last = { bin, env, target, hash };
    try {
      mkdirSync(serveDir(target.home), { recursive: true, mode: 0o700 });
      fd = openSync(paths.log, "w", 0o600);
      // Detached: its own session and process group, stdout on a file, so the dashboard's exit leaves it running.
      proc = Bun.spawn([bin, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
        env: { ...env, OPENCODE_SERVER_PASSWORD: password }, stdin: "ignore", stdout: fd, stderr: fd, detached: true,
      });
      proc.unref();
    } catch {
      e.failures++;
      e.retryAt = Date.now() + this.backoff(e.failures);
      return;
    } finally {
      if (fd !== null) {
        closeSync(fd);
      }
    }
    const now = new Date().toISOString();
    const rec: ServeRecord = { pid: proc.pid, url: null, password, profile: target.profile, hash, bin, started: now, last_used: now, turns: [] };
    writeRecord(paths.record, rec);
    e.proc = proc;
    e.verified = null;
    const starting = (async (): Promise<OpencodeServer | null> => {
      const end = Date.now() + (this.opts.startTimeoutMs ?? START_TIMEOUT_MS);
      while (Date.now() < end && proc.exitCode === null && proc.signalCode === null && !this.stopped) {
        let text = "";
        try {
          text = readFileSync(paths.log, "utf8").slice(0, 64 * 1024);
        } catch {
          // not there yet
        }
        const m = LISTENING.exec(text);
        if (m?.[1] !== undefined) {
          const url = m[1].replace(/\/$/, "");
          const cur = readServeRecord(paths.record);
          if (cur?.pid !== proc.pid) {
            return null;
          }
          writeRecord(paths.record, { ...cur, url });
          e.verified = { pid: proc.pid, url };
          e.failures = 0;
          return { url, password };
        }
        await Bun.sleep(POLL_MS);
      }
      // Too slow or dead: never leave a half-started server behind.
      e.failures++;
      e.retryAt = Date.now() + this.backoff(e.failures);
      const cur = readServeRecord(paths.record);
      if (cur?.pid === proc.pid) {
        await this.kill(target, cur);
      }
      return null;
    })();
    e.starting = starting;
    void starting.finally(() => {
      if (e.starting === starting) {
        e.starting = null;
      }
    });
    void proc.exited.then(() => {
      if (e.proc !== proc) {
        return;
      }
      e.proc = null;
      e.verified = null;
      const cur = readServeRecord(paths.record);
      // Stopped on purpose (record cleared) or shutting down: no restart.
      if (this.stopped || cur?.pid !== proc.pid || cur.url === null) {
        return;
      }
      // It crashed while serving: start a fresh one after a short back-off, so the next turn finds it up.
      e.failures++;
      const wait = this.backoff(e.failures);
      e.retryAt = Date.now() + wait;
      e.restartTimer = setTimeout(() => {
        e.restartTimer = null;
        const again = readServeRecord(paths.record);
        if (!this.stopped && e.starting === null && e.last !== null && (again === null || !isAlive(again.pid))) {
          this.spawn(e, e.last.bin, e.last.env, e.last.target, e.last.hash);
        }
      }, wait);
      e.restartTimer.unref?.();
    });
  }

  /** Stops the recorded server (its whole process group) and clears the record. */
  private async kill(target: Pick<ServeTarget, "home" | "profile">, rec: ServeRecord): Promise<void> {
    const path = servePaths(target.home, target.profile).record;
    const e = this.entries.get(`${target.home}\0${target.profile}`);
    if (e !== undefined && e.verified?.pid === rec.pid) {
      e.verified = null;
    }
    const cur = readServeRecord(path);
    if (cur?.pid === rec.pid) {
      writeRecord(path, { ...cur, pid: 0, url: null, turns: [] });
    }
    if (rec.pid > 0) {
      await killGroup(rec.pid);
    }
  }

  /**
   * Dashboard shutdown: stop the timers and leave every server running, so the turns attached to it finish and the
   * next dashboard adopts it.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const e of this.entries.values()) {
      if (e.restartTimer !== null) {
        clearTimeout(e.restartTimer);
        e.restartTimer = null;
      }
      e.proc = null;
    }
  }

  /** Stops every recorded server in `home` (tests, and tearing a state dir down). */
  static async stopServers(home: string): Promise<number[]> {
    const pool = new OpencodeServerPool();
    const killed: number[] = [];
    for (const rec of pool.records(home)) {
      if (rec.pid > 0) {
        killed.push(rec.pid);
        await pool.kill({ home, profile: rec.profile }, rec);
      }
    }
    return killed;
  }
}
