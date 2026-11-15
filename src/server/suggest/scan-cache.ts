import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { dispatchPath } from "../dispatch-path";

export const SCAN_CACHE_MS: number = 300_000;

export interface ScanResult {
  ok: boolean;
  output: string;
  error: string;
}

interface Entry {
  at: number;
  sig: string;
  result: ScanResult;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<ScanResult>>();

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Everything a scan reads or writes: a change to any file makes the cached scan stale at once. */
export function scanSignature(home: string): string {
  const parts: number[] = [
    mtime(join(home, "profiles.json")),
    mtime(join(home, "memory.json")),
    mtime(join(home, "suggestions.json")),
  ];
  try {
    for (const id of readdirSync(join(home, "runs")).sort()) {
      parts.push(mtime(join(home, "runs", id, "state.json")));
    }
  } catch {
    // no runs directory yet
  }
  return parts.join(",");
}

async function runScan(home: string): Promise<ScanResult> {
  const proc = Bun.spawn(["bash", dispatchPath(), "suggest", "scan"], {
    env: { ...process.env, HARNESS_ORCH_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, output: out.trim(), error: err.trim() || out.trim() || `dispatch exited ${code}` };
}

/**
 * Scan the home for suggestions without blocking the server. A scan whose inputs did not change
 * (same signature) within SCAN_CACHE_MS is answered from memory; concurrent callers share one run.
 */
export function scanSuggestions(home: string, force = false): Promise<ScanResult> {
  const hit = cache.get(home);
  if (!force && hit !== undefined && Date.now() - hit.at < SCAN_CACHE_MS && hit.sig === scanSignature(home)) {
    return Promise.resolve(hit.result);
  }
  const running = inflight.get(home);
  if (running !== undefined) {
    return running;
  }
  const sigBefore = scanSignature(home);
  const p = runScan(home)
    .then((result) => {
      if (result.ok) {
        cache.set(home, { at: Date.now(), sig: sigBefore, result });
      } else {
        cache.delete(home);
      }
      return result;
    })
    .finally(() => {
      inflight.delete(home);
    });
  inflight.set(home, p);
  return p;
}

export function clearScanCache(): void {
  cache.clear();
}
