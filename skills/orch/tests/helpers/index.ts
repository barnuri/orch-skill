// Shared helpers for tests/**/*.test.ts. Bun built-ins only.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync, readdirSync, appendFileSync, renameSync, utimesSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "bun:test";
import { inProcess, stopInProcess } from "./inproc.ts";
import { templateHome } from "./template.ts";
import { reapUnder } from "../lib/reap.ts";

export const TESTS_DIR = resolve(import.meta.dir, "..");
export const ORCH_DIR = resolve(TESTS_DIR, "..");
export const REPO_ROOT = resolve(ORCH_DIR, "../..");
export const CLI_TS = join(ORCH_DIR, "core/cli.ts");
export const DISPATCH = join(ORCH_DIR, "scripts/dispatch.ts");

const made: string[] = [];
export function tempDir(prefix = "orch-t-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
// Recoverable removal without a process: the `trash` program takes about a second per call. Run.ts clears old ones.
const TRASH_ROOT = join(tmpdir(), "orch-test-trash", String(process.pid));
let trashN = 0;
export function trashSync(p: string): void {
  if (!existsSync(p)) return;
  // Stop the runners of this home before it is moved, or they keep ticking with no record. A home without
  // runner dirs has none; skipping the process scan there keeps each trash call fast (ps takes about 0.4 s).
  if (["loops", "watches", "jobs", "health", "serve", "serve.json", "schedules"].some((d) => existsSync(join(p, d)))) reapUnder(p);
  try {
    mkdirSync(TRASH_ROOT, { recursive: true });
    renameSync(p, join(TRASH_ROOT, `${++trashN}-${basename(p)}`));
  } catch { Bun.spawnSync(["trash", p]); }
}
export function cleanupTemps(): void {
  while (made.length) trashSync(made.pop()!);
}
export function autoCleanup(): void {
  afterAll(() => { stopInProcess(); cleanupTemps(); });
}

// Env a test process gets: no identity inherited from an orch node or opencode session, no announcer, no herdr.
const DROP = [
  "ORCH_SESSION_ID", "ORCH_RESUME_SESSION", "ORCH_MODEL_BEHAVES_AS", "ORCH_MODEL_SLUG", "ORCH_RUN_ID", "ORCH_JOB_DIR",
  "ORCH_NODE_ID", "ORCH_NODE_LABEL", "ORCH_NODE_OUT", "ORCH_NODE_ROLE", "ORCH_NODE_TIER", "ORCH_NODE_ATTEMPT", "ORCH_NODE_ACCEPTANCE",
  "ORCH_EVENT_BY", "OPENCODE", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_SESSION_ID", "OPENCODE_TERMINAL",
  "HARNESS_ORCH_HOME", "ORCH_DISPATCH", "LLM_HUB_URL", "LLM_HUB_V1_URL", "LLM_HUB_KEY",
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID",
  "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE",
];
// The live terminal identity leaves this process too, so a test that spawns with { ...process.env } can never
// record the real herdr pane or hc terminal as a coordinator and type its asks into the live session.
for (const k of DROP) if (k.startsWith("HERDR_") || k.startsWith("HC_")) delete process.env[k];
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, ORCH_NO_ANNOUNCE: "1", ORCH_HERDR: "0", ORCH_TRASH_MOVE: "1", ORCH_OWNER_CALL_TIMEOUT: "1", ORCH_OPENCODE_DB: join(tmpdir(), "orch-test-no-opencode.db") };
  for (const k of DROP) delete env[k];
  Object.assign(env, extra);
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

// ORCH_TEST_TRACE=<file>: one line per orch call (kind, ms, command), and per process the in-process worker spawns.
function trace(kind: string, ms: number, what: string): void {
  const f = process.env.ORCH_TEST_TRACE;
  if (f) appendFileSync(f, `${kind}\t${ms}\t${what.slice(0, 120)}\n`);
}

export interface Result { rc: number; out: string; err: string; all: string }

// Calls that detach, install signal handlers, kill their own process group, call process.exit or run an adapter
// run as a real process; every other call runs in the worker thread (helpers/inproc.ts). Servers a test starts
// must not live in the test thread (it blocks during a call): use fakeHub() or a child process.
const SPAWN_ALWAYS = new Set(["start", "serve", "ui", "job-run", "artifact", "__run-cancel"]);
const SPAWN_VERBS: Record<string, string[]> = {
  loop: ["start", "resume", "recover", "__run"],
  watch: ["start", "wait", "__run"],
  schedule: ["tick", "run", "__runcmd"],
};
const RUN_ADAPTERS = ["--profile", "claude", "claude-native", "cursor-agent", "local-llm", "opencode", "copilot", "pi"];
export function mustSpawn(args: string[]): boolean {
  if (process.env.ORCH_TEST_SPAWN === "1") return true;
  const words = args.filter((a) => !a.startsWith("--"));
  const [a, b] = words;
  if (!a) return false;
  if (SPAWN_ALWAYS.has(a)) return true;
  if (a === "run" && RUN_ADAPTERS.includes(args[1] ?? "")) return true;
  if (a === "announce") return args.includes("--daemon");
  return !!SPAWN_VERBS[a]?.includes(b ?? "");
}

