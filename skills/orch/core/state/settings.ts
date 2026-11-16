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

export function maxParallelCapFrom(doc: Doc): number {
  const v = String(doc.defaults?.max_parallel ?? doc.settings?.max_parallel ?? "");
  return /^[0-9]+$/.test(v) && Number(v) >= 1 ? Number(v) : 15;
}

export async function settingUint(home: string, key: string, dflt: number): Promise<number> {
  return settingUintFrom(await loadDoc(home), key, dflt);
}

export async function maxParallelCap(home: string): Promise<number> {
  return maxParallelCapFrom(await loadDoc(home));
}

export { loadDoc as loadProfilesDoc };
