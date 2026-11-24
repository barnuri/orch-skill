// Load-aware scheduling: no new node starts while the 1-minute load average is above settings.max_load (default CPU count x 2).
import { cpus, loadavg } from "node:os";
import { loadProfilesDoc } from "./settings.ts";

/** Injectable reader: tests set ORCH_LOAD_FILE to a file holding the load number. */
export function readLoad(): number {
  const f = process.env.ORCH_LOAD_FILE;
  if (f) { try { const n = Number(require("node:fs").readFileSync(f, "utf8").trim()); if (Number.isFinite(n)) return n; } catch {} }
  return loadavg()[0] ?? 0;
}

export async function maxLoad(home: string): Promise<number> {
  const doc = await loadProfilesDoc(home);
  const raw = String(doc.settings?.max_load ?? "");
  return /^[0-9]+(\.[0-9]+)?$/.test(raw) && Number(raw) > 0 ? Number(raw) : cpus().length * 2;
}

/** `load <n> > <max>` when new nodes must wait, else null. */
export async function loadHold(home: string): Promise<string | null> {
  const load = readLoad();
  const max = await maxLoad(home);
  return load > max ? `load ${load.toFixed(1)} > ${max}` : null;
}

/** Wait for the load to drop (polls every 10 s, up to ORCH_LOAD_WAIT_SEC, default 600). Returns the hold text if still held. */
export async function waitForLoad(home: string): Promise<string | null> {
  const end = Date.now() + Number(process.env.ORCH_LOAD_WAIT_SEC ?? 600) * 1000;
  let h = await loadHold(home);
  while (h && Date.now() < end) { await Bun.sleep(Math.min(10000, Math.max(100, end - Date.now()))); h = await loadHold(home); }
  return h;
}
