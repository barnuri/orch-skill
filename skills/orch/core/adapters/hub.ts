// llm-hub native mode helpers. Ported from lib/adapters/hub.sh: the pure profile and role lookups.
// Network calls (hub setup, resolve, status probe) are not ported yet. Bun built-ins only.
import type { Catalog } from "./routing.ts";

export const HUB_MODE = "smart-auto";
export const HUB_PROFILE_SUFFIX = "-smart-auto";
export const SMART_AUTO_TIERS = "efficiency balance intelligence fast".split(" ");
export const HUB_ROLE_TIERS_DEFAULT: Record<string, string> = {
  planning: "intelligence",
  investigation: "balance",
  implementation: "balance",
  validation: "efficiency",
  conversation: "fast",
};

export function hubModeOn(cat: Catalog): boolean {
  return (cat.settings?.llm_hub?.mode ?? "") === HUB_MODE;
}

// The profile every hub-mode node runs on unless it names its own.
export function hubProfile(cat: Catalog): string {
  return `${cat.settings?.llm_hub?.harness || "opencode"}${HUB_PROFILE_SUFFIX}`;
}

// The tier for a role: the configured value when it is a tier, else the default ("" for no role).
export function hubRoleTier(cat: Catalog, role: string): string {
  if (role === "") return "";
  const tier = cat.settings?.llm_hub?.role_tiers?.[role] ?? "";
  if (SMART_AUTO_TIERS.includes(tier)) return tier;
  return HUB_ROLE_TIERS_DEFAULT[role] ?? "";
}

// ---- network and commands (ported from the rest of lib/adapters/hub.sh) ----
import { orchHome, paths } from "../state/home.ts";
import { OrchLock } from "../state/lock.ts";
import { loadRun, saveRun } from "../state/store.ts";
import { loadEnv, type Env } from "./spawn.ts";
import { readCatalog } from "./routing.ts";
import { writeJsonAtomic } from "../state/store.ts";

export const HUB_USAGE = "dispatch.ts hub setup [--harness H] | hub off | hub status | hub resolve <tier> [<role>]";
const HUB_HARNESSES = ["claude", "opencode", "copilot", "pi"];
const HUB_HTTP_TIMEOUT_MS = 5000;

export class HubError extends Error {
  constructor(readonly rc: number, msg: string) {
    super(msg);
  }
}

