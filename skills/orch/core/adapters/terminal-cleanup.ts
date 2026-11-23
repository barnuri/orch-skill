// Supervisor-owned terminal cleanup for the orch herdr instance.
//
// snapshotCleanup reads the herdr panes, the job folders, the owner files and every run state.
// planCleanup is pure: it decides, per tab, close or keep (with every reason), and which stale nodes
// get a message to the orchestrator. runCleanup applies a plan, but only after it re-reads the snapshot
// and plans again: a tab that became live, or a node that stopped being stale, is dropped from the plan.
//
// Safety rule: a tab closes only when every job in it is not running, its owner
// file names one of those jobs, no pane in it is foreign, no run reachable through it has an active
// orchestrator or a pending ask, and every failed job has its result recorded on its node.
// A job with no exit code closes only when no node still points at it (a crash that left no result).
// Unowned tabs are never closed here (the herdr sweep handles orphan panes).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../state/home.ts";
import { writeJsonAtomic } from "../state/store.ts";
import { herdrCli, herdrDir, jobRunning, ownerFile, readTrim, serverRunning } from "./herdr.ts";

export const CLEANUP_LIMIT_DEFAULT = 10;
const STOP_CODES = [129, 130, 143];
const RESULT_STATUSES = ["done", "covered", "skipped", "stopped"];
const NOTIFIED_KEEP = 500;
const dispatchScript = join(import.meta.dir, "..", "..", "scripts", "dispatch.ts");

export interface HerdrPane { pane_id: string; tab_id: string }

export interface NodeFact {
  id: string;
  status: string;
  job_id: string | null;
  error: string | null;
  covered_by: string | null;
  needs_user: string | null;
  handoff: boolean;
  attempts: number;
  /** Made by the loop or watch engine: the loop decides, never this pass. */
  engine: boolean;
}

export interface RunFact {
  id: string;
  status: string;
  paused: boolean;
  stopped: boolean;
  /** The registered coordinator's pane, or null. */
  coordinatorPane: string | null;
  /** True while a coordinator is registered and reachable. */
  orchestratorActive: boolean;
  pendingAsks: number;
  nodes: NodeFact[];
}

export interface JobFact {
  job: string;
  dir: string;
  tab: string;
  pane: string | null;
  running: boolean;
  exitCode: number | null;
  run: RunFact | null;
  node: NodeFact | null;
}

export interface CleanupSnapshot {
  /** False when the orch herdr instance does not answer: the plan is empty. */
  herdrUp: boolean;
  panes: HerdrPane[];
  /** Tab id to the job folder named in its owner file. */
  owners: Map<string, string>;
  jobs: JobFact[];
  runs: RunFact[];
  /** Recovery keys already sent to an orchestrator. */
  notified: Set<string>;
}

export interface CloseAction { tab: string; jobs: string[] }
export interface TellAction { run: string; node: string; key: string; text: string }
export interface KeepEntry { tab: string; reasons: string[] }

export interface CleanupPlan {
  close: CloseAction[];
  tell: TellAction[];
  keep: KeepEntry[];
  /** Tabs with panes but no orch job: left to the herdr sweep. */
  unowned_tabs: number;
  /** Actions cut by the limit. */
  limited: number;
}

export interface CleanupReport {
  mode: "dry-run" | "apply";
  herdr: "up" | "down";
  limit: number;
  plan: CleanupPlan;
  applied: { closed: string[]; told: string[]; failed: string[] };
}

const emptyPlan = (): CleanupPlan => ({ close: [], tell: [], keep: [], unowned_tabs: 0, limited: 0 });

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function handoffPresent(outDir: string): boolean {
  try {
    return statSync(join(outDir, "handoff.md")).size > 0;
  } catch {
    return false;
  }
}

function countPendingAsks(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const msg = readJsonSafe<{ kind?: string; delivered_at?: string | null }>(join(dir, name));
    if (msg?.kind === "ask" && (msg.delivered_at ?? null) === null) n += 1;
  }
  return n;
}

function listPanes(home: string): Promise<HerdrPane[] | null> {
  return serverRunning(home).then(async (up) => {
    if (!up) return null;
    const r = await herdrCli(home, ["pane", "list"]);
    if (!r.ok) return null;
    try {
      return ((JSON.parse(r.stdout).result?.panes ?? []) as any[]).map((p) => ({ pane_id: String(p.pane_id), tab_id: String(p.tab_id) }));
    } catch {
      return null;
    }
  });
}

