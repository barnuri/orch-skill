// Shared helpers for tests/**/*.test.ts. Bun built-ins only.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, chmodSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "bun:test";

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
  afterAll(cleanupTemps);
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
  const env: Record<string, string | undefined> = { ...process.env, ORCH_NO_ANNOUNCE: "1", ORCH_HERDR: "0" };
  for (const k of DROP) delete env[k];
  Object.assign(env, extra);
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
}

export interface Result { rc: number; out: string; err: string; all: string }

export function runCmd(cmd: string[], opts: { home?: string; env?: Record<string, string | undefined>; cwd?: string; stdin?: string } = {}): Result {
  const env = cleanEnv({ ...(opts.home ? { HARNESS_ORCH_HOME: opts.home } : {}), ...opts.env });
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

let template: string | undefined;
function templateHome(): string {
  if (process.env.ORCH_TEST_HOME_TEMPLATE && existsSync(join(process.env.ORCH_TEST_HOME_TEMPLATE, "profiles.json"))) return process.env.ORCH_TEST_HOME_TEMPLATE;
  if (template) return template;
  const d = join(tempDir("orch-tpl-"), "home");
  mkdirSync(d, { recursive: true });
  runCmd([process.execPath, DISPATCH, "init"], { home: d });
  return (template = d);
}
/** A fresh initialised home (copy of a home that ran `init` once). */
export function seedHome(dest?: string): string {
  const home = dest ?? join(tempDir(), "home");
  mkdirSync(home, { recursive: true });
  cpSync(templateHome(), home, { recursive: true, preserveTimestamps: true, filter: (s) => !s.endsWith("/.trash") });
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