function orchArgs(cmd: string[]): string[] | null {
  if (cmd.length < 2) return null;
  const exe = cmd[0], target = cmd[1];
  if (exe !== "bun" && exe !== process.execPath) return null;
  return target === DISPATCH || target === CLI_TS ? cmd.slice(2) : null;
}

/** A bare `bun` in a test command is this very bun, so a test that sets a bare PATH still finds it. */
function resolveBun(cmd: string[]): string[] {
  return cmd[0] === "bun" ? [process.execPath, ...cmd.slice(1)] : cmd;
}

export function runCmd(cmd: string[], opts: { home?: string; env?: Record<string, string | undefined>; cwd?: string; stdin?: string; spawn?: boolean } = {}): Result {
  const env = cleanEnv({ ORCH_NO_DONE_GATE: "1", ...(opts.home ? { HARNESS_ORCH_HOME: opts.home } : {}), ...opts.env });
  const oargs = orchArgs(cmd);
  if (oargs && !opts.cwd && !opts.spawn && !mustSpawn(oargs)) {
    const t1 = Date.now(), r = inProcess(oargs, env, opts.stdin);
    trace("inproc", Date.now() - t1, oargs.join(" "));
    return r;
  }
  const t0 = Date.now();
  const p = Bun.spawnSync(resolveBun(cmd), { env, cwd: opts.cwd, stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : undefined });
  const out = p.stdout.toString(), err = p.stderr.toString();
  trace("spawn", Date.now() - t0, cmd.slice(2).join(" "));
  return { rc: p.exitCode ?? 1, out, err, all: out + err };
}

export async function runCmdAsync(cmd: string[], opts: { home?: string; env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<Result> {
  const env = cleanEnv({ ORCH_NO_DONE_GATE: "1", ...(opts.home ? { HARNESS_ORCH_HOME: opts.home } : {}), ...opts.env });
  const p = Bun.spawn(resolveBun(cmd), { env, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { rc: await p.exited, out, err, all: out + err };
}

/** The Bun CLI (skills/orch/core/cli.ts). */
export const cli = (home: string, ...args: string[]) => runCmd(["bun", CLI_TS, ...args], { home });
/** The dispatcher (routes ported commands to the Bun CLI, the rest to bash until it is gone). */
export const dispatch = (home: string, ...args: string[]) => runCmd([process.execPath, DISPATCH, ...args], { home });

export { templateHome };
/** A fresh initialised home (copy of a home that ran `init` once). */
export function seedHome(dest?: string): string {
  const home = dest ?? join(tempDir(), "home");
  mkdirSync(home, { recursive: true });
  cpSync(templateHome(), home, { recursive: true });
  return home;
}
/** An empty home dir (no init). */
export const tempHome = () => join(tempDir(), "home");

export const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, "utf8"));
export const writeJson = (p: string, v: unknown) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)); };
export function editJson(p: string, fn: (v: any) => any): void { const v = readJson(p); writeJson(p, fn(v) ?? v); }

/** A fake executable script placed in a bin dir; returns the dir (prepend to PATH). */
export function fakeBin(files: Record<string, string>): string {
  const dir = tempDir("orch-bin-");
  for (const [name, body] of Object.entries(files)) {
    const f = join(dir, name);
    writeFileSync(f, body.startsWith("#!") ? body : `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
  }
  return dir;
}
export const fakeAdapter = (reply = "ok") => fakeBin({ "fake-adapter": `printf '%s' ${JSON.stringify(reply)}` });
export const fakeHerdr = () => fakeBin({ herdr: `echo "$@" >> "\${FAKE_HERDR_LOG:-/dev/null}"; echo '{}'` });

/** Loopback fake LLM hub: echoes the prompt and model. It runs in its own thread, so the test thread can block on an in-process orch call. */
export function fakeHub(delayMs = 0) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  const worker = new Worker(new URL("./fake-hub-worker.ts", import.meta.url));
  worker.postMessage({ sab, delayMs });
  Atomics.wait(ia, 0, 0, 30_000);
  const port = Atomics.load(ia, 0);
  if (!port) throw new Error("fakeHub did not start");
  return { port, url: `http://127.0.0.1:${port}`, stop: () => { worker.postMessage("stop"); setTimeout(() => worker.terminate(), 50); } };
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, seconds = 60): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(25); }
  return false;
}
export const listFiles = (d: string) => (existsSync(d) ? readdirSync(d) : []);

