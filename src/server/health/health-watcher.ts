import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";

import type { HealthSummary, RunHealth, RunHealthSource } from "../../shared/types/run-health";
import { watchProcessAlive } from "../active/watch-liveness";
import { dispatchPath } from "../dispatch-path";
import { orchPaths } from "../files/paths";
import { runSignature } from "../runs/run-reconciler";
import { listRuns } from "../runs/runs-reader";
import type { OrchPaths } from "../types/orch-paths";

export const HEALTH_EVERY_SEC_DEFAULT: number = 30;
export const HEALTH_TIMEOUT_MS: number = 20_000;
export const MAX_BACKOFF_MS: number = 300_000;
/** An unchanged run is still re-checked this often: "stalled" grows with time, not with file writes. */
export const RECHECK_UNCHANGED_MS: number = 300_000;
const MIN_EVERY_SEC: number = 5;
const KILLED_CODE: number = 137;
const TAIL_BYTES: number = 256 * 1024;
const MONITOR_PREFIX: string = "health:";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HealthSpawner = (args: readonly string[], timeoutMs: number) => Promise<SpawnResult>;

/** The run's `health:<run-id>` monitor: whether it is alive, and the text of its newest event. */
export interface MonitorOutput {
  alive: boolean;
  text: string | null;
}

export interface HealthDeps {
  runningRunIds: () => string[];
  /** state.json + events.jsonl mtimes; null when the run cannot be read. */
  signature: (runId: string) => string | null;
  monitor: (runId: string) => MonitorOutput;
  spawn: HealthSpawner;
  now?: () => number;
  log?: (line: string) => void;
}

export interface HealthEntry {
  health: RunHealth;
  source: Exclude<RunHealthSource, "none">;
  signature: string | null;
  at: number;
}

interface RunSlot {
  inFlight: Promise<HealthEntry | null> | null;
  again: boolean;
  intervalMs: number;
  nextAt: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `run health --json` output; null unless it has the contract's shape. */
export function parseHealth(text: string | null): RunHealth | null {
  if (text === null || text.trim() === "") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value) || typeof value["run"] !== "string" || !Array.isArray(value["nodes"])) {
      return null;
    }
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      run: value["run"],
      at: typeof value["at"] === "string" ? value["at"] : "",
      max_parallel: num(value["max_parallel"]),
      running: num(value["running"]),
      slots: num(value["slots"]),
      nodes: (value["nodes"] as unknown[]).filter(isObject).map((n) => ({
        id: String(n["id"] ?? ""),
        status: String(n["status"] ?? ""),
        health: (["ok", "stalled", "unowned", "dead", "no-report", "needs-user"].includes(String(n["health"])) ? n["health"] : "ok") as RunHealth["nodes"][number]["health"],
        owner_id: typeof n["owner_id"] === "string" ? n["owner_id"] : null,
        last_activity: typeof n["last_activity"] === "string" ? n["last_activity"] : null,
        idle_min: typeof n["idle_min"] === "number" ? n["idle_min"] : null,
        note: typeof n["note"] === "string" ? n["note"] : null,
      })),
      ready: Array.isArray(value["ready"]) ? value["ready"].filter((r): r is string => typeof r === "string") : [],
      changes: Array.isArray(value["changes"]) ? value["changes"] : [],
    };
  } catch {
    return null;
  }
}

/**
 * Keeps the latest `run health` result per run in memory. A pass for one run never overlaps
 * itself (a second caller shares the in-flight promise), a failed or timed-out pass doubles the
 * wait up to MAX_BACKOFF_MS, and an unchanged run is skipped until RECHECK_UNCHANGED_MS. When the
 * run's `health:<id>` monitor is alive, the watcher only reads that monitor's newest output.
 */
