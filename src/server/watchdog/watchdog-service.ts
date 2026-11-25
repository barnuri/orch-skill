import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { startDeployWatch } from "../build/deploy-watch";
import { startLlmHubWatch } from "../build/llm-hub-watch";
import { makeSessionIdle } from "./session-idle";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { RunHealth } from "../../shared/types/run-health";
import { RECONCILE_MS, reconcileArgs } from "../runs/run-reconciler";
import type { WatchdogAction, WatchdogCounters, WatchdogFlag, WatchdogRule, WatchdogStatus } from "../../shared/types/watchdog";
import { isEngineNode, loopOfRun } from "../../shared/engine-node";
import { serviceProblem } from "../../../skills/orch/core/adapters/opencode-service.ts";
import { dispatchPath } from "../dispatch-path";
import { orchPaths } from "../files/paths";
import { healthWatcherFor } from "../health/health-watcher";
import { countPendingAsks } from "../runs/coordinator-state";
import { RunEngine, type Starter } from "../runs/auto-dispatch";
import { listRuns } from "../runs/runs-reader";
import { flagCleared, writeFlags } from "../../../skills/orch/core/runs/projection";

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
 *  - cli-source: a node seen turning error with a CLI or source runtime error is flagged and reported
 *    to the run coordinator with `node tell`. It is never retried.
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
const GHOST_SCAN_MS = 30_000;
/** The supervisor terminal cleanup pass (`herdr cleanup --apply`) runs at most this often. */
export const CLEANUP_EVERY_MS: number = 60_000;
/** Takeover steps (`run heal`, `run advance`) run at most this often per run while no orchestrator is reachable. */
export const TAKEOVER_EVERY_MS: number = 20_000;
/** Retries of a node the takeover owns before it is replaced (same as `run watch`). */
export const TAKEOVER_MAX_ATTEMPTS: number = 5;

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
const CLI_SOURCE_ERROR: RegExp = /ReferenceError|TypeError|SyntaxError|Cannot find module|is not defined|(?:usage|dispatch)\.ts/i;
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
  /** The open question for the user (`node update --needs-user`); set on a blocked-user node. */
  needs_user?: string | null;
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
  coordinator?: { session_id?: unknown; unreachable?: unknown } | null;
}

export interface WatchdogOptions {
  /** Spawns `dispatch.ts <args>` for the watchdog's own actions; exit code back. */
  run?: Starter;
  /** Reads the stale-shared-service problem (tests). Default: opencode-service.ts serviceProblem. */
  serviceProblem?: () => string | null;
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
  /** Whether a session-only orchestrator (`orchestrator register --session`) is alive; default: its announce activity file is fresh. */
  sessionAlive?: (sessionId: string) => boolean;
  /** Whether a registered session is idle past settings.orchestrator_idle_minutes with no live TUI; default: opencode db + ps. */
  sessionIdle?: (sessionId: string) => boolean;
}

/** A session counts as alive while its `<home>/activity/<sid>.json` was written in the last SESSION_ALIVE_MS (as `coordSessionAlive`). */
export const SESSION_ALIVE_MS: number = 120_000;

/**
 * True when the run has no reachable orchestrator: none was ever registered (`coordinator` null), or the
 * registered one is unreachable. Only then does the supervisor take over.
 */
export function orchestratorAbsent(
  state: { coordinator?: { session_id?: unknown; unreachable?: unknown; transport?: unknown } | null; harness_session?: string | null },
  sessionAlive: (sessionId: string) => boolean = () => false,
  sessionIdle: (sessionId: string) => boolean = () => false,
): boolean {
  const coord = state.coordinator;
  if (coord === undefined || coord === null) return true;
  const registered = typeof coord.session_id === "string" ? coord.session_id : "";
  // Registered with `--session` only (no terminal): present while that session is alive.
  if (coord.transport === "session") return registered === "" || !sessionAlive(registered);
  const active = typeof state.harness_session === "string" ? state.harness_session : "";
  // The registered session is the active one: present unless it is idle (no activity, no live TUI holds it).
  if (registered !== "" && registered === active) return sessionIdle(registered);
  return (coord.unreachable ?? null) !== null;
}

