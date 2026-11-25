// The shared opencode background service: read its registration, check it, POST to it without a CLI process,
// and report a stale one. Registration file: ~/.local/state/opencode/service.json (url, password, version, pid).
// Auth is Basic `opencode:<password>`, as `opencode api` sends it. orch never restarts the service itself.
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ServiceInfo { url: string; password: string; version: string; pid: number }

export const STALE_FIX = "opencode service restart";

export function serviceFile(): string {
  return process.env.ORCH_OPENCODE_SERVICE_JSON || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode", "service.json");
}

export function readService(): ServiceInfo | null {
  try {
    const j = JSON.parse(readFileSync(serviceFile(), "utf8"));
    if (typeof j.url !== "string" || !j.url) return null;
    // 0.0.0.0 is a bind address, not a place to connect to.
    return { url: j.url.replace("//0.0.0.0", "//127.0.0.1").replace(/\/$/, ""), password: String(j.password ?? ""), version: String(j.version ?? ""), pid: Number(j.pid) || 0 };
  } catch { return null; }
}

function headers(s: ServiceInfo): Record<string, string> {
  return { authorization: "Basic " + Buffer.from(`opencode:${s.password}`).toString("base64"), "content-type": "application/json" };
}

/** True when the service answers GET /api/info with 200 inside `ms`. */
export async function serviceHealthy(s: ServiceInfo, ms = 2000): Promise<boolean> {
  try {
    const r = await fetch(`${s.url}/api/info`, { headers: headers(s), signal: AbortSignal.timeout(ms) });
    return r.status === 200;
  } catch { return false; }
}

/** POST a JSON body to the service. Returns ok plus a short detail for the log. */
export async function servicePost(s: ServiceInfo, path: string, body: unknown, ms = 10_000): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(`${s.url}${path}`, { method: "POST", headers: headers(s), body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    const t = (await r.text()).slice(0, 200);
    return { ok: r.status >= 200 && r.status < 300, detail: `http ${r.status} ${t}` };
  } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
}

/** Nudge: POST the prompt to the service. null means "service not usable, fall back to the CLI". */
export async function nudgeViaService(session: string, body: unknown): Promise<{ ok: boolean; detail: string } | null> {
  const s = readService();
  if (!s || !(await serviceHealthy(s))) return null;
  return servicePost(s, `/api/session/${session}/prompt`, body);
}

/** `opencode --version` without colour codes ("2.4.1"), or null. */
export function cliVersion(bin = Bun.which("opencode", { PATH: process.env.PATH ?? "" })): string | null {
  if (process.env.ORCH_OPENCODE_CLI_VERSION) return process.env.ORCH_OPENCODE_CLI_VERSION;
  if (!bin) return null;
  const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
  const m = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout.toString().replace(/\x1b\[[0-9;]*m/g, ""));
  return m ? m[1]! : null;
}

function logFile(): string {
  return process.env.ORCH_OPENCODE_LOG || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "log", "opencode.log");
}

/** The last "already in use by PID" line of the opencode log written within `withinMs`, or null. Reads the last 256 KB. */
export function recentPortConflict(withinMs = 3_600_000, now = Date.now()): string | null {
  const f = logFile();
  try {
    if (!existsSync(f)) return null;
    const size = statSync(f).size;
    const len = Math.min(size, 262_144);
    const fd = openSync(f, "r");
    const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    const lines = buf.toString("utf8").split("\n").filter((l) => /cli process failed/.test(l) && /already in use by PID/.test(l));
    const last = lines[lines.length - 1];
    if (!last) return null;
    const ts = /timestamp=(\S+)/.exec(last)?.[1];
    const at = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(at) && now - at > withinMs) return null;
    return /already in use by PID (\d+)/.exec(last)?.[0] ?? "already in use by PID";
  } catch { return null; }
}

/** One-line problem text with the fix, or null when the service is fine or absent. */
export function serviceProblem(): string | null {
  const s = readService();
  const cli = cliVersion();
  if (s && cli && s.version && s.version !== cli) return `opencode service is stale: service ${s.version}, cli ${cli}. Fix: ${STALE_FIX}`;
  const c = recentPortConflict();
  if (c) return `opencode service start fails (${c}). Fix: ${STALE_FIX}`;
  return null;
}

export interface ServiceModel { providerID: string; id: string; baseURL: string }

/** The models the service serves (GET /api/model), or null when it does not answer. */
export async function serviceModels(ms = 3000): Promise<ServiceModel[] | null> {
  const s = readService();
  if (!s) return null;
  try {
    const r = await fetch(`${s.url}/api/model`, { headers: headers(s), signal: AbortSignal.timeout(ms) });
    if (r.status !== 200) return null;
    const j: any = await r.json();
    const list: any[] = Array.isArray(j?.data) ? j.data : [];
    return list
      .filter((m) => typeof m?.id === "string" && typeof m?.providerID === "string" && m.enabled !== false)
      .map((m) => ({ providerID: m.providerID, id: m.id, baseURL: String(m.settings?.baseURL ?? "") }));
  } catch { return null; }
}

/** Shared service usable for nodes: registered, healthy, same version as the CLI. */
export async function sharedServiceUsable(): Promise<boolean> {
  if (process.env.ORCH_OPENCODE_SHARED === "0") return false;
  const s = readService();
  if (!s || !(await serviceHealthy(s))) return false;
  const cli = cliVersion();
  return !!cli && cli === s.version;
}
