#!/usr/bin/env bun
// Deploy a committed ref to the always-on service, from a deploy checkout that never holds edits.
//
//   deploy.ts [--ref REF] [--dry-run]   REF defaults to origin/master (master when there is no origin)
//
// Gate: for an origin/* ref the GitHub checks of the commit decide: all green deploys, any running waits (exit 0,
// nothing recorded), any failed refuses. For a local ref (no origin) the local typecheck and fast tier decide.
// ORCH_DEPLOY_LOCAL_CHECKS=1 runs the local checks too. ORCH_DEPLOY_CHECKS_CMD (sh -c "<cmd> <sha>", prints
// success|pending|failure) replaces the GitHub query in tests.
// Steps: update <home>/deploy/orch-skill (git worktree, detached) to REF, link or install node_modules,
// run the gate, point the service at the checkout and restart it, wait until
// /api/build reports the sha. Any failure keeps (or restores) the previous sha and exits 1 with the reason.
// Records <home>/deploy/current.json and history.jsonl. A lock stops two deploys at once.
//
// Env seams (tests): ORCH_DEPLOY_REPO, ORCH_DEPLOY_TYPECHECK_CMD, ORCH_DEPLOY_TEST_CMD (sh -c, run in the checkout),
// ORCH_SERVICE_SH (service script), ORCH_DEPLOY_HEALTH_URL, ORCH_DEPLOY_HEALTH_TIMEOUT_MS.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deployCheckout, deployDir, readCurrent } from "../src/server/build/deploy-status.ts";
import type { DeployCurrent } from "../src/server/build/deploy-status.ts";
import { REPO_DIR, run, sleep } from "./lib/util.ts";

const HOME = process.env["HARNESS_ORCH_HOME"] || join(homedir(), ".harness-orch");
const REPO = process.env["ORCH_DEPLOY_REPO"] || REPO_DIR;
const DIR = deployDir(HOME);
const CHECKOUT = deployCheckout(HOME);
const LOCK = join(DIR, "lock.d");
const BUN = process.execPath;

// A git hook runs with GIT_DIR, GIT_INDEX_FILE and friends set to the committing checkout; git in the deploy checkout must not inherit them.
for (const k of Object.keys(process.env)) if (/^GIT_(DIR|INDEX_FILE|WORK_TREE|PREFIX|OBJECT_DIRECTORY|COMMON_DIR|REFLOG_ACTION)$/.test(k)) delete process.env[k];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const refIdx = args.indexOf("--ref");
const hasOrigin = (): boolean => run(["git", "remote", "get-url", "origin"], { cwd: REPO }).code === 0;
const ref = refIdx >= 0 ? (args[refIdx + 1] ?? "master") : hasOrigin() ? "origin/master" : "master";
const remoteRef = ref.startsWith("origin/");

const log = (s: string): void => void process.stdout.write(`deploy: ${s}\n`);
const git = (cwd: string, ...a: string[]) => run(["git", ...a], { cwd });
let attempted: string | null = null;
const history = (e: Record<string, unknown>): void => appendFileSync(join(DIR, "history.jsonl"), JSON.stringify({ at: new Date().toISOString(), ref, ...e }) + "\n");

function fail(reason: string, tests = "not run"): never {
  mkdirSync(DIR, { recursive: true });
  history({ ok: false, reason, tests, sha: attempted, kept: readCurrent(HOME)?.sha ?? null });
  process.stderr.write(`deploy failed: ${reason}\n`);
  unlock();
  process.exit(1);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function lock(): void {
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "pid"), String(process.pid));
      return;
    } catch {
      const pid = Number(readFileSync(join(LOCK, "pid"), "utf8").trim() || 0);
      if (pid > 0 && alive(pid)) {
        process.stderr.write(`deploy failed: another deploy is running (pid ${pid})\n`);
        process.exit(1);
      }
      try {
        unlinkSync(join(LOCK, "pid"));
        rmdirSync(LOCK);
      } catch {}
    }
  }
  process.stderr.write("deploy failed: cannot take the lock\n");
  process.exit(1);
}

function unlock(): void {
  try {
    unlinkSync(join(LOCK, "pid"));
    rmdirSync(LOCK);
  } catch {}
}

function sh(cmd: string, cwd: string): { code: number; out: string } {
  const r = run(["sh", "-c", cmd], { cwd });
  return { code: r.code, out: r.out };
}

