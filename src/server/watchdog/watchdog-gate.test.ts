// test-tier: slow (fake-dispatch processes)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Database } from "bun:sqlite";

import { TempHome } from "../test-support/temp-home";
import { orchestratorAbsent, WatchdogService } from "./watchdog-service";
import { holdsSession, makeSessionIdle, orchestratorIdleMinutes } from "./session-idle";

const FAKE = resolve(import.meta.dir, "../test-support/fake-dispatch.ts");
let prev: string | undefined;
beforeAll(() => { prev = process.env["ORCH_DISPATCH"]; process.env["ORCH_DISPATCH"] = FAKE; });
afterAll(() => { if (prev === undefined) delete process.env["ORCH_DISPATCH"]; else process.env["ORCH_DISPATCH"] = prev; });

const RUN = "gt1";
const nodes = (gate: Record<string, unknown>, a = "done") => [{ id: "a", status: a }, { id: "done-gate", ...gate }];

function fixture() {
  const home = TempHome.create();
  const dog = new WatchdogService(home.path, { now: () => new Date(), log: () => undefined, health: () => null, pidAlive: () => true, sessionIdle: () => false });
  const set = (ns: unknown[], patch: Record<string, unknown> = {}) => home.write(`runs/${RUN}/state.json`, JSON.stringify({ run_id: RUN, status: "running", nodes: ns, edges: [], coordinator: { session_id: "s", transport: "herdr" }, harness_session: "s", ...patch }));
  const tick = async () => { dog.engine.evaluate(RUN); await Promise.all([...dog.inflight, ...dog.engine.inflight]); };
  const gateCalls = () => (existsSync(home.resolve("fake-dispatch.actions")) ? readFileSync(home.resolve("fake-dispatch.actions"), "utf8").split("\n") : []).filter((l) => l.startsWith("run gate"));
  return { home, set, tick, gateCalls };
}

describe("watchdog done gate", () => {
  test("runs `run gate` once when every other node is settled and the gate waits", async () => {
    const f = fixture();
    f.set(nodes({ status: "waiting" }));
    await f.tick();
    await f.tick();
    expect(f.gateCalls()).toEqual([`run gate ${RUN}`]);
  });
  test("does not run while another node is open or the gate is not waiting", async () => {
    const f = fixture();
    f.set(nodes({ status: "waiting" }, "running"));
    await f.tick();
    f.set(nodes({ status: "done" }));
    await f.tick();
    expect(f.gateCalls()).toEqual([]);
  });
  test("reruns after a failed gate only when a node changed", async () => {
    const f = fixture();
    const blocked = { status: "blocked-user", needs_user: "verify FAILED: 1 failure(s)" };
    f.set(nodes(blocked));
    await f.tick();
    await f.tick();
    expect(f.gateCalls().length).toBe(1);
    f.set(nodes(blocked), { nodes: [{ id: "a", status: "done", result: "x" }, { id: "done-gate", ...blocked }] });
    await f.tick();
    expect(f.gateCalls().length).toBe(2);
  });
});

describe("session-only orchestrator", () => {
  const st = { coordinator: { session_id: "s", transport: "herdr" }, harness_session: "s" };
  test("registered and active session is absent only when idle", () => {
    expect(orchestratorAbsent(st, () => false, () => false)).toBe(false);
    expect(orchestratorAbsent(st, () => false, () => true)).toBe(true);
  });
  test("idle needs old db time, old activity and no live process", () => {
    const home = TempHome.create();
    const dbPath = join(home.path, "oc.db");
    const db = new Database(dbPath);
    db.run("create table session_v2 (id text primary key, time_updated integer)");
    const now = Date.parse("2026-11-25T12:00:00Z");
    db.run("insert into session_v2 values ('old', ?), ('fresh', ?), ('held', ?)", [now - 3_600_000, now - 60_000, now - 3_600_000]);
    db.close();
    const idle = makeSessionIdle(home.path, { now: () => new Date(now), dbPath, processArgs: () => ["opencode --standalone -s held"] });
    expect(idle("old")).toBe(true);
    expect(idle("fresh")).toBe(false);
    expect(idle("held")).toBe(false);
    mkdirSync(join(home.path, "activity"), { recursive: true });
    writeFileSync(join(home.path, "activity", "old.json"), "{}");
    utimesSync(join(home.path, "activity", "old.json"), new Date(now - 60_000), new Date(now - 60_000));
    expect(idle("old")).toBe(false);
  });
  test("setting orchestrator_idle_minutes, default 30; process match ignores job-run", () => {
    const home = TempHome.create();
    expect(orchestratorIdleMinutes(home.path)).toBe(30);
    home.write("profiles.json", JSON.stringify({ settings: { orchestrator_idle_minutes: 5 } }));
    expect(orchestratorIdleMinutes(home.path)).toBe(5);
    expect(holdsSession(["bun cli.ts job-run opencode s1"], "s1")).toBe(false);
    expect(holdsSession(["opencode --session s1"], "s1")).toBe(true);
  });
});
