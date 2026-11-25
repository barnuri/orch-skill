import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { retireLegacyGate } from "../../../skills/orch/core/runs/legacy-gate";
import type { FSWatcher } from "node:fs";
import { join, resolve } from "node:path";

import { dispatchPath } from "../dispatch-path";
import { attemptCount } from "../../shared/attempt-count";
import { BUILTIN_DEFAULTS, effectiveProfile, type ProfileDefaults } from "../../shared/profile-effective";
import { blockersOf, type ProjectionNodeInput } from "../../../skills/orch/core/runs/projection";

/**
 * Event-driven run engine. Watches each active run's folder (fs.watch, debounced) and, on every
 * change to state.json, starts each ready node of a run that opted in with
 * `dispatch.ts run set <run> auto_dispatch true`. A 30 s sweep catches missed events and new runs.
 * It also turns every node change to done or error into a bus event (SSE) and a notification line.
 * Server-written files, like the schedule claims: `<home>/autodispatch/<run>/claims/<node>@<attempt>`
 * and `<home>/autodispatch/<run>/notify.log`. Run state is only changed through `dispatch.ts`.
 */

export const DEBOUNCE_MS: number = 200;
export const SWEEP_MS: number = 30_000;
export const DEFAULT_MAX_PARALLEL: number = 30;
const AGENT_RULES: string = resolve(import.meta.dir, "../../../skills/orch/references/agent-rules.md");

interface NodeState {
  id: string;
  status?: string;
  label?: string;
  acceptance?: string | null;
  prompt?: string | null;
  profile?: string | null;
  attempts?: unknown[] | null;
  attempt_count?: number | null;
  needs_user?: string | null;
}

export interface RunState {
  run_id?: string;
  status?: string;
  paused?: boolean;
  stopped?: boolean;
  auto_dispatch?: boolean;
  max_parallel?: number | null;
  default_profile?: string | null;
  profile?: string | null;
  nodes?: NodeState[];
  edges?: [string, string][];
}

export interface NodeChange {
  run: string;
  node: string;
  from: string | null;
  to: string;
  at: string;
}

type Listener = (change: NodeChange) => void;
const listeners = new Set<Listener>();

