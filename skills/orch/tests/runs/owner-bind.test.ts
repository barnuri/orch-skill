import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { orch, seedHome, runState, nodeOf, readJson, readText, editJson, fakeBin, tempDir, ndjson, autoCleanup } from "../helpers";
autoCleanup();
import { existsSync as ex } from "node:fs";

const mk = (extraEnv: Record<string, string> = {}) => {
  const fake = tempDir("orch-bind-");
  const bin = fakeBin({ opencode: `path="$3"
echo "$*" >> "${fake}/calls"
case "$path" in
  /api/session) [ -f "${fake}/children.json" ] && cat "${fake}/children.json" || { echo boom >&2; exit 1; } ;;
  */message) echo '{"data":[{"type":"assistant","time":{},"content":[]}]}' ;;
  /api/session/*) id="\${path#/api/session/}"; [ -f "${fake}/info-$id.json" ] && cat "${fake}/info-$id.json" || { echo 'Error: 404 Not Found' >&2; exit 1; } ;;
esac` });
  const home = seedHome();
  const env: Record<string, string | undefined> = {
    ORCH_OPENCODE_DB: "/nonexistent/opencode.db", PATH: `${bin}:${process.env.PATH}`, ORCH_OWNER_CALL_TIMEOUT: "5", ORCH_OWNER_CACHE_SECS: "0",
    ORCH_OWNER_TOTAL_SECS: "120", ORCH_OWNER_BIND_SECS: "0", ORCH_UNOWNED_SECS: "0", OPENCODE_SESSION_ID: "ses_parent", ...extraEnv,
  };
  const o = orch(home, env);
  const nf = (run: string, id: string) => nodeOf(home, run, id);
  const pend = (child: string, title: string, offsetMs: number) => {
    mkdirSync(join(home, "owners/pending"), { recursive: true });
    writeFileSync(join(home, "owners/pending", `${child}.json`), JSON.stringify({ child, parent: "ses_parent", title, created: "2026-01-01T00:00:00Z", created_ms: Date.now() + offsetMs }));
  };
  const patch = (run: string, id: string, fn: (n: any) => void) => editJson(join(home, "runs", run, "state.json"), (s) => { fn(s.nodes.find((n: any) => n.id === id)); });
  return { fake, home, o, env, nf, pend, patch };
};
const L = (...r: object[]) => ndjson(r);
const runningAgent = (id: string, label: string, owner = "agent (spawned)") => [{ op: "add", id, label }, { op: "update", id, status: "running", owner }];

test("literal, title, time, tie, two nodes", () => {
  let t = mk();
  let R = t.o("run", "start", "bind").out.trim();
  t.o("node", "add", R, "lit", "Literal node");
  t.o("node", "update", R, "lit", "running", "--owner", "agent ses_lit123 (spawned)");
  expect([t.nf(R, "lit").owner_kind, t.nf(R, "lit").owner_id, t.nf(R, "lit").owner_bind, t.nf(R, "lit").owner]).toEqual(["session", "ses_lit123", "literal", "agent ses_lit123 (spawned)"]);
  expect(readJson(join(t.home, "owners/ses_lit123.json")).run).toBe(R);

  t = mk(); R = t.o("run", "start", "bind").out.trim();
  t.o.in(L({ op: "add", id: "speed", label: "Make the test suites faster" }, { op: "add", id: "colours", label: "Restore status colours" },
    { op: "update", id: "speed", status: "running", owner: "agent (spawned)" }, { op: "update", id: "colours", status: "running", owner: "agent (spawned)" }), "node", "batch", R);
  t.pend("ses_c1", "Restore status colours site-wide", 1000); t.pend("ses_c2", "Faster test suites", 2000);
  let out = t.o("node", "bind-owners", "--run", R).out;
  expect(out).toMatch(/speed: bound ses_c2 \(title\)/);
  expect(out).toMatch(/colours: bound ses_c1 \(title\)/);
  expect(readJson(join(t.home, "owners/ses_c2.json")).run).toBe(R);
  expect(t.nf(R, "speed").owner_id).toBe("ses_c2");
  expect(t.o("node", "bind-owners", "--run", R).out.trim()).toBe("");

  t = mk(); R = t.o("run", "start", "bind").out.trim();
  t.o.in(L(...runningAgent("alpha", "Alpha")), "node", "batch", R);
  t.pend("ses_near", "zzz qqq", 5000); t.pend("ses_far", "yyy www", 60000);
  expect(t.o("node", "bind-owners", "--run", R).out).toMatch(/alpha: bound ses_near \(time\)/);

  t = mk(); R = t.o("run", "start", "bind").out.trim();
  t.o.in(L(...runningAgent("alpha", "Alpha")), "node", "batch", R);
  t.pend("ses_t1", "qqq", 4000); t.pend("ses_t2", "www", 4500);
  expect(t.o("node", "bind-owners", "--run", R).out).toMatch(/alpha: unbound/);
  expect(t.nf(R, "alpha").owner_reason).toMatch(/ses_t1.*ses_t2|ses_t2.*ses_t1/);
  expect(t.nf(R, "alpha").owner_state).toBe("unbound");
  expect(ex(join(t.home, "owners/ses_t1.json"))).toBe(false);

  t = mk(); R = t.o("run", "start", "bind").out.trim();
  t.o.in(L(...runningAgent("a1", "Aone"), ...runningAgent("a2", "Atwo")), "node", "batch", R);
  t.pend("ses_one", "qqq", 1000);
  t.o("node", "bind-owners", "--run", R);
  expect(t.nf(R, "a1").owner_reason).toMatch(/also fits node/);
});

