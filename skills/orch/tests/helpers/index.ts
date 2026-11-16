// Shared helpers for tests/**/*.test.ts. Bun built-ins only.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "bun:test";
import { inProcess, stopInProcess } from "./inproc.ts";
import { templateHome } from "./template.ts";

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
export function cleanupTemps(): void {
  while (made.length) Bun.spawnSync(["trash", made.pop()!]);
}
export function autoCleanup(): void {
  afterAll(() => { stopInProcess(); cleanupTemps(); });
}

// Env a test process gets: no identity inherited from an orch node or opencode session, no announcer, no herdr.
const DROP = [
  "ORCH_SESSION_ID", "ORCH_RESUME_SESSION", "ORCH_MODEL_BEHAVES_AS", "ORCH_MODEL_SLUG", "ORCH_RUN_ID", "ORCH_JOB_DIR",
  "ORCH_NODE_ID", "ORCH_NODE_OUT", "ORCH_NODE_ROLE", "ORCH_NODE_TIER", "ORCH_NODE_ATTEMPT", "ORCH_NODE_ACCEPTANCE",
  "ORCH_EVENT_BY", "OPENCODE", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_SESSION_ID", "OPENCODE_TERMINAL",
  "HARNESS_ORCH_HOME", "ORCH_DISPATCH", "LLM_HUB_URL", "LLM_HUB_V1_URL", "LLM_HUB_KEY",
];
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env, ORCH_NO_ANNOUNCE: "1", ORCH_HERDR: "0", ORCH_OPENCODE_DB: join(tmpdir(), "orch-test-no-opencode.db") };
  for (const k of DROP) delete env[k];
  Object.assign(env, extra);
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export interface Result { rc: number; out: string; err: string; all: string }

// Commands that detach, install signal handlers, kill their process group or call process.exit run as a real process.
const SPAWN_ALWAYS = new Set(["start", "serve", "ui", "job-run", "loop", "watch", "announce", "active", "herdr", "artifact", "__run-cancel"]);
const SPAWN_ONLY = new Set(["schedule tick", "schedule run", "schedule __runcmd"]);
const RUN_ADAPTERS = ["--profile", "claude", "claude-native", "cursor-agent", "local-llm", "opencode", "copilot", "pi"];
let loopbackServer = false;
export function mustSpawn(args: string[], passed: Record<string, string | undefined>): boolean {
  if (process.env.ORCH_TEST_SPAWN === "1" || loopbackServer) return true;
  const words = args.filter((a) => !a.startsWith("--"));
  const [a, b] = words;
  if (!a || SPAWN_ALWAYS.has(a)) return !!a;
  if (a === "run" && RUN_ADAPTERS.includes(args[1] ?? "")) return true;
  if (SPAWN_ONLY.has(`${a} ${b ?? ""}`.trim()) || SPAWN_ONLY.has(a)) return true;
  return Object.values(passed).some((v) => v !== undefined && /https?:\/\/(127\.0\.0\.1|localhost)/.test(v));
}

function orchArgs(cmd: string[]): string[] | null {
  if (cmd.length < 2) return null;
  const exe = cmd[0], target = cmd[1];
  if (exe !== "bun" && exe !== process.execPath) return null;
  return target === DISPATCH || target === CLI_TS ? cmd.slice(2) : null;
}

export function runCmd(cmd: string[], opts: { home?: string; env?: Record<string, string | undefined>; cwd?: string; stdin?: string; spawn?: boolean } = {}): Result {
  const env = cleanEnv({ ...(opts.home ? { HARNESS_ORCH_HOME: opts.home } : {}), ...opts.env });
  const oargs = orchArgs(cmd);
  if (oargs && !opts.cwd && !opts.spawn && !mustSpawn(oargs, { ...opts.env })) return inProcess(oargs, env, opts.stdin);
  const p = Bun.spawnSync(cmd, { env, cwd: opts.cwd, stdin: opts.stdin !== undefined ? Buffer.from(opts.stdin) : undefined });
  const out = p.stdout.toString(), err = p.stderr.toString();
  return { rc: p.exitCode ?? 1, out, err, all: out + err };
}

export async function runCmdAsync(cmd: string[], opts: { home?: string; env?: Record<string, string | undefined>; cwd?: string } = {}): Promise<Result> {
  const env = cleanEnv({ ...(opts.home ? { HARNESS_ORCH_HOME: opts.home } : {}), ...opts.env });
  const p = Bun.spawn(cmd, { env, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
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

/** Loopback fake LLM hub: echoes the prompt and model like the old python fixture. */
export function fakeHub(delayMs = 0) {
  loopbackServer = true;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      let content = "", model = "";
      try { const b: any = await req.json(); content = b.messages?.[0]?.content ?? ""; model = b.model ?? ""; } catch {}
      if (delayMs) await Bun.sleep(delayMs);
      return Response.json({ choices: [{ message: { content: `echo:${content}|model=${model}` } }] });
    },
  });
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export async function waitUntil(cond: () => boolean | Promise<boolean>, seconds = 60): Promise<boolean> {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { if (await cond()) return true; await Bun.sleep(200); }
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
  const bin = fakeBin({ opencode: `echo "$*" >> "${dir}/calls"\necho '{"data":{"id":"msg_1"}}'` });
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
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !["created", "updated", "started", "finished", "at", "next_retry_at", "owner_checked", "run_id", "title"].includes(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, strip(x)])) : v;
  return JSON.stringify(strip(runState(home, run)));
}
export const eventKeys = (home: string, run: string) => JSON.stringify(events(home, run).map((e) => [e.kind, e.node, e.from, e.to, e.note, e.by]));
export const handoff = (home: string, run: string, node: string) => {
  mkdirSync(join(home, "runs", run, "out", node), { recursive: true });
  writeFileSync(join(home, "runs", run, "out", node, "handoff.md"), "handoff\n");
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
