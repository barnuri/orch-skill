// Run lifecycle commands: `run start|list|retry|sync`, `__run-cancel`, `prune`. Ported from lib/runs/runs.sh
// (cmd_run_start, cmd_run_list, cmd_run_retry, cmd_run_sync + auto retry, run_cancel, cmd_prune, auto_prune).
import { profileAllowedFor, usageRefusal } from "../../../../src/shared/profile-usage.ts";
import { mkdir, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { epochOf, nowIso } from "../state/clock.ts";
import { loadRun, type RunState } from "../state/store.ts";
import { acquireLock } from "../state/lock.ts";
import { jobStatus, pidAlive, signalTree } from "../state/proc.ts";
import { activityRows, staleMinutes, staleNodes } from "../state/timing.ts";
import { loadProfilesDoc, runCap, settingFrom } from "../state/settings.ts";
import { trashPath } from "../state/trash.ts";
import { ev, findNode, setStatus, doneVerify, nextRetryAt, ID_PATTERN } from "../runs/node.ts";
import { closeJobTab, hcJobTail, jobGoneNote } from "../adapters/herdr.ts";
import { hubNodeSettle } from "../adapters/hub.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import { nodeReady } from "./run.ts";
import { ensureHome } from "./serve.ts";
import { gitToplevel } from "../runs/repo.ts";
import { retryDispatch, profileRequire, nodeLiveJob } from "./dispatch.ts";
import { ownerReportLines, ownersVerifyRun } from "./owners.ts";
import { loopCommands } from "./loops.ts";
import { captured } from "../io.ts";
import { addFeedback, readFeedback } from "../feedback.ts";

const RUN_STATUSES = ["done", "error", "cancelled"];
const RUN_START_USAGE = 'dispatch.ts run start "<title>" [--id <run-id>] [--description "<text>"]';
const RUN_SYNC_USAGE = "dispatch.ts run sync <run-id> [--no-retry]";
const RUN_STOP_USAGE = "dispatch.ts run stop <run-id>";
const RUN_RETRY_USAGE = "dispatch.ts run retry <run-id> [--profile P] [--no-dispatch]";
const PRUNE_USAGE = "dispatch.ts prune [--older-than <N>d|<N>h|<N>] [--dry-run]";
const LOG_TAIL_LINES = 20;
const RETENTION_DEFAULT_DAYS = 7;
const COMMIT_END_EXIT_CODES = new Set(["1", "129"]);

function jobFile(jobDir: string, name: string): string {
  try {
    return readFileSync(join(jobDir, name), "utf8").trim();
  } catch {
    return "";
  }
}

// A handoff the job wrote to <repo>/agent-spec/<slug>/handoff.md instead of $ORCH_NODE_OUT, when that file is newer than the attempt start.
function specHandoffSince(jobDir: string, attemptStartMs: number): string | null {
  const repo = jobFile(jobDir, "repo");
  if (!repo || !Number.isFinite(attemptStartMs)) return null;
  let newest: { file: string; mtime: number } | null = null;
  for (const rel of new Bun.Glob("agent-spec/*/handoff.md").scanSync({ cwd: repo })) {
    const file = join(repo, rel);
    const st = statSync(file);
    if (st.size === 0 || st.mtimeMs < attemptStartMs) continue;
    if (!newest || st.mtimeMs > newest.mtime) newest = { file, mtime: st.mtimeMs };
  }
  return newest?.file ?? null;
}

function recordMissingHandoffFeedback(home: string, runId: string, nodeId: string): void {
  const signature = `missing-handoff:${runId}:${nodeId}`;
  const existing = readFeedback(home).some((item) => item.text.includes(signature) && item.status !== "wontfix");
  if (existing) return;
  addFeedback(home, {
    text: `Automatic orch repair: agent exited successfully without handoff.md (${signature}). Strengthen the shared node rules and prompt wrapper so every node writes handoff.md and records a result before exit.`,
    source: "cli",
    kind: "bug",
    run_id: runId,
    node_id: nodeId,
  }, nowIso());
}

function transcriptHandoff(jobDir: string): string {
  const log = join(jobDir, "log.plain");
  const fallback = join(jobDir, "log");
  let text = "";
  try {
    text = readFileSync(existsSync(log) ? log : fallback, "utf8");
  } catch {
    return "";
  }
  const clean = text.replace(/\r/g, "").trim();
  if (clean.length === 0) return "";
  const lines = clean.split("\n");
  const bounded = lines.slice(-120).join("\n");
  return `# Generated handoff from job output\n\nThe agent exited successfully without writing handoff.md. This handoff was generated from the final job transcript. Review it before accepting the node result.\n\n\x60\x60\x60text\n${bounded}\n\x60\x60\x60\n`;
}

function commitLogHandoff(jobDir: string): string {
  const repo = jobFile(jobDir, "repo");
  const startCommit = jobFile(jobDir, "start_commit");
  if (repo === "" || startCommit === "") return "";
  const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  if (head.exitCode !== 0) return "";
  const headCommit = head.stdout.toString().trim();
  if (headCommit === "" || headCommit === startCommit) return "";
  const log = Bun.spawnSync(["git", "-C", repo, "log", "--format=%h %s", `${startCommit}..${headCommit}`], { stdout: "pipe", stderr: "ignore" });
  if (log.exitCode !== 0) return "";
  const commits = log.stdout.toString().trim();
  return commits === "" ? "" : `# Handoff from commit log\n\nThe job ended but left no handoff. These commits were added during the job:\n\n${commits}\n`;
}

const alt = (v: any, d: any) => (v === null || v === undefined || v === false ? d : v);
const out = (s: string) => void process.stdout.write(s);
const readTrim = (f: string): string => {
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    return "";
  }
};