test("listing-title, unowned, fill, copilot", () => {
  let t = mk();
  let R = t.o("run", "start", "bind").out.trim();
  t.o.in(L(...runningAgent("speed", "Make the test suites faster")), "node", "batch", R);
  const nowS = Math.floor(Date.now() / 1000);
  writeFileSync(join(t.fake, "children.json"), JSON.stringify({ data: [
    { id: "ses_k1", parentID: "ses_parent", title: "test suites speedup", time: { created: nowS * 1000 + 3000 } },
    { id: "ses_old", parentID: "ses_parent", title: "test suites", time: { created: (nowS - 3600) * 1000 } },
    { id: "ses_other", parentID: "ses_zzz", title: "test suites", time: { created: nowS * 1000 + 3000 } }] }));
  expect(t.o("node", "bind-owners", "--run", R).out).toMatch(/speed: bound ses_k1 \(listing-title\)/);

  t = mk(); R = t.o("run", "start", "bind").out.trim();
  t.o.in(L({ op: "add", id: "x", label: "X node" }, { op: "add", id: "y", label: "Y node" }, { op: "update", id: "x", status: "running", owner: "agent (spawned)" }, { op: "update", id: "y", status: "running" }), "node", "batch", R);
  t.o("node", "bind-owners", "--run", R);
  expect(t.nf(R, "x").owner_reason).toMatch(/listing unavailable/);
  expect(t.nf(R, "y").unowned).toBe(true);
  expect(t.nf(R, "y").owner_reason).toMatch(/running without an owner/);
  const unowned = () => readText(join(t.home, "runs", R, "events.jsonl")).split("\n").filter((l) => l.includes('"unowned"')).length;
  expect(unowned()).toBe(1);
  t.o("node", "bind-owners", "--run", R);
  expect(unowned()).toBe(1);

  t = mk(); R = t.o("run", "start", "bind").out.trim();
  t.o.in(L({ op: "add", id: "f1", label: "Fill one" }, { op: "add", id: "f2", label: "Fill two" }, { op: "update", id: "f1", status: "running", owner: "ses_fill1" },
    { op: "update", id: "f2", status: "running", owner: "ses_fill2" }, { op: "report", id: "f2", model: "coordinator-model", input_tokens: 7, usd: 0.5 }), "node", "batch", R);
  for (const s of ["fill1", "fill2"]) writeFileSync(join(t.fake, `info-ses_${s}.json`), JSON.stringify({ data: { id: `ses_${s}`, model: { id: "prov/real-model" }, cost: 1.25, tokens: { input: 900, output: 100 }, time: { created: nowS * 1000, updated: nowS * 1000 } } }));
  t.o("node", "bind-owners", "--run", R);
  const f1 = t.nf(R, "f1"), f2 = t.nf(R, "f2");
  expect([f1.model, f1.report.input_tokens, f1.report.output_tokens, f1.report.usd, f1.harness, f1.last_activity != null]).toEqual(["prov/real-model", 900, 100, 1.25, "opencode", true]);
  expect([f2.model, f2.report.input_tokens, f2.report.usd, f2.report.output_tokens ?? null]).toEqual(["coordinator-model", 7, 0.5, null]);

  const cp = tempDir("orch-cp-");
  t = mk({ ORCH_COPILOT_SESSION_DIR: cp }); R = t.o("run", "start", "copilot").out.trim();
  mkdirSync(join(cp, "11111111-2222-3333-4444-555555555555"), { recursive: true });
  writeFileSync(join(cp, "11111111-2222-3333-4444-555555555555/events.jsonl"), [
    '{"type":"session.start","data":{"selectedModel":"auto"}}',
    '{"type":"session.usage_record","data":{"usage":{"initiator":"user","model":"gpt-6-luna","responseModel":"gpt-6-luna"}}}',
    '{"type":"session.usage_record","data":{"usage":{"initiator":"agent","model":"gpt-6.1-sol","responseModel":"gpt-6.1-sol"}}}',
    '{"type":"session.usage_record","data":{"usage":{"initiator":"sub-agent","model":"claude-sonnet-5.5","responseModel":"claude-sonnet-5-5"}}}', ""].join("\n"));
  t.o.in(L({ op: "add", id: "cp", label: "Copilot node" }, { op: "update", id: "cp", status: "running", owner: "coordinator" }), "node", "batch", R);
  t.patch(R, "cp", (n) => { n.adapter = "copilot"; n.model = "copilot-auto"; n.session = "11111111-2222-3333-4444-555555555555"; });
  t.o("node", "bind-owners", "--run", R);
  expect([t.nf(R, "cp").actual_model, t.nf(R, "cp").model]).toEqual(["gpt-6.1-sol", "copilot-auto"]);
  t.o.in(L({ op: "add", id: "cq", label: "Copilot no session file" }, { op: "update", id: "cq", status: "running", owner: "coordinator" }), "node", "batch", R);
  t.patch(R, "cq", (n) => { n.adapter = "copilot"; n.session = "99999999-0000-0000-0000-000000000000"; });
  t.o("node", "bind-owners", "--run", R);
  expect(t.nf(R, "cq").actual_model ?? null).toBeNull();
});