/** Reads the live state. `panes` overrides the herdr pane list (tests); null means herdr is down, no spawn. */
export async function snapshotCleanup(home: string, panes?: HerdrPane[] | null): Promise<CleanupSnapshot> {
  const livePanes = panes === null ? null : (panes ?? (await listPanes(home)));
  const runs: RunFact[] = [];
  let runDirs: string[] = [];
  try { runDirs = readdirSync(paths.runs(home)); } catch { /* no runs yet */ }
  for (const id of runDirs.sort()) {
    const st = readJsonSafe<any>(paths.runState(home, id));
    if (st === null) continue;
    const coord = st.coordinator ?? null;
    const reachable = coord !== null && (coord.unreachable ?? null) === null;
    runs.push({
      id,
      status: String(st.status ?? ""),
      paused: st.paused === true,
      stopped: st.stopped === true,
      coordinatorPane: typeof coord?.pane_id === "string" ? coord.pane_id : null,
      orchestratorActive: reachable,
      pendingAsks: countPendingAsks(join(paths.runs(home), id, "inbox", "orch")),
      nodes: (Array.isArray(st.nodes) ? st.nodes : []).map((n: any): NodeFact => ({
        id: String(n.id),
        status: String(n.status ?? ""),
        job_id: typeof n.job_id === "string" && n.job_id !== "" ? n.job_id : null,
        error: typeof n.error === "string" && n.error !== "" ? n.error : null,
        covered_by: typeof n.covered_by === "string" && n.covered_by !== "" ? n.covered_by : null,
        needs_user: typeof n.needs_user === "string" && n.needs_user.trim() !== "" ? n.needs_user : null,
        handoff: handoffPresent(typeof n.out_dir === "string" && n.out_dir !== "" ? n.out_dir : paths.runOutDir(home, id, String(n.id))),
        attempts: Array.isArray(n.attempts) ? n.attempts.length : 0,
        engine: Boolean(n.origin || n.loop_id),
      })),
    });
  }
  const runByNodeJob = new Map<string, { run: RunFact; node: NodeFact }>();
  for (const run of runs) for (const node of run.nodes) if (node.job_id) runByNodeJob.set(node.job_id, { run, node });

  const jobs: JobFact[] = [];
  let jobDirs: string[] = [];
  try { jobDirs = readdirSync(paths.jobs(home)); } catch { /* no jobs yet */ }
  for (const name of jobDirs.sort()) {
    const dir = join(paths.jobs(home), name);
    const tab = readTrim(join(dir, "herdr_tab"));
    if (!tab) continue; // not in a herdr tab: nothing for this pass to close
    const ref = runByNodeJob.get(name);
    const exitRaw = readTrim(join(dir, "exit_code"));
    jobs.push({
      job: name,
      dir,
      tab,
      pane: readTrim(join(dir, "herdr_pane")) || null,
      running: jobRunning(dir),
      exitCode: exitRaw === "" ? null : Number(exitRaw),
      run: ref?.run ?? null,
      node: ref?.node ?? null,
    });
  }

  const owners = new Map<string, string>();
  for (const tab of new Set(jobs.map((j) => j.tab))) {
    const owner = readTrim(ownerFile(home, tab));
    if (owner) owners.set(tab, owner);
  }
  const notifiedDoc = readJsonSafe<{ keys?: string[] }>(join(herdrDir(home), "cleanup-recovery.json"));
  return {
    herdrUp: livePanes !== null,
    panes: livePanes ?? [],
    owners,
    jobs,
    runs,
    notified: new Set(notifiedDoc?.keys ?? []),
  };
}

/** A failed job's result counts as recorded once its node has a final status and an error or handoff. */
function resultRecorded(node: NodeFact | null): boolean {
  if (node === null) return false;
  if (RESULT_STATUSES.includes(node.status)) return true;
  return node.status === "error" && (node.error !== null || node.handoff);
}

function keepReasons(tab: string, panes: string[], jobs: JobFact[], owners: Map<string, string>, activeRuns: Set<string>, coordPanes: Set<string>): string[] {
  const reasons: string[] = [];
  const owner = owners.get(tab);
  if (owner === undefined || !jobs.some((j) => j.dir === owner)) reasons.push("tab not owned by an orch job");
  for (const p of panes) if (coordPanes.has(p)) reasons.push(`orchestrator pane ${p}`);
  const jobPanes = new Set(jobs.map((j) => j.pane).filter((p): p is string => p !== null));
  if (panes.some((p) => !jobPanes.has(p))) reasons.push("foreign pane in tab");
  for (const j of jobs) {
    if (j.run !== null && activeRuns.has(j.run.id)) reasons.push(`orchestrator active for run ${j.run.id}`);
    if (j.running) reasons.push(`live job ${j.job}`);
    else if (j.exitCode === null && j.node !== null) reasons.push(`job ${j.job} has no exit code and node ${j.node.id} still points at it`);
    if (j.node?.status === "running") reasons.push(`node ${j.node.id} running`);
    if (j.node?.status === "blocked-user" || j.node?.needs_user) reasons.push(`node ${j.node.id} waits for the user`);
    if (j.run !== null && j.run.pendingAsks > 0) reasons.push(`run ${j.run.id} has ${j.run.pendingAsks} pending ask(s)`);
    const failed = j.exitCode !== null && j.exitCode !== 0 && !STOP_CODES.includes(j.exitCode);
    if (failed && !resultRecorded(j.node)) reasons.push(`failed job ${j.job}: result not recorded`);
  }
  return [...new Set(reasons)];
}