async function runIds(home: string): Promise<string[]> {
  const names = await readdir(paths.runs(home)).catch(() => [] as string[]);
  return names.filter((n) => existsSync(paths.runState(home, n))).sort();
}

// ---- run start ---------------------------------------------------------------------------------------

export async function runStart(args: string[]): Promise<number> {
  const title = args[0] ?? "";
  if (!title) return (errLine(`usage: ${RUN_START_USAGE}`), 2);
  let runId = "";
  let description = "";
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--id") runId = rest[++i] ?? "";
    else if (rest[i] === "--description") description = rest[++i] ?? "";
    else return (errLine(`run start: unknown argument ${rest[i]}`), 2);
  }
  const home = orchHome();
  if (!(await ensureHome(home))) return 1;
  if (!runId) {
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
    runId = `${stamp}-${Math.floor(Math.random() * 65536).toString(16).padStart(4, "0")}`;
  }
  if (!ID_PATTERN.test(runId)) return (errLine(`run start: id must match ^[A-Za-z0-9][A-Za-z0-9._-]*$`), 2);
  const dir = join(paths.runs(home), runId);
  if (existsSync(dir)) return (errLine(`run start: ${runId} already exists`), 2);
  await mkdir(dir, { recursive: true });
  const session = process.env.CLAUDE_CODE_SESSION_ID || process.env.OPENCODE_SESSION_ID || `pid-${process.ppid}`;
  const repo = gitToplevel(process.cwd());
  await Bun.write(
    join(dir, "state.json"),
    JSON.stringify({ run_id: runId, title, ...(repo ? { repo } : {}), ...(description ? { description } : {}), harness_session: session, ...(process.env.ORCH_MUTED === "1" ? { muted: true } : {}), started: nowIso(), finished: null, status: "running", nodes: [], edges: [] }, null, 2) + "\n",
  );
  await autoPrune(home);
  out(runId + "\n");
  return 0;
}

// ---- run list ----------------------------------------------------------------------------------------

