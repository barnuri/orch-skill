import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync, mkdirSync, existsSync, readFileSync, renameSync } from "node:fs";
import { orch, seedHome, opencodeFixture, ndjson, events, readText, readJson, waitUntil, autoCleanup } from "../helpers";
autoCleanup();

const fx = await opencodeFixture();
const setup = () => {
  const home = seedHome();
  const o = orch(home, fx.env);
  o("settings", "set", "defaults.max_parallel", "4");
  const hj = (R: string) => JSON.parse(o("run", "health", R, "--json").out);
  const hOf = (out: any, n: string) => out.nodes.find((x: any) => x.id === n);
  const R = o("run", "start", "health").out.trim();
  return { home, o, hj, hOf, R };
};
const healthEvents = (home: string, R: string) => events(home, R).filter((e) => e.kind === "health").length;

test("health classes, text, events, nudge", () => {
  const { home, o, hj, hOf, R } = setup();
  o.in(ndjson([
    { op: "add", id: "ok", label: "ok" }, { op: "add", id: "stall", label: "stall" }, { op: "add", id: "dead", label: "dead" },
    { op: "add", id: "orphan", label: "orphan" }, { op: "add", id: "idle", label: "idle" },
    { op: "update", id: "ok", status: "running", owner: "ses_busy1" }, { op: "update", id: "stall", status: "running", owner: "ses_stall1" },
    { op: "update", id: "dead", status: "running", owner: "ses_gone99" }, { op: "update", id: "orphan", status: "running" },
    { op: "update", id: "idle", status: "running", owner: "ses_idle1" },
  ]), "node", "batch", R);
  const out = hj(R);
  expect(hOf(out, "ok").health).toBe("ok");
  expect(hOf(out, "stall").health).toBe("stalled");
  expect(hOf(out, "dead").health).toBe("dead");
  expect(hOf(out, "orphan").health).toBe("unowned");
  expect(hOf(out, "idle").health).toBe("no-report");
  expect(hOf(out, "stall").note).toMatch(/no activity since \d{2}:\d{2}/);
  expect(hOf(out, "stall").owner_id).toBe("ses_stall1");
  expect(hOf(out, "stall").idle_min).toBeGreaterThanOrEqual(40);
  const { status, would_nudge, ...rest } = out;
  expect(Object.keys(rest).sort()).toEqual(["at", "changes", "max_parallel", "nodes", "ready", "run", "running", "slots"]);
  expect([out.running, out.max_parallel, out.slots]).toEqual([5, 4, 0]);
  expect(out.would_nudge).toEqual(["stall"]);
  expect(fx.calls().match(/prompt/g)?.length ?? 0).toBe(0);
  const text = o("run", "health", R).out;
  expect(text).toMatch(/running 5\/4, slots 0/);
  expect(text).toMatch(/^stalled: stall \(ses_stall1\)/m);

  const first = healthEvents(home, R);
  expect(first).toBe(4);
  hj(R); hj(R);
  expect(healthEvents(home, R)).toBe(first);
  expect(hj(R).changes).toEqual([]);
  o("node", "update", R, "orphan", "done");
  expect(JSON.stringify(hj(R))).toMatch(/"kind":"finished","node":"orphan"/);
  expect(healthEvents(home, R)).toBe(first + 1);

  writeFileSync(join(fx.dir, "calls"), "");
  o("run", "health", R, "--nudge");
  expect(fx.calls()).toMatch(/api POST \/api\/session\/ses_stall1\/prompt --data/);
  expect(fx.calls()).toMatch(/You stopped mid-task at \d{2}:\d{2}\. Continue the task to completion and reply only with the final report\./);
  expect(fx.calls().match(/prompt/g)!.length).toBe(1);
  expect(events(home, R).filter((e) => e.kind === "nudge" && e.node === "stall" && e.by === "health").length).toBe(1);
  o("run", "health", R, "--nudge"); o("run", "health", R, "--nudge");
  expect(fx.calls().match(/prompt/g)!.length).toBe(1);
  o.env({ ORCH_HEALTH_NUDGE_GAP_SECS: "0" }, "run", "health", R, "--nudge");
  expect(fx.calls().match(/prompt/g)!.length).toBe(2);
});