/** orch(home, env?) -> o(...args): runs dispatch.sh (routes to the Bun CLI where ported) in a home. */
export function orch(home: string, env: Record<string, string | undefined> = {}) {
  const o = (...args: string[]) => runCmd(["bun", DISPATCH, ...args], { home, env });
  o.in = (stdin: string, ...args: string[]) => runCmd(["bun", DISPATCH, ...args], { home, env, stdin });
  o.env = (extra: Record<string, string | undefined>, ...args: string[]) => runCmd(["bun", DISPATCH, ...args], { home, env: { ...env, ...extra } });
  return o;
}
export const runState = (home: string, run: string) => readJson(join(home, "runs", run, "state.json"));
export const nodeOf = (home: string, run: string, id: string) => runState(home, run).nodes.find((n: any) => n.id === id);
export const readText = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
export const events = (home: string, run: string) =>
  readText(join(home, "runs", run, "events.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Fake `opencode` binary (logs argv to <dir>/calls) plus an opencode sqlite db with busy/stalled/idle sessions. */
export async function opencodeFixture() {
  const { Database } = await import("bun:sqlite");
  const dir = tempDir("orch-oc-");
  const bin = fakeBin({ opencode: `echo "$*" >> "${dir}/calls"\n[ -n "$OC_FAIL" ] && exit 1\necho '{"data":{"id":"msg_1"}}'` });
  const db = join(dir, "opencode.db");
  const now = Date.now(), old = now - 40 * 60 * 1000;
  const d = new Database(db);
  d.run(`create table session_v2 (id text primary key, parent_id text, title text, model text,
    cost real default 0, tokens_input integer default 0, tokens_output integer default 0, tokens_reasoning integer default 0,
    tokens_cache_read integer default 0, tokens_cache_write integer default 0, time_created integer, time_updated integer,
    time_busy integer, time_idle integer)`);
  const ins = d.prepare("insert into session_v2 (id, title, time_created, time_updated, time_busy, time_idle) values (?,?,?,?,?,?)");
  ins.run("ses_busy1", "busy", old, now, now, null);
  ins.run("ses_stall1", "stalled", old, old, old, null);
  ins.run("ses_idle1", "idle", old, now, now - 5000, now);
  d.close();
  const env = { PATH: `${bin}:${process.env.PATH}`, ORCH_OPENCODE_DB: db, ORCH_OWNER_CACHE_SECS: "0", ORCH_HEALTH_MONITOR: "0" };
  return { dir, bin, db, env, calls: () => readText(join(dir, "calls")) };
}
export const ndjson = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** State with volatile timestamps removed, for comparing two runs. */
export function normState(home: string, run: string): string {
  const strip = (v: any): any => Array.isArray(v) ? v.map(strip) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !["created", "updated", "started", "finished", "at", "next_retry_at", "owner_checked", "run_id", "title", "dispatched_at", "started_at", "finished_at", "run_segments"].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, strip(x)])) : v;
  return JSON.stringify(strip(runState(home, run)));
}
export const eventKeys = (home: string, run: string) => JSON.stringify(events(home, run).map((e) => [e.kind, e.node, e.from, e.to, e.note, e.by]));
export const handoff = (home: string, run: string, node: string) => {
  mkdirSync(join(home, "runs", run, "out", node), { recursive: true });
  const file = join(home, "runs", run, "out", node, "handoff.md");
  writeFileSync(file, "handoff\n");
  // A handoff older than the node's start counts as stale; a test writes it before the node runs, so date it ahead.
  const ahead = new Date(Date.now() + 3600_000);
  utimesSync(file, ahead, ahead);
};

export const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Run state of a node, shorthand. */
export const jqNode = (home: string, run: string, id: string) => nodeOf(home, run, id);

/** PATH with each named binary's directory removed (so `which <name>` fails), keeping everything else. */
export function pathWithout(...names: string[]): string {
  let parts = (process.env.PATH ?? "").split(":");
  for (const n of names) for (;;) {
    const hit = Bun.spawnSync(["sh", "-c", `PATH='${parts.join(":")}' command -v ${n}`]).stdout.toString().trim();
    if (!hit) break;
    const dir = hit.replace(/\/[^/]*$/, "");
    parts = parts.filter((p) => p !== dir);
  }
  return parts.join(":");
}

/** Directory holding a fake `herdr` (TypeScript, run by bun) — see helpers/fake-herdr.ts. */
export const fakeHerdrBin = () => fakeBin({ herdr: `exec bun "${join(import.meta.dir, "fake-herdr.ts")}" "$@"` });

/** Like orch(), but every command is a real process: for detached jobs, signals and background `wait`. */
export function orchSpawn(home: string, env: Record<string, string | undefined> = {}) {
  const run = (e: Record<string, string | undefined>, args: string[], stdin?: string) => runCmd(["bun", DISPATCH, ...args], { home, env: e, stdin, spawn: true });
  const o = (...args: string[]) => run(env, args);
  o.in = (stdin: string, ...args: string[]) => run(env, args, stdin);
  o.env = (extra: Record<string, string | undefined>, ...args: string[]) => run({ ...env, ...extra }, args);
  return o;
}