// hub_api: the hub's answer text; throws on a transport or HTTP error (rc 2 when LLM_HUB_URL is unset).
export async function hubApi(e: Env, method: string, path: string, body?: string): Promise<string> {
  if (!e.LLM_HUB_URL) throw new HubError(2, "hub: LLM_HUB_URL not set\n");
  const headers: Record<string, string> = {};
  if (e.LLM_HUB_KEY) headers.Authorization = `Bearer ${e.LLM_HUB_KEY}`;
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${e.LLM_HUB_URL.replace(/\/+$/, "")}${path}`, { method, headers, body, signal: AbortSignal.timeout(HUB_HTTP_TIMEOUT_MS) }).catch(() => null);
  if (!res || !res.ok) throw new HubError(22, "");
  return await res.text();
}

export async function hubResolveJson(e: Env, tier: string, role = "", worker = ""): Promise<any | null> {
  const body = JSON.stringify({ tier, ...(role ? { role } : {}), ...(worker ? { worker } : {}) });
  try {
    const j = JSON.parse(await hubApi(e, "POST", "/api/smart-auto/resolve", body));
    return j && typeof j === "object" && !Array.isArray(j) && "model" in j ? j : null;
  } catch {
    return null;
  }
}

async function patchNode(home: string, runId: string, nodeId: string, fn: (n: Record<string, any>) => void): Promise<void> {
  const lock = new OrchLock(home, `run-${runId}`);
  for (let i = 0; i < 600 && !(await lock.acquire()); i++) await Bun.sleep(50);
  try {
    const run = await loadRun(home, runId);
    const node = run?.nodes.find((n) => n.id === nodeId);
    if (!run || !node) return;
    fn(node);
    await saveRun(home, runId, run);
  } finally {
    await lock.release();
  }
}

// Before a hub-mode dispatch: records the model the hub expects. Best effort.
export async function hubNodeExpect(runId: string, nodeId: string, tier: string, role: string, worker: string): Promise<number> {
  const home = orchHome();
  const cat = await readCatalog(paths.profiles(home)).catch(() => ({}) as any);
  if (!hubModeOn(cat) || (tier === "" && role === "")) return 0;
  const e = await loadEnv(home);
  const expected = await hubResolveJson(e, tier || "balance", role, worker);
  await patchNode(home, runId, nodeId, (n) => {
    n.hub = { expected, actual: null, outcome: null };
  });
  return 0;
}

// After a hub-mode node ends: records the model the hub used; reports tests_passed for a done node with acceptance checks.
export async function hubNodeSettle(runId: string, nodeId: string, status: string): Promise<number> {
  const home = orchHome();
  const cat = await readCatalog(paths.profiles(home)).catch(() => ({}) as any);
  if (!hubModeOn(cat)) return 0;
  const run = await loadRun(home, runId);
  const node = run?.nodes.find((n) => n.id === nodeId);
  const worker = node?.worker_identity;
  if (!node || !worker) return 0;
  const e = await loadEnv(home);
  let current: any;
  try {
    current = JSON.parse(await hubApi(e, "GET", `/api/smart-auto/current?worker=${encodeURIComponent(worker)}`));
  } catch {
    return 0;
  }
  const m = current?.selection?.main;
  if (!m) return 0;
  const actual = { model: m.model, tier: m.tier, role: m.role, reason: m.reason, state: m.state };
  let code = "";
  if (node.acceptance && m.worker) {
    if (status === "done") {
      code = "tests_passed";
      try {
        await hubApi(e, "POST", "/api/smart-auto/outcome", JSON.stringify({ worker: m.worker, code }));
      } catch {
        code = "";
      }
    }
  }
  await patchNode(home, runId, nodeId, (n) => {
    n.hub = { expected: null, ...(n.hub ?? {}), actual, outcome: code === "" ? null : code };
  });
  return 0;
}

async function settingsWrite(home: string, fn: (cat: any) => void): Promise<boolean> {
  const file = paths.profiles(home);
  try {
    const cat = await readCatalog(file);
    fn(cat);
    await writeJsonAtomic(file, cat);
    return true;
  } catch {
    process.stderr.write(`hub: could not update ${file}\n`);
    return false;
  }
}

async function hubStatus(home: string, e: Env): Promise<number> {
  const cat = await readCatalog(paths.profiles(home));
  const s = cat.settings ?? {};
  const rt = Object.entries(s.llm_hub?.role_tiers ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  process.stdout.write(
    [`mode: ${s.llm_hub?.mode ?? "off"}`, `harness: ${s.llm_hub?.harness ?? "-"}`, `default_profile: ${s.default_profile ?? "-"}`, `planner_profile: ${s.planner_profile ?? "-"}`, `role_tiers: ${rt}`].join("\n") + "\n",
  );
  const url = (e.LLM_HUB_URL ?? "").replace(/\/+$/, "");
  if (!e.LLM_HUB_URL) process.stdout.write("hub: LLM_HUB_URL not set\n");
  else process.stdout.write(`hub: ${url} ${(await hubApi(e, "GET", "/healthz").catch(() => "")) === "ok" ? "ok" : "down"}\n`);
  return 0;
}

async function hubSetup(home: string, e: Env, args: string[]): Promise<number> {
  let harness = "opencode";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--harness") harness = args[++i] ?? "";
    else return (process.stderr.write(`hub setup: unknown argument ${args[i]}\n  usage: ${HUB_USAGE}\n`), 2);
  }
  if (!HUB_HARNESSES.includes(harness)) return (process.stderr.write(`hub setup: --harness must be one of: ${HUB_HARNESSES.join(" ")}\n`), 2);
  if (!e.LLM_HUB_URL) return (process.stderr.write(`hub setup: set LLM_HUB_URL (and LLM_HUB_KEY if the hub needs one) in ${home}/env\n`), 2);
  if ((await hubApi(e, "GET", "/healthz").catch(() => "")) !== "ok") return (process.stderr.write(`hub setup: ${e.LLM_HUB_URL.replace(/\/+$/, "")}/healthz did not answer ok\n`), 1);
  const profile = `${harness}${HUB_PROFILE_SUFFIX}`;
  const cat = await readCatalog(paths.profiles(home));
  if (!cat.profiles?.[profile]) return (process.stderr.write(`profile ${profile}: unknown profile. Available: ${Object.keys(cat.profiles ?? {}).sort().join(", ")}\n`), 2);
  const ok = await settingsWrite(home, (c) => {
    c.settings = c.settings ?? {};
    c.settings.llm_hub = { ...(c.settings.llm_hub ?? {}), mode: HUB_MODE, harness };
    c.settings.llm_hub.role_tiers ??= { ...HUB_ROLE_TIERS_DEFAULT };
    c.settings.default_profile = profile;
    c.settings.planner_profile = profile;
    c.settings.disabled_harnesses = (c.settings.disabled_harnesses ?? []).filter((x: string) => x !== harness);
    c.profiles[profile].enabled = true;
  });
  return ok ? hubStatus(home, e) : 1;
}

export async function cmdHub(args: string[]): Promise<number> {
  const home = orchHome();
  const e = await loadEnv(home);
  switch (args[0]) {
    case "setup": return hubSetup(home, e, args.slice(1));
    case "off":
      return (await settingsWrite(home, (c) => {
        c.settings = c.settings ?? {};
        c.settings.llm_hub = { ...(c.settings.llm_hub ?? {}), mode: "off" };
      }))
        ? hubStatus(home, e)
        : 1;
    case "status": return hubStatus(home, e);
    case "resolve": {
      const tier = args[1] ?? "";
      if (tier === "") return (process.stderr.write(`usage: ${HUB_USAGE}\n`), 2);
      if (!SMART_AUTO_TIERS.includes(tier)) return (process.stderr.write(`hub resolve: tier must be one of: ${SMART_AUTO_TIERS.join(" ")}\n`), 2);
      const j = await hubResolveJson(e, tier, args[2] ?? "");
      if (!j) return (process.stderr.write("hub resolve: the hub gave no pick\n"), 1);
      process.stdout.write(JSON.stringify(j) + "\n");
      return 0;
    }
    default:
      process.stderr.write(`usage: ${HUB_USAGE}\n`);
      return 2;
  }
}
