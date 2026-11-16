// Profile and model routing. Ported from lib/adapters/routing.sh and budget_check (scripts/dispatch.sh).
// Bun built-ins only. Pure over the parsed profiles.json, plus the budget snapshot read.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROFILE_PICK_USAGE = 'dispatch.sh profile pick "<task>" [--complexity trivial|small|medium|large] [--kind K]';
export const MODEL_LIST_USAGE = "dispatch.sh model list [--profile P] [--harness H]";
export const DEFAULT_BUDGET_THRESHOLD = 85;
export const SNAPSHOT_MAX_AGE_SECS = Number(process.env.HARNESS_ORCH_SNAPSHOT_MAX_AGE ?? 900);

export type Catalog = { profiles?: Record<string, any>; models?: Record<string, any>; settings?: Record<string, any> };

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const hasHarness = (m: any, h: string) => Array.isArray(m?.harnesses) && m.harnesses.includes(h);

export async function readCatalog(file: string): Promise<Catalog> {
  return JSON.parse(await readFile(file, "utf8"));
}

// harness_disabled: settings.disabled_harnesses lists the harness.
export function hasHarnessDisabled(cat: Catalog, harness: string): boolean {
  return list(cat.settings?.disabled_harnesses).includes(harness);
}

// settings.<key>, or the default when the key is null or missing (setting_get).
export function setting(cat: Catalog, key: string, dflt: string): string {
  const v = cat.settings?.[key];
  return v === undefined || v === null || v === false ? dflt : String(v);
}

// An allowed_models entry: exact id or slug, or a prefix ending in "*".
export function entryMatches(id: string, slug: string, entry: string): boolean {
  if (entry.endsWith("*")) {
    const pre = entry.slice(0, -1);
    return pre === "" || id.startsWith(pre) || slug.startsWith(pre);
  }
  return entry === id || entry === slug;
}

function modelAllowed(id: string, slug: string, allowed: string[]): boolean {
  return allowed.some((e) => entryMatches(id, slug ?? "", e));
}

// The catalog model for a profile's model field: by id first, then by slug on the profile's harness.
export function modelIdResolve(cat: Catalog, profile: string): string | null {
  const prof = cat.profiles?.[profile];
  if (!prof || !prof.model) return null;
  if (cat.models?.[prof.model]) return prof.model;
  const hit = Object.entries(cat.models ?? {}).find(([, m]) => m.slug === prof.model && hasHarness(m, prof.harness));
  return hit ? hit[0] : null;
}

export function modelSlugResolve(cat: Catalog, profile: string, ref: string): string | null {
  const prof = cat.profiles?.[profile];
  if (!prof) return null;
  if (cat.models?.[ref]) return cat.models[ref].slug;
  const hit = Object.values(cat.models ?? {}).find((m: any) => m.slug === ref && hasHarness(m, prof.harness));
  return hit ? (hit as any).slug : ref;
}

export function modelIdAllowed(cat: Catalog, profile: string, modelId: string): boolean {
  const prof = cat.profiles?.[profile];
  if (!prof) return false;
  const allowed = list(prof.allowed_models);
  if (allowed.length === 0) return true;
  const spec = cat.models?.[modelId];
  return !!spec && modelAllowed(modelId, spec.slug, allowed);
}

// @tsv escaping: backslash, tab, newline and carriage return.
const tsv = (v: unknown) => String(v ?? "").replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");

// model list rows: [id, slug, description, cost, quality] for a profile, a harness, or all models.
export function modelListText(cat: Catalog, profile: string, harness: string): string {
  const models = Object.entries(cat.models ?? {});
  let rows: [string, any][];
  if (profile !== "") {
    const prof = cat.profiles?.[profile];
    if (!prof) return "";
    const allowed = list(prof.allowed_models);
    rows = models.filter(([id, m]) => hasHarness(m, prof.harness) && (allowed.length === 0 || modelAllowed(id, m.slug, allowed)));
  } else {
    rows = models.filter(([, m]) => harness === "" || hasHarness(m, harness));
  }
  return rows.map(([id, m]) => [id, m.slug, m.description, m.cost, m.quality].map(tsv).join("\t") + "\n").join("");
}

const RANK: Record<string, number> = { trivial: 1, small: 2, medium: 3, large: 4 };
const rank = (x: string) => RANK[x] ?? 3;

function inBand(p: any, c: string): boolean {
  return (p.min_complexity ? rank(c) >= rank(p.min_complexity) : true) && (p.max_complexity ? rank(c) <= rank(p.max_complexity) : true);
}

function costScore(p: any, budgetOk: boolean): number {
  const cost = p.cost ?? "subscription";
  if (!budgetOk) return ({ free: 0, low: 1, subscription: 4, metered: 3, high: 5 } as Record<string, number>)[cost] ?? 3;
  return ({ free: 2, low: 1, subscription: 0, metered: 1, high: 3 } as Record<string, number>)[cost] ?? 0;
}

function memoryBoost(mem: any[], name: string, kind: string): number {
  return mem.filter((e) => e.profile === name && e.outcome === "success" && (kind === "" || (e.task_kind ?? "") === kind)).length;
}

// profile pick: the lowest score wins. Returns the output lines, or null when no profile is available.
export function profilePick(cat: Catalog, mem: any[], complexity: string, kind: string, budgetOk: boolean): string[] | null {
  const disabled = list(cat.settings?.disabled_harnesses);
  const scored = Object.entries(cat.profiles ?? {})
    .filter(([, p]) => p.enabled !== false && !disabled.includes(p.harness) && inBand(p, complexity))
    .map(([name, p]) => ({
      name,
      score: memoryBoost(mem, name, kind) * -10 + costScore(p, budgetOk) + (10 - (p.priority ?? 5)),
    }))
    .sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pick = scored[0]?.name ?? setting(cat, "default_profile", "");
  if (!pick) return null;
  const modelId = modelIdResolve(cat, pick);
  let reason = `complexity=${complexity}`;
  if (kind) reason += ` kind=${kind}`;
  if (!budgetOk) reason += " budget_tight";
  const out = [`profile=${pick}`];
  if (modelId) out.push(`model=${modelId}`);
  out.push(`reason=${reason}`);
  return out;
}

// budget_check (dispatch.sh): true when every rate-limit window is below the threshold, or when
// no gating applies (no snapshot, stale snapshot, not a subscription account). False = avoid Claude.
export async function budgetCheck(cat: Catalog): Promise<boolean> {
  const threshold = Number(process.env.HARNESS_ORCH_BUDGET_THRESHOLD ?? setting(cat, "budget_threshold", String(DEFAULT_BUDGET_THRESHOLD)));
  const snapFile = process.env.CLAUDE_USAGE_SNAPSHOT ?? join(process.env.HOME || homedir(), ".claude", "usage-snapshot.json");
  let snap: any;
  try {
    snap = JSON.parse(await readFile(snapFile, "utf8"));
  } catch {
    return true;
  }
  if (snap?.api?.type !== "subscription") return true;
  let snapMs = Date.parse(snap.captured_at ?? "");
  if (Number.isNaN(snapMs)) snapMs = (await stat(snapFile)).mtimeMs;
  if ((Date.now() - snapMs) / 1000 > SNAPSHOT_MAX_AGE_SECS) return true;
  for (const w of ["five_hour", "day", "week", "seven_day"]) {
    const pct = snap.rate_limits?.[w]?.used_percentage;
    if (pct === undefined || pct === null || pct === "") continue;
    if (Number(pct) >= threshold) return false;
  }
  return true;
}
