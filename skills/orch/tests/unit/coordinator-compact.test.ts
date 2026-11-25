import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { DISPATCH, seedHome, runCmd, editJson, tempDir, autoCleanup } from "../helpers";
import {
  AUTOCOMPACT_COOLDOWN_MS, autocompactCheck, autocompactEnabledFrom, autocompactVerdict, compactIdempotencyId, compactNotice,
  requestCompaction, sessionInFlight, type AutocompactRecord, type CompactRoutes,
} from "../../core/commands/coordinator-compact.ts";
autoCleanup();

const NOW = Date.parse("2026-11-25T12:00:00Z");
const rec = (minsAgo: number, ok: boolean, armed: boolean): AutocompactRecord => ({ at: new Date(NOW - minsAgo * 60_000).toISOString(), tokens: 900_000, result: "x", ok, armed });

// Routes that record the order they were tried in.
function routes(o: { standalone?: boolean; service?: { ok: boolean; detail: string } | null; terminal?: { via: string } | { why: string } }, calls: string[]): CompactRoutes {
  return {
    standalone: async () => o.standalone ?? false,
    service: async (id) => { calls.push(`service ${id}`); return o.service ?? null; },
    terminal: async () => { calls.push("terminal"); return o.terminal ?? { why: "no terminal" }; },
  };
}

// A fake opencode.db: one assistant message per row, with tokens and time.
function fakeDb(rows: Array<{ session: string; seq: number; tokens?: number; time?: Record<string, number> }>): string {
  const path = join(tempDir("orch-compact-"), "opencode.db");
  const d = new Database(path);
  d.run("create table session_message (session_id text, type text, seq integer, data text)");
  for (const r of rows) {
    const data = { ...(r.tokens === undefined ? {} : { tokens: { input: r.tokens, cache: { read: 0, write: 0 } } }), ...(r.time ? { time: r.time } : {}) };
    d.run("insert into session_message values (?,?,?,?)", [r.session, "assistant", r.seq, JSON.stringify(data)]);
  }
  d.close();
  return path;
}

test("autocompact verdict: threshold, cooldown and re-arm", () => {
  expect(autocompactVerdict(999, 1000, null, NOW)).toBe("below");
  expect(autocompactVerdict(1000, 1000, null, NOW)).toBe("compact");
  expect(autocompactVerdict(5000, 1000, rec(10, false, true), NOW)).toBe("cooldown");
  expect(autocompactVerdict(5000, 1000, rec(10, true, true), NOW)).toBe("cooldown");
  expect(autocompactVerdict(5000, 1000, rec(AUTOCOMPACT_COOLDOWN_MS / 60_000 + 1, true, false), NOW)).toBe("not re-armed");
  expect(autocompactVerdict(5000, 1000, rec(31, true, true), NOW)).toBe("compact");
  // A failed request stays armed: it is retried once the cooldown ends.
  expect(autocompactVerdict(5000, 1000, rec(31, false, true), NOW)).toBe("compact");
});

test("autocompact setting, idempotency id and notice", () => {
  expect(autocompactEnabledFrom({})).toBe(true);
  expect(autocompactEnabledFrom({ settings: { coordinator_autocompact: true } })).toBe(true);
  expect(autocompactEnabledFrom({ settings: { coordinator_autocompact: false } })).toBe(false);
  expect(compactIdempotencyId("r1", 812_345)).toBe("orch-compact-r1-810000");
  expect(compactIdempotencyId("r1", 815_000)).toBe("orch-compact-r1-820000");
  const n = compactNotice("r1", 812_345, 200_000);
  expect(n).toMatch(/^orch compacted this session at 812k tokens \(threshold 200k\)\. Each turn re-reads the whole context/);
  expect(n).toContain("orch orchestrator rotate r1 --tokens 812345");
});

test("requestCompaction: service first, terminal fallback, failure with both reasons", async () => {
  let calls: string[] = [];
  expect(await requestCompaction(routes({ service: { ok: true, detail: "http 200" } }, calls), "id1")).toEqual({ ok: true, via: "service" });
  expect(calls).toEqual(["service id1"]);

  calls = [];
  expect(await requestCompaction(routes({ service: null, terminal: { via: "herdr-terminal" } }, calls), "id1")).toEqual({ ok: true, via: "herdr-terminal" });
  expect(calls).toEqual(["service id1", "terminal"]);

  calls = [];
  const failed = await requestCompaction(routes({ service: { ok: false, detail: "http 404 no session" }, terminal: { why: "the recorded terminal is gone" } }, calls), "id1");
  expect(failed).toEqual({ ok: false, why: "service: http 404 no session; terminal: the recorded terminal is gone" });
});

test("requestCompaction: a standalone TUI gets the terminal first", async () => {
  const calls: string[] = [];
  expect(await requestCompaction(routes({ standalone: true, service: { ok: true, detail: "" }, terminal: { via: "hc-terminal" } }, calls), "id")).toEqual({ ok: true, via: "hc-terminal" });
  expect(calls).toEqual(["terminal"]);
});