function tellFor(run: RunFact, node: NodeFact, liveNodes: Set<string>, notified: Set<string>): TellAction | null {
  if (node.engine || node.needs_user !== null || liveNodes.has(`${run.id}/${node.id}`)) return null;
  if (node.status === "error") {
    const key = `${run.id}/${node.id}/error/${node.attempts}`;
    if (notified.has(key)) return null;
    const why = node.error ?? "no error text";
    return {
      run: run.id,
      node: node.id,
      key,
      text: `Node ${node.id} is in error (${why}) and no job runs for it. Read its log and handoff, then retry or replace it.`,
    };
  }
  if (node.status === "covered") {
    const target = node.covered_by === null ? null : (node.covered_by.split("/").pop() ?? null);
    const targetNode = target === null ? undefined : run.nodes.find((n) => n.id === target);
    if (targetNode !== undefined && targetNode.status !== "error") return null;
    const key = `${run.id}/${node.id}/covered/${target ?? "none"}`;
    if (notified.has(key)) return null;
    const state = targetNode === undefined ? "missing" : targetNode.status;
    return {
      run: run.id,
      node: node.id,
      key,
      text: `Node ${node.id} is covered by ${target ?? "no node"}, which is ${state}. The chain is stale. Continue it: retry or replace ${target ?? "its replacement"}.`,
    };
  }
  return null;
}

/**
 * The pure plan. `limit` caps closes and messages together; closes come first.
 * A stopped, paused or finished run gets no messages, and no tab of a run with an active orchestrator closes.
 */
export function planCleanup(snap: CleanupSnapshot, limit: number = CLEANUP_LIMIT_DEFAULT): CleanupPlan {
  const plan = emptyPlan();
  if (!snap.herdrUp) return plan;
  const panesByTab = new Map<string, string[]>();
  for (const p of snap.panes) panesByTab.set(p.tab_id, [...(panesByTab.get(p.tab_id) ?? []), p.pane_id]);
  const activeRuns = new Set(snap.runs.filter((r) => r.orchestratorActive).map((r) => r.id));
  const coordPanes = new Set(snap.runs.filter((r) => r.orchestratorActive && r.coordinatorPane).map((r) => r.coordinatorPane as string));
  const closes: CloseAction[] = [];
  for (const [tab, panes] of panesByTab) {
    const jobs = snap.jobs.filter((j) => j.tab === tab);
    if (jobs.length === 0) {
      plan.unowned_tabs += 1;
      continue;
    }
    const reasons = keepReasons(tab, panes, jobs, snap.owners, activeRuns, coordPanes);
    if (reasons.length > 0) plan.keep.push({ tab, reasons });
    else closes.push({ tab, jobs: jobs.map((j) => j.job) });
  }
  const liveNodes = new Set(snap.jobs.filter((j) => j.running && j.run !== null && j.node !== null).map((j) => `${j.run!.id}/${j.node!.id}`));
  const tells: TellAction[] = [];
  for (const run of snap.runs) {
    if (run.status !== "running" || run.paused || run.stopped) continue;
    for (const node of run.nodes) {
      const t = tellFor(run, node, liveNodes, snap.notified);
      if (t !== null) tells.push(t);
    }
  }
  const all = [...closes.map((c) => ({ kind: "close" as const, c })), ...tells.map((t) => ({ kind: "tell" as const, t }))];
  const kept = all.slice(0, Math.max(0, limit));
  plan.limited = all.length - kept.length;
  plan.close = kept.filter((x) => x.kind === "close").map((x) => (x as { c: CloseAction }).c);
  plan.tell = kept.filter((x) => x.kind === "tell").map((x) => (x as { t: TellAction }).t);
  return plan;
}

