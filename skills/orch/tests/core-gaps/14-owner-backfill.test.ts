import { test, expect, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { seedHome, runState, editJson, tempDir, runCmdAsync, DISPATCH, autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

// P23: nodes of a finished run that never got actual model, role, tier and effort are filled once.
test("P23 node bind-owners --run backfills old done nodes once, from the session database and the hub history", async () => {
  const calls: string[] = [];
  const hub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      calls.push(`${u.pathname}?worker=${u.searchParams.get("worker") ?? ""}`);
      if (u.pathname === "/api/smart-auto/history" && u.searchParams.get("worker") === "r1/hubjob/1") {
        return Response.json({ events: [{ seq: 1, stage: "solver", state: "completed", model: "copilot/claude-opus-5-5", role: "implementation", tier: "balance", attempt_key: "k1", selected_effort: "high", ts_ms: 1 }] });
      }
      return Response.json({ events: [] });
    },
  });
  try {
    const dir = tempDir("orch-p23-");
    const db = join(dir, "opencode.db");
    const d = new Database(db);
    d.run(`create table session_v2 (id text primary key, parent_id text, title text, model text, cost real default 0, tokens_input integer default 0,
      tokens_output integer default 0, tokens_reasoning integer default 0, tokens_cache_read integer default 0, tokens_cache_write integer default 0,
      time_created integer, time_updated integer, time_busy integer, time_idle integer)`);
    d.run("create table session_message (session_id text, type text, seq integer, data text)");
    d.run("insert into session_message values (?,?,?,?)", ["ses_plain1", "assistant", 1, JSON.stringify({ model: { id: "claude-sonnet-5-5", providerID: "copilot" } })]);
    d.close();

    const home = seedHome();
    const env = { ORCH_OPENCODE_DB: db, LLM_HUB_URL: `http://127.0.0.1:${hub.port}`, ORCH_OWNER_BIND_SECS: "0", ORCH_OWNER_CACHE_SECS: "0" };
    const run = async (...args: string[]) => runCmdAsync([process.execPath, DISPATCH, ...args], { home, env });
    await run("run", "start", "Old run", "--id", "r1");
    for (const id of ["hubjob", "plain", "inline", "tiered"]) await run("node", "add", "r1", id, id);
    const old = { status: "done", started: "2026-01-01T00:00:00Z", finished: "2026-01-01T00:10:00Z", actual_model: null, effort: null, role: null, tier: null };
    editJson(join(home, "runs/r1/state.json"), (s) => {
      const set = (id: string, p: Record<string, unknown>) => Object.assign(s.nodes.find((n: any) => n.id === id), old, p);
      set("hubjob", { job_id: "j1", adapter: "opencode", model: "hub/smart-auto-balance", model_id: "hub-smart-auto-balance", session: "00000000-0000-0000-0000-000000000000", attempts: [] });
      set("plain", { adapter: null, model: "copilot/claude-sonnet-5-5", owner_kind: "session", owner_id: "ses_plain1", session: "ses_plain1" });
      set("inline", { adapter: null, model: null });
      set("tiered", { adapter: null, model: "hub/smart-auto-intelligence", model_id: "hub/smart-auto-intelligence" });
    });

    const first = await run("node", "bind-owners", "--run", "r1");
    expect(first.rc).toBe(0);
    const n = (id: string) => runState(home, "r1").nodes.find((x: any) => x.id === id);
    expect([n("hubjob").actual_model, n("hubjob").role, n("hubjob").effort, n("hubjob").tier, n("hubjob").worker_identity, n("hubjob").selections_final]).toEqual(["copilot/claude-opus-5-5", "implementation", "high", "balance", "r1/hubjob/1", true]);
    expect([n("plain").actual_model, n("tiered").tier, n("tiered").actual_model ?? null]).toEqual(["copilot/claude-sonnet-5-5", "intelligence", null]);
    expect([n("inline").actual_model ?? null, n("inline").effort ?? null]).toEqual([null, null]);
    for (const id of ["hubjob", "plain", "inline", "tiered"]) expect(n(id).fill_backfilled).toBe(true);
    expect(first.out).toMatch(/hubjob: backfilled/);
    expect(calls.filter((c) => c.includes("worker=r1/hubjob/1"))).toHaveLength(1);

    // Once: the second pass asks the hub nothing and reports nothing.
    const before = calls.length;
    const second = await run("node", "bind-owners", "--run", "r1");
    expect(second.rc).toBe(0);
    expect(second.out).not.toMatch(/backfilled/);
    expect(calls.length).toBe(before);
  } finally {
    hub.stop(true);
  }
});

test("P23 a node whose hub history is gone is marked done-trying, not asked again, and stays empty", async () => {
  const calls: string[] = [];
  const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (calls.push(new URL(req.url).pathname), Response.json({ events: [] })) });
  try {
    const home = seedHome();
    const env = { ORCH_OPENCODE_DB: join(tempDir("orch-p23-"), "none.db"), LLM_HUB_URL: `http://127.0.0.1:${hub.port}`, ORCH_OWNER_BIND_SECS: "0" };
    const run = async (...args: string[]) => runCmdAsync([process.execPath, DISPATCH, ...args], { home, env });
    await run("run", "start", "Old run", "--id", "r1");
    await run("node", "add", "r1", "gone", "gone");
    editJson(join(home, "runs/r1/state.json"), (s) => { Object.assign(s.nodes[0], { status: "done", job_id: "j1", adapter: "claude", model: "hub/smart-auto-balance", started: "2026-01-01T00:00:00Z", finished: "2026-01-01T00:10:00Z" }); });
    await run("node", "bind-owners", "--run", "r1");
    const node = runState(home, "r1").nodes[0];
    expect([node.fill_backfilled, node.selections_final, node.effort ?? null, node.actual_model ?? null, node.tier]).toEqual([true, true, null, null, "balance"]);
    const asked = calls.length;
    expect(asked).toBeGreaterThan(0);
    await run("node", "bind-owners", "--run", "r1");
    expect(calls.length).toBe(asked);
  } finally {
    hub.stop(true);
  }
});
