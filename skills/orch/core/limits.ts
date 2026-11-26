// Spend and usage limits that pause a run. Off by default: every limit is optional.
// Settings: profiles.json settings.limits { node_usd, run_usd, session_usd, profile_pct: { <profile>: pct } }.
// A run overrides them with state.json `limits` (same keys; null turns one off for the run) and skips a hit
// with `limits.ignore` (hit keys such as "run_usd", "node_usd:<node>", "profile_pct:<profile>").
// Cost source: the usd orch already records per node (nodeUsage: harness cost, node report, owner-fill session
// stats) and the opencode session cost of the run's main and coordinator sessions. Usage percent: the Claude
// usage snapshot behind `budget-check` (Claude subscription profiles) and the llm-hub Copilot premium quota
// (copilot-harness profiles, one quota group "copilot"). The check reads files, one read-only sqlite query
// and one local HTTP GET: no spawn.
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, stat } from "node:fs/promises";
import { nodeUsage } from "../../../src/shared/run-usage.ts";
import type { RunNode } from "../../../src/shared/types/run-node.ts";
import { snapshotMaxAgeSecs } from "./adapters/routing.ts";

export const USD_KEYS = ["node_usd", "run_usd", "session_usd"] as const;
export type UsdKey = (typeof USD_KEYS)[number];
export type LimitKind = UsdKey | "profile_pct";

export interface Limits {
  node_usd: number | null;
  run_usd: number | null;
  session_usd: number | null;
  profile_pct: Record<string, number>;
}

export interface LimitHit {
  /** node_usd:<node>, run_usd, session_usd:<session>, profile_pct:<profile>. */
  key: string;
  kind: LimitKind;
  limit: number;
  value: number;
  /** Where the limit came from: profiles.json settings or the run's own override. */
  source: "settings" | "run";
  node?: string;
  session?: string;
  profile?: string;
}

export interface LimitInputs {
  /** USD per session id (main and coordinator sessions). */
  sessionUsd: Record<string, number>;
  /** Used percent per profile, null when unknown. */
  profilePct: Record<string, number | null>;
}

type Obj = Record<string, any>;

/** The usd orch recorded for a node (one source per node, see nodeUsage), null when none. */
export const nodeUsd = (n: Obj): number | null => nodeUsage(n as RunNode).usd;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Parses a limit value: a non-negative number, or "off"/"null"/"" for none. Undefined when invalid. */
export function parseLimitValue(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "" || t === "off" || t === "null") return null;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(t)) return undefined;
  return Number(t);
}

/** The settings limits of profiles.json, each one null when unset. */
export function settingsLimits(doc: Obj): Limits {
  const s = (doc?.settings?.limits ?? {}) as Obj;
  const pct: Record<string, number> = {};
  for (const [p, v] of Object.entries((s.profile_pct ?? {}) as Obj)) if (num(v) !== null) pct[p] = v as number;
  return { node_usd: num(s.node_usd), run_usd: num(s.run_usd), session_usd: num(s.session_usd), profile_pct: pct };
}

/** Effective limits of a run with the source of each one. A run key set to null turns the setting off. */
export function effectiveLimits(doc: Obj, run: Obj): { limits: Limits; source: Record<string, "settings" | "run"> } {
  const base = settingsLimits(doc);
  const own = (run?.limits ?? {}) as Obj;
  const source: Record<string, "settings" | "run"> = {};
  const limits: Limits = { node_usd: base.node_usd, run_usd: base.run_usd, session_usd: base.session_usd, profile_pct: { ...base.profile_pct } };
  for (const k of USD_KEYS) {
    if (base[k] !== null) source[k] = "settings";
    if (k in own) {
      limits[k] = num(own[k]);
      source[k] = "run";
    }
  }
  for (const p of Object.keys(base.profile_pct)) source[`profile_pct:${p}`] = "settings";
  for (const [p, v] of Object.entries((own.profile_pct ?? {}) as Obj)) {
    if (num(v) === null) delete limits.profile_pct[p];
    else limits.profile_pct[p] = v as number;
    source[`profile_pct:${p}`] = "run";
  }
  return { limits, source };
}

export const anyLimit = (l: Limits): boolean =>
  l.node_usd !== null || l.run_usd !== null || l.session_usd !== null || Object.keys(l.profile_pct).length > 0;