export class HealthWatcher {
  private readonly latestByRun = new Map<string, HealthEntry>();
  private readonly slots = new Map<string, RunSlot>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: HealthDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => process.stderr.write(line));
  }

  latest(runId: string): HealthEntry | null {
    return this.latestByRun.get(runId) ?? null;
  }

  private slot(runId: string): RunSlot {
    let s = this.slots.get(runId);
    if (s === undefined) {
      s = { inFlight: null, again: false, intervalMs: 0, nextAt: 0 };
      this.slots.set(runId, s);
    }
    return s;
  }

  /** Whether a pass would do anything now: not in backoff, and changed or due for a recheck. */
  private due(runId: string, force: boolean): boolean {
    const s = this.slot(runId);
    if (this.now() < s.nextAt) {
      return false;
    }
    if (force) {
      return true;
    }
    const prev = this.latestByRun.get(runId);
    if (prev === undefined) {
      return true;
    }
    const sig = this.deps.signature(runId);
    return sig === null || sig !== prev.signature || this.now() - prev.at >= RECHECK_UNCHANGED_MS;
  }

  /**
   * One check of one run. `force` ignores the unchanged-skip (an events.jsonl change, or a read
   * with nothing cached) but never the backoff. Resolves to the latest entry, fresh or not.
   */
  check(runId: string, force = false): Promise<HealthEntry | null> {
    const s = this.slot(runId);
    if (s.inFlight !== null) {
      if (force) {
        s.again = true;
      }
      return s.inFlight;
    }
    if (!this.due(runId, force)) {
      return Promise.resolve(this.latest(runId));
    }
    const pass = this.pass(runId).finally(() => {
      s.inFlight = null;
      if (s.again) {
        s.again = false;
        void this.check(runId, true);
      }
    });
    s.inFlight = pass;
    return pass;
  }

  private async pass(runId: string): Promise<HealthEntry | null> {
    const s = this.slot(runId);
    const signature = this.deps.signature(runId);
    const monitor = this.deps.monitor(runId);
    if (monitor.alive) {
      const fromMonitor = parseHealth(monitor.text);
      if (fromMonitor !== null) {
        return this.keep(runId, { health: fromMonitor, source: "monitor", signature, at: this.now() });
      }
    }
    try {
      const r = await this.deps.spawn(["run", "health", runId, "--json"], HEALTH_TIMEOUT_MS);
      const health = r.code === 0 ? parseHealth(r.stdout) : null;
      if (health === null) {
        s.intervalMs = Math.min(Math.max(s.intervalMs * 2, HEALTH_EVERY_SEC_DEFAULT * 1000), MAX_BACKOFF_MS);
        s.nextAt = this.now() + s.intervalMs;
        const why = r.code === KILLED_CODE ? "timed out" : r.code === 0 ? "unreadable output" : `failed (${r.code}): ${r.stderr.trim().slice(0, 200)}`;
        this.log(`${new Date(this.now()).toISOString()} run health ${runId} ${why}; next try in ${Math.round(s.intervalMs / 1000)}s\n`);
        return this.latest(runId);
      }
      s.intervalMs = 0;
      s.nextAt = 0;
      // Taken after the pass: a nudge's own writes must not count as a change next time.
      return this.keep(runId, { health, source: "watcher", signature: this.deps.signature(runId), at: this.now() });
    } catch (err) {
      this.log(`run health ${runId} error: ${err instanceof Error ? err.message : String(err)}\n`);
      return this.latest(runId);
    }
  }

  private keep(runId: string, entry: HealthEntry): HealthEntry {
    this.latestByRun.set(runId, entry);
    return entry;
  }

  /** One sweep over the running runs, one at a time. */
  async tick(): Promise<number> {
    let n = 0;
    for (const id of this.deps.runningRunIds()) {
      if (this.due(id, false) || this.slot(id).inFlight !== null) {
        n += 1;
      }
      await this.check(id);
    }
    return n;
  }

  /** Counts over the running runs' cached results. Never spawns: a run with nothing cached counts as 0. */
  summary(): HealthSummary {
    const out: HealthSummary = { generated_at: new Date(this.now()).toISOString(), running_runs: 0, stalled: 0, dead: 0, unowned: 0, no_report: 0, needs_user: 0, ready: 0, flagged_runs: [] };
    for (const id of this.deps.runningRunIds()) {
      out.running_runs += 1;
      const health = this.latestByRun.get(id)?.health;
      if (health === undefined) {
        continue;
      }
      let flagged = false;
      for (const node of health.nodes) {
        if (node.health === "ok") {
          continue;
        }
        if (node.health === "needs-user") {
          out.needs_user += 1;
          continue;
        }
        flagged = true;
        if (node.health === "no-report") {
          out.no_report += 1;
        } else {
          out[node.health] += 1;
        }
      }
      if (health.slots > 0) {
        out.ready += health.ready.length;
      }
      if (flagged) {
        out.flagged_runs.push(id);
      }
    }
    return out;
  }

  /** Read for the API: the cached result, or one pass when nothing is cached yet. */
  async read(runId: string): Promise<HealthEntry | null> {
    return this.latest(runId) ?? (await this.check(runId, true));
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function lastLine(path: string): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
    return lines.at(-1) ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/**
 * The run's `health:<run-id>` monitor, found the way the loops/monitors strip finds monitors:
 * `<home>/watches/<id>/{spec,state}.json`, alive when recorded running and its pid answers as this
 * watch (watchProcessAlive: a missing or reused pid is not alive).
 * Its newest output is the `text` of the last line of events.jsonl.
 */
export function findHealthMonitor(home: string, runId: string): MonitorOutput {
  const dir = join(home, "watches");
  let ids: string[];
  try {
    ids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { alive: false, text: null };
  }
  for (const id of ids) {
    const spec = readJson(join(dir, id, "spec.json"));
    if (spec === null || spec["name"] !== `${MONITOR_PREFIX}${runId}`) {
      continue;
    }
    const state = readJson(join(dir, id, "state.json"));
    if (state === null || state["status"] !== "running" || !watchProcessAlive(state["pid"], id)) {
      continue;
    }
    const line = lastLine(join(dir, id, "events.jsonl"));
    let text: string | null = null;
    if (line !== null) {
      const event = (() => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })();
      text = isObject(event) && typeof event["text"] === "string" ? event["text"] : null;
    }
    return { alive: true, text };
  }
  return { alive: false, text: null };
}

