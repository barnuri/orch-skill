import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RunHealth } from "../../shared/types/run-health";
import type { WatchdogAction, WatchdogCounters, WatchdogFlag, WatchdogRule, WatchdogStatus } from "../../shared/types/watchdog";
import { isEngineNode, loopOfRun } from "../../shared/engine-node";
import { dispatchPath } from "../dispatch-path";
import { orchPaths } from "../files/paths";
import { healthWatcherFor } from "../health/health-watcher";
import { countPendingAsks } from "../runs/coordinator-state";
import { RunEngine, type Starter } from "../runs/auto-dispatch";

/**
 * The one watchdog: every deterministic babysitting step for orch runs, in one place. It owns the
 * auto-dispatch RunEngine (event-driven: fs.watch on each running run's state.json, plus the
 * engine's 30 s sweep) and inspects every state the engine reads. Rules, all skipped for a paused
 * or stopped run:
 *  - lost: a running node whose job process (or session, by the health verdict) has been dead for
 *    2 minutes gets `node update ... error --error "process died"` and one `node retry`, then a flag.
 *  - stalled: a running node the health watcher calls stalled (or, without a verdict, idle past
 *    stall_minutes) is flagged amber and reported once per episode.
 *  - A node whose job pid answers, or whose job log grew since the last look or within the window,
 *    is never lost or stalled: the job folder wins over owner events and health verdicts.
 *  - unverified: a node seen turning done without a non-empty handoff.md (the agent ended its turn early)
 *    gets `node retry --early-end`: the same session is resumed with a "continue and write handoff.md" message
 *    (an adapter without resume restarts with the original prompt). At most 2 resumes per node (`node.resumes`);
 *    after that the node is marked error "ended early without handoff" and flagged.
 *  - Loop and watch ticks (nodes the loop engine made, any node of a `loop-` run, any node whose loop is stopped)
 *    are exempt from every rule above that retries or verifies: the loop decides whether another tick runs.
 *  - infra-retry: a node seen turning error with an infrastructure error (dispatch exit, model
 *    unavailable, process died, job vanished) gets one `node retry`. Test failures are never retried.
 *  - starting: a node dispatched (running, segment open) with no started_at for STARTING_AFTER_MS
 *    is marked error "stuck starting" (an infrastructure failure) and gets one `node retry`.
 *  - finish: an auto_dispatch run whose nodes are all done gets `run finish`.
 *  - owners: `node bind-owners --run <run>` at most once per sweep interval while a node runs or
 *    finished within the last 10 minutes, and once per run as a backfill (claim `owners-backfill`).
 *    It links each dispatched job to its opencode session and fills model, tier, usage and cost.
 * Every action appends one JSON line to `<home>/watchdog/actions.log`. Once-only markers are
 * exclusive-create claim files under `<home>/watchdog/<run>/claims/`, so a restart or a second
 * server never repeats an action. Run state changes only through `dispatch.ts`.
 */

export const LOST_AFTER_MS: number = 120_000;
export const STALL_MIN_DEFAULT: number = 15;
/** The coordinator sweep runs at most this often per run. */
const COORD_EVERY_MS = 20_000;

/** A node still `starting` (dispatched, no real activity) after this long is retried once. */
export const STARTING_AFTER_MS: number = 180_000;
export const OWNERS_EVERY_MS: number = 30_000;
/** Resumes of a node that ended early (done, no handoff.md) before the watchdog gives up. */
export const MAX_EARLY_END_RESUMES: number = 2;
export const EARLY_END_MESSAGE: string = "You ended early. Read your task and handoff notes, continue, and write handoff.md in $ORCH_NODE_OUT before you finish";
const OWNERS_RECENT_MS: number = 600_000;
const LAST_ACTIONS: number = 50;
const LOG_TAIL_BYTES: number = 512 * 1024;

const INFRA_ERROR: RegExp = /stuck starting|dispatch exit|exit=unknown|model (is )?(unavailable|not available)|process died|job vanished|job (is )?gone/i;
const TEST_FAILURE: RegExp = /tests? fail|failing tests?|test(s)? did not pass|assertion/i;

