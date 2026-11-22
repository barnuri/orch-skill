// Dedicated herdr instance for orch. Ported from lib/adapters/herdr.sh. The orch skill never touches
// the user's live herdr: jobs run in panes of a second, headless herdr server under <home>/herdr/
// with its own HOME, config.toml, socket, pidfile and log. One workspace per run, one tab per node
// (titled "<node-id>", plus " #<attempt>" above 1) with one pane. A retry reuses the node's tab.
// An ended job's tab closes as soon as the wrapper writes its result. Every herdr call is best
// effort: when it fails the caller starts the job detached. Bun built-ins only.
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { orchHome, paths } from "../state/home.ts";
import { acquireLock } from "../state/lock.ts";
import { trashPath } from "../state/trash.ts";
import { readJson, writeJsonAtomic } from "../state/store.ts";

export const HERDR_USAGE = "dispatch.ts herdr on|off|auto|status|attach|ensure|stop|sweep | herdr health [--json] [--nudge]";
const NO_RUN_LABEL = "jobs";
const PID_WAIT_SECS = 15;
const PANE_CAP_DEFAULT = 20;
const LINGER_DEFAULT = 300;
const ORPHAN_SECS = 60;
const SOCK_MAX_BYTES = 100;
const WEB_ENV_ID = "orch-skill";
const CONFIG_TOML = `# Managed by orch (dispatch.ts herdr). No plugins, no notifications: the orch skill has its own.
onboarding = false

[ui.toast]
delivery = "off"
`;

const callTimeoutMs = () => Number(process.env.ORCH_HERDR_CALL_TIMEOUT || 8) * 1000;
const startWaitSecs = () => Number(process.env.ORCH_HERDR_START_WAIT || 15);
const herdrDir = (home: string) => join(home, "herdr");
const binPresent = () => Bun.which("herdr", { PATH: process.env.PATH ?? "" }) !== null;
const readText = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };
const readTrim = (f: string) => readText(f).trim();
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

type Settings = Record<string, any>;
async function settings(home: string): Promise<Settings> {
  try { return ((await readJson<any>(paths.profiles(home))).settings ?? {}) as Settings; } catch { return {}; }
}

// The HOME the instance runs with. Unix socket paths stay under ~104 bytes, so a long <home> is
// reached through a short symlink in /tmp.
export function instHome(home: string): string | null {
  const real = join(herdrDir(home), "home");
  mkdirSync(join(real, ".config", "herdr"), { recursive: true });
  if (join(real, ".config", "herdr", "herdr.sock").length <= SOCK_MAX_BYTES) return real;
  const sum = new Bun.CryptoHasher("md5").update(home).digest("hex").slice(0, 10);
  const link = `/tmp/orch-herdr-${process.getuid?.() ?? 0}-${sum}`;
  try {
    if (!lstatSync(link).isSymbolicLink()) return null;
    if (readlinkSync(link) === real) return link;
  } catch { /* absent */ }
  return Bun.spawnSync(["ln", "-sfn", real, link]).exitCode === 0 ? link : null;
}

export function instEnv(inst: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: inst,
    TERM: process.env.TERM || "xterm-256color", LANG: process.env.LANG || "en_US.UTF-8",
  };
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("ORCH_HERDR_") && v !== undefined) env[k] = v;
  return env;
}

export type CliResult = { ok: boolean; stdout: string; stderr: string };