/** ORCH_HEALTH_EVERY_SEC, then settings.health_every_sec, then 30; never under 5. */
export function healthEverySec(paths: OrchPaths, env: Record<string, string | undefined> = process.env): number {
  const fromEnv = Number(env["ORCH_HEALTH_EVERY_SEC"]);
  if (env["ORCH_HEALTH_EVERY_SEC"] !== undefined && Number.isInteger(fromEnv) && fromEnv > 0) {
    return Math.max(MIN_EVERY_SEC, fromEnv);
  }
  const settings = readJson(paths.profiles)?.["settings"];
  const fromSettings = isObject(settings) ? settings["health_every_sec"] : undefined;
  return typeof fromSettings === "number" && Number.isInteger(fromSettings) && fromSettings > 0
    ? Math.max(MIN_EVERY_SEC, fromSettings)
    : HEALTH_EVERY_SEC_DEFAULT;
}

export function homeHealthSpawner(home: string): HealthSpawner {
  return async (args, timeoutMs) => {
    const proc = Bun.spawn(["bash", dispatchPath(), ...args], {
      env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "health", ORCH_NO_ANNOUNCE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code: proc.signalCode === "SIGKILL" ? KILLED_CODE : code, stdout, stderr };
  };
}

function depsFor(paths: OrchPaths): HealthDeps {
  return {
    runningRunIds: () => listRuns(paths).filter((r) => r.status === "running").map((r) => r.run_id),
    signature: (id) => runSignature(paths.runs, id),
    monitor: (id) => findHealthMonitor(paths.home, id),
    spawn: homeHealthSpawner(paths.home),
  };
}

const watchers = new Map<string, HealthWatcher>();

/** The one watcher per state directory; the API reads through it whether or not it was started. */
export function healthWatcherFor(paths: OrchPaths): HealthWatcher {
  let w = watchers.get(paths.home);
  if (w === undefined) {
    w = new HealthWatcher(depsFor(paths));
    watchers.set(paths.home, w);
  }
  return w;
}

export interface RunningHealthWatcher {
  watcher: HealthWatcher;
  stop(): void;
}

/** Runs `run health --ensure-monitors` once; a dispatch without the subcommand is only logged. */
export async function ensureMonitors(spawn: HealthSpawner, log: (line: string) => void = (l) => process.stderr.write(l)): Promise<boolean> {
  try {
    const r = await spawn(["run", "health", "--ensure-monitors"], HEALTH_TIMEOUT_MS);
    if (r.code !== 0) {
      log(`run health --ensure-monitors unavailable (${r.code}): ${r.stderr.trim().slice(0, 200)}\n`);
    }
    return r.code === 0;
  } catch (err) {
    log(`run health --ensure-monitors error: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

/**
 * Server startup: ensure the per-run monitors once, sweep the running runs every
 * healthEverySec(), and check a run right away when its events.jsonl changes.
 */
export function startHealthWatcher(home: string): RunningHealthWatcher {
  const paths = orchPaths(home);
  const watcher = healthWatcherFor(paths);
  void ensureMonitors(homeHealthSpawner(home));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let busy = false;
  const loop = (): void => {
    timer = setTimeout(() => {
      if (!busy) {
        busy = true;
        void watcher.tick().finally(() => {
          busy = false;
        });
      }
      loop();
    }, healthEverySec(paths) * 1000);
  };
  loop();
  let fsWatcher: FSWatcher | null = null;
  try {
    fsWatcher = watch(paths.runs, { recursive: true }, (_event, filename) => {
      const name = typeof filename === "string" ? filename : null;
      const m = name === null ? null : /^([^/\\]+)[/\\]events\.jsonl$/.exec(name);
      if (m?.[1] !== undefined) {
        void watcher.check(m[1], true);
      }
    });
  } catch {
    // No recursive watch on this platform: the periodic sweep still covers every run.
  }
  return {
    watcher,
    stop: (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      fsWatcher?.close();
    },
  };
}
