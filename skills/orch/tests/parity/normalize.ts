// normalize.ts <home-dir>: prints the normalized state tree of an orch home, for parity diffs (P2).
// Masks only: timestamps, run ids, pids, job ids, durations. JSON keys are sorted. Nothing else changes.
// Bun built-ins only. Skips .trash (trash is an audit area, not state).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MASKS: Array<[RegExp, string]> = [
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?/g, "<TS>"],
  [/\d{8}-\d{6}-[0-9a-f]{4}/g, "<RUN>"],
  [/\bj-[0-9a-zA-Z_-]+/g, "<JOB>"],
  [/("pid"\s*:\s*)\d+/g, "$1<PID>"],
  [/("[a-z_]*(?:duration|elapsed|_ms|_sec|_secs|_seconds)"\s*:\s*)-?\d+(\.\d+)?/g, "$1<DUR>"],
];

function mask(text: string): string {
  let out = text;
  for (const [re, rep] of MASKS) out = out.replace(re, rep);
  return out;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortKeys((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

function normalizeContent(rel: string, raw: string): string {
  if (rel.endsWith(".json")) {
    try {
      return mask(JSON.stringify(sortKeys(JSON.parse(raw)), null, 2));
    } catch {
      return mask(raw);
    }
  }
  if (rel.endsWith(".jsonl")) {
    return raw
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return mask(JSON.stringify(sortKeys(JSON.parse(l))));
        } catch {
          return mask(l);
        }
      })
      .join("\n");
  }
  return mask(raw);
}

function walk(dir: string, root: string, acc: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".trash") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, acc);
    else acc.push(full);
  }
}

export function normalizeTree(home: string): string {
  const files: string[] = [];
  walk(home, home, files);
  const parts: string[] = [];
  for (const f of files) {
    const rel = mask(relative(home, f));
    parts.push(`== ${rel}`, normalizeContent(rel, readFileSync(f, "utf8")));
  }
  return parts.join("\n") + "\n";
}

if (import.meta.main) {
  const home = process.argv[2];
  if (!home) {
    process.stderr.write("usage: normalize.ts <home-dir>\n");
    process.exit(2);
  }
  process.stdout.write(normalizeTree(home));
}