// The herdr CLI against the dedicated instance only. A clean env drops every HERDR_* variable of a
// calling pane and the real HOME, so the live session's socket is unreachable.
export async function herdrCli(home: string, args: string[]): Promise<CliResult> {
  const inst = instHome(home);
  if (!inst) return { ok: false, stdout: "", stderr: "no instance home" };
  try {
    const p = Bun.spawn(["herdr", ...args], { env: instEnv(inst), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), callTimeoutMs());
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

async function cliJson(home: string, args: string[]): Promise<any | null> {
  const r = await herdrCli(home, args);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// ORCH_HERDR=0 turns it off, 1 on; else settings.herdr; else on exactly when the binary exists.
export async function herdrEnabled(home: string): Promise<boolean> {
  if (!binPresent()) return false;
  const v = process.env.ORCH_HERDR ?? "";
  if (["0", "false", "off"].includes(v)) return false;
  if (["1", "true", "on"].includes(v)) return true;
  return (await settings(home)).herdr !== false;
}

export async function enabledReason(home: string): Promise<string> {
  const v = process.env.ORCH_HERDR ?? "";
  if (["0", "false", "off"].includes(v)) return "off (ORCH_HERDR=0)";
  if (["1", "true", "on"].includes(v)) return "on (ORCH_HERDR=1)";
  const s = (await settings(home)).herdr;
  if (s === true) return "on (settings.herdr)";
  if (s === false) return "off (settings.herdr)";
  return binPresent() ? "on (default: herdr found)" : "off (default: herdr not on PATH)";
}

export async function serverRunning(home: string): Promise<boolean> {
  if (!binPresent()) return false;
  const j = await cliJson(home, ["status", "--json"]);
  return j?.server?.running === true;
}

export function attachHint(home: string): string {
  const inst = instHome(home) ?? "";
  return `env -u HERDR_ENV -u HERDR_SOCKET_PATH -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID HOME='${inst}' herdr`;
}

// ---- herdr web registry ----
const webEnvsDir = () => process.env.ORCH_HERDR_WEB_ENVS_DIR || join(process.env.HOME || homedir(), ".config", "herdr-web", "envs.d");
const webUrl = () => process.env.ORCH_HERDR_WEB_URL || "http://127.0.0.1:2222";

async function webRegister(home: string): Promise<void> {
  try {
    if (!(await herdrEnabled(home))) return;
    const inst = instHome(home);
    if (!inst) return;
    mkdirSync(webEnvsDir(), { recursive: true });
    await writeJsonAtomic(join(webEnvsDir(), `${WEB_ENV_ID}.json`), {
      id: WEB_ENV_ID, label: WEB_ENV_ID, home: inst, socket: join(inst, ".config", "herdr", "herdr.sock"),
    });
  } catch { /* best effort */ }
}

async function webUnregister(home: string): Promise<void> {
  await trashPath(home, join(webEnvsDir(), `${WEB_ENV_ID}.json`)).catch(() => undefined);
}

function webEntryState(home: string): "ok" | "missing" | "wrong" {
  const file = join(webEnvsDir(), `${WEB_ENV_ID}.json`);
  if (!existsSync(file)) return "missing";
  const inst = instHome(home);
  try {
    const j = JSON.parse(readText(file));
    const ok = inst && j.id === WEB_ENV_ID && j.label === WEB_ENV_ID && j.home === inst && j.socket === join(inst, ".config", "herdr", "herdr.sock");
    return ok ? "ok" : "wrong";
  } catch { return "wrong"; }
}

async function webListed(): Promise<string> {
  const url = webUrl();
  if (url === "off") return "skipped";
  try {
    const res = await fetch(`${url}/api/envs`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return "no-plugin";
    const list = (await res.json()) as any[];
    const e = Array.isArray(list) ? list.find((x) => x?.id === WEB_ENV_ID) : undefined;
    return !e ? "missing" : e.reachable === true ? "listed" : "unreachable";
  } catch { return "no-plugin"; }
}

function serverPidAlive(pid: string): boolean {
  const n = Number(pid);
  if (!n || !pidAlive(n)) return false;
  const r = Bun.spawnSync(["ps", "-p", String(n), "-o", "command="]);
  return r.stdout.toString().includes("herdr");
}

// ---- health ----
export async function herdrHealth(home: string, args: string[]): Promise<number> {
  let json = false, nudge = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--nudge") nudge = true;
    else { process.stderr.write("usage: dispatch.ts herdr health [--json] [--nudge]\n"); return 2; }
  }
  const collect = async () => {
    const pid = readTrim(join(herdrDir(home), "server.pid"));
    return { pid, pidAlive: serverPidAlive(pid), socketOk: await serverRunning(home), registry: webEntryState(home) as string, web: await webListed() };
  };
  let state = "off", nudged = false;
  let c = { pid: "", pidAlive: false, socketOk: false, registry: "missing", web: "skipped" };
  if (await herdrEnabled(home)) {
    c = await collect();
    if (nudge && (!c.socketOk || c.registry !== "ok")) {
      await herdrOrch(home, "ensure");
      nudged = true;
      c = await collect();
    }
    state = !c.socketOk ? "down" : c.registry !== "ok" || c.web === "missing" || c.web === "unreachable" ? "degraded" : "ok";
    if (c.socketOk) await sweep(home).catch(() => undefined);
  }
  const problems: string[] = [];
  if (state !== "off") {
    if (!c.socketOk) problems.push("the orch herdr instance does not answer on its socket");
    if (!c.pidAlive && c.socketOk) problems.push("the server pidfile is stale");
    if (c.registry === "missing") problems.push("herdr web registry file is missing");
    if (c.registry === "wrong") problems.push("herdr web registry file does not match the instance");
    if (c.web === "missing") problems.push(`herdr web does not list ${WEB_ENV_ID}`);
    if (c.web === "unreachable") problems.push(`herdr web lists ${WEB_ENV_ID} but cannot reach its socket`);
    if (c.web === "no-plugin") problems.push(`herdr web plugin does not answer at ${webUrl()}`);
  }
  const reason = await enabledReason(home);
  const registryPath = join(webEnvsDir(), `${WEB_ENV_ID}.json`);
  if (json) {
    const pidN = c.pid === "" ? null : Number.isFinite(Number(c.pid)) ? Number(c.pid) : null;
    process.stdout.write(JSON.stringify({
      state, enabled: state !== "off", reason, env_id: WEB_ENV_ID, pid: pidN, pid_alive: c.pidAlive, socket_ok: c.socketOk,
      registry: c.registry, registry_path: registryPath, web: c.web, web_url: webUrl(), nudged,
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), problems,
    }) + "\n");
  } else {
    let out = `herdr health: ${state} (${reason})\n`;
    if (state !== "off") {
      out += `server pid: ${c.pid || "none"} (${c.pidAlive ? "alive" : "dead"})\nsocket: ${c.socketOk ? "answers" : "no answer"}\n`;
      out += `registry: ${c.registry} (${registryPath})\nweb: ${c.web} (${webUrl()})\n`;
      if (nudged) out += "nudged: re-ensured the instance and its registry\n";
      for (const p of problems) out += `problem: ${p}\n`;
    }
    process.stdout.write(out);
  }
  return state === "ok" || state === "off" ? 0 : state === "degraded" ? 1 : 3;
}

// ---- server ----
async function ensureServer(home: string): Promise<boolean> {
  if (!binPresent()) return false;
  if (await serverRunning(home)) return true;
  const lock = await acquireLock(home, "herdr-ensure", startWaitSecs() * 2, 500);
  if (!lock) return await serverRunning(home);
  try {
    if (await serverRunning(home)) return true;
    const dir = herdrDir(home);
    const inst = instHome(home);
    if (!inst) return false;
    const cfg = join(inst, ".config", "herdr", "config.toml");
    if (!existsSync(cfg)) writeFileSync(cfg, CONFIG_TOML);
    const sock = join(inst, ".config", "herdr", "herdr.sock");
    if (existsSync(sock)) await trashPath(home, sock);
    mkdirSync(dir, { recursive: true });
    const log = join(dir, "server.log");
    const p = Bun.spawn(["sh", "-c", `exec herdr server >>"${log}" 2>&1 </dev/null`], { env: instEnv(inst), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    p.unref();
    writeFileSync(join(dir, "server.pid"), `${p.pid}\n`);
    for (let i = 0; i < startWaitSecs() * 10; i++) {
      if (await serverRunning(home)) return true;
      await Bun.sleep(100);
    }
    return false;
  } finally {
    await lock.release();
  }
}

export async function herdrOrch(home: string, sub: string): Promise<number> {
  if (sub === "status") return (await serverRunning(home)) ? 0 : 1;
  if (sub === "attach-hint") { process.stdout.write(attachHint(home) + "\n"); return 0; }
  if (sub === "ensure") {
    if (!(await ensureServer(home))) return 1;
    await webRegister(home);
    return 0;
  }
  if (sub === "stop") {
    if (!(await serverRunning(home))) { await webUnregister(home); return 0; }
    await herdrCli(home, ["server", "stop"]);
    for (let i = 0; i < 100 && (await serverRunning(home)); i++) await Bun.sleep(100);
    if (await serverRunning(home)) return 1;
    writeFileSync(join(herdrDir(home), "server.pid"), "");
    await webUnregister(home);
    return 0;
  }
  return 2;
}

// ---- labels, tabs, jobs ----
const stripPrefix = (label: string) => label.replace(/^\[\d+\] /, "");
const labelIs = (label: string | undefined, want: string) => (label ?? "") === want || (label ?? "").endsWith(" " + want);

async function runWorkspace(home: string, label: string, cwd: string): Promise<{ ws: string; rootTab: string } | null> {
  const list = await cliJson(home, ["workspace", "list"]);
  if (!list) return null;
  const found = (list.result?.workspaces ?? []).find((w: any) => labelIs(w.label, label));
  if (found?.workspace_id) return { ws: found.workspace_id, rootTab: "" };
  const created = await cliJson(home, ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  const ws = created?.result?.workspace?.workspace_id;
  return ws ? { ws, rootTab: created?.result?.tab?.tab_id ?? "" } : null;
}

async function findNodeTab(home: string, ws: string, title: string): Promise<string> {
  const list = await cliJson(home, ["tab", "list", "--workspace", ws]);
  const t = (list?.result?.tabs ?? []).find((x: any) => stripPrefix(x.label ?? "").replace(/-attempt-\d+$/, "") === title);
  return t?.tab_id ?? "";
}

const lingerSec = async (home: string): Promise<number> => {
  const v = String(process.env.ORCH_HERDR_CLOSE_AFTER ?? (await settings(home)).herdr_linger_sec ?? LINGER_DEFAULT);
  return /^\d+$/.test(v) ? Number(v) : LINGER_DEFAULT;
};

const stoppedExitCode = (exitCode: number): boolean => [129, 130, 143].includes(exitCode);

const ownerFile = (home: string, tab: string) => join(herdrDir(home), "tabs", `${tab.replace(/[^A-Za-z0-9._-]/g, "_")}.job`);

// Closes the job's tab now when this job still owns it (cancelled or duplicate jobs). Best effort.
export async function closeJobTab(home: string, jobDir: string): Promise<void> {
  const tab = readTrim(join(jobDir, "herdr_tab"));
  if (!tab) return;
  if (readTrim(ownerFile(home, tab)) !== jobDir) return;
  await herdrCli(home, ["tab", "close", tab]);
}

const LAUNCH_ENV = /^(ORCH_|HARNESS_ORCH_)|^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TMPDIR|SSH_AUTH_SOCK|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_CACHE_HOME)$/;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// The pane shell inherits the instance HOME, so the launcher restores the real HOME and the job's
// env first. It carries only the orch env, PATH and a short allow-list, so no other secret lands on disk.
// `close` is null for an hc terminal: hc removes ended terminals itself (see hcSweep).
function writeLauncher(file: string, jobDir: string, launcherTs: string, close: { tab: string; owner: string; inst: string; linger: number } | null): void {
  let s = "#!/bin/sh\n";
  s += `command -v bun >/dev/null 2>&1 || { echo "orch needs bun: install it from https://bun.sh" >&2; exit 127; }\n`;
  s += "unset HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID\n";
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && LAUNCH_ENV.test(k)) s += `export ${k}=${shq(v)}\n`;
  // Per-job environment (for example a profile's provider config) written by the caller as env.json.
  const jobEnv = join(jobDir, "env.json");
  if (existsSync(jobEnv)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(jobEnv, "utf8")) as Record<string, unknown>)) {
        if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof v === "string") s += `export ${k}=${shq(v)}\n`;
      }
    } catch { /* a bad env.json is ignored: the job starts with the default environment */ }
  }
  s += `cd -- ${shq(process.cwd())} || exit 1\n`;
  s += `me=$$\nprintf %s "$me" > ${shq(join(jobDir, "pid"))}\n`;
  if (close) {
    // Success and stop signals close the tab at once; a failed job keeps its tab for the linger first.
    s += `( while kill -0 "$me" 2>/dev/null; do sleep 1; done\n  exit_code=$(cat ${shq(join(jobDir, "exit_code"))} 2>/dev/null || true)\n`;
    s += `  case "$exit_code" in 0|129|130|143|"") ;; *) sleep ${close.linger} ;; esac\n`;
    s += `  [ "$(cat ${shq(close.owner)} 2>/dev/null)" = ${shq(jobDir)} ] || exit 0\n`;
    s += `  env -i PATH=${shq(process.env.PATH ?? "")} HOME=${shq(close.inst)} herdr tab close ${shq(close.tab)} >/dev/null 2>&1\n`;
    s += ") >/dev/null 2>&1 </dev/null &\n";
  }
  s += `exec bun ${shq(launcherTs)} ${shq(jobDir)}\n`;
  writeFileSync(file, s);
  chmodSync(file, 0o700);
}