test("sessionInFlight: an unfinished recent assistant message only", () => {
  const db = fakeDb([
    { session: "ses_busy", seq: 1, tokens: 10, time: { created: NOW - 60_000, completed: NOW - 50_000 } },
    { session: "ses_busy", seq: 2, time: { created: NOW - 5_000 } },
    { session: "ses_idle", seq: 1, tokens: 10, time: { created: NOW - 60_000, completed: NOW - 50_000 } },
    { session: "ses_stale", seq: 1, time: { created: NOW - 2 * 3_600_000 } },
  ]);
  expect(sessionInFlight("ses_busy", NOW, db)).toBe(true);
  expect(sessionInFlight("ses_idle", NOW, db)).toBe(false);
  expect(sessionInFlight("ses_stale", NOW, db)).toBe(false);
  expect(sessionInFlight("ses_none", NOW, db)).toBe(false);
  expect(sessionInFlight("bad id", NOW, db)).toBe(false);
});

test("orchestrator check on a person-started session: setting, dry run, failure, cooldown", () => {
  const home = seedHome();
  const o = (db: string, ...a: string[]) => runCmd([process.execPath, DISPATCH, ...a], { home, env: { ORCH_OPENCODE_DB: db, ORCH_OWNER_FILL: "0" } });
  const R = runCmd([process.execPath, DISPATCH, "run", "start", "compact run"], { home, env: {} }).out.trim();
  editJson(join(home, "profiles.json"), (d) => { d.settings = { ...(d.settings ?? {}), coordinator_rotate_tokens: 1000 }; });
  const state = join(home, "runs", R, "state.json");
  editJson(state, (s) => { s.coordinator = { transport: "session", pane_id: "", session_id: "ses_person1", unreachable: null, started_by: "person" }; });
  const hot = fakeDb([{ session: "ses_person1", seq: 1, tokens: 812_000 }]);

  expect(o(fakeDb([{ session: "ses_person1", seq: 1, tokens: 900 }]), "orchestrator", "check", R).out).toBe("person-started: ok: 900 < 1000\n");
  expect(o(hot, "orchestrator", "check", R, "--dry-run").out).toBe("person-started: would compact at 812k\n");

  editJson(join(home, "profiles.json"), (d) => { d.settings.coordinator_autocompact = false; });
  expect(o(hot, "orchestrator", "check", R).out).toBe("not orch-started: no rotation, autocompact off\n");
  editJson(join(home, "profiles.json"), (d) => { d.settings.coordinator_autocompact = true; });

  // No service (the test env points at a missing service.json) and no terminal: the attempt fails and is recorded.
  const fail = o(hot, "orchestrator", "check", R);
  expect(fail.out).toMatch(/^person-started: compact failed at 812k: service: not available; terminal: /);
  const s1 = JSON.parse(readFileSync(state, "utf8"));
  expect(s1.coordinator.autocompact).toMatchObject({ tokens: 812_000, ok: false, armed: true });
  expect(readFileSync(join(home, "runs", R, "events.jsonl"), "utf8")).toContain("orchestrator autocompact: compact failed at 812k");

  // Inside 30 min: no new attempt.
  expect(o(hot, "orchestrator", "check", R).out).toMatch(/^person-started: cooldown at 812k/);
}, 60_000);

test("autocompactCheck: compacts once, tells the session, waits for a reading below the threshold", async () => {
  process.env.ORCH_OPENCODE_SERVICE_JSON = join(tmpdir(), "orch-test-no-service.json");
  process.env.ORCH_OPENCODE_DB = join(tmpdir(), "orch-test-no-opencode.db");
  const home = seedHome();
  const R = runCmd([process.execPath, DISPATCH, "run", "start", "compact ok"], { home, env: {} }).out.trim();
  const state = join(home, "runs", R, "state.json");
  editJson(state, (s) => { s.coordinator = { transport: "session", pane_id: "", session_id: "ses_person2", unreachable: null, started_by: "person" }; });
  const calls: string[] = [];
  const base = { home, run: R, sessionId: "ses_person2", threshold: 200_000, dry: false };
  const last = (): AutocompactRecord | null => JSON.parse(readFileSync(state, "utf8")).coordinator.autocompact ?? null;

  const line = await autocompactCheck({ ...base, tokens: 812_000, last: null, nowMs: Date.now() }, routes({ service: { ok: true, detail: "http 200" } }, calls));
  expect(line).toBe("person-started: compacted at 812k via service");
  expect(calls).toEqual([`service orch-compact-${R}-810000`]);
  expect(last()).toMatchObject({ tokens: 812_000, ok: true, armed: false });
  const inbox = runCmd([process.execPath, DISPATCH, "node", "inbox", R, "orch"], { home, env: {} }).all;
  expect(inbox).toContain("orch compacted this session at 812k tokens (threshold 200k)");

  // After the cooldown, still above the threshold: no second compaction until a reading below it.
  const later = Date.now() + AUTOCOMPACT_COOLDOWN_MS + 60_000;
  expect(await autocompactCheck({ ...base, tokens: 820_000, last: last(), nowMs: later }, routes({}, calls))).toMatch(/^person-started: not re-armed at 820k/);
  expect(await autocompactCheck({ ...base, tokens: 50_000, last: last(), nowMs: later }, routes({}, calls))).toBe("person-started: ok: 50000 < 200000");
  expect(last()?.armed).toBe(true);
  expect(await autocompactCheck({ ...base, tokens: 300_000, last: last(), nowMs: later }, routes({ terminal: { via: "herdr-terminal" } }, calls))).toBe("person-started: compacted at 300k via herdr-terminal");
  expect(calls.at(-1)).toBe("terminal");
}, 60_000);
