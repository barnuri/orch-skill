import { test, expect } from "bun:test";
import { join } from "node:path";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { orch, seedHome, tempHome, tempDir, editJson, runCmd, DISPATCH, pathWithout, readJson, autoCleanup } from "../helpers";
autoCleanup();

test("demo seed, advance, reset", () => {
  const demo = seedHome();
  let r = orch(demo)("demo");
  expect(r.rc).toBe(2); expect(r.all).toMatch(/demo seed/);
  r = runCmd(["bun", DISPATCH, "demo", "seed"], { env: { HARNESS_ORCH_HOME: undefined, HOME: tempDir() } });
  expect(r.rc).toBe(2); expect(r.all).toMatch(/HARNESS_ORCH_HOME/);
  const o = orch(demo, { PATH: pathWithout("claude", "cursor-agent", "opencode") });
  r = o("demo", "seed");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/seeded 4 runs/);
  const list = orch(demo)("run", "list").all;
  expect(list).toMatch(/running.*Ship the payments service/);
  expect(list).toMatch(/error.*Migrate the llm-hub profiles/);
  expect(list).toMatch(/done.*Nightly benchmark sweep/);
  const states = readdirSync(join(demo, "runs")).map((r) => readJson(join(demo, "runs", r, "state.json")));
  const nodes = states.flatMap((s: any) => s.nodes);
  expect([...new Set(nodes.map((n: any) => n.status))].sort().join(",")).toBe("done,error,running,skipped,waiting");
  const adapters = [...new Set(nodes.filter((n: any) => n.adapter != null).map((n: any) => n.adapter))].sort().join(",");
  expect(adapters).toMatch(/claude,cursor-agent/);
  expect(nodes.filter((n: any) => (n.log_tail ?? []).length > 0).length).toBeGreaterThan(0);
  const jobDir = join(demo, "jobs", readdirSync(join(demo, "jobs")).find((d) => d.startsWith("demo-"))!);
  for (const f of ["log", "adapter", "session"]) expect(existsSync(join(jobDir, f))).toBe(true);
  expect(readFileSync(join(jobDir, "session"), "utf8").trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  orch(demo)("run", "start", "a real run", "--id", "20260101-000000-keep");
  r = orch(demo)("demo", "advance");
  expect(r.rc).toBe(0); expect(r.out).toMatch(/\t(done|running)$/m);
  expect(orch(demo)("demo", "reset").all).toMatch(/removed 4 seeded run/);
  expect(orch(demo)("demo", "reset").all).toMatch(/removed 0 seeded run/);
  expect(orch(demo)("run", "list").all).toMatch(/20260101-000000-keep/);
  expect(existsSync(jobDir)).toBe(false);
});

test("demo seed --graph", () => {
  const demo = seedHome();
  const r = orch(demo, { PATH: pathWithout("claude", "cursor-agent", "opencode", "copilot") })("demo", "seed", "--graph");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/seeded graph run/);
  const s = readJson(join(demo, "runs", readdirSync(join(demo, "runs"))[0], "state.json"));
  expect(s.nodes.length).toBe(13);
  expect([...new Set(s.nodes.map((n: any) => n.status))].sort().join(",")).toBe("done,error,running,skipped,waiting");
  expect(s.nodes.find((n: any) => n.id === "design").cost.usd).toBe(3.12);
  expect(s.nodes.find((n: any) => n.id === "ui").attempts.length).toBe(1);
});
