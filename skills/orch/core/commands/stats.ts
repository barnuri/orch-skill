// `orch stats context [--json] [--run <id>]`: peak context per model over every node that has `session_stats.peak_context`.
import { orchHome } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { paths } from "../state/home.ts";
import { nodeUsage } from "../../../../src/shared/run-usage.ts";

export const STATS_CONTEXT_USAGE = "stats context [--json] [--run <run-id>]";
export const CONTEXT_LIMITS = [100_000, 150_000, 200_000] as const;

export interface ContextRow {
  model: string;
  nodes: number;
  median: number;
  p90: number;
  max: number;
  over_100k: number;
  over_150k: number;
  over_200k: number;
  usd: number;
  usd_over_200k: number;
  cost_share_over_200k: number;
}

const pct = (sorted: number[], p: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!);

// Nodes without a peak (no opencode session, or not fetchable) are skipped and counted in `without_peak`.
export function contextStats(nodes: any[]): { rows: ContextRow[]; total: ContextRow | null; without_peak: number } {
  const groups = new Map<string, { peak: number; usd: number }[]>();
  let without = 0;
  for (const n of nodes) {
    const peak = n.session_stats?.peak_context;
    if (typeof peak !== "number") { without++; continue; }
    const model = String(n.actual_model ?? n.model_id ?? n.model ?? "unknown");
    const g = groups.get(model) ?? [];
    g.push({ peak, usd: nodeUsage(n).usd ?? 0 });
    groups.set(model, g);
  }
  const row = (model: string, g: { peak: number; usd: number }[]): ContextRow => {
    const s = g.map((x) => x.peak).sort((a, b) => a - b);
    const usd = g.reduce((a, x) => a + x.usd, 0);
    const over = g.filter((x) => x.peak > 200_000).reduce((a, x) => a + x.usd, 0);
    return {
      model, nodes: g.length, median: pct(s, 0.5), p90: pct(s, 0.9), max: s[s.length - 1] ?? 0,
      over_100k: s.filter((v) => v > 100_000).length, over_150k: s.filter((v) => v > 150_000).length, over_200k: s.filter((v) => v > 200_000).length,
      usd: Math.round(usd * 100) / 100, usd_over_200k: Math.round(over * 100) / 100, cost_share_over_200k: usd > 0 ? Math.round((over / usd) * 1000) / 1000 : 0,
    };
  };
  const rows = [...groups].map(([m, g]) => row(m, g)).sort((a, b) => b.nodes - a.nodes || a.model.localeCompare(b.model));
  const all = [...groups.values()].flat();
  return { rows, total: all.length ? row("ALL", all) : null, without_peak: without };
}

const k = (v: number) => `${Math.round(v / 1000)}k`;

export function formatContextTable(r: ReturnType<typeof contextStats>): string {
  const head = ["model", "nodes", "median", "p90", "max", ">100k", ">150k", ">200k", "usd", "usd>200k", "share>200k"];
  const body = [...r.rows, ...(r.total ? [r.total] : [])].map((x) => [
    x.model, String(x.nodes), k(x.median), k(x.p90), k(x.max), String(x.over_100k), String(x.over_150k), String(x.over_200k),
    `$${x.usd.toFixed(2)}`, `$${x.usd_over_200k.toFixed(2)}`, `${(x.cost_share_over_200k * 100).toFixed(1)}%`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === 0 ? v.padEnd(w[i]!) : v.padStart(w[i]!))).join("  ");
  return [line(head), ...body.map(line), `${r.without_peak} nodes without peak_context (skipped)`].join("\n") + "\n";
}

export async function statsContext(args: string[]): Promise<number> {
  let json = false, only = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--run" && args[i + 1]) only = args[++i]!;
    else { process.stderr.write(`usage: ${STATS_CONTEXT_USAGE}\n`); return 2; }
  }
  const home = orchHome();
  const ids = only ? [only] : (await readdir(paths.runs(home)).catch(() => [] as string[])).filter((n) => existsSync(paths.runState(home, n))).sort();
  const nodes: any[] = [];
  for (const id of ids) nodes.push(...((await loadRun(home, id))?.nodes ?? []));
  const res = contextStats(nodes);
  process.stdout.write(json ? JSON.stringify({ runs: ids.length, ...res }, null, 2) + "\n" : formatContextTable(res));
  return 0;
}
