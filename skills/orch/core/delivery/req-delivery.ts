// Requirement delivery. When a requirement passes independent verification, its implementers' uncommitted files and the
// tests from its evidence are queued in <home>/delivery/req-queue.json. `delivery run` then delivers each entry:
//   local-commit (private repo without a PR rule): re-run the tests and the typecheck, `git commit -- <files>`, run scripts/deploy.ts.
//   pr (public repo or a repo whose instructions talk about PRs): commit the files on a branch in a temp worktree, push it, open a
//   PR with ghx. Never merges.
// An entry is blocked, and nothing is committed, when: it has no tests, a test fails, a file has conflict markers, a file changed
// after the verifier passed, or a running node changed the same file. The result goes back to the ledger with `req evidence`.
// Never `git add -A`, never stash, never checkout or reset the working tree.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { loadLedger, type Req } from "../commands/req.ts";
import { changedSinceStart, dirtyPaths, withDirtyCache, hasConflictMarkers, mtimeMs, namedInHandoff, readStatusSnapshot } from "./attribution.ts";
import { spawnRunner, type Runner } from "./deliver.ts";
import { deliveryMode } from "./queue.ts";

export type ReqPolicy = "local-commit" | "pr";
export type ReqEntryState = "queued" | "blocked" | "committed" | "pr" | "failed" | "empty";

export interface ReqEntry {
  key: string;
  run: string;
  req: string;
  text: string;
  repo: string;
  policy: ReqPolicy;
  nodes: string[];
  files: string[];
  tests: string[];
  verified_at: string;
  state: ReqEntryState;
  reason: string | null;
  sha: string | null;
  pr_url: string | null;
  enqueued_at: string;
  updated: string;
}

export interface ReqQueue { version: 1; entries: Record<string, ReqEntry> }

export const reqQueuePath = (home: string): string => join(home, "delivery", "req-queue.json");