export async function runList(_args: string[]): Promise<number> {
  const home = orchHome();
  const runs: RunState[] = [];
  for (const id of await runIds(home)) {
    const r = await loadRun(home, id);
    if (r) runs.push(r);
  }
  runs.sort((a, b) => String(a.started ?? "").localeCompare(String(b.started ?? "")));
  runs.reverse();
  for (const r of runs) {
    const done = r.nodes.filter((n) => n.status === "done").length;
    out([r.run_id, r.status, r.title, `${done}/${r.nodes.length}`].map((v) => String(v ?? "null")).join("\t") + "\n");
  }
  return 0;
}

// ---- run cancel --------------------------------------------------------------------------------------

export async function runCancel(args: string[]): Promise<number> {
  const runId = args[0] ?? "";
  if (!runId || args.length !== 1) return (errLine(`usage: ${RUN_STOP_USAGE}`), 2);
  const home = orchHome();
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  let stopped = 0;
  for (const n of run.nodes) {
    if (n.status !== "running" || !n.job_id) continue;
    const jobDir = join(paths.jobs(home), String(n.job_id));
    const pid = Number(readTrim(join(jobDir, "pid")));
    if (!pid || !pidAlive(pid)) continue;
    if (signalTree(pid, "SIGTERM").length === 0) continue;
    stopped++;
    await closeJobTab(home, jobDir).catch(() => undefined);
  }
  const rc = await mutateRun(home, runId, (r, ctx) => {
    for (const n of r.nodes) {
      if (n.status === "running") Object.assign(n, { status: "error", error: "cancelled", finished: ctx.now, next_retry_at: null });
      else if (n.status === "waiting") Object.assign(n, { status: "skipped", finished: ctx.now, next_retry_at: null });
    }
    if (r.status !== "covered") r.status = "cancelled";
    r.finished = ctx.now;
    ev(ctx, "run", "", "", "cancelled", "");
  });
  if (rc !== 0) return rc;
  out(`cancelled (stopped ${stopped} job(s))\n`);
  return 0;
}

// ---- run retry ---------------------------------------------------------------------------------------

export async function runRetry(args: string[]): Promise<number> {
  const [runArg = ""] = args;
  if (!runArg) return (errLine(`usage: ${RUN_RETRY_USAGE}`), 2);
  let override = "";
  let noDispatch = false;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--profile") override = rest[++i] ?? "";
    else if (rest[i] === "--no-dispatch") noDispatch = true;
    else return (errLine(`run retry: unknown argument ${rest[i]}\n  usage: ${RUN_RETRY_USAGE}`), 2);
  }
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  if (override && !(await profileRequire(home, override))) return 2;
  let slots = (await runCap(home, run.max_parallel)) - run.nodes.filter((n) => n.status === "running").length;
  const retried: string[] = [];
  const queued: string[] = [];
  for (const id of run.nodes.filter((n) => n.status === "error").map((n) => n.id as string)) {
    if (!noDispatch && slots > 0) {
      // An old process that still runs owns the node: stop it first (node retry --force), never start a second one beside it.
    if (await nodeLiveJob(home, runId, id)) {
      errLine(`auto-retry: ${id} still has a live job; not retried`);
      continue;
    }
    const r = await retryDispatch(home, runId, id, override, false, "manual run retry", "", false);
      if (r.rc !== 0) return r.rc;
      retried.push(id);
      slots--;
    } else {
      // An old process that still runs owns the node: stop it first (node retry --force), never start a second one beside it.
    if (await nodeLiveJob(home, runId, id)) {
      errLine(`auto-retry: ${id} still has a live job; not retried`);
      continue;
    }
    const r = await retryDispatch(home, runId, id, override, true, "manual run retry", "", false);
      if (r.rc !== 0) return r.rc;
      queued.push(id);
    }
  }
  out(`retried: ${retried.join(",")}\nwaiting: ${queued.join(",")}\n`);
  return 0;
}

// ---- run sync ----------------------------------------------------------------------------------------

