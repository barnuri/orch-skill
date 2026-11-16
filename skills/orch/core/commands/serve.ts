// serve / ui / artifact lifecycle. One Bun server per config home. `serve` runs it in the foreground;
// `ui` reuses a healthy one, starts one detached when nothing answers, and restarts it when the
// sources are newer than the running server. Bind address, port and auth policy live in
// <home>/serve.json. The server owns the markers under <home>/serve/; this file only reads them and
// truncates `pid` (never deletes it).
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, appendFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, err, home as ioHome, out } from "../io.ts";
import { ensureHome } from "../state/profiles.ts";

export const SERVE_DEFAULT_HOST = "0.0.0.0";
export const SERVE_DEFAULT_PORT = 6724;
export const SERVE_MAX_PORT = 65535;
const START_WAIT_TICKS = 50;
const STOP_WAIT_TICKS = 50;
export const VALID_HARNESSES = "claude cursor-agent opencode local-llm copilot pi";
export const VALID_OUTCOMES = "success failure partial";

export const SERVE_USAGE = "dispatch.sh serve [--host H] [--port P] | serve --stop";
export const ARTIFACT_USAGE = "dispatch.sh artifact <run-id> [--out DIR]";
export const SERVE_STATUS_USAGE = "dispatch.sh serve status [--json]";
export const SERVE_RECOVER_USAGE = "dispatch.sh serve recover [--start|--no-start]";
export const SERVE_CONFIG_USAGE =
  "dispatch.sh serve config show | serve config get <key> | serve config set [--host H] [--port P] [--require-token|--no-require-token] [--allow-remote|--no-allow-remote]";
export const UI_USAGE = "dispatch.sh ui [--stop]";

const ROOT = resolve(import.meta.dir, "../../../..");
const SRC_DIR = join(ROOT, "src");
const TEMPLATES_DIR = resolve(import.meta.dir, "../../templates");
export const serveEntry = () => join(SRC_DIR, "server/main.ts");
const artifactEntry = () => join(SRC_DIR, "server/artifact/main.ts");