export function loadReqQueue(home: string): ReqQueue {
  const f = reqQueuePath(home);
  if (!existsSync(f)) return { version: 1, entries: {} };
  try {
    return JSON.parse(readFileSync(f, "utf8")) as ReqQueue;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveReqQueue(home: string, q: ReqQueue): void {
  const f = reqQueuePath(home);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  renameSync(tmp, f);
}

function instructionsOf(repo: string): string {
  return ["CLAUDE.md", "AGENTS.md"].map((f) => join(repo, f)).filter(existsSync).map((p) => readFileSync(p, "utf8")).join("\n");
}

/** local-commit for a private repo whose instructions never mention PRs; pr otherwise. */
export function reqPolicy(repo: string, instructions = instructionsOf(repo)): ReqPolicy {
  if (deliveryMode(repo, instructions) === "pr") return "pr";
  return /\bPRs?\b|pull request/.test(instructions) ? "pr" : "local-commit";
}

const jobFile = (home: string, job: string, f: string): string => {
  const p = join(paths.jobs(home), job, f);
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
};

/** The uncommitted files one node changed in its repo: snapshot diff, else files touched after it started that its handoff names. */
export function nodeFiles(home: string, runId: string, n: Record<string, any>): { repo: string; files: string[] } | null {
  const job = String(n.job_id ?? "");
  if (!job) return null;
  const repo = jobFile(home, job, "repo");
  if (!repo || !existsSync(repo)) return null;
  const snap = readStatusSnapshot(join(paths.jobs(home), job));
  const started = n.started_at ?? n.started ?? null;
  let files = changedSinceStart(repo, snap, started);
  if (!snap) {
    const hf = join(paths.runOutDir(home, runId, String(n.id)), "handoff.md");
    files = existsSync(hf) ? namedInHandoff(readFileSync(hf, "utf8"), files) : [];
  }
  return { repo, files };
}

/** Builds the delivery entries for a verified requirement: one per repo its implementers worked in. */
export async function buildReqEntries(home: string, runId: string, r: Req, now: string): Promise<ReqEntry[]> {
  return withDirtyCache(() => buildEntries(home, runId, r, now));
}

async function buildEntries(home: string, runId: string, r: Req, now: string): Promise<ReqEntry[]> {
  const run = await loadRun(home, runId);
  if (!run) return [];
  const ids = [...new Set([...(r.implemented_by ?? []), ...r.nodes])].filter((id) => id !== r.verifier);
  const tests = [...new Set(r.evidence.map((e) => e.test ?? "").filter(Boolean))];
  const byRepo = new Map<string, { nodes: string[]; files: Set<string> }>();
  for (const id of ids) {
    const n = (run.nodes as any[]).find((x) => x.id === id);
    if (!n) continue;
    const got = nodeFiles(home, runId, n);
    if (!got) continue;
    got.files = await dropContested(home, runId, n, got.repo, got.files);
    const slot = byRepo.get(got.repo) ?? { nodes: [], files: new Set<string>() };
    slot.nodes.push(id);
    for (const f of got.files) slot.files.add(f);
    byRepo.set(got.repo, slot);
  }
  return [...byRepo].map(([repo, s]) => ({
    key: `${runId}/${r.id}/${repo.split("/").pop()}`,
    run: runId,
    req: r.id,
    text: r.text,
    repo,
    policy: reqPolicy(repo),
    nodes: s.nodes,
    files: [...s.files].sort(),
    tests,
    verified_at: now,
    state: "queued",
    reason: null,
    sha: null,
    pr_url: null,
    enqueued_at: now,
    updated: now,
  }));
}

/**
 * A snapshot cannot tell this node's edit from one a node started later made. A file that such a later node also changed
 * stays only when this node's handoff names it; then both own it and delivery blocks while the other one runs.
 */
async function dropContested(home: string, runId: string, n: Record<string, any>, repo: string, files: string[]): Promise<string[]> {
  const mine = Date.parse(n.started_at ?? n.started ?? "") || 0;
  const { readdirSync } = await import("node:fs");
  const contested = new Set<string>();
  for (const rid of existsSync(paths.runs(home)) ? readdirSync(paths.runs(home)) : []) {
    const run = await loadRun(home, rid).catch(() => null);
    if (!run) continue;
    for (const o of run.nodes as any[]) {
      if ((rid === runId && o.id === n.id) || (Date.parse(o.started_at ?? o.started ?? "") || 0) < mine) continue;
      if (rid !== runId && o.status !== "running") continue;
      const got = nodeFiles(home, rid, o);
      if (got?.repo === repo) for (const f of got.files) contested.add(f);
    }
  }
  if (contested.size === 0) return files;
  const hf = join(paths.runOutDir(home, runId, String(n.id)), "handoff.md");
  const named = new Set(existsSync(hf) ? namedInHandoff(readFileSync(hf, "utf8"), files) : []);
  return files.filter((f) => !contested.has(f) || named.has(f));
}

export const NO_TESTS_REASON = 'no test commands in the requirement evidence: the verifier records them with `req verdict <run> <req> pass --node <v> --test "<cmd>"` (or `req evidence <run> <req> --note T --test "<cmd>"`)';

export interface EnqueueReport { added: string[]; existing: string[]; refused: { key: string; reason: string }[] }

/**
 * Queues a verified requirement. Idempotent per key: an entry already queued keeps its state. An entry that could never be
 * delivered is refused, not queued: no test commands in the evidence, or no implementer files to commit.
 */
export async function enqueueVerifiedReqReport(home: string, runId: string, reqId: string, now = new Date().toISOString()): Promise<EnqueueReport> {
  const rep: EnqueueReport = { added: [], existing: [], refused: [] };
  const r = (await loadLedger(home, runId)).requirements.find((x) => x.id === reqId);
  if (!r) return (rep.refused.push({ key: `${runId}/${reqId}`, reason: "not in the ledger" }), rep);
  const q = loadReqQueue(home);
  const entries = await buildReqEntries(home, runId, r, now);
  if (entries.length === 0) rep.refused.push({ key: `${runId}/${reqId}`, reason: "no implementer repo found (no node with a job repo)" });
  for (const e of entries) {
    const old = q.entries[e.key];
    // A dropped entry (`delivery drop`) may be queued again; any other existing entry keeps its state.
    if (old && !(old.state === "failed" && old.reason?.startsWith("dropped:"))) { rep.existing.push(e.key); continue; }
    if (e.tests.length === 0) { rep.refused.push({ key: e.key, reason: NO_TESTS_REASON }); continue; }
    if (e.files.length === 0) { rep.refused.push({ key: e.key, reason: "no uncommitted implementer files to deliver" }); continue; }
    q.entries[e.key] = e;
    rep.added.push(e.key);
  }
  if (rep.added.length) saveReqQueue(home, q);
  return rep;
}

/** Same as enqueueVerifiedReqReport; returns only the keys added. */
export async function enqueueVerifiedReq(home: string, runId: string, reqId: string, now = new Date().toISOString()): Promise<string[]> {
  return (await enqueueVerifiedReqReport(home, runId, reqId, now)).added;
}

/**
 * Queues named files and tests for a requirement that is not verified yet (in_progress or implemented), for a change
 * that no node snapshot attributes. verified_at is now: a file edited after this blocks the delivery. A key already
 * committed or opened as a PR is not replaced. Returns the key, or an error text.
 */
export async function enqueueNamedReq(
  home: string, runId: string, r: Req, repo: string, files: string[], tests: string[], nodes: string[], now = new Date().toISOString(),
): Promise<{ key: string } | { error: string }> {
  if (files.length === 0) return { error: "--files needs at least one path" };
  if (tests.length === 0) return { error: "--test needs at least one command" };
  const missing = files.filter((f) => !existsSync(join(repo, f)) && !dirtyPaths(repo).includes(f));
  if (missing.length) return { error: `not in ${repo}: ${missing.join(", ")}` };
  const key = `${runId}/${r.id}/${repo.split("/").pop()}`;
  const q = loadReqQueue(home);
  const old = q.entries[key];
  if (old && (old.state === "committed" || old.state === "pr")) return { error: `${key} is already ${old.state} (${old.sha ?? old.pr_url})` };
  q.entries[key] = {
    key, run: runId, req: r.id, text: r.text, repo, policy: reqPolicy(repo), nodes, files: [...new Set(files)].sort(), tests,
    verified_at: now, state: "queued", reason: null, sha: null, pr_url: null, enqueued_at: old?.enqueued_at ?? now, updated: now,
  };
  saveReqQueue(home, q);
  return { key };
}

/** Files other running nodes changed (any run), per repo. */
export async function runningTouched(home: string, repo: string, except: Set<string>): Promise<Map<string, string>> {
  return withDirtyCache(() => scanRunning(home, repo, except));
}

async function scanRunning(home: string, repo: string, except: Set<string>): Promise<Map<string, string>> {
  const owner = new Map<string, string>();
  const { readdirSync } = await import("node:fs");
  const runsDir = paths.runs(home);
  if (!existsSync(runsDir)) return owner;
  for (const runId of readdirSync(runsDir)) {
    const run = await loadRun(home, runId).catch(() => null);
    if (!run || run.status === "done" || run.status === "stopped") continue;
    for (const n of run.nodes as any[]) {
      if (n.status !== "running" || except.has(`${runId}/${n.id}`)) continue;
      const got = nodeFiles(home, runId, n);
      if (!got || got.repo !== repo) continue;
      for (const f of got.files) if (!owner.has(f)) owner.set(f, `${runId}/${n.id}`);
    }
  }
  return owner;
}

export interface DeliverReqOpts {
  home: string;
  runner?: Runner;
  dryRun?: boolean;
  /** Files owned by running nodes; computed from run state when absent. */
  running?: Map<string, string>;
  /** Records the outcome on the ledger; defaults to `req evidence`. */
  record?: (e: ReqEntry, note: string) => Promise<void>;
}

export interface ReqOutcome { key: string; state: ReqEntryState; reason: string | null; sha: string | null; pr_url: string | null; files: string[]; tests: string[]; plan: string[] }

const sh = (cmd: string): string[] => ["/bin/sh", "-c", cmd];

/** Checks that block an entry before any test runs. "" when the entry may go ahead. */
export function blockReason(e: ReqEntry, files: string[], running: Map<string, string>): string {
  if (e.tests.length === 0) return "no tests in the requirement evidence";
  const marked = files.filter((f) => hasConflictMarkers(join(e.repo, f)));
  if (marked.length) return `conflict markers in ${marked.join(", ")}`;
  const verified = Date.parse(e.verified_at);
  const late = files.filter((f) => mtimeMs(join(e.repo, f)) > verified);
  if (late.length) return `changed after the verifier passed: ${late.join(", ")}`;
  const owned = files.filter((f) => running.has(f));
  if (owned.length) return `still being edited by running node(s): ${owned.map((f) => `${f} (${running.get(f)})`).join(", ")}`;
  return "";
}

export function commitMessage(e: ReqEntry): string {
  return `orch: deliver ${e.req} (${e.text.slice(0, 60)})\n\nVerified requirement ${e.req} of run ${e.run}.\nTests: ${e.tests.join("; ")}\nFiles: ${e.files.length}`;
}

/** Delivers one entry. Returns the outcome; mutates nothing outside the repo except through `record`. */
export async function deliverReqEntry(e: ReqEntry, o: DeliverReqOpts): Promise<ReqOutcome> {
  const run = o.runner ?? spawnRunner;
  const dirty = new Set(dirtyPaths(e.repo));
  const files = e.files.filter((f) => dirty.has(f));
  const plan: string[] = [];
  const out = (state: ReqEntryState, reason: string | null, extra: Partial<ReqOutcome> = {}): ReqOutcome => ({ key: e.key, state, reason, sha: null, pr_url: null, files, tests: e.tests, plan, ...extra });
  if (files.length === 0) return out("empty", "no uncommitted files left to deliver");
  const running = o.running ?? (await runningTouched(o.home, e.repo, new Set(e.nodes.map((n) => `${e.run}/${n}`))));
  const why = blockReason(e, files, running);
  if (why) return out("blocked", why);
  const typecheck = existsSync(join(e.repo, "scripts", "typecheck.ts")) ? "bun scripts/typecheck.ts" : "";
  const checks = [...e.tests, ...(typecheck ? [typecheck] : [])];
  for (const t of checks) plan.push(`test: ${t}`);
  if (e.policy === "local-commit") {
    plan.push(`git add -- ${files.join(" ")}`, `git commit -m "<${e.req} message>" -- ${files.join(" ")}`);
    if (existsSync(join(e.repo, "scripts", "deploy.ts"))) plan.push("bun scripts/deploy.ts");
  } else {
    plan.push(`git worktree add -b orch/deliver-${e.req.toLowerCase()} <tmp> HEAD`, `copy ${files.length} files, commit, git push -u origin <branch>`, "ghx pr create");
  }
  if (o.dryRun) return out("queued", "dry run");
  for (const t of checks) {
    const r = await run(e.repo, sh(t));
    if (r.code !== 0) return out("blocked", `test failed: ${t}: ${(r.err || r.out).split("\n").slice(-3).join(" ").slice(0, 300)}`);
  }
  // Re-check after the tests: a file may have changed while they ran.
  const again = blockReason(e, files, o.running ?? (await runningTouched(o.home, e.repo, new Set(e.nodes.map((n) => `${e.run}/${n}`)))));
  if (again) return out("blocked", again);
  const msg = commitMessage({ ...e, files });
  if (e.policy === "local-commit") {
    const add = await run(e.repo, ["git", "add", "--", ...files]);
    if (add.code !== 0) return out("failed", `git add: ${add.err}`);
    const c = await run(e.repo, ["git", "commit", "-m", msg, "--", ...files]);
    if (c.code !== 0) return out("failed", `git commit: ${c.err || c.out}`);
    const sha = (await run(e.repo, ["git", "rev-parse", "HEAD"])).out.trim();
    let reason: string | null = null;
    if (existsSync(join(e.repo, "scripts", "deploy.ts"))) {
      const d = await run(e.repo, ["bun", "scripts/deploy.ts"]);
      reason = d.code === 0 ? "deployed" : `deploy failed (exit ${d.code})`;
    }
    return out("committed", reason, { sha });
  }
  const branch = `orch/deliver-${e.req.toLowerCase()}-${Date.now().toString(36)}`;
  const wt = join(await mkdtemp(join(tmpdir(), "orch-deliver-")), "wt");
  const w = await run(e.repo, ["git", "worktree", "add", "-b", branch, wt, "HEAD"]);
  if (w.code !== 0) return out("failed", `git worktree add: ${w.err}`);
  try {
    for (const f of files) {
      const src = join(e.repo, f);
      if (existsSync(src)) {
        await mkdir(dirname(join(wt, f)), { recursive: true });
        await cp(src, join(wt, f));
      } else await run(wt, ["git", "rm", "-q", "--", f]);
    }
    const add = await run(wt, ["git", "add", "--", ...files.filter((f) => existsSync(join(e.repo, f)))]);
    if (add.code !== 0) return out("failed", `git add: ${add.err}`);
    const c = await run(wt, ["git", "commit", "-m", msg]);
    if (c.code !== 0) return out("failed", `git commit: ${c.err || c.out}`);
    const sha = (await run(wt, ["git", "rev-parse", "HEAD"])).out.trim();
    const p = await run(wt, ["git", "push", "-u", "origin", branch]);
    if (p.code !== 0) return out("failed", `git push: ${p.err}`, { sha });
    const pr = await run(wt, ["ghx", "pr", "create", "--head", branch, "--title", `${e.req}: ${e.text.slice(0, 60)}`, "--body", msg]);
    if (pr.code !== 0) return out("failed", `ghx pr create: ${pr.err}`, { sha });
    return out("pr", null, { sha, pr_url: pr.out.trim().split("\n").pop() ?? "" });
  } finally {
    await run(e.repo, ["git", "worktree", "remove", "--force", wt]);
  }
}

async function recordEvidence(e: ReqEntry, note: string): Promise<void> {
  const { reqEvidence } = await import("../commands/req.ts");
  await reqEvidence([e.run, e.req, "--note", note]);
}

/** Delivers every queued or blocked entry (optionally of one run, or one key). Saves the new states unless it is a dry run. */
export async function deliverReqQueue(o: DeliverReqOpts & { run?: string; key?: string }): Promise<ReqOutcome[]> {
  const q = loadReqQueue(o.home);
  const results: ReqOutcome[] = [];
  for (const e of Object.values(q.entries).sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at))) {
    if (o.run && e.run !== o.run) continue;
    if (o.key && e.key !== o.key) continue;
    if (e.state !== "queued" && e.state !== "blocked") continue;
    const r = await deliverReqEntry(e, o);
    results.push(r);
    if (o.dryRun) continue;
    const now = new Date().toISOString();
    const prev = e.state + (e.reason ?? "");
    Object.assign(e, { state: r.state, reason: r.reason, sha: r.sha, pr_url: r.pr_url, updated: now });
    saveReqQueue(o.home, q);
    const note = r.state === "committed" ? `delivered ${r.sha} (${r.files.length} files, tests: ${r.tests.join("; ")})${r.reason ? `, ${r.reason}` : ""}`
      : r.state === "pr" ? `delivered as PR ${r.pr_url} (commit ${r.sha})`
      : `delivery ${r.state}: ${r.reason}`;
    if (prev !== r.state + (r.reason ?? "")) await (o.record ?? recordEvidence)(e, note);
  }
  return results;
}