test("ready set and slots", () => {
  const { o, hj, hOf, R } = setup();
  o.in(ndjson([
    { op: "add", id: "a", label: "A" }, { op: "add", id: "b", label: "B", after: "a" }, { op: "add", id: "p", label: "P" },
    { op: "add", id: "c", label: "C", after: "p" }, { op: "add", id: "free", label: "Free" },
    { op: "update", id: "a", status: "done" }, { op: "update", id: "p", status: "running", owner: "ses_busy1" },
  ]), "node", "batch", R);
  let out = hj(R);
  expect(out.ready).toEqual(["b", "free"]);
  expect(out.slots).toBe(3);
  expect(hOf(out, "c").note).toMatch(/waiting on p/);
  expect(JSON.stringify(out)).toMatch(/"kind":"ready".*"note":"ready: b,free"/);
  o.in(ndjson(["x1", "x2", "x3"].flatMap((id) => [{ op: "add", id, label: id }, { op: "update", id, status: "running", owner: "ses_busy1" }])), "node", "batch", R);
  out = hj(R);
  expect(out.slots).toBe(0);
  expect(out.ready).toEqual(["b", "free"]);
  expect(JSON.stringify(out)).not.toMatch(/"kind":"ready"/);
  o("node", "update", R, "p", "done");
  expect(JSON.stringify(hj(R))).toMatch(/"note":"ready: c"/);
  o("run", "finish", R);
});

test("late deps, needs-user, gates", () => {
  const { home, o, hj, hOf, R } = setup();
  o.in(ndjson(["a", "b", "ask", "gate"].map((id) => ({ op: "add", id, label: id }))), "node", "batch", R);
  expect([...hj(R).ready].sort()).toEqual(["a", "ask", "b", "gate"]);
  o("node", "update", R, "b", "--after", "a");
  o("node", "update", R, "ask", "--needs-user", "pick the product name");
  o("node", "update", R, "gate", "--after", "*");
  const out = hj(R);
  expect(out.ready).toEqual(["a"]);
  expect(hOf(out, "ask").health).toBe("needs-user");
  expect(hOf(out, "ask").note).toBe("needs the user: pick the product name");
  expect(hOf(out, "gate").note).toBe("waiting on a,ask,b");
  expect(o("run", "sync", R, "--no-retry").out).toMatch(/^ready: a$/m);
  expect(events(home, R).filter((e) => e.kind === "deps" || e.kind === "needs-user").length).toBe(3);
  expect(o("node", "update", R, "a", "--after", "a").rc).toBe(2);
  expect(o("node", "update", R, "a", "--after", "b").rc).toBe(2);
  expect(o("node", "update", R, "a", "--after", "nope").rc).toBe(2);
  o("node", "update", R, "a", "done"); o("node", "update", R, "b", "done");
  o("node", "update", R, "ask", "--clear-needs-user");
  expect(hj(R).ready).toEqual(["ask"]);
  o("node", "update", R, "ask", "skipped");
  expect(hj(R).ready).toEqual(["gate"]);
  o("node", "update", R, "gate", "--after", "");
  expect(readJson(join(home, "runs", R, "state.json")).nodes.find((n: any) => n.id === "gate").after_all).toBe(false);
  expect(o("node", "update", R, "gate").rc).toBe(2);
  o("node", "update", R, "gate", "running", "--needs-user", "confirm");
  const g = readJson(join(home, "runs", R, "state.json")).nodes.find((n: any) => n.id === "gate");
  expect([g.status, g.needs_user]).toEqual(["running", "confirm"]);
});

test("holds, big run, corrupt state, usage", () => {
  let { home, o, hj, hOf, R } = setup();
  o.in(ndjson([{ op: "add", id: "h1", label: "h1" }, { op: "add", id: "h2", label: "h2" }]), "node", "batch", R);
  o("node", "update", R, "h1", "--hold", "until load < 4");
  const out = hj(R);
  expect(out.ready).toEqual(["h2"]);
  expect(hOf(out, "h1").health).toBe("held");
  expect(hOf(out, "h1").note).toBe("held: until load < 4");
  expect(o("run", "health", R).out).toMatch(/^held: h1 — held: until load < 4$/m);
  expect(o("run", "sync", R, "--no-retry").out).toMatch(/^ready: h2$/m);
  expect(events(home, R).find((e) => e.kind === "hold").note).toBe("until load < 4");
  expect(o("node", "update", R, "h1", "--hold", "").rc).toBe(2);
  o("node", "update", R, "h2", "--needs-user", "pick", "--hold", "later");
  expect(hOf(hj(R), "h2").health).toBe("needs-user");
  o("node", "update", R, "h1", "--clear-hold");
  expect(hj(R).ready).toEqual(["h1"]);
  expect(events(home, R).filter((e) => e.kind === "hold").pop().note).toBe("cleared");
  o("node", "update", R, "h1", "--hold", "wait");
  o("node", "update", R, "h1", "running", "--owner", "coordinator");
  expect(readJson(join(home, "runs", R, "state.json")).nodes.find((n: any) => n.id === "h1").hold ?? null).toBeNull();

  ({ home, o, hj, hOf, R } = setup());
  o.in(ndjson(Array.from({ length: 120 }, (_, i) => ({ op: "add", id: `n${i + 1}`, label: `n${i + 1}`, ...(i > 0 ? { after: `n${i}` } : {}) }))), "node", "batch", R);
  const t0 = Date.now();
  const big = hj(R);
  expect(big.nodes.length).toBe(120);
  expect(big.ready).toEqual(["n1"]);
  expect(Date.now() - t0).toBeLessThan(10000);
  writeFileSync(join(home, "runs", R, "state.json"), "{bad");
  expect(o("run", "health", R, "--json").rc).toBe(1);
  expect(readJson(join(home, "health", `${R}.json`)).nodes.length).toBe(120);
  expect(o("run", "health").rc).toBe(2);
  expect(o("run", "health", "nope").rc).toBe(2);
});