const isUint = (s: unknown): s is string => typeof s === "string" && /^\d+$/.test(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function serveFiles(home: string) {
  const dir = join(home, "serve");
  return {
    dir,
    pid: join(dir, "pid"),
    port: join(dir, "port"),
    host: join(dir, "host"),
    log: join(dir, "log"),
    sock: join(dir, "orch.sock"),
    token: join(home, "serve.token"),
    config: join(home, "serve.json"),
  };
}

function readText(file: string): string {
  try {
    return require("node:fs").readFileSync(file, "utf8").replace(/\n+$/, "");
  } catch {
    return "";
  }
}

// Copies templates/serve.json on first use; never overwrites an existing file.
export function ensureServeConfig(home: string): boolean {
  const f = serveFiles(home);
  mkdirSync(home, { recursive: true });
  if (existsSync(f.config)) return true;
  const tpl = join(TEMPLATES_DIR, "serve.json");
  if (!existsSync(tpl)) {
    err(`serve: template ${tpl} missing\n`);
    return false;
  }
  copyFileSync(tpl, f.config);
  return true;
}

// jq `.[$k] // $d`: null and false fall back to the default.
export function serveConfigGet(home: string, key: string, dflt: string): string {
  const f = serveFiles(home);
  if (!existsSync(f.config)) return dflt;
  try {
    const v = JSON.parse(readText(f.config))[key];
    if (v === undefined || v === null || v === false) return dflt;
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return dflt;
  }
}

const configBool = (home: string, key: string): boolean => ["true", "1"].includes(serveConfigGet(home, key, "false"));
const requireToken = (home: string): boolean => !!env().ORCH_REQUIRE_TOKEN || configBool(home, "require_token");
const allowRemote = (home: string): boolean => !!env().ORCH_ALLOW_REMOTE || configBool(home, "allow_remote");

function authArgv(home: string): string[] {
  return [...(requireToken(home) ? ["--require-token"] : []), ...(allowRemote(home) ? ["--allow-remote"] : [])];
}

async function ensureDeps(): Promise<boolean> {
  if (!existsSync(join(ROOT, "package.json")) || existsSync(join(ROOT, "node_modules/hono"))) return true;
  err("serve: installing the dashboard dependencies (first run only)…\n");
  const p = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  err(o + e);
  if ((await p.exited) !== 0) {
    err(`serve: \`bun install\` failed in ${ROOT} — run it there by hand and check your network\n`);
    return false;
  }
  return true;
}

interface BindOpts {
  host: string;
  port: string;
  stop: boolean;
}

// `ui` takes only --stop: the bind address belongs to `serve`, and `ui` always opens 127.0.0.1.
function parseServeOpts(home: string, caller: "serve" | "ui", args: string[]): BindOpts | number {
  const usage = caller === "ui" ? UI_USAGE : SERVE_USAGE;
  if (!ensureServeConfig(home)) return 1;
  const o: BindOpts = {
    host: serveConfigGet(home, "host", SERVE_DEFAULT_HOST),
    port: serveConfigGet(home, "port", String(SERVE_DEFAULT_PORT)),
    stop: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--stop") o.stop = true;
    else if (a === "--host" || a === "--port") {
      if (caller === "ui") {
        err(`${caller}: unknown argument ${a}\n  usage: ${usage}\n`);
        return 2;
      }
      const v = args[++i] ?? "";
      if (a === "--host") {
        if (!v) {
          err(`${caller}: --host expects a host\n`);
          return 2;
        }
        o.host = v;
      } else {
        if (!isUint(v) || Number(v) > SERVE_MAX_PORT) {
          err(`${caller}: --port expects 0-${SERVE_MAX_PORT}\n`);
          return 2;
        }
        o.port = v;
      }
    } else {
      err(`${caller}: unknown argument ${a}\n  usage: ${usage}\n`);
      return 2;
    }
  }
  return o;
}

export async function serveConfig(args: string[]): Promise<number> {
  const home = ioHome();
  const verb = args[0] ?? "";
  const rest = args.slice(1);
  const f = serveFiles(home);
  if (verb === "show") {
    if (!ensureServeConfig(home)) return 1;
    out(readText(f.config) + "\n");
    return 0;
  }
  if (verb === "get") {
    const key = rest[0] ?? "";
    if (!key) {
      err(`usage: ${SERVE_CONFIG_USAGE}\n`);
      return 2;
    }
    if (!ensureServeConfig(home)) return 1;
    out(serveConfigGet(home, key, "") + "\n");
    return 0;
  }
  if (verb === "set") {
    let host = "", port = "", rt = "", ar = "";
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--host") {
        host = rest[++i] ?? "";
        if (!host) {
          err("serve config set: --host expects a host\n");
          return 2;
        }
      } else if (a === "--port") {
        port = rest[++i] ?? "";
        if (!isUint(port) || Number(port) > SERVE_MAX_PORT) {
          err(`serve config set: --port expects 0-${SERVE_MAX_PORT}\n`);
          return 2;
        }
      } else if (a === "--require-token") rt = "1";
      else if (a === "--no-require-token") rt = "0";
      else if (a === "--allow-remote") ar = "1";
      else if (a === "--no-allow-remote") ar = "0";
      else {
        err(`serve config set: unknown argument ${a}\n  usage: ${SERVE_CONFIG_USAGE}\n`);
        return 2;
      }
    }
    if (!ensureServeConfig(home)) return 1;
    const cur = {
      host: host || serveConfigGet(home, "host", SERVE_DEFAULT_HOST),
      port: port || serveConfigGet(home, "port", String(SERVE_DEFAULT_PORT)),
      rt: rt ? rt === "1" : configBool(home, "require_token"),
      ar: ar ? ar === "1" : configBool(home, "allow_remote"),
    };
    const tmp = `${f.config}.tmp.${process.pid}`;
    writeFileSync(
      tmp,
      JSON.stringify({ host: cur.host, port: Number(cur.port), require_token: cur.rt, allow_remote: cur.ar }, null, 2) + "\n",
    );
    require("node:fs").renameSync(tmp, f.config);
    out(readText(f.config) + "\n");
    return 0;
  }
  err(`usage: ${SERVE_CONFIG_USAGE}\n`);
  return 2;
}

