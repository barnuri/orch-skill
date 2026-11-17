import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { orch, seedHome, runState, nodeOf, readJson, readText, fakeBin, tempDir, ndjson, autoCleanup, trashSync, DISPATCH } from "../helpers";
autoCleanup();

const setup = () => {
  const fake = tempDir("orch-live-");
  mkdirSync(join(fake, "modes"), { recursive: true });
  const bin = fakeBin({ opencode: `id=$(printf '%s' "$3" | sed -E 's#/api/session/([^/]+)/message#\\1#')
echo "$id" >> "${fake}/calls"
mode=$(cat "${fake}/modes/$id" 2>/dev/null || echo error)
case "$mode" in
  idle) echo '{"data":[{"type":"assistant","time":{"completed":1},"content":[{"type":"text","text":"all done, tests pass"}]}]}' ;;
  busy) echo '{"data":[{"type":"assistant","time":{},"content":[]}]}' ;;
  404) echo 'Error: 404 Not Found' >&2; exit 1 ;;
  slow) exec sleep 8 ;;
  *) echo 'boom' >&2; exit 1 ;;
esac` });
  const mode = (id: string, m: string) => writeFileSync(join(fake, "modes", id), m + "\n");
  const home = seedHome();
  const env = { ORCH_OPENCODE_DB: "/nonexistent/opencode.db", PATH: `${bin}:${process.env.PATH}`, ORCH_OWNER_CALL_TIMEOUT: "5", ORCH_OWNER_CACHE_SECS: "0", ORCH_OWNER_TOTAL_SECS: "120" };
  return { fake, mode, home, env, o: orch(home, env), calls: () => readText(join(fake, "calls")) };
};

test("verify-owners classifies and applies", () => {
  const { fake, mode, home, o, calls } = setup();
  const R = o("run", "start", "liveness").out.trim();
  const nd = (id: string) => nodeOf(home, R, id);
  o.in(ndjson(["idle", "busy", "gone", "err", "slow", "pid", "dead", "coord", "none"].map((n) => ({ op: "add", id: n, label: n }))), "node", "batch", R);
  mode("ses_idle", "idle"); mode("ses_busy", "busy"); mode("ses_gone", "404"); mode("ses_err", "error"); mode("ses_slow", "slow");
  o("node", "update", R, "idle", "running", "--owner", "agent ses_idle");
  const live = Bun.spawn(["sleep", "900"]);
  o.in(ndjson([
    { op: "update", id: "busy", status: "running", owner: "ses_busy" }, { op: "update", id: "gone", status: "running", owner: "ses_gone" },
    { op: "update", id: "err", status: "running", owner: "ses_err" }, { op: "update", id: "slow", status: "running", owner: "ses_slow" },
    { op: "update", id: "pid", status: "running", owner: `pid:${live.pid}` }, { op: "update", id: "dead", status: "running", owner: "pid:999999" },
    { op: "update", id: "coord", status: "running", owner: "coordinator" }, { op: "update", id: "none", status: "running" },
  ]), "node", "batch", R);
  expect([nd("idle").owner_kind, nd("idle").owner_id]).toEqual(["session", "ses_idle"]);
  expect(readJson(join(home, "owners/ses_idle.json")).run).toBe(R);
  let out = JSON.parse(o("node", "verify-owners", R, "--no-apply", "--json").out);
  expect(out.find((x: any) => x.node === "idle").owner_state).toBe("idle");
  expect(nd("idle").status).toBe("running");
  expect(out.filter((x: any) => x.node === "coord").length).toBe(0);
  out = JSON.parse(o("node", "verify-owners", R, "--json").out);
  const st = (n: string) => out.find((x: any) => x.node === n).owner_state;
  expect([st("idle"), st("busy"), st("gone"), st("err"), st("slow"), st("pid"), st("dead")]).toEqual(["idle", "alive", "gone", "unknown", "unknown", "alive", "gone"]);
  expect([nd("idle").status, nd("idle").owner_state]).toEqual(["running", "idle"]);
  expect(nd("idle").owner_idle_since).toBeTruthy();
  expect(nd("idle").owner_note).toMatch(/all done, tests pass/);
  expect([nd("idle").unverified ?? null, nd("idle").report ?? null]).toEqual([null, null]);
  expect([nd("gone").status, nd("gone").error]).toEqual(["error", "owner ses_gone is gone"]);
  expect(nd("dead").status).toBe("error");
  expect([nd("busy").status, nd("busy").owner_state]).toEqual(["running", "alive"]);
  expect([nd("err").status, nd("err").owner_state]).toEqual(["running", "unknown"]);
  expect([nd("coord").status, nd("none").status]).toEqual(["running", "running"]);
  const ev = readText(join(home, "runs", R, "events.jsonl")).split("\n").filter(Boolean);
  expect(ev.filter((l) => l.includes('"by":"owner-liveness"') && l.includes('"to":"done"')).length).toBe(0);
  const evs = ev.join("\n");
  expect(evs).toMatch(/"to":"idle".*"by":"owner-liveness"/);
  expect(evs).toMatch(/"to":"error".*owner ses_gone is gone/);
  expect(evs).toMatch(/"kind":"owner"/);
  writeFileSync(join(o("node", "out", R, "idle").out.trim(), "handoff.md"), "handoff\n");
  o("node", "update", R, "idle", "done");
  expect([nd("idle").status, nd("idle").unverified ?? null]).toEqual(["done", null]);
  const b = o("node", "brief", R, "busy").out;
  expect(b).toContain(`node ping ${R} busy --note`);
  expect(b).toContain(`node report ${R} busy --model`);
  expect(b).toContain(`node update ${R} busy done`);
  expect(b).toContain(`node update ${R} busy error --error`);
  expect(b).toMatch(/\/dev\/null/);
  live.kill();
}, 120000);

