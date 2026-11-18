import { test, expect } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { contextStats, formatContextTable } from "../../core/commands/stats.ts";
import { sessionPeaks } from "../../core/commands/owners.ts";
import { tempDir } from "../helpers";

const node = (model: string, peak: number | undefined, usd: number) => ({
  model, cost: { usd, cost_basis: "x" },
  session_stats: peak === undefined ? null : { session: "ses_x", peak_context: peak },
});

test("contextStats: per-model percentiles, thresholds, cost share over 200k, skips nodes without a peak", () => {
  const r = contextStats([node("a", 50_000, 1), node("a", 120_000, 1), node("a", 210_000, 2), node("a", undefined, 5), node("b", 160_000, 4)]);
  expect(r.without_peak).toBe(1);
  const a = r.rows.find((x) => x.model === "a")!;
  expect([a.nodes, a.median, a.max, a.over_100k, a.over_150k, a.over_200k, a.usd, a.usd_over_200k, a.cost_share_over_200k]).toEqual([3, 120_000, 210_000, 2, 1, 1, 4, 2, 0.5]);
  expect(r.total).toMatchObject({ model: "ALL", nodes: 4, over_150k: 2, over_200k: 1 });
  expect(formatContextTable(r)).toContain("share>200k");
  expect(contextStats([]).total).toBeNull();
});

test("sessionPeaks: max/avg of input+cache_read+cache_write over assistant messages, steps counted", () => {
  const dir = tempDir("orch-peaks-");
  const db = join(dir, "opencode.db");
  const d = new Database(db);
  d.run("create table session_message (session_id text, type text, seq integer, data text)");
  const add = (seq: number, type: string, tokens: any) => d.run("insert into session_message values (?,?,?,?)", ["ses_p1", type, seq, JSON.stringify(tokens === null ? {} : { tokens })]);
  add(1, "assistant", { input: 100, output: 5, cache: { read: 1000, write: 50 } });
  add(2, "assistant", { input: 10, output: 5, cache: { read: 3000, write: 0 } });
  add(3, "user", null);
  add(4, "assistant", null);
  d.close();
  process.env.ORCH_OPENCODE_DB = db;
  try {
    expect(sessionPeaks(["ses_p1", "ses_none", "bad id"])).toEqual({ ses_p1: { peak_context: 3010, steps: 2, avg_context: 2080 } });
    expect(sessionPeaks([])).toEqual({});
  } finally {
    delete process.env.ORCH_OPENCODE_DB;
  }
});