// serve/ is 0700 and its log 0600: the log holds the tokenized URL bun prints at startup.
function preparehome(home: string): boolean {
  if (!ensureServeConfig(home)) return false;
  const f = serveFiles(home);
  try {
    mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    appendFileSync(f.log, "", { mode: 0o600 });
    return true;
  } catch {
    err(`serve: cannot prepare ${f.dir}\n`);
    return false;
  }
}

const pidAlive = (pid: string): boolean => {
  if (!isUint(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

// Proves a listener is there without ever putting the token on argv. Any HTTP status counts (401 too).
export async function serveProbe(port: string): Promise<boolean> {
  if (!isUint(port)) return false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function clearPid(home: string): void {
  const f = serveFiles(home);
  if (existsSync(f.pid)) writeFileSync(f.pid, "");
}

// 0 running, 1 nothing running (a stale pid marker is truncated), 3 alive but nothing answers.
async function serveRunning(home: string): Promise<number> {
  const f = serveFiles(home);
  const pid = readText(f.pid);
  const port = readText(f.port);
  if (!pidAlive(pid)) {
    if (pid) clearPid(home);
    return 1;
  }
  if (!port) return 1;
  if (await serveProbe(port)) return 0;
  err(`ui: pid ${pid} is alive but nothing answers on 127.0.0.1:${port}; run dispatch.sh ui --stop to reset\n`);
  return 3;
}

function sourceDirs(): string[] {
  const e = env().ORCH_SERVE_SOURCE_DIRS;
  return e ? e.split(/\s+/).filter(Boolean) : ["server", "snapshot", "web", "shared"].map((d) => join(SRC_DIR, d));
}

function newerThan(dir: string, ref: number): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (newerThan(p, ref)) return true;
    } else if (e.isFile()) {
      try {
        if (statSync(p).mtimeMs > ref) return true;
      } catch {}
    }
  }
  return false;
}

// True when a source is newer than the pid marker: the running server bundled code that changed.
export function serveSourcesChanged(home: string): boolean {
  const f = serveFiles(home);
  try {
    const st = statSync(f.pid);
    if (st.size === 0) return false;
    return sourceDirs().some((d) => newerThan(d, st.mtimeMs));
  } catch {
    return false;
  }
}

function serverArgs(home: string, host: string, port: string): string[] {
  return [
    serveEntry(), "--home", home, "--host", host, "--port", port,
    "--harnesses", VALID_HARNESSES, "--outcomes", VALID_OUTCOMES, ...authArgv(home),
  ];
}

export async function serveStartBackground(home: string): Promise<number> {
  if (!(await ensureDeps())) return 1;
  if (!preparehome(home)) return 1;
  const f = serveFiles(home);
  const host = serveConfigGet(home, "host", SERVE_DEFAULT_HOST);
  const port = serveConfigGet(home, "port", String(SERVE_DEFAULT_PORT));
  const fd = openSync(f.log, "a");
  const proc = Bun.spawn([process.execPath, ...serverArgs(home, host, port)], {
    stdin: "ignore", stdout: fd, stderr: fd, detached: true, env: { ...env() } as Record<string, string>,
  });
  proc.unref();
  closeSync(fd);
  for (let tick = 0; tick < START_WAIT_TICKS; tick++) {
    if (readText(f.pid) === String(proc.pid) && (await serveProbe(readText(f.port)))) return 0;
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  err("ui: server did not start; last log lines:\n");
  err(readText(f.log).split("\n").slice(-5).join("\n") + "\n");
  return 1;
}

function serveUrl(home: string): string {
  const f = serveFiles(home);
  if (requireToken(home)) return `http://127.0.0.1:${readText(f.port)}/?token=${readText(f.token)}\n`;
  return `http://127.0.0.1:${readText(f.port)}/\n`;
}

// SIGTERM, then SIGKILL after STOP_WAIT_TICKS x 100 ms. The pid marker is truncated like the server does.
async function serveStop(home: string): Promise<number> {
  const f = serveFiles(home);
  const pid = readText(f.pid);
  if (!pidAlive(pid)) {
    out("serve: not running\n");
    clearPid(home);
    return 0;
  }
  const n = Number(pid);
  try { process.kill(n, "SIGTERM"); } catch {}
  for (let t = 0; t < STOP_WAIT_TICKS && pidAlive(pid); t++) await sleep(100);
  if (pidAlive(pid)) try { process.kill(n, "SIGKILL"); } catch {}
  clearPid(home);
  out(`serve: stopped (pid ${pid})\n`);
  return 0;
}

export interface Diag {
  rc: number;
  reason: string;
  pid: string;
  port: string;
  host: string;
  url: string;
}

// rc: 0 running, 1 down/stale_pid, 2 bun_missing, 3 zombie, 4 sources_stale
export async function serveDiagnose(home: string): Promise<Diag> {
  const f = serveFiles(home);
  const pid = readText(f.pid), port = readText(f.port), host = readText(f.host);
  const d: Diag = { rc: 1, reason: "down", pid: "", port: "", host: "", url: "" };
  if (pidAlive(pid)) {
    if (!port || !(await serveProbe(port))) return { ...d, rc: 3, reason: "zombie", pid, port };
    if (serveSourcesChanged(home)) return { ...d, rc: 4, reason: "sources_stale", pid, port, host };
    return { rc: 0, reason: "running", pid, port, host, url: serveUrl(home).trimEnd() };
  }
  if (pid) return { ...d, reason: "stale_pid", pid };
  return d;
}

export async function serveRecover(args: string[]): Promise<number> {
  const home = ioHome();
  let doStart = true;
  for (const a of args) {
    if (a === "--start") doStart = true;
    else if (a === "--no-start") doStart = false;
    else {
      err(`serve recover: unknown argument ${a}\n  usage: ${SERVE_RECOVER_USAGE}\n`);
      return 2;
    }
  }
  if (!(await ensureHome(home))) return 1;
  const d = await serveDiagnose(home);
  if (d.rc === 0) {
    out(`serve: healthy (pid ${d.pid}, port ${d.port})\n${d.url}\n`);
    return 0;
  }
  if (d.rc === 3) {
    err(`serve: pid ${d.pid} is alive but not answering — stopping it\n`);
    await serveStop(home);
  } else if (d.rc === 4) {
    err("serve: skill sources changed — restarting the server\n");
    await serveStop(home);
  } else if (d.reason === "stale_pid") {
    err("serve: clearing stale pid marker\n");
    clearPid(home);
  }
  if (!doStart) {
    err("serve: not running; pass --start to bring the dashboard up\n");
    return 1;
  }
  if ((await serveStartBackground(home)) !== 0) return 1;
  out(`serve: started on ${readText(serveFiles(home).host)}:${readText(serveFiles(home).port)}\n`);
  out(serveUrl(home));
  return 0;
}

export async function serveStatus(args: string[]): Promise<number> {
  let asJson = false;
  for (const a of args) {
    if (a === "--json") asJson = true;
    else {
      err(`serve status: unknown argument ${a}\n  usage: ${SERVE_STATUS_USAGE}\n`);
      return 2;
    }
  }
  const home = ioHome();
  if (!(await ensureHome(home))) return 1;
  const d = await serveDiagnose(home);
  if (asJson) {
    out(
      JSON.stringify({
        healthy: d.rc === 0,
        reason: d.reason,
        pid: d.pid === "" ? null : d.pid,
        port: d.port === "" ? null : Number(d.port),
        host: d.host === "" ? null : d.host,
        url: d.url === "" ? null : d.url,
      }) + "\n",
    );
    return d.rc;
  }
  switch (d.reason) {
    case "running": out(`state=running listener=answering pid=${d.pid} port=${d.port} url=${d.url}\n`); break;
    case "down": out("state=down listener=stopped\n"); break;
    case "stale_pid": out(`state=down listener=stopped stale_pid=${d.pid}\n`); break;
    case "zombie": out(`state=zombie listener=stopped pid=${d.pid} port=${d.port}\n`); break;
    case "bun_missing": out("state=unavailable reason=bun_missing\n"); break;
    case "sources_stale": out(`state=stale listener=answering pid=${d.pid} port=${d.port}\n`); break;
    default: out(`state=unknown reason=${d.reason}\n`);
  }
  return d.rc;
}

export { ensureHome } from "../state/profiles.ts";

function herdrBoot(home: string): void {
  const flag = env().ORCH_HERDR ?? "";
  if (["0", "false", "off"].includes(flag) || !Bun.which("herdr")) return;
  try {
    const dispatch = resolve(import.meta.dir, "../../scripts/dispatch.sh");
    Bun.spawn(["bash", dispatch, "herdr", "ensure"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, env: { ...env(), HARNESS_ORCH_HOME: home } as Record<string, string>,
    }).unref();
  } catch {}
}

// serve [--host H] [--port P] | serve --stop: bun runs in the foreground.
export async function serveCommand(args: string[]): Promise<number> {
  const home = ioHome();
  const o = parseServeOpts(home, "serve", args);
  if (typeof o === "number") return o;
  if (o.stop) return serveStop(home);
  if (!(await ensureDeps())) return 1;
  if (!existsSync(serveEntry())) {
    err(`serve: ${serveEntry()} missing\n`);
    return 1;
  }
  const f = serveFiles(home);
  const rc = await serveRunning(home);
  if (rc === 0) {
    err(`serve: already running on ${readText(f.host)}:${readText(f.port)} (pid ${readText(f.pid)}); use dispatch.sh serve --stop first\n`);
    return 1;
  }
  if (rc === 3) return 1;
  if (!preparehome(home)) return 1;
  herdrBoot(home);
  const p = Bun.spawn([process.execPath, ...serverArgs(home, o.host, o.port)], {
    stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...env() } as Record<string, string>,
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => p.kill(sig));
  return await p.exited;
}

// ui [--stop]: reuse, restart or start the shared server, then open the URL. ORCH_NO_OPEN=1 prints only.
export async function uiCommand(args: string[]): Promise<number> {
  const home = ioHome();
  const o = parseServeOpts(home, "ui", args);
  if (typeof o === "number") return o;
  if (o.stop) return serveStop(home);
  const f = serveFiles(home);
  let rc = await serveRunning(home);
  if (rc === 3) {
    err("ui: server not answering — recovering\n");
    await serveStop(home);
    rc = 1;
  }
  if (rc === 0 && serveSourcesChanged(home)) {
    err("ui: skill sources changed since the server started — restarting it\n");
    await serveStop(home);
    rc = 1;
  }
  if (rc === 0) {
    if (readText(f.host) !== o.host || readText(f.port) !== o.port) {
      err(`ui: reusing the server running on ${readText(f.host)}:${readText(f.port)}\n`);
    }
  } else {
    const s = await serveStartBackground(home);
    if (s !== 0) return s;
  }
  const url = serveUrl(home);
  out(url);
  if (env().ORCH_NO_OPEN) return 0;
  const opener = Bun.which("open") ?? Bun.which("xdg-open");
  if (opener) Bun.spawn([opener, url.trim()], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  return 0;
}

// artifact <run-id> [--out DIR]: bundles the dashboard with the run's documents embedded.
export async function artifactCommand(args: string[]): Promise<number> {
  const home = ioHome();
  let runId = "", outDir = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") {
      outDir = args[++i] ?? "";
      if (!outDir) {
        err(`artifact: --out needs a directory\nusage: ${ARTIFACT_USAGE}\n`);
        return 2;
      }
    } else if (a === "-h" || a === "--help") {
      out(`usage: ${ARTIFACT_USAGE}\n`);
      return 0;
    } else if (a.startsWith("-")) {
      err(`artifact: unknown flag ${a}\nusage: ${ARTIFACT_USAGE}\n`);
      return 2;
    } else {
      if (runId) {
        err(`artifact: one run id at a time\nusage: ${ARTIFACT_USAGE}\n`);
        return 2;
      }
      runId = a;
    }
  }
  if (!runId) {
    err(`usage: ${ARTIFACT_USAGE}\n`);
    return 2;
  }
  if (!existsSync(artifactEntry())) {
    err(`artifact: ${artifactEntry()} missing\n`);
    return 1;
  }
  if (!(await ensureDeps())) return 1;
  if (!outDir) outDir = join(home, "artifacts", runId);
  const p = Bun.spawn(
    [process.execPath, artifactEntry(), "--home", home, "--run", runId, "--out", outDir, "--harnesses", VALID_HARNESSES, "--outcomes", VALID_OUTCOMES],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env() } as Record<string, string> },
  );
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  out(o);
  err(e);
  return await p.exited;
}