function defaultDispatch(args: string[], home: string): Promise<number> {
  const proc = Bun.spawn([process.execPath, dispatchScript, ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home, ORCH_EVENT_BY: "watchdog", ORCH_NO_ANNOUNCE: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return proc.exited;
}

async function markNotified(home: string, snap: CleanupSnapshot, keys: string[]): Promise<void> {
  const keep = [...snap.notified, ...keys].slice(-NOTIFIED_KEEP);
  await writeJsonAtomic(join(herdrDir(home), "cleanup-recovery.json"), { keys: keep });
}

export interface CleanupOptions {
  apply: boolean;
  limit?: number;
  /** Pane list override (tests). */
  panes?: HerdrPane[];
}

export interface CleanupDeps {
  snapshot?: () => Promise<CleanupSnapshot>;
  closeTab?: (home: string, tab: string) => Promise<boolean>;
  dispatch?: (args: string[], home: string) => Promise<number>;
}

/**
 * Dry-run plans only. Apply re-reads the snapshot, plans again without a limit, and runs only the actions
 * both plans agree on. Each applied close and each sent message is appended to <home>/herdr/cleanup.log.
 */
export async function runCleanup(home: string, opts: CleanupOptions, deps: CleanupDeps = {}): Promise<CleanupReport> {
  const limit = opts.limit ?? CLEANUP_LIMIT_DEFAULT;
  const snap = await (deps.snapshot ?? (() => snapshotCleanup(home, opts.panes)))();
  const plan = planCleanup(snap, limit);
  const report: CleanupReport = { mode: opts.apply ? "apply" : "dry-run", herdr: snap.herdrUp ? "up" : "down", limit, plan, applied: { closed: [], told: [], failed: [] } };
  if (!opts.apply || !snap.herdrUp) return report;

  const fresh = planCleanup(await (deps.snapshot ?? (() => snapshotCleanup(home, opts.panes)))(), Number.MAX_SAFE_INTEGER);
  const closeTab = deps.closeTab ?? (async (h: string, tab: string) => (await herdrCli(h, ["tab", "close", tab])).ok);
  const dispatch = deps.dispatch ?? defaultDispatch;
  const log: string[] = [];
  const at = new Date().toISOString();
  for (const c of plan.close) {
    if (!fresh.close.some((f) => f.tab === c.tab)) continue;
    if (await closeTab(home, c.tab)) {
      report.applied.closed.push(c.tab);
      log.push(JSON.stringify({ at, action: "close", tab: c.tab, jobs: c.jobs }));
    } else {
      report.applied.failed.push(`close ${c.tab}`);
    }
  }
  const sent: string[] = [];
  for (const t of plan.tell) {
    if (!fresh.tell.some((f) => f.key === t.key)) continue;
    const rc = await dispatch(["node", "tell", t.run, "coordinator", t.text, "--from", "watchdog"], home);
    if (rc === 0) {
      sent.push(t.key);
      report.applied.told.push(`${t.run}/${t.node}`);
      log.push(JSON.stringify({ at, action: "tell", run: t.run, node: t.node, key: t.key }));
    } else {
      report.applied.failed.push(`tell ${t.run}/${t.node} rc=${rc}`);
    }
  }
  if (sent.length > 0) await markNotified(home, snap, sent);
  if (log.length > 0) {
    mkdirSync(herdrDir(home), { recursive: true });
    appendFileSync(join(herdrDir(home), "cleanup.log"), `${log.join("\n")}\n`);
  }
  return report;
}

/** Human summary: one line per action or keep. */
export function formatReport(r: CleanupReport): string {
  const p = r.plan;
  const lines = [
    `terminal cleanup (${r.mode}): herdr ${r.herdr}, close ${p.close.length}, tell ${p.tell.length}, keep ${p.keep.length}, unowned tabs ${p.unowned_tabs}, over limit ${p.limited} (limit ${r.limit})`,
  ];
  for (const c of p.close) lines.push(`close ${c.tab} (jobs ${c.jobs.join(", ")})`);
  for (const t of p.tell) lines.push(`tell ${t.run}/${t.node}: ${t.key}`);
  for (const k of p.keep) lines.push(`keep ${k.tab}: ${k.reasons.join("; ")}`);
  if (r.mode === "apply") {
    lines.push(`applied: closed ${r.applied.closed.length}, told ${r.applied.told.length}, failed ${r.applied.failed.length}${r.applied.failed.length ? ` (${r.applied.failed.join(", ")})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `dispatch.ts herdr cleanup [--apply] [--limit N] [--json]`. Dry-run unless --apply. */
export async function herdrCleanupCommand(home: string, args: string[]): Promise<number> {
  let apply = false;
  let json = false;
  let limit = CLEANUP_LIMIT_DEFAULT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") apply = true;
    else if (a === "--json") json = true;
    else if (a === "--limit") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write("herdr cleanup: --limit expects a whole number of 1 or more\n");
        return 2;
      }
      limit = n;
    } else {
      process.stderr.write(`herdr cleanup: unknown argument ${a}\nusage: dispatch.ts herdr cleanup [--apply] [--limit N] [--json]\n`);
      return 2;
    }
  }
  const report = await runCleanup(home, { apply, limit });
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return 0;
}
