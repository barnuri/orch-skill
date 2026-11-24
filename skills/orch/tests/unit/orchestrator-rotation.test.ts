import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, utimesSync } from "node:fs";
import { Database } from "bun:sqlite";
import { DISPATCH, seedHome, runCmd, editJson, tempDir, autoCleanup } from "../helpers";
import { is1mModel, latestPromptTokens } from "../../core/commands/coordinator.ts";
import { rotationCandidates, startOrchestratorRotation } from "../../../../src/server/watchdog/orchestrator-rotation.ts";
autoCleanup();

// A fake opencode.db with the two tables latestPromptTokens reads.
function fakeDb(rows: Array<{ session: string; seq: number; type?: string; tokens?: { input: number; read: number; write: number } | null }>): string {
  const path = join(tempDir("orch-usage-"), "opencode.db");
  const d = new Database(path);
  d.run("create table session_message (session_id text, type text, seq integer, data text)");
  for (const r of rows) {
    const data = r.tokens === null ? { role: "assistant" } : { tokens: { input: r.tokens?.input ?? 0, cache: { read: r.tokens?.read ?? 0, write: r.tokens?.write ?? 0 } } };
    d.run("insert into session_message values (?,?,?,?)", [r.session, r.type ?? "assistant", r.seq, JSON.stringify(data)]);
  }
  d.close();
  return path;
}

test("is1mModel matches only ids ending in [1m]", () => {
  expect(is1mModel("hub/claude-haiku-5-5[1m]")).toBe(true);
  expect(is1mModel("hub/claude-sonnet-5-5")).toBe(false);
  expect(is1mModel("hub/copilot/mai-code-2-flash")).toBe(false);
});

test("latestPromptTokens sums input and cache of the newest assistant message", () => {
  const db = fakeDb([
    { session: "ses_abc", seq: 1, tokens: { input: 10, read: 1000, write: 0 } },
    { session: "ses_abc", seq: 2, tokens: { input: 5, read: 150000, write: 300 } },
    { session: "ses_abc", seq: 3, type: "user", tokens: null },
    { session: "ses_other", seq: 9, tokens: { input: 1, read: 1, write: 1 } },
  ]);
  expect(latestPromptTokens("ses_abc", db)).toBe(150305);
  expect(latestPromptTokens("ses_none", db)).toBeNull();
  expect(latestPromptTokens("ses_abc", join(tempDir(), "missing.db"))).toBeNull();
  expect(latestPromptTokens("bad id; drop", db)).toBeNull();
});

test("orchestrator check: rotates at the threshold, refuses [1m] without the setting, honours the cooldown", () => {
  const home = seedHome();
  const env = (db: string) => ({ ORCH_OPENCODE_DB: db, ORCH_OWNER_FILL: "0" });
  const o = (db: string, ...a: string[]) => runCmd([process.execPath, DISPATCH, ...a], { home, env: env(db) });
  const R = runCmd([process.execPath, DISPATCH, "run", "start", "check run"], { home, env: {} }).out.trim();
  editJson(join(home, "profiles.json"), (d) => { d.settings = { ...(d.settings ?? {}), coordinator_model: "llm-hub/test-model", coordinator_rotate_tokens: 1000 }; });
  const dir = join(home, "runs", R, "coordinator-handoffs");

  // No coordinator registered: nothing to check.
  const db = fakeDb([{ session: "ses_coord1", seq: 1, tokens: { input: 900, read: 0, write: 0 } }]);
  expect(o(db, "orchestrator", "check", R).out).toBe("no session\n");

  // Register a coordinator session in state.
  editJson(join(home, "runs", R, "state.json"), (s) => { s.coordinator = { transport: "session", pane_id: "", session_id: "ses_coord1", unreachable: null }; });
  expect(o(db, "orchestrator", "check", R).out).toBe("ok: 900 < 1000\n");

  // Above the threshold: handoff written, fresh orchestrator started (dry run prints argv).
  const hot = fakeDb([{ session: "ses_coord1", seq: 1, tokens: { input: 1200, read: 0, write: 0 } }]);
  const hi = o(hot, "orchestrator", "check", R, "--dry-run");
  expect(hi.rc).toBe(0);
  expect(hi.out).toMatch(/^rotate: 1200 >= 1000/);
  expect(readdirSync(dir).length).toBe(1);

  // Second check inside the cooldown does not rotate again.
  const again = o(hot, "orchestrator", "check", R, "--dry-run");
  expect(again.out).toMatch(/^cooldown:/);
  expect(readdirSync(dir).length).toBe(1);

  // Cooldown over: rotates again.
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  expect(o(hot, "orchestrator", "check", R, "--dry-run").out).toMatch(/^rotate:/);

  // Unknown usage source: unknown, never rotates.
  expect(o(join(tempDir(), "missing.db"), "orchestrator", "check", R, "--dry-run").out).toBe("unknown\n");

  // [1m] orchestrator model: refused, and no handoff written. Age the handoffs so the cooldown does not answer first.
  for (const f of readdirSync(dir)) utimesSync(join(dir, f), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  editJson(join(home, "profiles.json"), (d) => { d.settings.coordinator_model = "hub/claude-haiku-5-5[1m]"; });
  const before = readdirSync(dir).length;
  const refused = o(hot, "orchestrator", "check", R, "--dry-run");
  expect(refused.rc).toBe(2);
  expect(readdirSync(dir).length).toBe(before);
  const start = o(hot, "orchestrator", "start", R, "--dry-run");
  expect(start.rc).toBe(2);
  expect(start.err).toMatch(/\[1m\]/);

  // The setting allows it.
  editJson(join(home, "profiles.json"), (d) => { d.settings.coordinator_allow_1m = true; });
  expect(o(hot, "orchestrator", "start", R, "--dry-run").rc).toBe(0);
}, 60_000);

test("rotation candidates: running, unpaused, with a coordinator session only", () => {
  const home = seedHome();
  const mk = (id: string, state: Record<string, unknown>) => {
    const d = join(home, "runs", id);
    require("node:fs").mkdirSync(d, { recursive: true });
    require("node:fs").writeFileSync(join(d, "state.json"), JSON.stringify(state));
  };
  mk("a", { status: "running", coordinator: { session_id: "ses_a" } });
  mk("b", { status: "running", paused: true, coordinator: { session_id: "ses_b" } });
  mk("c", { status: "done", coordinator: { session_id: "ses_c" } });
  mk("d", { status: "running", coordinator: null });
  mk("e", { status: "running", stopped: true, coordinator: { session_id: "ses_e" } });
  expect(rotationCandidates(home)).toEqual(["a"]);
});

test("rotation timer runs one check per candidate and does not stack a busy run", async () => {
  const home = seedHome();
  const calls: string[][] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const run = async (args: string[]) => { calls.push(args); await gate; return 0; };
  const mkRun = (id: string) => {
    const d = join(home, "runs", id);
    require("node:fs").mkdirSync(d, { recursive: true });
    require("node:fs").writeFileSync(join(d, "state.json"), JSON.stringify({ status: "running", coordinator: { session_id: "ses_x" } }));
  };
  mkRun("r1");
  const stop = startOrchestratorRotation(home, { run, everyMs: 10 });
  await new Promise((r) => setTimeout(r, 60));
  stop();
  release();
  expect(calls).toEqual([["orchestrator", "check", "r1"]]);
});
