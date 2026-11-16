// Dedicated herdr instance for orch. Ported from lib/adapters/herdr.sh. The orch skill never touches
// the user's live herdr: jobs run in panes of a second, headless herdr server under <home>/herdr/
// with its own HOME, config.toml, socket, pidfile and log. One workspace per run, one tab per node
// (titled "<node-id>", plus " #<attempt>" above 1) with one pane. A retry reuses the node's tab.
// An ended job's tab is closed by sweep() once herdr_linger_sec has passed. Every herdr call is best
// effort: when it fails the caller starts the job detached. Bun built-ins only.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
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
const binPresent = () => Bun.which("herdr") !== null;
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
    const p = Bun.spawn(["sh", "-c", `exec herdr server >>"${log}" 2>&1 </dev/null`], { env: instEnv(inst), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    p.unref();
    writeFileSync(join(dir, "server.pid"), `${p.pid}\n`);
    for (let i = 0; i < startWaitSecs() * 4; i++) {
      if (await serverRunning(home)) return true;
      await Bun.sleep(250);
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
    for (let i = 0; i < 20 && (await serverRunning(home)); i++) await Bun.sleep(500);
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

async function findNodeTab(home: string, ws: string, node: string): Promise<string> {
  const list = await cliJson(home, ["tab", "list", "--workspace", ws]);
  const t = (list?.result?.tabs ?? []).find((x: any) => stripPrefix(x.label ?? "").replace(/ #\d+$/, "") === node);
  return t?.tab_id ?? "";
}

const lingerSec = async (home: string): Promise<number> => {
  const v = String(process.env.ORCH_HERDR_CLOSE_AFTER ?? (await settings(home)).herdr_linger_sec ?? LINGER_DEFAULT);
  return /^\d+$/.test(v) ? Number(v) : LINGER_DEFAULT;
};

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
function writeLauncher(file: string, jobDir: string, launcherTs: string, close: { tab: string; owner: string; inst: string; linger: number }): void {
  let s = "#!/bin/sh\n";
  s += `command -v bun >/dev/null 2>&1 || { echo "orch needs bun: install it from https://bun.sh" >&2; exit 127; }\n`;
  s += "unset HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID\n";
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && LAUNCH_ENV.test(k)) s += `export ${k}=${shq(v)}\n`;
  s += `cd -- ${shq(process.cwd())} || exit 1\n`;
  s += `me=$$\nprintf %s "$me" > ${shq(join(jobDir, "pid"))}\n`;
  s += `( while kill -0 "$me" 2>/dev/null; do sleep 1; done\n  sleep ${close.linger}\n`;
  s += `  [ "$(cat ${shq(close.owner)} 2>/dev/null)" = ${shq(jobDir)} ] || exit 0\n`;
  s += `  env -i PATH=${shq(process.env.PATH ?? "")} HOME=${shq(close.inst)} herdr tab close ${shq(close.tab)} >/dev/null 2>&1\n`;
  s += ") >/dev/null 2>&1 </dev/null &\n";
  s += `exec bun ${shq(launcherTs)} ${shq(jobDir)}\n`;
  writeFileSync(file, s);
  chmodSync(file, 0o700);
}

const launchTs = () => join(dirname(import.meta.dir), "commands", "herdr-launch.ts");

// Runs the job in its own tab of the run's workspace. Returns false when nothing runs there
// (disabled, herdr missing, unreachable, pane cap), so the caller falls back to a detached job.
export async function startJob(home: string, jobDir: string, argv: string[]): Promise<boolean> {
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
  const base = process.env.ORCH_NODE_ID || jobDir.split("/").pop()!;
  const attempt = Number(process.env.ORCH_NODE_ATTEMPT || 1);
  const title = attempt > 1 ? `${base} #${attempt}` : base;
  const w = await runWorkspace(home, run, process.cwd());
  if (!w) return false;
  let tabId = attempt > 1 ? await findNodeTab(home, w.ws, base) : "";
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

// Closes the tabs of ended jobs after the linger (ended_at in the job dir, else exit_code mtime) and
// the panes no job owns after 60 s. Only ever touches the orch instance. Returns how many tabs it closed.
export async function sweep(home: string): Promise<number> {
  if (!(await herdrEnabled(home)) || !(await serverRunning(home))) return 0;
  const pl = await cliJson(home, ["pane", "list"]);
  if (!pl) return 0;
  const linger = await lingerSec(home);
  const jobsDir = paths.jobs(home);
  const byPane = new Map<string, string>();
  try {
    for (const d of readdirSync(jobsDir)) {
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
    let ended = 0;
    const iso = readTrim(join(job, "ended_at"));
    if (iso) ended = Date.parse(iso) / 1000;
    else {
      try { ended = statSync(join(job, "exit_code")).mtimeMs / 1000; } catch { continue; }
    }
    if (!(ended > 0) || now - ended < linger) continue;
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

export const HERDR_VERBS = ["on", "off", "auto", "status", "attach", "ensure", "stop", "health", "sweep", "enabled", "start-job", "close-tab", "job-gone-note", "serve-boot", "cli"];