interface WatchNode {
  id: string;
  status?: string;
  job_id?: string | null;
  owner_kind?: string | null;
  owner_id?: string | null;
  /** "job": the session was linked from the node's own job; liveness stays with the job. */
  owner_bind?: string | null;
  /** Timing (core/state/timing.ts): set at dispatch, at the first real activity, and an open segment. */
  dispatched_at?: string | null;
  started_at?: string | null;
  seg_open?: boolean | null;
  error?: string | null;
  out_dir?: string | null;
  updated?: string | null;
  attempts?: unknown[] | null;
  /** Set when the loop or watch engine made the node (`node add --origin`), or the loop that owns it. */
  origin?: string | null;
  loop_id?: string | null;
  /** Early-end resumes done so far (`node retry --early-end` counts them). */
  resumes?: number | null;
}

interface JobEvidence {
  job: string | null;
  exists: boolean;
  ended: boolean;
  pid: number | null;
  /** null: no pid file. */
  pidAlive: boolean | null;
  logMs: number | null;
  logGrew: boolean;
}

interface WatchRun {
  status?: string;
  paused?: boolean;
  stopped?: boolean;
  auto_dispatch?: boolean;
  nodes?: WatchNode[];
  coordinator?: { unreachable?: unknown } | null;
}

export interface WatchdogOptions {
  /** Spawns `dispatch.ts <args>` for the watchdog's own actions; exit code back. */
  run?: Starter;
  /** Passed to the RunEngine as its starter (tests). */
  engineStart?: Starter;
  now?: () => Date;
  log?: (line: string) => void;
  /** The latest health verdicts of a run; default: the server's health watcher cache. */
  health?: (runId: string) => RunHealth | null;
  /** Whether a pid answers; default: kill(pid, 0). */
  pidAlive?: (pid: number) => boolean;
  lostAfterMs?: number;
  /** Time a node may stay `starting` before the watchdog retries it; default STARTING_AFTER_MS. */
  startingAfterMs?: number;
  /** Least time between two `node bind-owners` calls for one run; default OWNERS_EVERY_MS. */
  ownersEveryMs?: number;
}

/** Infra error, never a test failure: the only errors the watchdog retries by itself. */
export function isInfraError(error: string | null | undefined): boolean {
  if (typeof error !== "string" || error === "") {
    return false;
  }
  return INFRA_ERROR.test(error) && !TEST_FAILURE.test(error);
}

