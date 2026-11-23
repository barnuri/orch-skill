import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, readJson, autoCleanup } from "../helpers";
autoCleanup();

const setup = (globalCap?: string) => {
  const home = seedHome();
  const o = orch(home);
  if (globalCap !== undefined) o("settings", "set", "defaults.max_parallel", globalCap);
  const R = o("run", "start", "health").out.trim();
  const health = () => JSON.parse(o("run", "health", R, "--json").out);
  const stored = () => readJson(join(home, "runs", R, "state.json")).max_parallel;
  return { home, o, R, health, stored };
};

test("run set max_parallel accepts -1 and 1-30 and stores the number", () => {
  const { o, R, stored } = setup();
  for (const v of ["1", "30", "-1"]) {
    const r = o("run", "set", R, "max_parallel", v);
    expect(r.rc).toBe(0);
    expect(r.out).toBe(`max_parallel: ${R} ${v}\n`);
    expect(stored()).toBe(Number(v));
  }
});

test("run set max_parallel rejects 0, 31, 2.5 and words with rc 2 and keeps the stored value", () => {
  const { o, R, stored } = setup();
  o("run", "set", R, "max_parallel", "3");
  for (const v of ["0", "31", "2.5", "many", "-2"]) {
    const r = o("run", "set", R, "max_parallel", v);
    expect(r.rc).toBe(2);
    expect(r.err).toMatch(/max_parallel must be -1 or an integer 1-30/);
  }
  expect(stored()).toBe(3);
});

test("run set without a value is a usage error", () => {
  const { o, R } = setup();
  expect(o("run", "set", R, "max_parallel").rc).toBe(2);
});

test("default global cap is 30 when the profiles set none", () => {
  const { home, o, R, health } = setup();
  const doc = readJson(join(home, "profiles.json"));
  delete doc.defaults.max_parallel;
  delete doc.settings.max_parallel;
  writeFileSync(join(home, "profiles.json"), JSON.stringify(doc));
  expect(health().max_parallel).toBe(30);
  expect(o("run", "health", R).out).toMatch(/running 0\/30, slots 30/);
});

test("effective cap is min(global, per-run)", () => {
  const { o, R, health } = setup("4");
  expect(health().max_parallel).toBe(4);
  o("run", "set", R, "max_parallel", "2");
  expect(health().max_parallel).toBe(2);
  expect(health().slots).toBe(2);
  o("run", "set", R, "max_parallel", "10");
  expect(health().max_parallel).toBe(4);
  expect(health().slots).toBe(4);
});

test("per-run -1 is unlimited for the run but still bounded by the global cap", () => {
  const { o, R, health } = setup("4");
  o("run", "set", R, "max_parallel", "-1");
  expect(health().max_parallel).toBe(4);
  expect(health().slots).toBe(4);
});

test("global -1 with per-run -1 is unlimited: slots null, text says unlimited", () => {
  const { o, R, health } = setup("-1");
  o("run", "set", R, "max_parallel", "-1");
  const json = health();
  expect(json.max_parallel).toBe(-1);
  expect(json.slots).toBeNull();
  expect(o("run", "health", R).out).toMatch(/running 0\/unlimited, slots unlimited/);
});

test("global -1 with a per-run number is capped by the per-run number", () => {
  const { o, R, health } = setup("-1");
  o("run", "set", R, "max_parallel", "5");
  expect(health().max_parallel).toBe(5);
  expect(health().slots).toBe(5);
});
