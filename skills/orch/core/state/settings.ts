// Shared settings readers over profiles.json. Same rules as setting_get / setting_uint / max_parallel_cap in config.sh.
import { paths } from "./home.ts";
import { readJson } from "./store.ts";

type Doc = { settings?: Record<string, any>; defaults?: Record<string, any>; profiles?: Record<string, any> };

async function loadDoc(home: string): Promise<Doc> {
  return readJson<Doc>(paths.profiles(home)).catch(() => ({}));
}

export function settingFrom(doc: Doc, key: string, dflt: string): string {
  const v = doc.settings?.[key];
  return v === undefined || v === null ? dflt : String(v);
}

// The setting when it is a positive integer, else the default.
export function settingUintFrom(doc: Doc, key: string, dflt: number): number {
  const v = settingFrom(doc, key, String(dflt));
  return /^[0-9]+$/.test(v) && Number(v) >= 1 ? Number(v) : dflt;
}

export const UNLIMITED_PARALLEL = -1;
/** The global cap when profiles.json sets none. */
export const DEFAULT_MAX_PARALLEL = 30;

/** Global cap: defaults.max_parallel, then settings.max_parallel. Infinity for -1 (unlimited). */
export function maxParallelCapFrom(doc: Doc): number {
  const raw = doc.defaults?.max_parallel ?? doc.settings?.max_parallel;
  if (raw === UNLIMITED_PARALLEL || raw === String(UNLIMITED_PARALLEL)) return Number.POSITIVE_INFINITY;
  const v = String(raw ?? "");
  return /^[0-9]+$/.test(v) && Number(v) >= 1 ? Number(v) : DEFAULT_MAX_PARALLEL;
}

/** Effective cap of one run: min(global, per-run). Per-run -1, null or unset is no per-run limit. */
export function runCapFrom(globalCap: number, runMax: number | null | undefined): number {
  if (typeof runMax !== "number" || runMax === UNLIMITED_PARALLEL) return globalCap;
  return Math.min(globalCap, Number.isInteger(runMax) && runMax >= 1 ? runMax : globalCap);
}

export async function settingUint(home: string, key: string, dflt: number): Promise<number> {
  return settingUintFrom(await loadDoc(home), key, dflt);
}

export async function maxParallelCap(home: string): Promise<number> {
  return maxParallelCapFrom(await loadDoc(home));
}

/** Effective cap of a run (Infinity when unlimited on both levels). */
export async function runCap(home: string, runMax: number | null | undefined): Promise<number> {
  return runCapFrom(await maxParallelCap(home), runMax);
}

export { loadDoc as loadProfilesDoc };