/** The run's main session and its coordinator session, when they are real session ids. */
export function runSessions(run: Obj): string[] {
  const ids = [run?.harness_session, run?.coordinator?.session_id].map((v) => String(v ?? "")).filter((v) => v !== "" && !v.startsWith("pid-"));
  return [...new Set(ids)];
}

/** Profiles of the run's nodes that may still start work: waiting, running, or error (a retry). */
export function activeProfiles(run: Obj): string[] {
  const ps: string[] = (run?.nodes ?? []).filter((n: Obj) => ["waiting", "running", "error"].includes(n.status)).map((n: Obj) => String(n.profile ?? ""));
  return [...new Set(ps.filter((p: string) => p !== ""))];
}

/** The quota group a profile draws on: every copilot-harness profile shares the llm-hub Copilot quota ("copilot"). */
export function quotaGroup(name: string, doc: Obj): string {
  return String(doc?.profiles?.[name]?.harness ?? "") === "copilot" ? "copilot" : name;
}

/** Quota groups of the run's nodes that may still start work. */
export function activeGroups(run: Obj, doc: Obj): string[] {
  return [...new Set(activeProfiles(run).map((p) => quotaGroup(p, doc)))];
}

/** Every limit the run reaches now, minus the ones in `limits.ignore`. Pure. */
export function evaluateLimits(run: Obj, doc: Obj, inputs: LimitInputs): LimitHit[] {
  const { limits, source } = effectiveLimits(doc, run);
  const hits: LimitHit[] = [];
  const round = (v: number) => Math.round(v * 10000) / 10000;
  if (limits.node_usd !== null) {
    for (const n of run.nodes ?? []) {
      const usd = nodeUsd(n);
      if (usd !== null && usd >= limits.node_usd) {
        hits.push({ key: `node_usd:${n.id}`, kind: "node_usd", limit: limits.node_usd, value: round(usd), source: source.node_usd ?? "settings", node: String(n.id) });
      }
    }
  }
  if (limits.run_usd !== null) {
    const total = (run.nodes ?? []).reduce((a: number, n: Obj) => a + (nodeUsd(n) ?? 0), 0);
    if (total >= limits.run_usd) hits.push({ key: "run_usd", kind: "run_usd", limit: limits.run_usd, value: round(total), source: source.run_usd ?? "settings" });
  }
  if (limits.session_usd !== null) {
    for (const s of runSessions(run)) {
      const usd = inputs.sessionUsd[s];
      if (usd !== undefined && usd >= limits.session_usd) {
        hits.push({ key: `session_usd:${s}`, kind: "session_usd", limit: limits.session_usd, value: round(usd), source: source.session_usd ?? "settings", session: s });
      }
    }
  }
  const used = activeGroups(run, doc);
  for (const [p, lim] of Object.entries(limits.profile_pct)) {
    const pct = inputs.profilePct[p];
    if (!used.includes(p) || pct === null || pct === undefined || pct < lim) continue;
    hits.push({ key: `profile_pct:${p}`, kind: "profile_pct", limit: lim, value: pct, source: source[`profile_pct:${p}`] ?? "settings", profile: p });
  }
  const ignore = new Set<string>(Array.isArray(run.limits?.ignore) ? run.limits.ignore.map(String) : []);
  return hits.filter((h) => !ignore.has(h.key) && !ignore.has(h.kind));
}

/** One line for events, the orchestrator message and the CLI. */
export function hitText(h: LimitHit): string {
  const money = (v: number) => `$${v.toFixed(2)}`;
  switch (h.kind) {
    case "node_usd": return `node ${h.node} spent ${money(h.value)} of its ${money(h.limit)} node limit`;
    case "run_usd": return `run spent ${money(h.value)} of its ${money(h.limit)} run limit`;
    case "session_usd": return `session ${h.session} spent ${money(h.value)} of its ${money(h.limit)} session limit`;
    case "profile_pct": return `profile ${h.profile} is at ${h.value}% usage (limit ${h.limit}%)`;
  }
}

// ---- inputs (files and one read-only sqlite query) ----------------------------------------------------