async function markStarted(home: string, runId: string, nodeId: string, at: string, source: string): Promise<void> {
  const run = await loadRun(home, runId);
  const n = run ? findNode(run, nodeId) : undefined;
  if (!n || !(n.status === "running" && n.seg_open && n.started_at == null)) return;
  await mutateRun(home, runId, (r, ctx) => {
    const x = findNode(r, nodeId);
    if (!x || !(x.status === "running" && x.seg_open && x.started_at == null)) return;
    const when = at || ctx.now;
    x.started_at = x.dispatched_at != null && when < x.dispatched_at ? x.dispatched_at : when;
    ev(ctx, "started", nodeId, "starting", "running", source);
  });
}

function tailLines(file: string): string[] {
  try {
    const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
    return lines.slice(-LOG_TAIL_LINES).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export async function runSync(args: string[]): Promise<number> {
  const home = orchHome();
  let lock = process.env.ORCH_SYNC_LOCK === "1";
  if (args.includes("--lock")) lock = true;
  const runArg = args[0] ?? "";
  const runId = runArg ? await resolveRun(home, runArg) : "";
  if (runId === null) return 1;
  if (runId) {
    const pre = await loadRun(home, runId);
    if (pre?.stopped === true) return (out(`run stopped: ${runId} (dispatch.ts run resume ${runId} --stopped)\n`), 0);
    if (pre?.paused === true) return (out(`run paused: ${runId} (dispatch.ts run resume ${runId})\n`), 0);
  }
  if (lock && runId) {
    const l = await acquireLock(home, `sync-${runId}`, 0, 0);
    if (!l) return (errLine(`run sync: a previous sync of ${runId} is still running, skipped`), 0);
    try {
      return await runSyncBody(home, runId, args.slice(1));
    } finally {
      await l.release();
    }
  }
  return runSyncBody(home, runId, args.slice(1));
}

async function runSyncBody(home: string, runId: string, rest: string[]): Promise<number> {
  if (!runId) return (errLine(`usage: ${RUN_SYNC_USAGE}`), 2);
  let retry = true;
  for (const a of rest) {
    if (a === "--no-retry") retry = false;
    else if (a === "--verify-owners" || a === "--lock") continue;
    else return (errLine(`run sync: unknown argument ${a}`), 2);
  }
  const run0 = await loadRun(home, runId);
  if (!run0) return (errLine(`run ${runId}: unknown run`), 2);

  for (const n of run0.nodes) {
    if (n.status !== "running" || n.job_id == null) continue;
    const node = String(n.id);
    const job = String(n.job_id);
    const jobDir = join(paths.jobs(home), job);
    const st = jobStatus(paths.jobs(home), job) ?? "done exit=unknown";
    const log = join(jobDir, "log");
    let tail = tailLines(log);
    if (tail.length === 0) tail = await hcJobTail(jobDir, LOG_TAIL_LINES);
    let cost: any = null;
    try {
      const c = JSON.parse(readFileSync(join(jobDir, "usage.json"), "utf8"));
      if (c && typeof c === "object" && !Array.isArray(c) && "usd" in c) cost = c;
    } catch {
      /* no cost sidecar */
    }
    if (st !== "running") {
      // A job that ended before any sync saw it running still gets a start time: the log's creation time.
      try {
        const ls = statSync(log);
        if (ls.size > 0) await markStarted(home, runId, node, nowIso(new Date(Math.floor((ls.birthtimeMs || ls.mtimeMs) / 1000) * 1000)), "job-log-birth");
      } catch {
        /* no log */
      }
    }
    if (st === "running") {
      let size = 0;
      try {
        size = statSync(log).size;
      } catch {
        /* no log */
      }
      if (size > 0) await markStarted(home, runId, node, nowIso(new Date(Math.floor(statSync(log).mtimeMs / 1000) * 1000)), "job-log");
    } else if (st === "done exit=0" || COMMIT_END_EXIT_CODES.has(st.replace(/^done exit=/, ""))) {
      const exitCode = st.replace(/^done exit=/, "");
      const commitHandoff = exitCode === "0" ? "" : commitLogHandoff(jobDir);
      const generatedHandoff = exitCode === "0" ? transcriptHandoff(jobDir) : "";
      // A handoff the job wrote itself counts: the stop signal can come after the work is done. Read it before any generated file exists.
      const ownHandoff = commitHandoff === "" && (await Bun.file(join(jobDir, "node")).text().then((v) => {
        const [runOut, nodeOut] = v.trim().split("/");
        const dir = paths.runOutDir(home, runOut ?? runId, nodeOut ?? node);
        const file = join(dir, "handoff.md");
        // A generated handoff from an earlier attempt is evidence, not the job's own report.
        return existsSync(file) && Bun.file(file).size > 0 && !readFileSync(file, "utf8").startsWith("# Generated handoff");
      }).catch(() => false));
      // The job wrote its handoff into the repo's agent-spec/ instead of $ORCH_NODE_OUT: copy it across.
      const specFile = commitHandoff === "" && !ownHandoff ? specHandoffSince(jobDir, Date.parse(String(n.dispatched_at ?? ""))) : null;
      if (specFile) {
        const outDir = await Bun.file(join(jobDir, "node")).text().then((v) => {
          const [runOut, nodeOut] = v.trim().split("/");
          return paths.runOutDir(home, runOut ?? runId, nodeOut ?? node);
        }).catch(() => paths.runOutDir(home, runId, node));
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "handoff.md"), `> Copied by run sync from ${specFile}: the job wrote it to agent-spec/, not $ORCH_NODE_OUT.\n\n${readFileSync(specFile, "utf8")}`);
      }
      if (commitHandoff !== "" || (generatedHandoff !== "" && !ownHandoff && !specFile)) {
        const outDir = await Bun.file(join(jobDir, "node")).text().then((v) => {
          const [runOut, nodeOut] = v.trim().split("/");
          return paths.runOutDir(home, runOut ?? runId, nodeOut ?? node);
        }).catch(() => paths.runOutDir(home, runId, node));
        mkdirSync(outDir, { recursive: true });
        const handoffFile = join(outDir, "handoff.md");
        if (!existsSync(handoffFile) || Bun.file(handoffFile).size === 0) {
          writeFileSync(handoffFile, commitHandoff || generatedHandoff);
          if (commitHandoff === "") recordMissingHandoffFeedback(home, runId, node);
        }
      }
      await mutateRun(home, runId, (r, ctx) => {
        if (commitHandoff === "" && !ownHandoff && !specFile) {
          setStatus(r, node, "error", "", "ended early without handoff", "", "", ctx);
          return;
        }
        if (exitCode === "0" && commitHandoff === "") {
          setStatus(r, node, "done", "", "", "", "", ctx);
          doneVerify(r, node, ctx);
          const x = findNode(r, node);
          if (x?.unverified) {
            x.unverified = true;
          }
          return;
        }
        setStatus(r, node, "done", "", "", "", "", ctx);
        if (commitHandoff !== "") {
          const x = findNode(r, node);
          if (x) x.result = { verdict: "full", summary: "Job added commits during the run.", follow_up: "none", at: ctx.now };
        }
        doneVerify(r, node, ctx);
      });
      await hubNodeSettle(runId, node, "done").catch(() => 0);
    } else if (st.startsWith("done")) {
      const gone = st.startsWith("done exit=unknown") ? jobGoneNote(jobDir) : "";
      await mutateRun(home, runId, (r, ctx) => {
        if (gone) ev(ctx, "note", node, "", "", gone);
        setStatus(r, node, "error", "", st.replace(/^done /, ""), "", "", ctx);
      });
      await hubNodeSettle(runId, node, "error").catch(() => 0);
    }
    await mutateRun(home, runId, (r) => {
      const x = findNode(r, node);
      if (!x) return;
      x.log_tail = tail;
      if (cost) x.cost = cost;
    });
  }
  const ownerLines = ownerReportLines(await ownersVerifyRun(home, runId, true));
  if (retry) {
    const rc = await autoRetryErrors(home, runId);
    if (rc !== 0) return rc;
  }

  const run = (await loadRun(home, runId))!;
  const lines = run.nodes.map((n) => `${n.id}\t${n.status}`);
  lines.push(...ownerLines);
  const now = Math.floor(Date.now() / 1000);
  const stale = staleNodes(await activityRows(home, runId, run), await staleMinutes(home), now).join(",");
  const running = run.nodes.filter((n) => n.status === "running");
  const cap = await runCap(home, run.max_parallel);
  lines.push(
    "ready: " + run.nodes.filter((n) => n.status === "waiting" && nodeReady(run, n)).map((n) => n.id).join(","),
    `running: ${running.length}`,
    `slots: ${Number.isFinite(cap) ? Math.max(0, cap - running.length) : "unlimited"}`,
  );
  if (stale) lines.push("stale: " + stale);
  const stalled = running.filter((n) => n.stalled === true).map((n) => n.id);
  if (stalled.length) lines.push("stalled: " + stalled.join(","));
  const unowned = running.filter((n) => !n.owner && !n.job_id).map((n) => n.id);
  if (unowned.length) lines.push("unowned: " + unowned.join(","));
  for (const n of run.nodes) {
    if (n.report == null) continue;
    const p = n.report;
    lines.push(`reported: ${n.id} ${p.reported_by} model=${alt(p.model, "-")} in=${alt(p.input_tokens, "-")} out=${alt(p.output_tokens, "-")} usd=${alt(p.usd, "-")}`);
  }
  out(lines.join("\n") + "\n");
  return 0;
}