export function isCliSourceError(error: string | null | undefined): boolean {
  return typeof error === "string" && error !== "" && CLI_SOURCE_ERROR.test(error);
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
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "watchdog", ORCH_NO_ANNOUNCE: "1", ORCH_LOAD_GATE: "1", ORCH_AUTO_DISPATCH: "1" },
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

/** True for a node made by `node replace` (id ends in `-r<N>`). */
export function isReplacement(nodeId: string): boolean {
  return /-r\d+$/.test(nodeId);
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
  return { lost: 0, stalled: 0, unverified: 0, cli_source: 0, retried: 0, flagged: 0, finished: 0 };
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
  if (rule === "cli-source") {
    return "cli_source";
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
  private readonly sessionAlive: (sessionId: string) => boolean;
  private readonly sessionIdle: (sessionId: string) => boolean;
  /** Last done-gate signature per run: the gate step reruns only when the run changed. */
  private readonly gateSig = new Map<string, string>();
  private readonly reconciledAt = new Map<string, number>();
  private readonly reconcileBusy = new Set<string>();
  private readonly coordAt = new Map<string, number>();
  private readonly coordBusy = new Set<string>();
  /** Last takeover step per run, and the runs with one in flight. */
  private readonly takeoverAt = new Map<string, number>();
  private readonly takeoverBusy = new Set<string>();
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
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private stopDeployWatch: (() => void) | null = null;
  private stopLlmHubWatch: (() => void) | null = null;
  private cleanupBusy = false;
  private readonly serviceProblemFn: () => string | null;

  constructor(readonly home: string, opts: WatchdogOptions = {}) {
    this.runDispatch = opts.run ?? spawnWatchdogDispatch;
    this.serviceProblemFn = opts.serviceProblem ?? serviceProblem;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.log ?? ((line) => void process.stderr.write(`watchdog: ${line}\n`));
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.lostAfterMs = opts.lostAfterMs ?? LOST_AFTER_MS;
    this.startingAfterMs = opts.startingAfterMs ?? STARTING_AFTER_MS;
    this.ownersEveryMs = opts.ownersEveryMs ?? OWNERS_EVERY_MS;
    this.sessionAlive = opts.sessionAlive ?? ((sid): boolean => {
      const at = mtimeMs(join(home, "activity", `${sid}.json`));
      return at !== null && this.now().getTime() - at < SESSION_ALIVE_MS;
    });
    this.sessionIdle = opts.sessionIdle ?? makeSessionIdle(home, { now: this.now });
    const paths = orchPaths(home);
    this.health = opts.health ?? ((runId): RunHealth | null => healthWatcherFor(paths).latest(runId)?.health ?? null);
    this.engine = new RunEngine(home, {
      ...(opts.engineStart === undefined ? {} : { start: opts.engineStart }),
      now: this.now,
      onState: (runId, state) => this.inspect(runId, state as WatchRun),
    });
    this.loadLog();
  }

  private serviceTimer: ReturnType<typeof setInterval> | null = null;
  private lastServiceProblem: string | null = null;

  /** Reports a stale shared opencode service once per distinct problem, with the fix. Never restarts it. */
  checkService(): void {
    let problem: string | null = null;
    try { problem = this.serviceProblemFn(); } catch { return; }
    if (problem === this.lastServiceProblem) return;
    this.lastServiceProblem = problem;
    if (problem) this.record({ at: this.now().toISOString(), run: "-", node: null, rule: "service", action: "report", detail: problem, rc: null });
  }

  begin(): void {
    this.startedAt = this.now().toISOString();
    if (process.env["ORCH_DEPLOY_WATCH"] !== "0") {
      this.checkService();
      this.serviceTimer = setInterval(() => this.checkService(), 600_000);
    }
    this.engine.begin();
    this.cleanupTimer = setInterval(() => this.cleanupPass(), CLEANUP_EVERY_MS);
    if (process.env["ORCH_DEPLOY_WATCH"] !== "0") {
      this.stopDeployWatch = startDeployWatch(this.home);
      this.stopLlmHubWatch = startLlmHubWatch(this.home);
    }
  }

  stop(): void {
    if (this.serviceTimer !== null) clearInterval(this.serviceTimer);
    this.serviceTimer = null;
    this.stopDeployWatch?.();
    this.stopDeployWatch = null;
    this.stopLlmHubWatch?.();
    this.stopLlmHubWatch = null;
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.engine.stop();
  }

  /**
   * Supervisor terminal cleanup: `dispatch.ts herdr cleanup --apply`, which closes only tabs with no live work
   * and sends stale node messages to the orchestrator. The command re-checks its own plan before it acts.
   */
  private cleanupPass(): void {
    if (this.cleanupBusy) {
      return;
    }
    this.cleanupBusy = true;
    const p = this.runDispatch(["herdr", "cleanup", "--apply"], this.home)
      .then((rc) => {
        if (rc !== 0) {
          this.log(`herdr cleanup rc=${rc}`);
        }
      })
      .catch((err: unknown) => this.log(`herdr cleanup failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.cleanupBusy = false;
        this.inflight.delete(p);
      });
    this.inflight.add(p);
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
        if ((node.error ?? "") === "ended early without handoff") {
          this.checkHandoff(runId, node);
        }
        this.checkInfraError(runId, node);
      }
    }
    this.checkFinish(runId, state, nodes);
    this.checkGate(runId, nodes);
    if (orchestratorAbsent(state, (sid) => this.sessionAlive(sid), (sid) => this.sessionIdle(sid))) {
      this.takeover(runId, state, nodes);
    }
    this.syncRun(runId);
    this.syncCoordinator(runId, state);
  }

  /**
   * Supervisor takeover, for a run with no reachable orchestrator. Only deterministic steps:
   *  - blocked-user nodes stay untouched; their question is queued once for the next orchestrator (`node tell`).
   *  - error nodes that no other rule owns get `node retry`, then `node replace` after TAKEOVER_MAX_ATTEMPTS.
   *  - `run heal` creates the gap nodes and closes the gate. With `auto_dispatch`, `run advance` dispatches the
   *    ready nodes, runs the gate and finishes the run. Throttled per run; each action is one actions.log line.
   * Never answers a question, clears needs_user, or approves a destructive or outward-facing step.
   */
  private takeover(runId: string, state: WatchRun, nodes: WatchNode[]): void {
    for (const node of nodes) {
      if (node.status === "blocked-user") {
        this.queueQuestion(runId, node);
      } else if (node.status === "error" && !this.engineOwned(runId, node)) {
        this.takeoverRetry(runId, node);
      }
    }
    this.takeoverSteps(runId, state);
  }

  private queueQuestion(runId: string, node: WatchNode): void {
    const question = (node.needs_user ?? "").trim();
    if (question === "" || (node.id === "done-gate" && question.startsWith("verify FAILED"))) {
      return;
    }
    const digest = createHash("sha1").update(question).digest("hex").slice(0, 12);
    if (!this.claim(runId, `blocked-${node.id}@${digest}`)) {
      return;
    }
    const text = `Node ${node.id} is blocked-user and waits for the user: ${question}`;
    this.chain(runId, node.id, async () => {
      await this.act(runId, node.id, "takeover", ["node", "tell", runId, "coordinator", text, "--from", "watchdog"], "question queued for the next orchestrator");
    });
  }

  private takeoverRetry(runId: string, node: WatchNode): void {
    const error = node.error ?? "";
    // Owned by other rules: early end (unverified), CLI or source errors (routed to the orchestrator), infra errors (infra-retry), test failures (never retried).
    if (error === "ended early without handoff" || isCliSourceError(error) || isInfraError(error) || TEST_FAILURE.test(error)) {
      return;
    }
    if (this.busy.has(`${runId}/${node.id}`)) {
      return;
    }
    const attempts = (node.attempts ?? []).length;
    if (!this.claim(runId, `takeover-${node.id}@${attempts}`)) {
      return;
    }
    const replace = attempts >= TAKEOVER_MAX_ATTEMPTS;
    // A replacement that fails again is not replaced: that grew chains like x-r2-r2-r2-r2. The user decides.
    if (replace && isReplacement(node.id)) {
      const reason = `replacement ${node.id} failed after ${attempts} attempts: ${error || "no error text"}`;
      // queueQuestion would tell the same question again once the node is blocked-user: claim its key now.
      this.claim(runId, `blocked-${node.id}@${createHash("sha1").update(reason).digest("hex").slice(0, 12)}`);
      this.chain(runId, node.id, async () => {
        await this.act(runId, node.id, "takeover", ["node", "update", runId, node.id, "blocked-user", "--needs-user", reason], "replacement failed again: needs the user");
        await this.act(runId, node.id, "takeover", ["node", "tell", runId, "coordinator", `Node ${node.id} is blocked-user: ${reason}`, "--from", "watchdog"], "orchestrator told");
      });
      return;
    }
    this.chain(runId, node.id, async () => {
      if (replace) {
        await this.act(runId, node.id, "takeover", ["node", "replace", runId, node.id], `${attempts} attempts used: same goal and profile in a new node`);
      } else {
        await this.act(runId, node.id, "takeover", ["node", "retry", runId, node.id], `attempt ${attempts + 1} of ${TAKEOVER_MAX_ATTEMPTS}: ${error}`);
      }
    });
  }

  private takeoverSteps(runId: string, state: WatchRun): void {
    const nowMs = this.now().getTime();
    const last = this.takeoverAt.get(runId);
    if (this.takeoverBusy.has(runId) || (last !== undefined && nowMs - last < TAKEOVER_EVERY_MS)) {
      return;
    }
    this.takeoverAt.set(runId, nowMs);
    this.takeoverBusy.add(runId);
    const dispatch = state.auto_dispatch === true;
    const p = (async (): Promise<void> => {
      await this.act(runId, null, "takeover", ["run", "heal", runId], "orchestrator absent: gap nodes, gate, finish");
      if (dispatch) {
        await this.act(runId, null, "takeover", ["run", "advance", runId], "orchestrator absent: dispatch ready nodes, gate, finish");
      }
    })()
      .catch((err: unknown) => this.log(`takeover ${runId} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.takeoverBusy.delete(runId);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
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
      .then((rc) => this.record({ at: this.now().toISOString(), run: runId, node: null, rule: "coordinator", action: "run messages", detail: "orchestrator sweep", rc }))
      .catch((err: unknown) => this.log(`coordinator sweep ${runId} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.coordBusy.delete(runId);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
  }

  private syncRun(runId: string): void {
    const now = this.now().getTime();
    const last = this.reconciledAt.get(runId) ?? 0;
    if (this.reconcileBusy.has(runId) || now - last < RECONCILE_MS) return;
    this.reconciledAt.set(runId, now);
    this.reconcileBusy.add(runId);
    const p = this.runDispatch(reconcileArgs(runId).slice(2), this.home)
      .then((rc) => { if (rc !== 0) this.log(`run sync ${runId} rc=${rc}`); })
      .catch((err: unknown) => this.log(`run sync ${runId} failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { this.reconcileBusy.delete(runId); this.inflight.delete(p); });
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
    if (isCliSourceError(node.error)) {
      this.routeCliSourceError(runId, node);
      return;
    }
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

  private routeCliSourceError(runId: string, node: WatchNode): void {
    const attempt = (node.attempts ?? []).length;
    if (!this.claim(runId, `cli-source-${node.id}@${attempt}`)) {
      return;
    }
    const error = node.error ?? "";
    this.flag(runId, node.id, "cli-source", error, "error");
    const message = `Node ${node.id} failed with a CLI or source error. The watchdog did not retry it. Fix the source, then retry the node. Error: ${error}`;
    this.chain(runId, node.id, async () => {
      await this.act(runId, node.id, "cli-source", ["node", "tell", runId, "coordinator", message, "--from", "watchdog"], error);
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

  /**
   * The done gate is deterministic: when every node but the gate is settled and the gate waits (or is blocked by an
   * earlier failed gate step), run `run gate`. It reruns only when the settled nodes changed, never on a timer.
   */
  private checkGate(runId: string, nodes: WatchNode[]): void {
    const gate = nodes.find((n) => n.id === "done-gate");
    if (gate === undefined) {
      return;
    }
    const retry = gate.status === "blocked-user" && (gate.needs_user ?? "").startsWith("verify FAILED");
    if (gate.status !== "waiting" && !retry) {
      this.gateSig.delete(runId);
      return;
    }
    const others = nodes.filter((n) => n.id !== "done-gate");
    if (!others.every((n) => n.status === "done" || n.status === "skipped" || n.status === "covered")) {
      return;
    }
    if ([...this.busy].some((k) => k.startsWith(`${runId}/`))) {
      return;
    }
    const sig = createHash("sha1").update(JSON.stringify(others)).digest("hex");
    if (this.gateSig.get(runId) === sig) {
      return;
    }
    this.gateSig.set(runId, sig);
    this.chain(runId, "done-gate", async () => {
      await this.act(runId, "done-gate", "gate", ["run", "gate", runId], "every node settled: watchdog ran the done gate");
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
    this.persistFlags();
    this.record({ at, run: runId, node: nodeId, rule, action: "flag", detail, rc: null });
  }

  /**
   * Drops a run's flags whose cause is gone: the node left the status the flag was raised in (retried,
   * finished, removed), or an `unverified` node now has its handoff.md.
   */
  private dropStaleFlags(runId: string, nodes: WatchNode[]): void {
    let dropped = false;
    for (const [key, f] of this.flags) {
      if (f.run !== runId) {
        continue;
      }
      const node = nodes.find((n) => n.id === f.node);
      if (flagCleared(f, node === undefined ? undefined : { status: node.status ?? "" }, node !== undefined && handoffPresent(this.home, runId, node))) {
        this.flags.delete(key);
        dropped = true;
      }
    }
    if (dropped) {
      this.persistFlags();
    }
  }

  /** The flags the CLI and API read (`<home>/watchdog/flags.json`), written on every change. */
  private persistFlags(): void {
    try {
      writeFlags(this.home, [...this.flags.values()]);
    } catch (err) {
      this.log(`flags.json write failed: ${err instanceof Error ? err.message : String(err)}`);
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
    // The run summaries are memoised per run, so this reads state.json only for the running runs.
    for (const summary of listRuns(orchPaths(this.home))) {
      if (summary.status !== "running") {
        continue;
      }
      try {
        const st = JSON.parse(readFileSync(join(this.home, "runs", summary.run_id, "state.json"), "utf8")) as WatchRun;
        running.set(summary.run_id, st.nodes ?? []);
      } catch {
        // a state.json that vanished or tore mid-write is skipped
      }
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
      ghosts: this.ghostCount(),
    };
  }

  // Ghost runners, from one process scan per 30 s. The scan (`ps`, blocking) runs in a worker, so the
  // route returns the last count at once. Until the first scan ends the count is 0. A failed scan reports 0.
  private ghostCache: { at: number; count: number } | null = null;
  private ghostScanning = false;
  private ghostCount(): number {
    const nowMs = this.now().getTime();
    if (!this.ghostScanning && (this.ghostCache === null || nowMs - this.ghostCache.at >= GHOST_SCAN_MS)) {
      this.startGhostScan(nowMs);
    }
    return this.ghostCache?.count ?? 0;
  }

  private startGhostScan(nowMs: number): void {
    this.ghostScanning = true;
    const worker = new Worker(new URL("./ghost-worker.ts", import.meta.url).href);
    const finish = (count: number): void => {
      this.ghostCache = { at: nowMs, count };
      this.ghostScanning = false;
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<unknown>): void => finish(typeof event.data === "number" ? event.data : 0);
    worker.onerror = (): void => finish(0);
    worker.postMessage("scan");
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