test("owner probe cache", () => {
  const { mode, home, env, calls } = setup();
  mode("ses_busy", "busy");
  const R = orch(home, env)("run", "start", "cache").out.trim();
  const oc = orch(home, { ...env, ORCH_OWNER_CACHE_SECS: "900", ORCH_OWNER_CALL_TIMEOUT: "20" });
  oc("node", "add", R, "b", "b"); oc("node", "update", R, "b", "running", "--owner", "ses_busy");
  trashSync(join(home, "owners/cache"));
  const count = () => calls().split("\n").filter((l) => l === "ses_busy").length;
  const c0 = count();
  oc("node", "verify-owners", R);
  const c1 = count() - c0;
  oc("node", "verify-owners", R);
  expect([c1, count() - c0]).toEqual([1, 1]);
});

test("budget, job owners, status/sync apply, owner events", () => {
  const { fake, mode, home, o, calls } = setup();
  mode("ses_gone", "404");
  const RB = o("run", "start", "bound").out.trim();
  for (const n of ["s1", "s2", "s3"]) mode(`ses_${n}`, "slow");
  o.in(ndjson([
    ...["s1", "s2", "s3"].map((id) => ({ op: "add", id, label: id })),
    ...["s1", "s2", "s3"].map((id) => ({ op: "update", id, status: "running", owner: `ses_${id}` })),
  ]), "node", "batch", RB);
  writeFileSync(join(fake, "calls"), "");
  o.env({ ORCH_OWNER_CALL_TIMEOUT: "1", ORCH_OWNER_TOTAL_SECS: "2" }, "node", "verify-owners", RB);
  expect(calls().split("\n").filter(Boolean).length).toBeLessThanOrEqual(2);
  mkdirSync(join(home, "jobs/job-ok"), { recursive: true });
  writeFileSync(join(home, "jobs/job-ok/exit_code"), "0\n");
  const RJ = o("run", "start", "job owner").out.trim();
  o("node", "add", RJ, "j", "j"); o("node", "update", RJ, "j", "running", "--owner", "job-ok");
  o("node", "verify-owners", RJ);
  expect(nodeOf(home, RJ, "j").status).toBe("done");
  const R2 = o("run", "start", "status apply").out.trim();
  o("node", "add", R2, "a", "a"); mode("ses_st", "idle");
  o("node", "update", R2, "a", "running", "--owner", "ses_st");
  expect(o("run", "status", R2).out).toMatch(/owner idle: a/);
  expect(nodeOf(home, R2, "a").status).toBe("running");
  const R3 = o("run", "start", "sync apply").out.trim();
  o("node", "add", R3, "g", "g"); o("node", "update", R3, "g", "running", "--owner", "ses_gone");
  expect(o("run", "sync", R3, "--no-retry", "--verify-owners").out).toMatch(/owner gone: g/);
  expect(nodeOf(home, R3, "g").status).toBe("error");
  const R4 = o("run", "start", "owner events").out.trim();
  o("node", "add", R4, "w", "w"); o("node", "update", R4, "w", "running", "--owner", "ses_ev");
  expect(o("owner", "event", "ses_unknown", "finished", "--harness", "opencode").rc).toBe(0);
  expect(nodeOf(home, R4, "w").status).toBe("running");
  o("owner", "event", "ses_ev", "alive", "--harness", "opencode");
  expect(nodeOf(home, R4, "w").owner_state).toBe("alive");
  o("owner", "event", "ses_ev", "finished", "--harness", "opencode", "--note", "built it");
  const w = nodeOf(home, R4, "w");
  expect([w.status, w.owner_state, w.owner_note]).toEqual(["running", "idle", "built it"]);
  o("node", "add", R4, "x", "x"); o("node", "update", R4, "x", "running", "--owner", "ses_ex");
  o("owner", "event", "ses_ex", "failed", "--harness", "claude", "--note", "crashed");
  expect([nodeOf(home, R4, "x").status, nodeOf(home, R4, "x").error]).toEqual(["error", "crashed"]);
  o("owner", "event", "ses_ex", "finished", "--harness", "claude");
  expect(nodeOf(home, R4, "x").status).toBe("error");
  expect(readText(join(home, ".dispatch-path")).trim()).toBe(DISPATCH);
}, 180000);