const quotaLike = (n: Record<string, any>): boolean =>
  /exceeded your monthly quota|rate limit|429|quota|usage limit|401|auth/i.test([n.error ?? "", ...(n.log_tail ?? [])].join("\n"));

async function autoRetryErrors(home: string, runId: string): Promise<number> {
  const run = await loadRun(home, runId);
  if (!run || run.status === "cancelled" || run.status === "covered") return 0;
  const doc = await loadProfilesDoc(home);
  const maxRaw = settingFrom(doc, "max_attempts", "5");
  if (!(maxRaw === "-1" || (/^[0-9]+$/.test(maxRaw) && Number(maxRaw) >= 1))) {
    errLine("settings.max_attempts must be -1 or an integer >= 1");
    return 2;
  }
  const max = Number(maxRaw);
  if (!(max === -1 || max > 1)) return 0;
  let slots = (await runCap(home, run.max_parallel)) - run.nodes.filter((n) => n.status === "running").length;
  const unscheduled = run.nodes.filter((n) => n.status === "error" && (n.prompt ?? "") !== "" && (n.next_retry_at ?? "") === "").map((n) => String(n.id));
  if (unscheduled.length) {
    await mutateRun(home, runId, (r, ctx) => {
      for (const id of unscheduled) {
        const x = findNode(r, id);
        if (x) x.next_retry_at = nextRetryAt(x, ctx.now);
      }
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const fresh = (await loadRun(home, runId))!;
  const due = fresh.nodes
    .filter((n) => {
      if (n.status !== "error" || (n.prompt ?? "") === "") return false;
      const t = epochOf(String(n.next_retry_at ?? ""));
      if (t === null || t > now) return false;
      return max === -1 || (n.attempts ?? []).length + 1 < max;
    })
    .map((n) => String(n.id));
  const retried: string[] = [];
  for (const id of due) {
    if (slots <= 0) break;
    const cur = (await loadRun(home, runId))!;
    const n = findNode(cur, id)!;
    const profile = String(n.profile ?? "");
    let override = "";
    if (profile && quotaLike(n)) {
      const fb = String(doc.profiles?.[profile]?.fallback ?? "");
      const p = fb ? doc.profiles?.[fb] : null;
      const disabled = (doc.settings?.disabled_harnesses ?? []) as string[];
      if (fb && p && p.enabled !== false && !disabled.includes(p.harness) && profileAllowedFor(doc, fb, "runs")) {
        override = fb;
      }
    }
    let reason = "auto retry";
    if (override && override !== profile) reason = `auto retry: quota/rate/auth matched; fallback profile ${override}`;
    else if (quotaLike(n)) reason = "auto retry: quota/rate/auth matched; no usable fallback";
    // An old process that still runs owns the node: stop it first (node retry --force), never start a second one beside it.
    if (await nodeLiveJob(home, runId, id)) {
      errLine(`auto-retry: ${id} still has a live job; not retried`);
      continue;
    }
    const r = await retryDispatch(home, runId, id, override, false, reason, "", false);
    if (r.rc !== 0) return r.rc;
    retried.push(id);
    slots--;
  }
  if (retried.length) errLine(`auto-retried: ${retried.join(",")}`);
  return 0;
}

// ---- prune -------------------------------------------------------------------------------------------

function parseAge(spec: string): number | null {
  let num = spec;
  let unit = 86400;
  if (spec.endsWith("d")) num = spec.slice(0, -1);
  else if (spec.endsWith("h")) {
    num = spec.slice(0, -1);
    unit = 3600;
  }
  return /^[0-9]+$/.test(num) ? Number(num) * unit : null;
}

async function prunePath(home: string, path: string, dry: boolean, write: (s: string) => void): Promise<void> {
  const p = path.replace(/\/+$/, "");
  if (!existsSync(p)) return;
  if (dry) return write(`would prune: ${p}\n`);
  if (await trashPath(home, p)) write(`pruned: ${p}\n`);
}

export async function prune(args: string[], write: (s: string) => void = out, quiet = false): Promise<number> {
  let spec = "";
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--older-than") spec = args[++i] ?? "";
    else if (args[i] === "--dry-run") dry = true;
    else return (errLine(`prune: unknown argument ${args[i]}`), 2);
  }
  const home = orchHome();
  if (!(await ensureHome(home))) return 1;
  const doc = await loadProfilesDoc(home);
  if (!spec) spec = `${settingFrom(doc, "retention_days", String(RETENTION_DEFAULT_DAYS))}d`;
  const maxAge = parseAge(spec);
  if (maxAge === null) return (errLine(`prune: --older-than expects <N>d, <N>h or <N>\n  usage: ${PRUNE_USAGE}`), 2);
  const cutoff = Math.floor(Date.now() / 1000) - maxAge;
  const kept = new Set<string>();
  let pruned = 0;
  for (const id of await runIds(home)) {
    const r = await loadRun(home, id);
    if (!r) continue;
    const jobs = r.nodes.map((n) => n.job_id).filter((j) => j).map(String);
    const fin = r.finished ? epochOf(String(r.finished)) : null;
    if (RUN_STATUSES.includes(r.status) && fin !== null && fin < cutoff) {
      for (const j of jobs) await prunePath(home, join(paths.jobs(home), j), dry, write);
      await prunePath(home, join(paths.runs(home), String(r.run_id)), dry, write);
      pruned++;
      continue;
    }
    for (const j of jobs) kept.add(j);
  }
  for (const j of (await readdir(paths.jobs(home)).catch(() => [] as string[])).sort()) {
    const ec = join(paths.jobs(home), j, "exit_code");
    const st = await stat(ec).catch(() => null);
    if (!st || kept.has(j)) continue;
    if (!(Math.floor(st.mtimeMs / 1000) < cutoff)) continue;
    await prunePath(home, join(paths.jobs(home), j), dry, write);
  }
  const lp = () => loopCommands["loop prune"]([String(cutoff), dry ? "1" : "0"]);
  if (quiet) await captured({}, lp);
  else await lp();
  write(`${dry ? "would prune" : "pruned"} ${pruned} run(s) older than ${spec}\n`);
  return 0;
}

async function autoPrune(home: string): Promise<void> {
  const days = settingFrom(await loadProfilesDoc(home), "retention_days", String(RETENTION_DEFAULT_DAYS));
  if (!/^[0-9]+$/.test(days) || Number(days) <= 0) return;
  await prune(["--older-than", `${days}d`], () => undefined, true).catch(() => 0);
}