export const spawnWatchdogDispatch: Starter = async (args, home) => {
  const proc = Bun.spawn([process.execPath, dispatchPath(), ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "watchdog", ORCH_NO_ANNOUNCE: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
};

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** The node's output folder: its `out_dir`, or `<home>/runs/<run>/out/<node>`. */
function nodeOutDir(home: string, runId: string, node: WatchNode): string {
  return typeof node.out_dir === "string" && node.out_dir !== "" ? node.out_dir : join(home, "runs", runId, "out", node.id);
}

/** True when the node's `handoff.md` exists and is not empty. */
function handoffPresent(home: string, runId: string, node: WatchNode): boolean {
  try {
    return statSync(join(nodeOutDir(home, runId, node), "handoff.md")).size > 0;
  } catch {
    return false;
  }
}

function emptyCounters(): WatchdogCounters {
  return { lost: 0, stalled: 0, unverified: 0, retried: 0, flagged: 0, finished: 0 };
}

export function watchdogDir(home: string): string {
  return join(home, "watchdog");
}

export function actionsLog(home: string): string {
  return join(watchdogDir(home), "actions.log");
}

/** settings.stall_minutes from profiles.json, ORCH_STALL_MIN first; 15 by default. */
export function stallMinutes(home: string, env: Record<string, string | undefined> = process.env): number {
  const fromEnv = Number(env["ORCH_STALL_MIN"]);
  if (env["ORCH_STALL_MIN"] !== undefined && Number.isInteger(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  try {
    const settings = (JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")) as { settings?: Record<string, unknown> }).settings;
    const v = settings?.["stall_minutes"];
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : STALL_MIN_DEFAULT;
  } catch {
    return STALL_MIN_DEFAULT;
  }
}

function tailLines(path: string): string[] {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
    return start > 0 ? lines.slice(1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function counterFor(rule: WatchdogRule, action: string): keyof WatchdogCounters | null {
  if (action === "flag") {
    return rule === "stalled" ? "stalled" : "flagged";
  }
  if (action.startsWith("node retry")) {
    return "retried";
  }
  if (rule === "finish") {
    return "finished";
  }
  if (rule === "lost") {
    return "lost";
  }
  if (rule === "unverified") {
    return "unverified";
  }
  return null;
}

export class WatchdogService {
  readonly engine: RunEngine;
  /** Pending actions, so tests can await them. */
  readonly inflight = new Set<Promise<void>>();
  private readonly runDispatch: Starter;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly health: (runId: string) => RunHealth | null;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly lostAfterMs: number;
  private readonly startingAfterMs: number;
  private readonly ownersEveryMs: number;
  private readonly coordAt = new Map<string, number>();
  private readonly coordBusy = new Set<string>();
  /** Last `node bind-owners` start per run, and the runs with one in flight. */
  private readonly ownersAt = new Map<string, number>();
  private readonly ownersBusy = new Set<string>();
  private readonly deadSince = new Map<string, number>();
  /** Last seen job log size per `<run>/<node>/<job>`, to tell a growing log from a quiet one. */
  private readonly logSize = new Map<string, number>();
  private readonly lastStatus = new Map<string, Map<string, string>>();
  private readonly busy = new Set<string>();
  private readonly flags = new Map<string, WatchdogFlag & { status: string }>();
  private readonly actions: WatchdogAction[] = [];
  private readonly counters = new Map<string, WatchdogCounters>();
  private startedAt: string | null = null;

  constructor(readonly home: string, opts: WatchdogOptions = {}) {
    this.runDispatch = opts.run ?? spawnWatchdogDispatch;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.log ?? ((line) => void process.stderr.write(`watchdog: ${line}\n`));
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.lostAfterMs = opts.lostAfterMs ?? LOST_AFTER_MS;
    this.startingAfterMs = opts.startingAfterMs ?? STARTING_AFTER_MS;
    this.ownersEveryMs = opts.ownersEveryMs ?? OWNERS_EVERY_MS;
    const paths = orchPaths(home);
    this.health = opts.health ?? ((runId): RunHealth | null => healthWatcherFor(paths).latest(runId)?.health ?? null);
    this.engine = new RunEngine(home, {
      ...(opts.engineStart === undefined ? {} : { start: opts.engineStart }),
      now: this.now,
      onState: (runId, state) => this.inspect(runId, state as WatchRun),
    });
    this.loadLog();
  }

  begin(): void {
    this.startedAt = this.now().toISOString();
    this.engine.begin();
  }

  stop(): void {
    this.engine.stop();
  }

  /** Runs every rule over one run's state. Called by the engine on each state.json change and sweep. */
  inspect(runId: string, state: WatchRun): void {
    const nodes = state.nodes ?? [];
    const prev = this.lastStatus.get(runId);
    this.lastStatus.set(runId, new Map(nodes.map((n) => [n.id, n.status ?? ""])));
    if (state.status !== "running" || state.paused === true || state.stopped === true) {
      this.forgetDead(runId);
      return;
    }
    this.dropStaleFlags(runId, nodes);
    const healthById = new Map((this.health(runId)?.nodes ?? []).map((n) => [n.id, n]));
    for (const node of nodes) {
      if (this.busy.has(`${runId}/${node.id}`)) {
        continue;
      }
      if (this.engineOwned(runId, node)) {
        this.deadSince.delete(`${runId}/${node.id}`);
        continue;
      }
      const from = prev?.get(node.id);
      const turned = (to: string): boolean => node.status === to && from !== undefined && from !== to;
      const verdict = healthById.get(node.id)?.health ?? null;
      if (node.status === "running") {
        if (this.checkStarting(runId, node)) {
          continue;
        }
        const ev = this.jobEvidence(runId, node);
        this.checkLiveness(runId, node, verdict, ev);
        this.checkStall(runId, node, verdict, healthById.get(node.id)?.idle_min ?? null, ev);
        continue;
      }
      this.deadSince.delete(`${runId}/${node.id}`);
      if (turned("done")) {
        this.checkHandoff(runId, node);
      } else if (turned("error")) {
        this.checkInfraError(runId, node);
      }
    }
    this.checkFinish(runId, state, nodes);
    this.syncOwners(runId, nodes);
    this.syncCoordinator(runId, state);
  }

  /** A node the loop engine made, or one whose loop is stopped: never verified, never retried. */
  private engineOwned(runId: string, node: WatchNode): boolean {
    if (isEngineNode(runId, node)) {
      return true;
    }
    const loop = loopOfRun(runId);
    return loop !== null && this.loopStopped(loop);
  }

  private loopStopped(loopId: string): boolean {
    const st = readText(join(this.home, "loops", loopId, "state.json"));
    if (st === null) {
      return false;
    }
    try {
      const status = (JSON.parse(st) as { status?: string }).status;
      return status === "stopped" || status === "done" || status === "failed";
    } catch {
      return false;
    }
  }

  /**
   * Coordinator failover: when a run has a coordinator, `run messages <run> retry` runs the sweep, which refreshes
   * the heartbeat, repoints an unreachable coordinator and redelivers the pending asks. Throttled per run, and
   * only while the coordinator is unreachable or asks are pending.
   */
  private syncCoordinator(runId: string, state: WatchRun): void {
    const coord = state.coordinator;
    if (coord === undefined || coord === null) {
      return;
    }
    const nowMs = this.now().getTime();
    const last = this.coordAt.get(runId);
    const pending = countPendingAsks(orchPaths(this.home).runs, runId) > 0;
    if (this.coordBusy.has(runId) || (last !== undefined && nowMs - last < COORD_EVERY_MS)) {
      return;
    }
    if ((coord.unreachable ?? null) === null && !pending) {
      return;
    }
    this.coordAt.set(runId, nowMs);
    this.coordBusy.add(runId);
    const p = this.runDispatch(["run", "messages", runId, "retry"], this.home)
      .then((rc) => this.record({ at: this.now().toISOString(), run: runId, node: null, rule: "coordinator", action: "run messages", detail: "coordinator sweep", rc }))
      .catch((err: unknown) => this.log(`coordinator sweep ${runId} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.coordBusy.delete(runId);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  /**
   * Binds jobs to their sessions and fills node figures: `node bind-owners`, throttled per run. That
   * also runs `node selections` (effort, actual model, role, tier from the hub) for running nodes,
   * and once for finished ones.
   */
  private syncOwners(runId: string, nodes: WatchNode[]): void {
    const nowMs = this.now().getTime();
    const last = this.ownersAt.get(runId);
    if (this.ownersBusy.has(runId) || (last !== undefined && nowMs - last < this.ownersEveryMs)) {
      return;
    }
    const recent = nodes.some((n) => n.status === "running"
      || ((n.status === "done" || n.status === "error") && nowMs - (Date.parse(n.updated ?? "") || 0) < OWNERS_RECENT_MS));
    if (!recent && !this.claim(runId, "owners-backfill")) {
      return;
    }
    this.ownersAt.set(runId, nowMs);
    this.ownersBusy.add(runId);
    const p = this.runDispatch(["node", "bind-owners", "--run", runId], this.home)
      .then((rc) => {
        if (rc !== 0) {
          this.log(`node bind-owners --run ${runId} rc=${rc}`);
        }
      })
      .catch((err: unknown) => this.log(`node bind-owners --run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.ownersBusy.delete(runId);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  /** True when the node is still starting (so the liveness and stall rules do not apply yet). */
  private checkStarting(runId: string, node: WatchNode): boolean {
    if (node.seg_open !== true || (node.started_at ?? null) !== null || typeof node.dispatched_at !== "string") {
      return false;
    }
    const waited = this.now().getTime() - (Date.parse(node.dispatched_at) || 0);
    if (waited < this.startingAfterMs) {
      return true;
    }
    // The job folder wins: a live pid or a log written in the last 2 minutes means the agent works, so the
    // node is running, not stuck. Stamp started_at through `node started` instead of calling it an error.
    const ev = this.jobEvidence(runId, node);
    if (ev.pidAlive === true || this.logActive(ev, 120_000)) {
      const stamp = this.claim(runId, `started-${node.id}@${(node.attempts ?? []).length}`);
      if (stamp) {
        this.chain(runId, node.id, async () => {
          await this.act(runId, node.id, "starting", ["node", "started", runId, node.id], "job alive, stamped started_at");
        });
      }
      return false;
    }
    const attempt = (node.attempts ?? []).length;
    if (!this.claim(runId, `starting-${node.id}@${attempt}`)) {
      return true;
    }
    const detail = `starting for ${Math.round(waited / 1000)}s with no activity`;
    const retry = this.claim(runId, `retry-${node.id}`);
    this.chain(runId, node.id, async () => {
      await this.act(runId, node.id, "starting", ["node", "update", runId, node.id, "error", "--error", "stuck starting"], detail);
      if (retry) {
        await this.act(runId, node.id, "starting", ["node", "retry", runId, node.id], "one automatic retry");
      } else {
        this.flag(runId, node.id, "starting", `${detail}; retry already used`, "error");
      }
    });
    return true;
  }

  private checkLiveness(runId: string, node: WatchNode, verdict: string | null, ev: JobEvidence): void {
    const key = `${runId}/${node.id}`;
    const why = this.deadReason(node, verdict, ev);
    if (why === null) {
      this.deadSince.delete(key);
      return;
    }
    const nowMs = this.now().getTime();
    const since = this.deadSince.get(key);
    if (since === undefined) {
      this.deadSince.set(key, nowMs);
      return;
    }
    if (nowMs - since < this.lostAfterMs) {
      return;
    }
    this.deadSince.delete(key);
    const attempt = (node.attempts ?? []).length;
    if (!this.claim(runId, `lost-${node.id}@${attempt}`)) {
      return;
    }
    const detail = `${why}, dead for ${Math.round((nowMs - since) / 1000)}s`;
    const retry = this.claim(runId, `retry-${node.id}`);
    this.chain(runId, node.id, async () => {
      await this.act(runId, node.id, "lost", ["node", "update", runId, node.id, "error", "--error", "process died"], detail);
      if (retry) {
        await this.act(runId, node.id, "lost", ["node", "retry", runId, node.id], "one automatic retry");
      } else {
        this.flag(runId, node.id, "lost", `${detail}; retry already used`, "error");
      }
    });
  }

  /**
   * What the node's job folder says, read fresh on every inspection. A job's own pid and log are
   * the ground truth for a pid-owned node: owner events can be silent while the job works.
   */
  private jobEvidence(runId: string, node: WatchNode): JobEvidence {
    const job = typeof node.job_id === "string" && node.job_id !== "" ? node.job_id : null;
    if (job === null) {
      return { job: null, exists: false, ended: false, pid: null, pidAlive: null, logMs: null, logGrew: false };
    }
    const dir = join(this.home, "jobs", job);
    const exists = mtimeMs(dir) !== null;
    const pid = Number(readText(join(dir, "pid")));
    const hasPid = Number.isInteger(pid) && pid > 0;
    let logMs: number | null = null;
    let size: number | null = null;
    try {
      const st = statSync(existsSync(join(dir, "log.plain")) ? join(dir, "log.plain") : join(dir, "log"));
      logMs = st.mtimeMs;
      size = st.size;
    } catch {
      // no log yet
    }
    const key = `${runId}/${node.id}/${job}`;
    const before = this.logSize.get(key);
    if (size === null) {
      this.logSize.delete(key);
    } else {
      this.logSize.set(key, size);
    }
    return {
      job,
      exists,
      ended: exists && readText(join(dir, "exit_code")) !== null,
      pid: hasPid ? pid : null,
      pidAlive: hasPid ? this.pidAlive(pid) : null,
      logMs,
      logGrew: size !== null && before !== undefined && size !== before,
    };
  }

  /** The job log grew since the last inspection, or was written within `windowMs`. */
  private logActive(ev: JobEvidence, windowMs: number): boolean {
    return ev.logGrew || (ev.logMs !== null && this.now().getTime() - ev.logMs < windowMs);
  }

  /** Why a running node's owner is gone, or null while it lives (or nothing says otherwise). */
  private deadReason(node: WatchNode, verdict: string | null, ev: JobEvidence): string | null {
    // A live job pid or a growing job log always wins over owner events and health verdicts.
    if (ev.pidAlive === true || this.logActive(ev, this.lostAfterMs)) {
      return null;
    }
    if (ev.job !== null && ((node.owner_kind ?? "job") === "job" || node.owner_bind === "job")) {
      if (!ev.exists) {
        return `job ${ev.job} vanished`;
      }
      if (ev.ended) {
        return null; // ended: `run sync` (the reconciler) records the result
      }
      if (ev.pidAlive === false) {
        return `job ${ev.job} process ${ev.pid ?? "?"} died`;
      }
    }
    return verdict === "dead" ? `owner ${node.owner_id ?? node.job_id ?? "?"} is gone` : null;
  }

  private checkStall(runId: string, node: WatchNode, verdict: string | null, idleMin: number | null, ev: JobEvidence): void {
    const stallMs = stallMinutes(this.home) * 60_000;
    // A job whose pid answers or whose log is still growing is working, whatever the owner events say.
    const working = ev.pidAlive === true || this.logActive(ev, stallMs);
    let stalled = !working && verdict === "stalled";
    let idle = idleMin;
    if (!working && verdict === null) {
      const last = Math.max(ev.logMs ?? 0, Date.parse(node.updated ?? "") || 0);
      if (last > 0) {
        idle = Math.floor((this.now().getTime() - last) / 60_000);
        stalled = this.now().getTime() - last >= stallMs;
      }
    }
    const key = `${runId}/${node.id}/stalled`;
    if (!stalled) {
      this.flags.delete(key);
      return;
    }
    if (this.flags.has(key)) {
      return;
    }
    this.flag(runId, node.id, "stalled", `idle ${idle ?? "?"} min`, "running");
  }

  private checkHandoff(runId: string, node: WatchNode): void {
    if (handoffPresent(this.home, runId, node)) {
      return;
    }
    const dir = nodeOutDir(this.home, runId, node);
    const attempt = (node.attempts ?? []).length;
    if (!this.claim(runId, `unverified-${node.id}@${attempt}`)) {
      return;
    }
    const resumes = typeof node.resumes === "number" ? node.resumes : 0;
    if (resumes >= MAX_EARLY_END_RESUMES) {
      this.chain(runId, node.id, async () => {
        await this.act(runId, node.id, "unverified", ["node", "update", runId, node.id, "error", "--force", "--error", "ended early without handoff"], `${dir}/handoff.md missing or empty after ${resumes} resumes`);
        this.flag(runId, node.id, "unverified", `ended early without handoff.md after ${resumes} resumes`, "error");
      });
      return;
    }
    this.chain(runId, node.id, async () => {
      await this.act(
        runId,
        node.id,
        "unverified",
        ["node", "retry", runId, node.id, "--early-end", EARLY_END_MESSAGE],
        `${dir}/handoff.md missing or empty: resume ${resumes + 1} of ${MAX_EARLY_END_RESUMES} (same session)`,
      );
    });
  }

  private checkInfraError(runId: string, node: WatchNode): void {
    if (!isInfraError(node.error)) {
      return;
    }
    const attempt = (node.attempts ?? []).length;
    if (!this.claim(runId, `infra-${node.id}@${attempt}`)) {
      return;
    }
    if (!this.claim(runId, `retry-${node.id}`)) {
      this.flag(runId, node.id, "infra-retry", `${node.error ?? ""}; retry already used`, "error");
      return;
    }
    this.chain(runId, node.id, async () => {
      await this.act(runId, node.id, "infra-retry", ["node", "retry", runId, node.id], node.error ?? "");
    });
  }

  private checkFinish(runId: string, state: WatchRun, nodes: WatchNode[]): void {
    if (state.auto_dispatch !== true || nodes.length === 0 || !nodes.every((n) => n.status === "done")) {
      return;
    }
    if ([...this.busy].some((k) => k.startsWith(`${runId}/`)) || !this.claim(runId, "finish")) {
      return;
    }
    this.chain(runId, "", async () => {
      await this.act(runId, null, "finish", ["run", "finish", runId], `all ${nodes.length} nodes done`);
    });
  }

  private claim(runId: string, name: string): boolean {
    const dir = join(watchdogDir(this.home), runId, "claims");
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), this.now().toISOString(), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  /** Runs one node's actions in order; the node is skipped by inspect until they finish. */
  private chain(runId: string, nodeId: string, body: () => Promise<void>): void {
    const key = `${runId}/${nodeId}`;
    this.busy.add(key);
    const p = body()
      .catch((err: unknown) => this.log(`${key} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.busy.delete(key);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  private async act(runId: string, nodeId: string | null, rule: WatchdogRule, args: string[], detail: string): Promise<number> {
    let rc: number;
    try {
      rc = await this.runDispatch(args, this.home);
    } catch (err) {
      this.log(`${args.join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
      rc = -1;
    }
    this.record({ at: this.now().toISOString(), run: runId, node: nodeId, rule, action: args.slice(0, 2).join(" ") + (args[4] !== undefined && args[1] === "update" ? ` ${args[4]}` : ""), detail, rc });
    return rc;
  }

  private flag(runId: string, nodeId: string, rule: WatchdogRule, detail: string, status: string): void {
    const at = this.now().toISOString();
    this.flags.set(`${runId}/${nodeId}/${rule}`, { run: runId, node: nodeId, rule, detail, at, status });
    this.record({ at, run: runId, node: nodeId, rule, action: "flag", detail, rc: null });
  }

  /**
   * Drops a run's flags whose cause is gone: the node left the status the flag was raised in (retried,
   * finished, removed), or an `unverified` node now has its handoff.md.
   */
  private dropStaleFlags(runId: string, nodes: WatchNode[]): void {
    for (const [key, f] of this.flags) {
      if (f.run !== runId) {
        continue;
      }
      const node = nodes.find((n) => n.id === f.node);
      const cleared = node === undefined || (node.status ?? "") !== f.status
        || (f.rule === "unverified" && handoffPresent(this.home, runId, node));
      if (cleared) {
        this.flags.delete(key);
      }
    }
  }

  private forgetDead(runId: string): void {
    for (const key of this.deadSince.keys()) {
      if (key.startsWith(`${runId}/`)) {
        this.deadSince.delete(key);
      }
    }
  }

  private record(action: WatchdogAction): void {
    this.remember(action);
    this.log(`${action.rule} ${action.run}${action.node === null ? "" : ` ${action.node}`}: ${action.action} (${action.detail})${action.rc === null ? "" : ` rc=${action.rc}`}`);
    try {
      mkdirSync(watchdogDir(this.home), { recursive: true });
      appendFileSync(actionsLog(this.home), `${JSON.stringify(action)}\n`);
    } catch (err) {
      this.log(`actions.log write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private remember(action: WatchdogAction): void {
    this.actions.push(action);
    if (this.actions.length > LAST_ACTIONS) {
      this.actions.splice(0, this.actions.length - LAST_ACTIONS);
    }
    const counters = this.counters.get(action.run) ?? emptyCounters();
    const key = counterFor(action.rule, action.action);
    if (key !== null) {
      counters[key] += 1;
    }
    this.counters.set(action.run, counters);
  }

  /** Counters and last actions survive a restart: they are rebuilt from the log's tail. */
  private loadLog(): void {
    for (const line of tailLines(actionsLog(this.home))) {
      try {
        const a = JSON.parse(line) as WatchdogAction;
        if (typeof a.run === "string" && typeof a.rule === "string" && typeof a.action === "string") {
          this.remember(a);
        }
      } catch {
        // a torn line is skipped
      }
    }
  }

  /**
   * Flags of runs that are no longer running are dropped: nothing is left to watch there. Each running
   * run's flags are re-checked against its state.json on every read, so a cleared cause clears its flag
   * even when no state change reached the engine.
   */
  private liveFlags(): WatchdogFlag[] {
    const running = new Map<string, WatchNode[]>();
    try {
      for (const id of readdirSync(join(this.home, "runs"))) {
        const st = (() => {
          try {
            return JSON.parse(readFileSync(join(this.home, "runs", id, "state.json"), "utf8")) as WatchRun;
          } catch {
            return null;
          }
        })();
        if (st?.status === "running") {
          running.set(id, st.nodes ?? []);
        }
      }
    } catch {
      // no runs folder
    }
    for (const [id, nodes] of running) {
      this.dropStaleFlags(id, nodes);
    }
    return [...this.flags.values()].filter((f) => running.has(f.run)).map(({ status: _status, ...f }) => f);
  }

  status(): WatchdogStatus {
    return {
      generated_at: this.now().toISOString(),
      state: this.startedAt === null ? "off" : "on",
      started_at: this.startedAt,
      last_actions: [...this.actions].reverse(),
      runs: Object.fromEntries(this.counters),
      flags: this.liveFlags(),
    };
  }
}

const services = new Map<string, WatchdogService>();

/** The one watchdog per state directory; the API reads through it whether or not it was started. */
export function watchdogFor(home: string): WatchdogService {
  let w = services.get(home);
  if (w === undefined) {
    w = new WatchdogService(home);
    services.set(home, w);
  }
  return w;
}

/** Server startup: the watchdog owns the auto-dispatch engine, so it replaces `startRunEngine`. */
export function startWatchdog(home: string): WatchdogService {
  const w = watchdogFor(home);
  w.begin();
  return w;
}
