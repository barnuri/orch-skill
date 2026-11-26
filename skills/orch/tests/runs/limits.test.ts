import { test, expect } from "bun:test";
import { orch, seedHome, runState, nodeOf, autoCleanup } from "../helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { evaluateLimits, effectiveLimits, parseLimitValue, readLimitInputs, hitText, copilotUsedPct } from "../../core/limits.ts";
autoCleanup();

function setup(id: string) {
  const home = seedHome(), o = orch(home);
  o("run", "start", "Limits", "--id", id);
  o("node", "add", id, "a", "goal a");
  o("node", "add", id, "b", "goal b");
  return { home, o };
}

test("no limits: spend never pauses", () => {
  const { home, o } = setup("lim-0");
  o("node", "report", "lim-0", "a", "--usd", "50");
  expect(o("run", "sync", "lim-0", "--no-retry").rc).toBe(0);
  expect(runState(home, "lim-0").paused ?? false).toBe(false);
});

test("run_usd pauses the run, resume --raise clears it", () => {
  const { home, o } = setup("lim-1");
  expect(o("limits", "set", "run_usd", "2", "--run", "lim-1").rc).toBe(0);
  o("node", "report", "lim-1", "a", "--usd", "1.5");
  o("node", "report", "lim-1", "b", "--usd", "1");
  o("run", "sync", "lim-1", "--no-retry");
  const st = runState(home, "lim-1");
  expect(st.paused).toBe(true);
  expect(st.limit_hit.key).toBe("run_usd");
  expect(st.limit_hit.value).toBe(2.5);
  expect(o("limits", "resume", "lim-1", "--raise", "2").rc).toBe(2);
  expect(o("limits", "resume", "lim-1", "--raise", "10").rc).toBe(0);
  const after = runState(home, "lim-1");
  expect(after.paused ?? false).toBe(false);
  expect(after.limits.run_usd).toBe(10);
  o("run", "sync", "lim-1", "--no-retry");
  expect(runState(home, "lim-1").paused ?? false).toBe(false);
});

test("node_usd marks the node and --ignore resumes", () => {
  const { home, o } = setup("lim-2");
  expect(o("limits", "set", "node_usd", "1", "--run", "lim-2").rc).toBe(0);
  o("node", "report", "lim-2", "a", "--usd", "1.2");
  o("run", "sync", "lim-2", "--no-retry");
  expect(runState(home, "lim-2").paused).toBe(true);
  expect(nodeOf(home, "lim-2", "a").limit_reached.limit).toBe(1);
  expect(o("limits", "resume", "lim-2", "--ignore").rc).toBe(0);
  expect(runState(home, "lim-2").limits.ignore).toContain("node_usd:a");
  o("run", "sync", "lim-2", "--no-retry");
  expect(runState(home, "lim-2").paused ?? false).toBe(false);
});

test("settings limits and show/clear", () => {
  const { home, o } = setup("lim-3");
  expect(o("limits", "set", "run_usd", "1").rc).toBe(0);
  expect(o("limits", "show").out).toMatch(/run_usd: 1/);
  o("node", "report", "lim-3", "a", "--usd", "3");
  expect(o("limits", "show", "--run", "lim-3").out).toMatch(/reached: run spent \$3.00/);
  o("run", "sync", "lim-3", "--no-retry");
  expect(runState(home, "lim-3").paused).toBe(true);
  expect(o("limits", "clear").rc).toBe(0);
  expect(o("limits", "show").out).toMatch(/run_usd: off/);
  expect(o("limits", "set", "bogus", "1").rc).toBe(2);
});

test("session_usd and profile_pct (pure)", () => {
  const run = { harness_session: "ses_main", nodes: [{ id: "a", status: "waiting", profile: "p1" }], limits: { session_usd: 5 } };
  const doc = { settings: { limits: { profile_pct: { p1: 85 } } } };
  const hits = evaluateLimits(run, doc, { sessionUsd: { ses_main: 6 }, profilePct: { p1: 90 } });
  expect(hits.map((h) => h.key).sort()).toEqual(["profile_pct:p1", "session_usd:ses_main"]);
  expect(evaluateLimits(run, doc, { sessionUsd: { ses_main: 4 }, profilePct: { p1: 80 } })).toEqual([]);
  const off = { ...run, limits: { profile_pct: { p1: null } } };
  expect(effectiveLimits(doc, off).limits.profile_pct).toEqual({});
  expect([parseLimitValue("off"), parseLimitValue("2.5"), parseLimitValue("-1")]).toEqual([null, 2.5, undefined]);
});

test("profile_pct copilot: live llm-hub API, then the stored snapshot when the API is down", async () => {
  const saved = { url: process.env.LLM_HUB_URL, db: process.env.LLM_HUB_DB };
  const hub = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/copilot/usage" && u.searchParams.get("profile") === "copilot")
        return Response.json({ profile: "copilot", quotas: [{ id: "premium_interactions", used: 90, entitlement: 100 }] });
      return new Response("not found", { status: 404 });
    },
  });
  const doc = { profiles: { "copilot-llm-hub": { harness: "copilot" } }, settings: { limits: { profile_pct: { copilot: 90 } } } };
  const run = { nodes: [{ id: "a", status: "waiting", profile: "copilot-llm-hub" }] };
  try {
    process.env.LLM_HUB_URL = `http://127.0.0.1:${hub.port}`;
    const inputs = await readLimitInputs(run, doc, effectiveLimits(doc, run).limits);
    expect(inputs.profilePct.copilot).toBe(90);
    const hits = evaluateLimits(run, doc, inputs);
    expect(hits.map((h) => h.key)).toEqual(["profile_pct:copilot"]);
    expect(hitText(hits[0]!)).toMatch(/profile copilot is at 90% usage \(limit 90%\)/);
  } finally {
    hub.stop(true);
  }

  // API down: the newest quota_snapshots row (45 of 100) answers, not the older one (10 of 100).
  const dir = mkdtempSync(join(tmpdir(), "limits-copilot-"));
  const file = join(dir, "hub.db");
  const db = new Database(file);
  db.run("create table quota_snapshots (ts_ms integer, profile text, quota text, used real, entitlement real)");
  db.run("insert into quota_snapshots values (?, 'copilot', 'premium_interactions', 10, 100)", [Date.now() - 3_600_000]);
  db.run("insert into quota_snapshots values (?, 'copilot', 'premium_interactions', 45, 100)", [Date.now() - 1000]);
  db.close();
  try {
    process.env.LLM_HUB_URL = "http://127.0.0.1:9";
    process.env.LLM_HUB_DB = file;
    expect(await copilotUsedPct()).toBe(45);
    const inputs = await readLimitInputs(run, doc, effectiveLimits(doc, run).limits);
    expect(evaluateLimits(run, doc, inputs)).toEqual([]);
  } finally {
    if (saved.url === undefined) delete process.env.LLM_HUB_URL; else process.env.LLM_HUB_URL = saved.url;
    if (saved.db === undefined) delete process.env.LLM_HUB_DB; else process.env.LLM_HUB_DB = saved.db;
  }
});