const SCHEMA = `create table session_v2 (id text, parent_id text, title text, model text, cost real, tokens_input int, tokens_output int,
  tokens_reasoning int, tokens_cache_read int, tokens_cache_write int, time_created int, time_updated int, time_busy int, time_idle int)`;
const insertSession = (db: Database, id: string, parent: string | null, title: string, model: string, cost: number, created: number, updated: number, busy: boolean, tokens = [100, 20]) =>
  db.run("insert into session_v2 values (?,?,?,?,?,?,?,0,5,0,?,?,?,?)", [id, parent, title, JSON.stringify({ id: model }), cost, tokens[0], tokens[1], created, updated, busy ? updated : null, busy ? null : updated]);

test("session index, stall, umbrella, refresh, final, backfill, co-owners", async () => {
  const t = mk();
  const db = join(t.home, "fixture-opencode.db");
  const d = new Database(db); d.run(SCHEMA);
  const now = Date.now(), old = now - 20 * 60 * 1000;
  insertSession(d, "ses_aaaaaaaaaaaa1XXXXXXXXXXXXX", "ses_root", "prefix work", "prov/m1", 1.5, now, now, true);
  insertSession(d, "ses_bbbbbbbbbbbb1XXXXXXXXXXXXX", "ses_root", "one", "prov/m1", 0, now, now, true);
  insertSession(d, "ses_bbbbbbbbbbbb2XXXXXXXXXXXXX", "ses_root", "two", "prov/m1", 0, now, now, true);
  insertSession(d, "ses_chatXXXXXXXXXXXXXXXXXXXXXX", "ses_other", "Persistent chat turns across restarts", "prov/m1", 0.75, now, now, true);
  insertSession(d, "ses_noiseXXXXXXXXXXXXXXXXXXXXX", "ses_other", "unrelated words entirely", "prov/m1", 0, now, now, true);
  insertSession(d, "ses_stallXXXXXXXXXXXXXXXXXXXXX", "ses_root", "stall", "prov/m2", 0, old, old, false);
  insertSession(d, "ses_busyoldXXXXXXXXXXXXXXXXXXX", "ses_root", "busy old", "prov/m2", 0, old, old, true);
  const o = orch(t.home, { ...t.env, ORCH_OPENCODE_DB: db });
  const nf = t.nf;
  const clearCache = () => Bun.spawnSync(["trash", join(t.home, "owners/cache")]);
  const R = o("run", "start", "index").out.trim();
  o.in(L(
    ...["p1:Prefix node", "amb:Ambiguous node", "chats:Persistent chat turns", "st:Stall node", "bz:Busy node", "x2:Other model", "um:Umbrella one", "mx:Umbrella mixed"].map((s) => ({ op: "add", id: s.split(":")[0], label: s.split(":")[1] })),
    { op: "update", id: "p1", status: "running", owner: "agent ses_aaaaaaaaaaaa1" }, { op: "update", id: "amb", status: "running", owner: "agent ses_bbbbbbbbbbbb" },
    { op: "update", id: "chats", status: "running", owner: "agent restart-chats (spawned)" }, { op: "update", id: "st", status: "running", owner: "ses_stallXXXXXXXXXXXXXXXXXXXXX" },
    { op: "update", id: "bz", status: "running", owner: "ses_busyoldXXXXXXXXXXXXXXXXXXX" }, { op: "update", id: "x2", status: "running", owner: "coordinator" },
    { op: "report", id: "x2", model: "prov/other" }, { op: "update", id: "um", status: "running", owner: "see p1 and chats" }, { op: "update", id: "mx", status: "running", owner: "see p1 and x2" },
  ), "node", "batch", R);
  const out = o("node", "bind-owners", "--run", R).out;
  expect([nf(R, "p1").owner_id, nf(R, "p1").owner_bind]).toEqual(["ses_aaaaaaaaaaaa1XXXXXXXXXXXXX", "prefix"]);
  expect(nf(R, "amb").owner_state).toBe("unbound");
  expect(nf(R, "amb").owner_reason).toMatch(/ambiguous: ses_bbbbbbbbbbbb1X+, ses_bbbbbbbbbbbb2X+/);
  const c = nf(R, "chats");
  expect([c.owner_id, c.owner_bind, c.session, c.model, c.model_id, c.session_stats.cost, c.session_stats.tokens.input, c.report.usd, c.cost.usd, c.cost.cost_basis, c.cost.input_tokens])
    .toEqual(["ses_chatXXXXXXXXXXXXXXXXXXXXXX", "index-title", "ses_chatXXXXXXXXXXXXXXXXXXXXXX", "prov/m1", "prov/m1", 0.75, 100, 0.75, 0.75, "opencode-session", 100]);
  expect(nf(R, "p1").model).toBe("prov/m1");
  expect(nf(R, "st").stalled).toBe(true);
  expect(nf(R, "st").stalled_reason).toMatch(/^no activity since 20/);
  expect(out).toMatch(/st: stalled: no activity since/);
  const stalls = () => readText(join(t.home, "runs", R, "events.jsonl")).split("\n").filter((l) => l.includes('"to":"stalled"')).length;
  expect(stalls()).toBe(1);
  expect(nf(R, "st").status).toBe("running");
  expect(nf(R, "bz").stalled ?? null).toBeNull();
  o("node", "bind-owners", "--run", R);
  expect([nf(R, "um").owner_kind, nf(R, "um").model, nf(R, "um").umbrella_status, nf(R, "mx").model]).toEqual(["umbrella", "prov/m1", "0/2 done", "mixed"]);
  expect(stalls()).toBe(1);

  const later = now + 60000;
  d.run("update session_v2 set cost = 2.5, model = ?, time_updated = ?, time_busy = ? where id = 'ses_chatXXXXXXXXXXXXXXXXXXXXXX'", [JSON.stringify({ id: "prov/changed" }), later, later]);
  clearCache(); o("node", "bind-owners", "--run", R);
  const c2 = nf(R, "chats");
  expect([c2.session_stats.cost, c2.session_stats.duration_s, c2.report.usd, c2.model, c2.cost.usd]).toEqual([2.5, 60, 2.5, "prov/m1", 2.5]);
  o("node", "report", R, "chats", "--usd", "9", "--input-tokens", "1");
  o("node", "bind-owners", "--run", R);
  const c3 = nf(R, "chats");
  expect([c3.cost ?? null, c3.report.usd, c3.session_stats.cost]).toEqual([null, 9, 2.5]);
  t.patch(R, "p1", (n) => { n.attempts = [{ session: "ses_aaaaaaaaaaaa1XXXXXXXXXXXXX", cost: { usd: 1, cost_basis: "opencode-session", input_tokens: 40 } }]; });
  o("node", "bind-owners", "--run", R);
  expect([nf(R, "p1").cost.usd, nf(R, "p1").cost.input_tokens]).toEqual([0.5, 60]);
  d.run("update session_v2 set cost = 3.25 where id = 'ses_aaaaaaaaaaaa1XXXXXXXXXXXXX'");
  clearCache();
  o("node", "update", R, "p1", "done");
  const p1 = nf(R, "p1");
  expect([p1.owner_id, p1.session_stats.final, p1.session_stats.session_total.cost, p1.session_stats.cost, p1.cost.usd]).toEqual(["ses_aaaaaaaaaaaa1XXXXXXXXXXXXX", true, 3.25, 2.25, 2.25]);
  o("node", "add", R, "old", "Old done node");
  o("node", "update", R, "old", "done", "--force");
  t.patch(R, "old", (n) => { n.status = "done"; n.owner_kind = "session"; n.owner_id = "ses_stallXXXXXXXXXXXXXXXXXXXXX"; n.session_stats = null; });
  o("node", "bind-owners", "--run", R);
  expect([nf(R, "old").session_stats.final, nf(R, "old").stalled ?? null]).toEqual([true, null]);
  d.run("update session_v2 set cost = 99 where id = 'ses_stallXXXXXXXXXXXXXXXXXXXXX'");
  clearCache(); o("node", "bind-owners", "--run", R);
  expect(nf(R, "old").session_stats.cost).toBe(0);
  expect([nf(R, "chats").actual_model, nf(R, "chats").model]).toEqual(["prov/changed", "prov/m1"]);

  // report from session, refreshed; explicit --usd wins
  o.in(L({ op: "add", id: "rp", label: "Report node" }, { op: "update", id: "rp", status: "running", owner: "ses_noiseXXXXXXXXXXXXXXXXXXXXX" }), "node", "batch", R);
  d.run("update session_v2 set cost = 1.25 where id = 'ses_noiseXXXXXXXXXXXXXXXXXXXXX'"); clearCache();
  o("node", "bind-owners", "--run", R);
  o("node", "report", R, "rp", "--model", "prov/m1", "--note", "progress");
  expect(nf(R, "rp").report.reported_by).toBe("inline");
  expect(JSON.stringify(nf(R, "rp").report.auto)).toMatch(/"usd"/);
  d.run("update session_v2 set cost = 2.75 where id = 'ses_noiseXXXXXXXXXXXXXXXXXXXXX'"); clearCache();
  o("node", "bind-owners", "--run", R);
  expect([nf(R, "rp").report.usd, nf(R, "rp").cost.usd]).toEqual([2.75, 2.75]);
  o("node", "report", R, "rp", "--usd", "0.4"); o("node", "bind-owners", "--run", R);
  expect([nf(R, "rp").report.usd, nf(R, "rp").cost ?? null]).toEqual([0.4, null]);
  d.run("update session_v2 set cost = 3 where id = 'ses_noiseXXXXXXXXXXXXXXXXXXXXX'"); clearCache();
  o("node", "update", R, "rp", "done");
  expect(nf(R, "rp").report.usd).toBe(0.4);

  // one session owning two nodes in a row
  insertSession(d, "ses_seqXXXXXXXXXXXXXXXXXXXXXXX", "ses_root", "seq", "prov/m1", 4.11, now, now, true, [400, 40]); clearCache();
  o.in(L({ op: "add", id: "seq1", label: "First in a row" }, { op: "add", id: "seq2", label: "Second in a row" }, { op: "update", id: "seq1", status: "running", owner: "ses_seqXXXXXXXXXXXXXXXXXXXXXXX" }), "node", "batch", R);
  o("node", "update", R, "seq1", "done");
  expect(nf(R, "seq1").session_stats.cost).toBe(4.11);
  o("node", "update", R, "seq2", "running", "--owner", "ses_seqXXXXXXXXXXXXXXXXXXXXXXX");
  d.run("update session_v2 set cost = 5.04, tokens_input = 500 where id = 'ses_seqXXXXXXXXXXXXXXXXXXXXXXX'"); clearCache();
  o("node", "bind-owners", "--run", R);
  expect([Math.round(nf(R, "seq2").cost.usd * 100), nf(R, "seq2").cost.input_tokens, nf(R, "seq2").session_stats.baseline.cost, nf(R, "seq1").cost.usd]).toEqual([93, 100, 4.11, 4.11]);
  expect(Math.round((nf(R, "seq1").cost.usd + nf(R, "seq2").cost.usd) * 100)).toBe(504);

  // two nodes at once
  insertSession(d, "ses_dupXXXXXXXXXXXXXXXXXXXXXXX", "ses_root", "dup", "prov/m1", 3, now, now, true, [300, 30]); clearCache();
  o.in(L({ op: "add", id: "dup1", label: "First co-owner" }, { op: "add", id: "dup2", label: "Second co-owner" },
    { op: "update", id: "dup1", status: "running", owner: "ses_dupXXXXXXXXXXXXXXXXXXXXXXX" }, { op: "update", id: "dup2", status: "running", owner: "ses_dupXXXXXXXXXXXXXXXXXXXXXXX" }), "node", "batch", R);
  o("node", "bind-owners", "--run", R); o("node", "bind-owners", "--run", R);
  const dupTotal = () => Math.round((["dup1", "dup2"].map((n) => nf(R, n).cost?.usd ?? 0).reduce((a, b) => a + b, 0)) * 100);
  expect([nf(R, "dup1").cost.usd, nf(R, "dup2").cost.usd, dupTotal()]).toEqual([3, 0, 300]);
  o("node", "update", R, "dup1", "done"); o("node", "update", R, "dup2", "done"); o("node", "bind-owners", "--run", R);
  expect(dupTotal()).toBe(300);

  // smart-auto alias resolved by the hub
  const hubSrc = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const u = new URL(req.url); return Response.json(u.searchParams.get("session") === "ses_autoXXXXXXXXXXXXXXXXXXXXXX" ? { selection: { main: { model: "copilot/claude-opus-5-5", stage: "solver" } } } : { selection: null }); } }); console.log(s.port);`;
  const hubProc = Bun.spawn(["bun", "-e", hubSrc], { stdout: "pipe" });
  const hub = { port: Number((await hubProc.stdout.getReader().read().then((r) => new TextDecoder().decode(r.value))).trim()), stop: (_?: boolean) => hubProc.kill() };
  insertSession(d, "ses_autoXXXXXXXXXXXXXXXXXXXXXX", "ses_root", "auto", "hub/smart-auto-balance", 0, now, now, true, [1, 1]); clearCache();
  o.in(L({ op: "add", id: "auto", label: "Smart Auto node" }, { op: "update", id: "auto", status: "running", owner: "ses_autoXXXXXXXXXXXXXXXXXXXXXX" }), "node", "batch", R);
  o.env({ LLM_HUB_URL: `http://127.0.0.1:${hub.port}` }, "node", "bind-owners", "--run", R);
  expect([nf(R, "auto").model, nf(R, "auto").actual_model]).toEqual(["hub/smart-auto-balance", "copilot/claude-opus-5-5"]);
  hub.stop(true);
  d.close();
}, 300000);