test("health monitor", async () => {
  const home = seedHome();
  const o = orch(home, { ...fx.env, ORCH_HEALTH_MONITOR: "1", ORCH_HEALTH_EVERY_SEC: "2", ORCH_EVERY_MIN_SECS: "1" });
  const active = () => JSON.parse(o("active", "--json").out) as any[];
  const R = o("run", "start", "monitored").out.trim();
  expect(active().find((a) => a.kind === "watch").name).toBe(`health:${R}`);
  expect(Number(active()[0].interval)).toBe(2);
  expect(readText(join(home, "runs", R, "events.jsonl"))).toMatch(/monitor started/);
  o("run", "start", "monitored", "--id", R);
  expect(active().filter((a) => a.name === `health:${R}`).length).toBe(1);
  o("node", "add", R, "n1", "N1");
  expect(await waitUntil(() => readText(join(home, "runs", R, "events.jsonl")).includes("ready: n1"), 60)).toBe(true);
  const key = join(home, "health", `${R}.key`);
  await waitUntil(() => existsSync(key), 40);
  expect(events(home, R).filter((e) => e.kind === "health" && e.note === "ready: n1").length).toBe(1);
  const wid = active()[0].id;
  const pid = readJson(join(home, "watches", wid, "state.json")).pid;
  try { process.kill(-pid, "SIGKILL"); } catch {}
  const out = o("run", "health", "--ensure-monitors").out;
  expect(out).toMatch(new RegExp(`^started watch-.* for ${R}`));
  const st = readJson(join(home, "watches", wid, "state.json"));
  expect(`${st.status} ${st.reason}`).toMatch(/^dead process/);
  expect(readText(join(home, "runs", R, "events.jsonl"))).toContain(`monitor ${wid} dead`);
  expect(o("run", "health", "--ensure-monitors").out).toBe("");
  mkdirSync(join(home, "runs/0000-bad"), { recursive: true });
  writeFileSync(join(home, "runs/0000-bad/state.json"), "{bad");
  const w2 = active().find((a) => a.status === "running").id;
  try { process.kill(-readJson(join(home, "watches", w2, "state.json")).pid, "SIGTERM"); } catch {}
  await waitUntil(() => active().filter((a) => a.status === "running").length === 0, 20);
  await Promise.all([1, 2, 3].map(async () => Bun.spawn(["bun", join(import.meta.dir, "../../scripts/dispatch.ts"), "run", "health", "--ensure-monitors"], { env: { ...process.env, ...fx.env, HARNESS_ORCH_HOME: home, ORCH_HEALTH_MONITOR: "1", ORCH_HEALTH_EVERY_SEC: "2", ORCH_EVERY_MIN_SECS: "1", ORCH_HERDR: "0", ORCH_NO_ANNOUNCE: "1" } }).exited));
  expect(active().filter((a) => a.status === "running" && a.name === `health:${R}`).length).toBe(1);
  renameSync(join(home, "runs/0000-bad"), join(home, "bad-run"));
  o("run", "finish", R);
  await waitUntil(() => active().filter((a) => a.status === "running").length === 0, 60);
  expect(active().filter((a) => a.status === "running").length).toBe(0);
  expect(readText(join(home, "runs", R, "events.jsonl"))).toMatch(/monitor stopped \(run done\)/);
  o.env({ ORCH_HEALTH_EVERY_SEC: "3", ORCH_EVERY_MIN_SECS: "" }, "run", "start", "fast");
  expect(Number(active().find((a) => a.status === "running").interval)).toBe(10);
  for (const a of active()) o("watch", "stop", a.id);
}, 240000);