function ensureModules(): void {
  if (!existsSync(join(CHECKOUT, "package.json"))) return;
  const nm = join(CHECKOUT, "node_modules");
  const lock = (d: string): string => (existsSync(join(d, "bun.lock")) ? readFileSync(join(d, "bun.lock"), "utf8") : "");
  if (existsSync(nm) && !lstatSync(nm).isSymbolicLink()) {
    if (lock(CHECKOUT) === "") return;
  }
  if (lock(CHECKOUT) === lock(REPO) && existsSync(join(REPO, "node_modules"))) {
    if (!existsSync(nm)) symlinkSync(join(REPO, "node_modules"), nm);
    return;
  }
  if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) unlinkSync(nm);
  const r = run([BUN, "install", "--frozen-lockfile"], { cwd: CHECKOUT });
  if (r.code !== 0) fail(`bun install failed: ${r.out.trim().split("\n").slice(-1)[0] ?? ""}`);
}

async function healthy(sha: string): Promise<boolean> {
  const url = process.env["ORCH_DEPLOY_HEALTH_URL"] || `http://127.0.0.1:${readPort()}/api/build`;
  const deadline = Date.now() + Number(process.env["ORCH_DEPLOY_HEALTH_TIMEOUT_MS"] || 90_000);
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const b = (await r.json()) as { head?: string | null };
        if (b.head === sha) return true;
      }
    } catch {}
    await sleep(1000);
  }
  return false;
}

function readPort(): string {
  try {
    return String((JSON.parse(readFileSync(join(HOME, "serve.json"), "utf8")) as { port?: number }).port ?? 6724);
  } catch {
    return "6724";
  }
}

function restart(): { code: number; out: string } {
  const svc = process.env["ORCH_SERVICE_SH"] || join(REPO, "scripts/service.ts");
  return run([BUN, svc, "restart", "--root", CHECKOUT], { env: { HARNESS_ORCH_HOME: HOME } });
}

if (remoteRef && !process.env["ORCH_DEPLOY_NO_FETCH"]) git(REPO, "fetch", "-q", "origin");
const sha = git(REPO, "rev-parse", "--verify", `${ref}^{commit}`);
if (sha.code !== 0) {
  process.stderr.write(`deploy failed: cannot resolve ref ${ref}\n`);
  process.exit(1);
}
const target = sha.out.trim();
attempted = target;
const prev = readCurrent(HOME);

if (dryRun) {
  log(`ref ${ref} -> ${target}`);
  log(`current: ${prev ? `${prev.sha} (${prev.deployed_at})` : "none"}`);
  log(`checkout: ${CHECKOUT} (${existsSync(CHECKOUT) ? "exists" : "git worktree add --detach"}), then git checkout --detach ${target.slice(0, 7)}`);
  log("node_modules: link the repo's when bun.lock is identical, else bun install --frozen-lockfile");
  log(`gate: ${remoteRef || process.env["ORCH_DEPLOY_CHECKS_CMD"] ? "GitHub checks of the commit (pending waits, failure refuses)" : "local checks"}`);
  log(`local checks in the checkout: ${process.env["ORCH_DEPLOY_TYPECHECK_CMD"] || "bun scripts/typecheck.ts"}; ${process.env["ORCH_DEPLOY_TEST_CMD"] || "bun skills/orch/tests/run.ts"}`);
  log(`service: service.ts restart --root ${CHECKOUT}; wait for /api/build head = ${target.slice(0, 7)}`);
  log(`on failure: keep ${prev ? prev.sha.slice(0, 7) : "nothing (no previous deploy)"}, roll the service back, exit 1`);
  log(`record: ${join(DIR, "current.json")}, ${join(DIR, "history.jsonl")}; lock ${LOCK}`);
  process.exit(0);
}

lock();
if (prev?.sha === target && (await healthy(target))) {
  log(`already deployed ${target.slice(0, 7)}`);
  unlock();
  process.exit(0);
}

// 1. gate, before the checkout moves: GitHub checks for a pushed ref. Pending waits and records nothing.
const gate = remoteRef || process.env["ORCH_DEPLOY_CHECKS_CMD"] ? githubChecks(target) : { state: "none", detail: "" };
if (gate.state === "pending") {
  log(`waiting for GitHub checks on ${target.slice(0, 7)}: ${gate.detail}`);
  unlock();
  process.exit(0);
}
if (gate.state === "failure") fail(`GitHub checks failed: ${gate.detail}`, "failed");