test("bind by job window", () => {
  const t = mk({ ORCH_OWNER_HUB: "0" });
  const db = join(t.home, "fixture-opencode.db");
  const d = new Database(db); d.run(SCHEMA);
  d.run("create table session_message (id text, session_id text, type text, seq int, time_created int, time_updated int, data text)");
  const now = Math.floor(Date.now() / 1000), t1 = now - 120, t2 = now - 3600;
  const rules = "# Shared subagent rules\nA coordinator points each dispatched prompt at this file.";
  const sess = (id: string, created: number, cost: number, model: string, text: string) => {
    d.run("insert into session_v2 values (?, NULL, 't', ?, ?, 1000, 200, 0, 50, 0, ?, ?, NULL, ?)", [id, JSON.stringify({ id: model }), cost, created * 1000, now * 1000, now * 1000]);
    d.run("insert into session_message values (?, ?, 'user', 1, ?, ?, ?)", [`m_${id}`, id, created * 1000, created * 1000, JSON.stringify({ text })]);
  };
  sess("ses_jobBXXXXXXXXXXXXXXXXXXXXXXX", t1 + 2, 0.5, "hub/smart-auto-balance", `${rules}\nTask B: fix the fill.`);
  sess("ses_jobAXXXXXXXXXXXXXXXXXXXXXXX", t1 + 4, 1.25, "hub/smart-auto-balance", `${rules}\nTask A: link jobs.`);
  sess("ses_jobCXXXXXXXXXXXXXXXXXXXXXXX", t1 + 3, 2, "hub/smart-auto-balance", `${rules}\nTask C: done before.`);
  sess("ses_jobDXXXXXXXXXXXXXXXXXXXXXXX", t2 + 3, 0.75, "prov/real", "some other launch text");
  sess("ses_farXXXXXXXXXXXXXXXXXXXXXXXX", t2 - 900, 9, "prov/real", `${rules}\nTask A: link jobs.`);
  d.close();
  const o = orch(t.home, { ...t.env, ORCH_OPENCODE_DB: db, ORCH_OWNER_HUB: "0" });
  const R = o("run", "start", "job bind").out.trim();
  for (const n of ["a", "b", "c", "d"]) o("node", "add", R, n, `Node ${n}`);
  const stamp = (s: number) => new Date(s * 1000).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const jobs: string[] = [];
  const job = (node: string, start: number, status: string, prompt: string, model = "hub/smart-auto-balance") => {
    const id = `${stamp(start)}-pid-1-1-${Math.floor(Math.random() * 30000)}`;
    mkdirSync(join(t.home, "jobs", id), { recursive: true });
    jobs.push(id);
    t.patch(R, node, (n) => { Object.assign(n, { status, job_id: id, owner: id, owner_kind: "job", owner_id: id, model, session: "0af43496-564a-4c0f-b8ae-49ef34198318", prompt: prompt || null }); });
  };
  job("a", t1, "running", `${rules}\nTask A: link jobs.`); job("b", t1, "running", `${rules}\nTask B: fix the fill.`);
  job("c", t1, "done", `${rules}\nTask C: done before.`); job("d", t2, "running", "", "prov/real");
  const before = runState(t.home, R).nodes.map((n: any) => n.job_id).join(",");
  const out = o("node", "bind-owners", "--run", R).out;
  expect(out).toMatch(/a: bound ses_jobAX+ \(job-prompt\)/);
  expect(out).toMatch(/b: bound ses_jobBX+ \(job-prompt\)/);
  expect(out).toMatch(/d: bound ses_jobDX+ \(job-time\)/);
  const nf = t.nf;
  expect([nf(R, "a").owner_id, nf(R, "b").owner_id, nf(R, "c").owner_id]).toEqual(["ses_jobAXXXXXXXXXXXXXXXXXXXXXXX", "ses_jobBXXXXXXXXXXXXXXXXXXXXXXX", "ses_jobCXXXXXXXXXXXXXXXXXXXXXXX"]);
  expect([nf(R, "a").owner_kind, nf(R, "a").owner_bind]).toEqual(["session", "job"]);
  expect(runState(t.home, R).nodes.map((n: any) => n.job_id).join(",")).toBe(before);
  expect(nf(R, "a").session).toBe("0af43496-564a-4c0f-b8ae-49ef34198318");
  expect([nf(R, "a").cost.usd, nf(R, "a").cost.cost_basis, nf(R, "a").cost.input_tokens, nf(R, "a").cost.output_tokens, nf(R, "a").cost.cache_read_tokens]).toEqual([1.25, "opencode-session", 1000, 200, 50]);
  expect([nf(R, "a").session_stats.session, nf(R, "a").tier]).toEqual(["ses_jobAXXXXXXXXXXXXXXXXXXXXXXX", "balance"]);
  expect([nf(R, "c").cost.usd, nf(R, "c").session_stats.final]).toEqual([2, true]);
  expect([nf(R, "d").actual_model, nf(R, "d").tier ?? null]).toEqual(["prov/real", null]);
  expect(nf(R, "a").stalled ?? null).toBeNull();
  o("node", "verify-owners", R);
  expect(nf(R, "a").owner_state ?? null).toBeNull();
  expect(o("node", "bind-owners", "--run", R).out).not.toMatch(/bound/);
  expect(nf(R, "a").owner_id).toBe("ses_jobAXXXXXXXXXXXXXXXXXXXXXXX");
  o("node", "update", R, "a", "done");
  expect([nf(R, "a").owner_kind, nf(R, "a").owner_id]).toEqual(["session", "ses_jobAXXXXXXXXXXXXXXXXXXXXXXX"]);
}, 240000);