/** Cost of opencode sessions from its local database. Missing ids are left out. */
export async function sessionCosts(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0 || process.env.ORCH_OWNER_INDEX === "0") return {};
  const { opencodeDbPath } = await import("./commands/owners.ts");
  const file = opencodeDbPath();
  try {
    await stat(file);
    const { Database } = await import("bun:sqlite");
    const db = new Database(file, { readonly: true });
    try {
      const rows = db.query(`select id, cost from session_v2 where id in (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; cost: number | null }>;
      return Object.fromEntries(rows.map((r) => [r.id, Number(r.cost ?? 0)]));
    } finally {
      db.close();
    }
  } catch {
    return {};
  }
}

/** True for a profile that runs on the Claude subscription the usage snapshot describes. */
export function claudeSubscriptionProfile(p: Obj | undefined): boolean {
  if (!p) return false;
  return ["claude", "claude-native"].includes(String(p.harness ?? "")) && !p.env?.ANTHROPIC_BASE_URL;
}

/** Highest used percent of the Claude usage snapshot (the `budget-check` data), null when missing or stale. */
export async function claudeUsedPct(): Promise<number | null> {
  const file = process.env.CLAUDE_USAGE_SNAPSHOT ?? join(process.env.HOME || homedir(), ".claude", "usage-snapshot.json");
  let snap: Obj;
  try {
    snap = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  if (snap?.api?.type !== "subscription") return null;
  let at = Date.parse(snap.captured_at ?? "");
  if (Number.isNaN(at)) at = (await stat(file)).mtimeMs;
  if ((Date.now() - at) / 1000 > snapshotMaxAgeSecs()) return null;
  const pcts = ["five_hour", "day", "week", "seven_day"].map((w) => snap.rate_limits?.[w]?.used_percentage).filter((v) => v !== undefined && v !== null && v !== "").map(Number);
  return pcts.length === 0 ? null : Math.max(...pcts);
}

/** The llm-hub profile whose Copilot quota the copilot group reads. */
const copilotHubProfile = (): string => process.env.LLM_HUB_COPILOT_PROFILE || "copilot";

/** Used percent of a quota pair, null when either number is missing or the entitlement is not positive. */
const usedPct = (used: unknown, entitlement: unknown): number | null => {
  const u = Number(used), e = Number(entitlement);
  return Number.isFinite(u) && Number.isFinite(e) && e > 0 ? (u / e) * 100 : null;
};

/** premium_interactions used percent from the llm-hub live usage API (LLM_HUB_URL), null when it fails. */
async function copilotLivePct(): Promise<number | null> {
  const base = process.env.LLM_HUB_URL;
  if (!base) return null;
  const url = `${base.replace(/\/+$/, "")}/api/copilot/usage?profile=${encodeURIComponent(copilotHubProfile())}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const body = (await res.json()) as Obj;
    const q = ((body?.quotas ?? []) as Obj[]).find((x) => x?.id === "premium_interactions");
    return q ? usedPct(q.used, q.entitlement) : null;
  } catch {
    return null;
  }
}

/** premium_interactions used percent from the newest llm-hub quota_snapshots row (LLM_HUB_DB), null when missing or stale. */
async function copilotStoredPct(): Promise<number | null> {
  const file = process.env.LLM_HUB_DB || process.env.LLM_HUB_STORE_PATH;
  if (!file) return null;
  try {
    await stat(file);
    const { Database } = await import("bun:sqlite");
    const db = new Database(file, { readonly: true });
    try {
      const row = db.query("select ts_ms, used, entitlement from quota_snapshots where profile = 'copilot' and quota = 'premium_interactions' order by ts_ms desc limit 1").get() as Obj | null;
      if (!row || (Date.now() - Number(row.ts_ms)) / 1000 > snapshotMaxAgeSecs()) return null;
      return usedPct(row.used, row.entitlement);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Used percent of the Copilot premium quota: the live llm-hub API first, its stored snapshot second. Null when both fail. */
export async function copilotUsedPct(): Promise<number | null> {
  return (await copilotLivePct()) ?? (await copilotStoredPct());
}

/** Inputs for the limits in force: nothing is read for a limit that is off. */
export async function readLimitInputs(run: Obj, doc: Obj, limits: Limits): Promise<LimitInputs> {
  const sessionUsd = limits.session_usd !== null ? await sessionCosts(runSessions(run)) : {};
  const profilePct: Record<string, number | null> = {};
  const wanted = Object.keys(limits.profile_pct).filter((g) => activeGroups(run, doc).includes(g));
  for (const g of wanted) {
    if (g === "copilot") profilePct[g] = await copilotUsedPct();
    else profilePct[g] = claudeSubscriptionProfile(doc.profiles?.[g]) ? await claudeUsedPct() : null;
  }
  return { sessionUsd, profilePct };
}