// 2. checkout
if (!existsSync(join(CHECKOUT, ".git"))) {
  git(REPO, "worktree", "prune");
  const w = git(REPO, "worktree", "add", "--detach", CHECKOUT, target);
  if (w.code !== 0) fail(`worktree add failed: ${w.out.trim().slice(-200)}`);
} else {
  git(CHECKOUT, "reset", "--hard", "-q");
  const c = git(CHECKOUT, "checkout", "--detach", "-f", "-q", target);
  if (c.code !== 0) fail(`checkout failed: ${c.out.trim().slice(-200)}`);
}
ensureModules();

// 3. local checks, in the checkout (a local ref, or when asked).
if (gate.state === "none" || process.env["ORCH_DEPLOY_LOCAL_CHECKS"] === "1") localChecks();

function localChecks(): void {
const tc = sh(process.env["ORCH_DEPLOY_TYPECHECK_CMD"] || `${BUN} scripts/typecheck.ts`, CHECKOUT);
if (tc.code !== 0) restoreAndFail(`typecheck failed: ${tc.out.trim().split("\n").slice(-1)[0] ?? ""}`, "typecheck failed");
// Deploy checks correctness, not speed: a loaded machine must not block a deploy on the fast tier's time cap.
const ts = sh(process.env["ORCH_DEPLOY_TEST_CMD"] || `ORCH_TEST_FILE_CAP=${process.env["ORCH_TEST_FILE_CAP"] ?? "180"} ${BUN} skills/orch/tests/run.ts`, CHECKOUT);
if (ts.code !== 0) {
  // Name the files that failed or timed out: the last summary line alone can read "0 failed" when a file hit its time cap.
  const bad = ts.out.split("\n").filter((l) => /^=== .* (TIMEOUT|FAILED|LEAK)/.test(l)).map((l) => l.replace(/^=== | ===$/g, ""));
  restoreAndFail(`tests failed: ${[...bad, ts.out.trim().split("\n").slice(-1)[0] ?? ""].join("; ")}`, "failed");
}
}

/** success when every check run of the commit passed, pending while any runs or none exist yet, failure otherwise. */
function githubChecks(commit: string): { state: "success" | "pending" | "failure" | "none"; detail: string } {
  const cmd = process.env["ORCH_DEPLOY_CHECKS_CMD"];
  if (cmd) {
    const r = sh(`${cmd} ${commit}`, REPO);
    const word = r.out.trim().split(/\s+/)[0] ?? "";
    return { state: word === "success" || word === "failure" ? word : "pending", detail: r.out.trim() };
  }
  const url = git(REPO, "remote", "get-url", "origin").out.trim();
  const slug = url.replace(/\.git$/, "").match(/github\.com[:/]([^/]+\/[^/]+)$/)?.[1];
  if (!slug) return { state: "failure", detail: `origin is not a GitHub repo: ${url}` };
  const r = run(["ghx", "api", `repos/${slug}/commits/${commit}/check-runs`, "--jq", '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'], { cwd: REPO });
  if (r.code !== 0) return { state: "pending", detail: `check query failed: ${r.out.trim().slice(-200)}` };
  const runs = r.out.trim().split("\n").filter(Boolean).map((l) => l.split("\t"));
  if (runs.length === 0) return { state: "pending", detail: "no check runs yet" };
  const open = runs.filter(([, status]) => status !== "completed").map(([n]) => n);
  if (open.length) return { state: "pending", detail: `running: ${open.join(", ")}` };
  const bad = runs.filter(([, , c]) => !["success", "skipped", "neutral"].includes(c ?? "")).map(([n, , c]) => `${n}=${c}`);
  return bad.length ? { state: "failure", detail: bad.join(", ") } : { state: "success", detail: `${runs.length} checks green` };
}

// 4. switch the service
const rs = restart();
if (rs.code !== 0 || !(await healthy(target))) {
  if (prev) {
    git(CHECKOUT, "checkout", "--detach", "-f", "-q", prev.sha);
    restart();
  }
  fail(`service did not report ${target.slice(0, 7)} after restart${prev ? `; rolled back to ${prev.sha.slice(0, 7)}` : ""}`, "passed");
}
const cur: DeployCurrent = { sha: target, ref, deployed_at: new Date().toISOString(), tests: gate.state === "success" ? "github checks green" : "passed" };
writeFileSync(join(DIR, "current.json"), JSON.stringify(cur, null, 2) + "\n");
history({ ok: true, sha: target, tests: "passed" });
log(`deployed ${target.slice(0, 7)} (${ref})`);
unlock();
process.exit(0);

/** A failed check leaves the checkout on the previous sha so it never holds the rejected one. */
function restoreAndFail(reason: string, tests: string): never {
  if (prev) git(CHECKOUT, "checkout", "--detach", "-f", "-q", prev.sha);
  return fail(reason, tests);
}