const launchTs = () => join(dirname(import.meta.dir), "commands", "herdr-launch.ts");

// ---- herdr-core (hc) terminals ----
// When `hc` is on PATH, jobs run as hc terminals (labels orch=1, run=<run>, node=<node>, job=<job dir name>).
// ORCH_HC=0 turns this path off. Any hc failure falls back to the herdr path below.
const HC_LABEL = "orch=1";
const hcBinPresent = () => Bun.which("hc", { PATH: process.env.PATH ?? "" }) !== null;

export async function hcEnabled(home: string): Promise<boolean> {
  if (!hcBinPresent()) return false;
  if (process.env.ORCH_HC === "0") return false;
  const v = process.env.ORCH_HERDR ?? "";
  if (["0", "false", "off"].includes(v)) return false;
  if (["1", "true", "on"].includes(v) || process.env.ORCH_HC === "1") return true;
  return (await settings(home)).herdr !== false;
}

async function hcCli(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const p = Bun.spawn(["hc", ...args], { env: { ...process.env } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), callTimeoutMs());
    const stdout = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function hcList(extra: string[] = []): Promise<any[] | null> {
  const r = await hcCli(["ls", "--json", "--label", HC_LABEL, ...extra]);
  if (!r.ok) return null;
  try { return (JSON.parse(r.stdout).terminals ?? []) as any[]; } catch { return null; }
}

// ---- herdr-app (desktop app) placement of hc jobs ----
// settings.herdr_space (default "orch"; "off" or empty disables) names the desktop-app space. The hc terminal
// carries the labels herdr.space=<id> and herdr.tab=<id> (one tab per run), else herdr-app hides it.
// Every failure here is logged to the job log and never fails or delays the job.
const APP_SPACE_TTL_MS = 60_000;
let appSpaceCache: { name: string; id: string; at: number } | null = null;
const appTabCache = new Map<string, string>();
export function resetAppCache(): void { appSpaceCache = null; appTabCache.clear(); }

async function appCli(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const p = Bun.spawn(["herdr-app", ...args], { env: { ...process.env } as Record<string, string>, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), callTimeoutMs());
    const stdout = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(timer);
    return { ok: code === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function appSpaces(): Promise<any[] | null> {
  const r = await appCli(["ls"]);
  if (!r.ok) return null;
  try { return (JSON.parse(r.stdout).spaces ?? []) as any[]; } catch { return null; }
}

const idIn = (out: string, prefix: string): string => out.match(new RegExp(`"${prefix}[0-9a-f]+"`))?.[0].slice(1, -1) ?? "";

async function appSpaceId(name: string, folder: string): Promise<string> {
  const now = Date.now();
  if (appSpaceCache && appSpaceCache.name === name && now - appSpaceCache.at < APP_SPACE_TTL_MS) {
    const spaces = await appSpaces();
    if (spaces?.some((x) => x.id === appSpaceCache!.id)) return appSpaceCache.id;
    appSpaceCache = null;
    appTabCache.clear();
  }
  const spaces = await appSpaces();
  if (!spaces) throw new Error("herdr-app ls failed");
  let id: string = spaces.find((x) => x.name === name)?.id ?? "";
  if (!id) {
    const r = await appCli(["do", "space.new", "--name", name, "--folder", folder, "--focus", "false"]);
    id = r.ok ? idIn(r.stdout, "spa") : "";
    if (!id) {
      id = ((await appSpaces()) ?? []).find((x) => x.name === name)?.id ?? "";
    }
    if (!id) throw new Error(`herdr-app space.new ${name} failed`);
  }
  appSpaceCache = { name, id, at: now };
  return id;
}

// Returns the labels and the terminal name for an hc run, or null (with a log line) when unavailable.
export function buildJobTerminalName(runTitle: string, nodeLabel: string, attempt = 1): string {
  const sanitize = (value: string, maxLength: number): string => {
    const cleaned = value.normalize("NFKC").replace(/[^a-z0-9_-]+/gi, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase();
    return cleaned.slice(0, maxLength).replace(/[-_]+$/g, "") || "job";
  };
  const runShort = sanitize(runTitle, 20);
  const nodeShort = sanitize(nodeLabel, 25);
  const base = `${runShort}-${nodeShort}`;
  return attempt > 1 ? `${base}-attempt-${attempt}` : base;
}

async function appPlacement(home: string, jobDir: string, run: string, node: string): Promise<{ labels: string[]; name: string } | null> {
  const log = (m: string) => { try { appendFileSync(join(jobDir, "log"), `orch: herdr-app: ${m}\n`); } catch { /* ignore */ } };
  try {
    const envSpace = process.env.ORCH_HERDR_SPACE; // test hook: "default" means use the setting
    const raw = envSpace !== undefined && envSpace !== "default" ? envSpace : (await settings(home)).herdr_space;
    const name = raw === undefined || raw === null ? "orch" : String(raw).trim();
    if (!name || name.toLowerCase() === "off") return null;
    if (Bun.which("herdr-app", { PATH: process.env.PATH ?? "" }) === null) return null;
    if (!(await appCli(["status"])).ok) { log("not answering, job stays hidden"); return null; }
    const space = await appSpaceId(name, process.cwd());
    const key = `${space}:${run}`;
    let tab = appTabCache.get(key) ?? "";
    // Every dispatch is its own process, so the cache above is empty for each node: reuse the run's tab by name,
    // else every node adds one more tab and the space fills with stale tabs that a later cleanup closes with live jobs in them.
    if (!tab) {
      const tabName = run.slice(-12);
      tab = ((await appSpaces()) ?? []).find((x) => x.id === space)?.tabs?.find((t: any) => t.name === tabName)?.id ?? "";
      if (tab) appTabCache.set(key, tab);
    }
    if (!tab) {
      const r = await appCli(["do", "tab.new", "--name", run.slice(-12), "--space", space, "--focus", "false"]);
      tab = r.ok ? idIn(r.stdout, "tb") : "";
      if (!tab) throw new Error("tab.new failed");
      appTabCache.set(key, tab);
    }
    const state = await readJson<any>(paths.runState(home, run)).catch(() => null);
    const runTitle = typeof state?.title === "string" ? state.title : run;
    const nodeEntry = Array.isArray(state?.nodes) ? state.nodes.find((n: any) => n.id === node) : null;
    const nodeLabel = process.env.ORCH_NODE_LABEL || (typeof nodeEntry?.label === "string" ? nodeEntry.label : node);
    const attempt = Number(process.env.ORCH_NODE_ATTEMPT || 1);
    return { labels: [`herdr.space=${space}`, `herdr.tab=${tab}`], name: buildJobTerminalName(runTitle, nodeLabel, attempt) };
  } catch (e) {
    log(`${(e as Error).message}, job stays hidden`);
    return null;
  }
}

async function hcStartJob(home: string, jobDir: string, argv: string[]): Promise<boolean> {
  await hcSweep(home).catch(() => undefined);
  const live = await hcList();
  if (!live) return false;
  const cap = Number(process.env.ORCH_HERDR_PANE_CAP || PANE_CAP_DEFAULT);
  if (live.length >= cap) return false;
  const run = process.env.ORCH_RUN_ID || NO_RUN_LABEL;
  const node = process.env.ORCH_NODE_ID || jobDir.split("/").pop()!;
  const job = jobDir.split("/").pop()!;
  writeFileSync(join(jobDir, "argv.json"), JSON.stringify(argv));
  const launcher = join(jobDir, "herdr-launch.sh");
  writeLauncher(launcher, jobDir, launchTs(), null);
  const place = await appPlacement(home, jobDir, run, node);
  const placeArgs = place ? ["--name", place.name, ...place.labels.flatMap((l) => ["--label", l])] : [];
  const r = await hcCli(["run", "--bg", "--json", ...placeArgs, "--cwd", process.cwd(), "--label", HC_LABEL, "--label", `run=${run}`, "--label", `node=${node}`, "--label", `job=${job}`, "sh", launcher]);
  let addr = "";
  try { addr = JSON.parse(r.stdout).address ?? ""; } catch { /* no address */ }
  if (!r.ok || !addr) return false;
  writeFileSync(join(jobDir, "hc_term"), `${addr}\n`);
  if (place) writeFileSync(join(jobDir, "hc_app"), `${place.labels.join(" ")}\n`);
  return true;
}

// Tail of an hc job's terminal (`hc read <addr> --lines N`), for jobs whose log file is empty or missing.
// Returns [] when the job has no hc_term, hc fails, or the terminal is gone.
export async function hcJobTail(jobDir: string, n = 20): Promise<string[]> {
  const addr = readTrim(join(jobDir, "hc_term"));
  if (!addr || !hcBinPresent()) return [];
  const r = await hcCli(["read", addr, "--lines", String(n * 5)]);
  if (!r.ok) return [];
  return r.stdout.replace(/\s+$/, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.length > 0).slice(-n);
}

export async function closeEndedJob(home: string, jobDir: string): Promise<void> {
  const exitCode = readTrim(join(jobDir, "exit_code"));
  if (!exitCode) return;

  const hcAddr = readTrim(join(jobDir, "hc_term"));
  if (hcAddr && (await hcEnabled(home))) {
    await hcCli(["rm", hcAddr]);
    await trashPath(home, join(jobDir, "hc_term")).catch(() => undefined);
    return;
  }

  const tab = readTrim(join(jobDir, "herdr_tab"));
  if (!tab) return;
  const code = Number(exitCode);
  if (code !== 0 && !stoppedExitCode(code)) {
    const linger = await lingerSec(home);
    if (linger > 0) {
      const inst = readTrim(join(jobDir, "herdr_home"));
      if (!inst) return;
      Bun.spawn(["sh", "-c", `sleep ${linger}; env -i PATH=${shq(process.env.PATH ?? "")} HOME=${shq(inst)} herdr tab close ${shq(tab)} >/dev/null 2>&1`], {
        cwd: process.cwd(), env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      return;
    }
  }
  await closeJobTab(home, jobDir);
}

// Removes only hc terminals whose result write did not reach close-ended-job.
export async function hcSweep(home: string): Promise<number> {
  if (!(await hcEnabled(home))) return 0;
  let removed = 0;
  let dirs: string[] = [];
  try { dirs = readdirSync(paths.jobs(home)); } catch { return 0; }
  for (const d of dirs) {
    const dir = join(paths.jobs(home), d);
    const addr = readTrim(join(dir, "hc_term"));
    if (!addr || jobRunning(dir)) continue;
    if (!existsSync(join(dir, "exit_code"))) continue;
    // A failed job shown in the desktop app stays visible for the user.
    if (existsSync(join(dir, "hc_app")) && readTrim(join(dir, "exit_code")) !== "0") continue;
    const r = await hcCli(["rm", addr]);
    if (r.ok) { removed++; await trashPath(home, join(dir, "hc_term")).catch(() => undefined); }
  }
  return removed;
}

// Runs the job in its own tab of the run's workspace. Returns false when nothing runs there
// (disabled, herdr missing, unreachable, pane cap), so the caller falls back to a detached job.
export async function startJob(home: string, jobDir: string, argv: string[]): Promise<boolean> {
  if (await hcEnabled(home)) {
    if (await hcStartJob(home, jobDir, argv)) return true;
  }
  if (!(await herdrEnabled(home))) return false;
  if ((await herdrOrch(home, "ensure")) !== 0) return false;
  const inst = instHome(home);
  if (!inst) return false;
  await sweep(home).catch(() => undefined);
  const panes = await cliJson(home, ["pane", "list"]);
  if (!panes) return false;
  const cap = Number(process.env.ORCH_HERDR_PANE_CAP || PANE_CAP_DEFAULT);
  if ((panes.result?.panes ?? []).length >= cap) return false;
  const run = process.env.ORCH_RUN_ID || NO_RUN_LABEL;
  const node = process.env.ORCH_NODE_ID || jobDir.split("/").pop()!;
  const attempt = Number(process.env.ORCH_NODE_ATTEMPT || 1);
  const state = await readJson<any>(paths.runState(home, run)).catch(() => null);
  const runTitle = typeof state?.title === "string" ? state.title : run;
  const nodeEntry = Array.isArray(state?.nodes) ? state.nodes.find((n: any) => n.id === node) : null;
  const nodeLabel = process.env.ORCH_NODE_LABEL || (typeof nodeEntry?.label === "string" ? nodeEntry.label : node);
  const title = buildJobTerminalName(runTitle, nodeLabel, attempt);
  const w = await runWorkspace(home, run, process.cwd());
  if (!w) return false;
  const baseTitle = buildJobTerminalName(runTitle, nodeLabel, 1);
  let tabId = attempt > 1 ? await findNodeTab(home, w.ws, baseTitle) : "";
  let paneId = "";
  if (tabId) {
    if (!(await herdrCli(home, ["tab", "rename", tabId, title])).ok) return false;
    const pl = await cliJson(home, ["pane", "list", "--workspace", w.ws]);
    paneId = (pl?.result?.panes ?? []).find((p: any) => p.tab_id === tabId)?.pane_id ?? "";
  } else {
    const t = await cliJson(home, ["tab", "create", "--workspace", w.ws, "--cwd", process.cwd(), "--label", title, "--no-focus"]);
    tabId = t?.result?.tab?.tab_id ?? "";
    paneId = t?.result?.root_pane?.pane_id ?? "";
    if (w.rootTab) await herdrCli(home, ["tab", "close", w.rootTab]);
  }
  if (!tabId || !paneId) return false;
  const owner = ownerFile(home, tabId);
  mkdirSync(dirname(owner), { recursive: true });
  writeFileSync(owner, `${jobDir}\n`);
  writeFileSync(join(jobDir, "argv.json"), JSON.stringify(argv));
  const launcher = join(jobDir, "herdr-launch.sh");
  writeLauncher(launcher, jobDir, launchTs(), { tab: tabId, owner, inst, linger: await lingerSec(home) });
  await herdrCli(home, ["pane", "rename", paneId, title]);
  if (!(await herdrCli(home, ["pane", "run", paneId, `sh ${shq(launcher)}`])).ok) {
    await herdrCli(home, ["tab", "close", tabId]);
    return false;
  }
  writeFileSync(join(jobDir, "herdr_pane"), `${paneId}\n`);
  writeFileSync(join(jobDir, "herdr_tab"), `${tabId}\n`);
  writeFileSync(join(jobDir, "herdr_home"), `${inst}\n`);
  writeFileSync(join(jobDir, "herdr_sock"), `${join(inst, ".config", "herdr", "herdr.sock")}\n`);
  return true;
}

function jobRunning(jobDir: string): boolean {
  const pid = Number(readTrim(join(jobDir, "pid")));
  if (pid && pidAlive(pid)) return true;
  if (existsSync(join(jobDir, "exit_code"))) return false;
  if (!pid && existsSync(join(jobDir, "herdr_pane")) && existsSync(join(jobDir, "herdr-launch.sh"))) {
    try { return Date.now() / 1000 - statSync(join(jobDir, "herdr-launch.sh")).mtimeMs / 1000 < PID_WAIT_SECS; } catch { return false; }
  }
  return false;
}

// Closes orphan panes after 60 s. Ended job tabs close when the result is written. Only ever touches the orch instance. Returns how many tabs it closed.
export async function sweep(home: string): Promise<number> {
  if (!(await herdrEnabled(home)) || !(await serverRunning(home))) return 0;
  const pl = await cliJson(home, ["pane", "list"]);
  if (!pl) return 0;
  const jobsDir = paths.jobs(home);
  const byPane = new Map<string, string>();
  try {
    // Pane ids restart at w1:p2 with each server, so the newest job dir wins a shared id.
    for (const d of readdirSync(jobsDir).sort()) {
      const pane = readTrim(join(jobsDir, d, "herdr_pane"));
      if (pane) byPane.set(pane, join(jobsDir, d));
    }
  } catch { /* no jobs yet */ }
  const seenFile = join(herdrDir(home), "orphans.json");
  let seen: Record<string, number> = {};
  try { seen = await readJson<Record<string, number>>(seenFile); } catch { /* first run */ }
  const now = Date.now() / 1000;
  const next: Record<string, number> = {};
  let closed = 0;
  for (const p of pl.result?.panes ?? []) {
    const id = p.pane_id as string;
    const job = byPane.get(id);
    if (!job) {
      next[id] = seen[id] ?? now;
      if (now - next[id] >= ORPHAN_SECS) {
        const r = await herdrCli(home, p.tab_id ? ["tab", "close", p.tab_id] : ["pane", "close", id]);
        if (r.ok) { closed++; delete next[id]; }
      }
      continue;
    }
    if (jobRunning(job)) continue;
    if (!existsSync(join(job, "exit_code"))) continue;
    const code = Number(readTrim(join(job, "exit_code")));
    if (code !== 0 && !stoppedExitCode(code)) {
      const linger = await lingerSec(home);
      if (linger > 0) {
        let ended = 0;
        const iso = readTrim(join(job, "ended_at"));
        if (iso) ended = Date.parse(iso) / 1000;
        else {
          try { ended = statSync(join(job, "exit_code")).mtimeMs / 1000; } catch { continue; }
        }
        if (now - ended < linger) continue;
      }
    }
    const tab = readTrim(join(job, "herdr_tab")) || p.tab_id;
    if (tab && readTrim(ownerFile(home, tab)) !== job) continue;
    const r = await herdrCli(home, tab ? ["tab", "close", tab] : ["pane", "close", id]);
    if (r.ok) closed++;
  }
  mkdirSync(herdrDir(home), { recursive: true });
  await writeJsonAtomic(seenFile, next);
  return closed;
}

// Why a job with no exit code is gone, for the node's event log.
export function jobGoneNote(jobDir: string): string {
  let note = "job process gone without an exit code";
  const pane = readTrim(join(jobDir, "herdr_pane"));
  if (pane) note += `; its orch-herdr pane ${pane} is gone or idle`;
  try {
    const started = statSync(join(jobDir, "pid")).mtimeMs / 1000;
    const r = Bun.spawnSync(["sysctl", "-n", "kern.boottime"]).stdout.toString().match(/sec = (\d+)/);
    const booted = r ? Number(r[1]) : 0;
    if (booted > started) note += "; the host rebooted after the job started";
  } catch { /* no pid file */ }
  return note;
}

// ---- command: dispatch.ts herdr <verb> ----
async function setSetting(home: string, key: string, value: boolean | null): Promise<boolean> {
  try {
    const file = paths.profiles(home);
    const doc = await readJson<any>(file);
    doc.settings = doc.settings ?? {};
    if (value === null) delete doc.settings[key];
    else doc.settings[key] = value;
    await writeJsonAtomic(file, doc);
    return true;
  } catch {
    process.stderr.write(`herdr: could not update ${paths.profiles(home)}\n`);
    return false;
  }
}

export async function herdrCommand(verb: string, args: string[], home: string = orchHome()): Promise<number> {
  mkdirSync(home, { recursive: true });
  switch (verb) {
    case "on": if (!(await setSetting(home, "herdr", true))) return 1; break;
    case "off": if (!(await setSetting(home, "herdr", false))) return 1; break;
    case "auto": if (!(await setSetting(home, "herdr", null))) return 1; break;
    case "status": case "attach": break;
    case "ensure":
      if ((await herdrOrch(home, "ensure")) !== 0) { process.stderr.write("herdr: could not start the orch instance\n"); return 1; }
      break;
    case "stop": if ((await herdrOrch(home, "stop")) !== 0) return 1; break;
    case "health": return herdrHealth(home, args);
    case "sweep": process.stdout.write(`${await sweep(home)}\n`); return 0;
    // Internal verbs for the bash call sites that remain in dispatch.ts.
    case "enabled": return (await herdrEnabled(home)) ? 0 : 1;
    case "start-job": {
      const [jobDir, ...argv] = args;
      return (await startJob(home, jobDir!, argv)) ? 0 : 1;
    }
    case "close-tab": await closeJobTab(home, args[0] ?? ""); return 0;
    case "close-ended": await closeEndedJob(home, args[0] ?? ""); return 0;
    case "job-gone-note": process.stdout.write(jobGoneNote(args[0] ?? "") + "\n"); return 0;
    case "serve-boot":
      if (await herdrEnabled(home)) await herdrOrch(home, "ensure");
      return 0;
    case "cli": {
      const r = await herdrCli(home, args);
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      return r.ok ? 0 : 1;
    }
    default:
      process.stderr.write(`usage: ${HERDR_USAGE}\n`);
      return 2;
  }
  let out = `herdr: ${await enabledReason(home)}\n`;
  if (await serverRunning(home)) out += "server: running\n";
  else if (binPresent()) out += "server: not running (started by serve and on the first job; jobs start detached if it cannot start)\n";
  else out += "server: herdr not on PATH (jobs start detached)\n";
  if (binPresent()) {
    out += `home: ${instHome(home)}\nlog: ${herdrDir(home)}/server.log\n`;
    out += `attach (in a separate terminal, never inside your own herdr pane): ${attachHint(home)}\n`;
  }
  process.stdout.write(out);
  return 0;
}

export const HERDR_VERBS = ["on", "off", "auto", "status", "attach", "ensure", "stop", "health", "sweep", "enabled", "start-job", "close-tab", "close-ended", "job-gone-note", "serve-boot", "cli"];