/** Live node changes to done or error, for the run page's SSE stream. Returns the unsubscribe. */
export function subscribeNodeChanges(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function publishNodeChange(change: NodeChange): void {
  for (const fn of listeners) {
    try {
      fn(change);
    } catch {
      // a broken subscriber never stops the others
    }
  }
}

/** Spawns `dispatch.ts <args>`; resolves with its exit code. */
export type Starter = (args: string[], home: string) => Promise<number>;
export type Logger = (line: string) => void;

export const spawnDispatch: Starter = async (args, home) => {
  const proc = Bun.spawn([process.execPath, dispatchPath(), ...args], {
    // The service dispatches nodes itself: ORCH_AUTO_DISPATCH makes the job use the node's, its relatives' or the run's repo,
    // never the service's own cwd (verify-G17 found jobs started in the orch-skill checkout).
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_AUTO_DISPATCH: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
};

const stderrLog: Logger = (line) => void process.stderr.write(`auto-dispatch: ${line}\n`);

export function engineDir(home: string, runId: string): string {
  return join(home, "autodispatch", runId);
}

export function notifyFile(home: string, runId: string): string {
  return join(engineDir(home, runId), "notify.log");
}

/** Run cap: defaults.max_parallel, then settings.max_parallel (old key), then serve.json, then 30. */
export function maxParallel(home: string): number {
  const cfg = readProfilesConfig(home);
  for (const v of [cfg.defaults?.max_parallel, cfg.settings?.max_parallel]) {
    if (v === -1) return Number.POSITIVE_INFINITY;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
  }
  try {
    const v = (JSON.parse(readFileSync(join(home, "serve.json"), "utf8")) as Record<string, unknown>)["auto_dispatch_max_parallel"];
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : DEFAULT_MAX_PARALLEL;
  } catch {
    return DEFAULT_MAX_PARALLEL;
  }
}

interface ProfilesConfig {
  defaults?: ProfileDefaults & { max_parallel?: number };
  settings?: { max_parallel?: number };
  profiles?: Record<string, Record<string, unknown>>;
}

/** A parsed JSON file, reused while its size and mtime are unchanged. */
interface ParsedMemo<T> { sig: string; value: T }
const profilesMemo = new Map<string, ParsedMemo<ProfilesConfig>>();
const stateMemo = new Map<string, ParsedMemo<RunState | null>>();

function fileSig(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function readProfilesConfig(home: string): ProfilesConfig {
  const path = join(home, "profiles.json");
  const sig = fileSig(path);
  const memo = profilesMemo.get(path);
  if (sig !== null && memo !== undefined && memo.sig === sig) {
    return memo.value;
  }
  let value: ProfilesConfig;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as ProfilesConfig;
  } catch {
    return {};
  }
  if (sig !== null) {
    profilesMemo.set(path, { sig, value });
  }
  return value;
}

/** Per-profile cap: the profile's effective max_parallel (node, profile, defaults, builtin). */
export function profileCapOf(cfg: ProfilesConfig): (profile: string) => number {
  return (profile) => {
    const raw = cfg.profiles?.[profile] ?? {};
    const v = effectiveProfile(raw, cfg.defaults ?? {}).max_parallel.value;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : BUILTIN_DEFAULTS.max_parallel ?? DEFAULT_MAX_PARALLEL;
  };
}


/**
 * A run's state.json, parsed once per (size, mtime). The 30 s sweep reads every run, and most runs are
 * finished and unchanged; re-parsing them on each sweep blocked the event loop for seconds.
 */
function readState(home: string, runId: string): RunState | null {
  const path = join(home, "runs", runId, "state.json");
  const sig = fileSig(path);
  if (sig === null) {
    stateMemo.delete(path);
    return null;
  }
  const memo = stateMemo.get(path);
  if (memo !== undefined && memo.sig === sig) {
    return memo.value;
  }
  try {
    const value = retireLegacyGate(JSON.parse(readFileSync(path, "utf8")) as RunState);
    stateMemo.set(path, { sig, value });
    return value;
  } catch {
    stateMemo.delete(path);
    return null;
  }
}

function claimOnce(path: string, body: unknown): boolean {
  try {
    writeFileSync(path, JSON.stringify(body), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function agentRules(): string {
  try {
    return readFileSync(AGENT_RULES, "utf8");
  } catch {
    return "";
  }
}

/** The node's stored prompt, else agent-rules.md as a header plus its goal (label and acceptance). */
export function promptFor(node: NodeState): string {
  if (typeof node.prompt === "string" && node.prompt.trim() !== "") {
    return node.prompt;
  }
  const goal = [node.label ?? node.id, node.acceptance ? `Acceptance: ${node.acceptance}` : ""].filter((s) => s !== "").join("\n\n");
  const rules = agentRules().trim();
  return rules === "" ? goal : `${rules}\n\n# Task\n\n${goal}`;
}

export type Decision = { node: string; action: "start"; profile: string; prompt: string } | { node: string; action: "skip"; reason: string };

/** Pure: which waiting nodes start now and why the others wait. Empty when the run is not opted in. */
/** `isSettled(id)` is false for a dependency that just turned done but has no handoff yet: the watchdog may still flip it to error. */
export function decide(
  state: RunState,
  cap: number,
  isSettled: (id: string) => boolean = () => true,
  profileCap: (profile: string) => number = () => Infinity,
): Decision[] {
  if (state.auto_dispatch !== true) {
    return [];
  }
  const nodes = state.nodes ?? [];
  const waiting = nodes.filter((n) => n.status === "waiting");
  if (state.stopped === true || state.paused === true) {
    const reason = state.stopped === true ? "run stopped" : "run paused";
    return waiting.map((n) => ({ node: n.id, action: "skip", reason }));
  }
  let running = nodes.filter((n) => n.status === "running").length;
  const runningOf = new Map<string, number>();
  for (const n of nodes.filter((n) => n.status === "running")) {
    const p = n.profile ?? state.default_profile ?? state.profile ?? "";
    runningOf.set(p, (runningOf.get(p) ?? 0) + 1);
  }
  const out: Decision[] = [];
  for (const n of waiting) {
    // The readiness rule is the projection's (skills/orch/core/runs/projection.ts), shared with `run status`.
    const blockers = blockersOf({ nodes: nodes as unknown as ProjectionNodeInput[], edges: state.edges }, n as unknown as ProjectionNodeInput, isSettled);
    if (blockers.length > 0) {
      out.push({ node: n.id, action: "skip", reason: `waiting on ${blockers.join(",")}` });
      continue;
    }
    // A node with an open question for the user never starts without the user's answer.
    if ((n.needs_user ?? "") !== "") {
      out.push({ node: n.id, action: "skip", reason: "needs the user" });
      continue;
    }
    const profile = n.profile ?? state.default_profile ?? state.profile ?? null;
    if (profile === null || profile === "") {
      out.push({ node: n.id, action: "skip", reason: "no profile on node or run" });
      continue;
    }
    if (running >= cap) {
      out.push({ node: n.id, action: "skip", reason: `cap ${cap} reached` });
      continue;
    }
    const pCap = profileCap(profile);
    if ((runningOf.get(profile) ?? 0) >= pCap) {
      out.push({ node: n.id, action: "skip", reason: `profile ${profile} cap ${pCap} reached` });
      continue;
    }
    running += 1;
    runningOf.set(profile, (runningOf.get(profile) ?? 0) + 1);
    out.push({ node: n.id, action: "start", profile, prompt: promptFor(n) });
  }
  return out;
}

export interface EngineOptions {
  start?: Starter;
  log?: Logger;
  now?: () => Date;
  /** Delay before a failed start is retried (default 20 s). */
  retryMs?: number;
  /** Called with every state the engine reads (each state.json change and each sweep); the watchdog's hook. */
  onState?: (runId: string, state: RunState) => void;
}

const RETRY_LIMIT = 3;
const RETRY_DELAY_MS = 20000;

/** One engine over one home. `evaluate` is idempotent: claims make a second call start nothing. */
export class RunEngine {
  private readonly start: Starter;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly lastStatus = new Map<string, Map<string, string>>();
  private readonly lastSkip = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  private readonly retryMs: number;
  private readonly onState: ((runId: string, state: RunState) => void) | null;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private runsWatcher: FSWatcher | null = null;
  /** Pending starts, so tests can await them. */
  readonly inflight = new Set<Promise<void>>();

  constructor(readonly home: string, opts: EngineOptions = {}) {
    this.start = opts.start ?? spawnDispatch;
    this.log = opts.log ?? stderrLog;
    this.now = opts.now ?? ((): Date => new Date());
    this.retryMs = opts.retryMs ?? RETRY_DELAY_MS;
    this.onState = opts.onState ?? null;
  }

  evaluate(runId: string): void {
    const state = readState(this.home, runId);
    if (state === null) {
      return;
    }
    this.notifyChanges(runId, state);
    if (this.onState !== null) {
      try {
        this.onState(runId, state);
      } catch (err) {
        this.log(`onState ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const settled = (id: string): boolean => {
      const dep = (state.nodes ?? []).find((n) => n.id === id);
      const finished = Date.parse(String((dep as { finished?: string } | undefined)?.finished ?? ""));
      if (!Number.isFinite(finished) || Date.now() - finished > 120_000) {
        return true;
      }
      return existsSync(join(this.home, "runs", runId, "out", id, "handoff.md"));
    };
    const globalCap = maxParallel(this.home);
    const localCap = typeof state.max_parallel === "number" && (state.max_parallel === -1 || state.max_parallel >= 1) ? (state.max_parallel === -1 ? Number.POSITIVE_INFINITY : state.max_parallel) : globalCap;
    const cap = Math.min(globalCap, localCap);
    for (const d of decide(state, cap, settled, profileCapOf(readProfilesConfig(this.home)))) {
      const key = `${runId}/${d.node}`;
      if (d.action === "skip") {
        if (this.lastSkip.get(key) !== d.reason) {
          this.lastSkip.set(key, d.reason);
          this.log(`skip ${runId} ${d.node}: ${d.reason}`);
        }
        continue;
      }
      const node = (state.nodes ?? []).find((n) => n.id === d.node);
      const claims = join(engineDir(this.home, runId), "claims");
      mkdirSync(claims, { recursive: true });
      const claim = join(claims, `${d.node}@${attemptCount(node)}`);
      const updated = String((node as { updated?: string } | undefined)?.updated ?? "");
      if (!claimOnce(claim, { run: runId, node: d.node, profile: d.profile, claimed_at: this.now().toISOString(), node_updated: updated })) {
        if (!this.releaseReset(claim, updated) || !claimOnce(claim, { run: runId, node: d.node, profile: d.profile, claimed_at: this.now().toISOString(), node_updated: updated })) {
          continue;
        }
      }
      this.lastSkip.delete(key);
      this.log(`start ${runId} ${d.node} --profile ${d.profile}`);
      const p = this.start(["node", "dispatch", runId, d.node, "--profile", d.profile, d.prompt], this.home)
        .then((rc) => {
          if (rc !== 0) {
            this.releaseFailed(runId, d.node, claim, `dispatch exit ${rc}`);
          }
        })
        .catch((err: unknown) => this.releaseFailed(runId, d.node, claim, err instanceof Error ? err.message : String(err)))
        .finally(() => this.inflight.delete(p));
      this.inflight.add(p);
    }
  }

  /** A node set back to waiting by hand (its `updated` stamp moved since the claim) frees its claim, kept as `.reset-<n>`. */
  private releaseReset(claim: string, updated: string): boolean {
    let stamp: unknown;
    try {
      stamp = (JSON.parse(readFileSync(claim, "utf8")) as { node_updated?: unknown }).node_updated;
    } catch {
      return false;
    }
    if (typeof stamp !== "string" || stamp === updated) {
      return false;
    }
    for (let i = 1; ; i++) {
      if (!existsSync(`${claim}.reset-${i}`)) {
        try {
          renameSync(claim, `${claim}.reset-${i}`);
          return true;
        } catch {
          return false;
        }
      }
    }
  }

  /** A failed start frees its claim (kept as `.failed-<n>`) and retries after a backoff, up to 3 times. */
  private releaseFailed(runId: string, node: string, claim: string, reason: string): void {
    const key = `${runId}/${node}`;
    const count = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, count);
    try {
      renameSync(claim, `${claim}.failed-${count}`);
    } catch {
      // the claim is already gone
    }
    if (count >= RETRY_LIMIT) {
      this.log(`start failed ${runId} ${node}: ${reason} (gave up after ${count} tries)`);
      return;
    }
    this.log(`start failed ${runId} ${node}: ${reason} (retry ${count}/${RETRY_LIMIT - 1} in ${this.retryMs / 1000}s)`);
    setTimeout(() => this.evaluate(runId), this.retryMs).unref();
  }

  private notifyChanges(runId: string, state: RunState): void {
    const prev = this.lastStatus.get(runId);
    const next = new Map((state.nodes ?? []).map((n) => [n.id, n.status ?? ""]));
    this.lastStatus.set(runId, next);
    if (prev === undefined) {
      return;
    }
    for (const [node, to] of next) {
      const from = prev.get(node) ?? null;
      if (from === to || (to !== "done" && to !== "error")) {
        continue;
      }
      const change: NodeChange = { run: runId, node, from, to, at: this.now().toISOString() };
      try {
        mkdirSync(engineDir(this.home, runId), { recursive: true });
        appendFileSync(notifyFile(this.home, runId), `${JSON.stringify(change)}\n`);
      } catch (err) {
        this.log(`notify failed ${runId} ${node}: ${err instanceof Error ? err.message : String(err)}`);
      }
      publishNodeChange(change);
    }
  }

  /** Debounced evaluation: a burst of writes inside DEBOUNCE_MS counts once. */
  schedule(runId: string, delayMs: number = DEBOUNCE_MS): void {
    const old = this.timers.get(runId);
    if (old !== undefined) {
      clearTimeout(old);
    }
    this.timers.set(runId, setTimeout(() => {
      this.timers.delete(runId);
      this.safeEvaluate(runId);
    }, delayMs));
  }

  private safeEvaluate(runId: string): void {
    try {
      this.evaluate(runId);
    } catch (err) {
      this.log(`evaluate ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Watches every active run (status running) and drops watchers of finished ones. */
  sweep(): void {
    const runsDir = join(this.home, "runs");
    let ids: string[] = [];
    try {
      ids = readdirSync(runsDir);
    } catch {
      return;
    }
    const active = new Set<string>();
    for (const id of ids) {
      const state = readState(this.home, id);
      if (state === null || state.status !== "running") {
        continue;
      }
      active.add(id);
      this.watchRun(id);
      this.safeEvaluate(id);
    }
    for (const [id, w] of this.watchers) {
      if (!active.has(id)) {
        w.close();
        this.watchers.delete(id);
        this.lastStatus.delete(id);
      }
    }
  }

  private watchRun(id: string): void {
    if (this.watchers.has(id)) {
      return;
    }
    const dir = join(this.home, "runs", id);
    try {
      // The folder, not the file: state.json is replaced by rename on every write.
      const w = watch(dir, (_event, name) => {
        if (name === null || name === "state.json") {
          this.schedule(id);
        }
      });
      w.on("error", () => {
        w.close();
        this.watchers.delete(id);
      });
      this.watchers.set(id, w);
    } catch {
      // the folder vanished between the scan and the watch
    }
  }

  begin(): void {
    this.sweep();
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    const runsDir = join(this.home, "runs");
    if (existsSync(runsDir)) {
      try {
        // A new run folder gets its watcher at once instead of at the next sweep.
        this.runsWatcher = watch(runsDir, (_event, name) => {
          if (name !== null && !this.watchers.has(name)) {
            setTimeout(() => this.sweep(), DEBOUNCE_MS);
          }
        });
      } catch {
        this.runsWatcher = null;
      }
    }
  }

  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
    }
    this.runsWatcher?.close();
    for (const w of this.watchers.values()) {
      w.close();
    }
    this.watchers.clear();
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    this.timers.clear();
  }
}

export function startRunEngine(home: string, opts: EngineOptions = {}): RunEngine {
  const engine = new RunEngine(home, opts);
  engine.begin();
  return engine;
}
