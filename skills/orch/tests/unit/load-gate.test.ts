import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { loadHold, maxLoad } from "../../core/state/load.ts";
import { orch, seedHome, tempDir } from "../helpers/index.ts";

test("default max_load is CPU count x 2 and the hold text names both numbers", async () => {
  const home = seedHome();
  const f = join(tempDir(), "load"); process.env.ORCH_LOAD_FILE = f;
  try {
    expect(await maxLoad(home)).toBe(cpus().length * 2);
    writeFileSync(f, "1"); expect(await loadHold(home)).toBeNull();
    writeFileSync(f, "999"); expect(await loadHold(home)).toBe(`load 999.0 > ${cpus().length * 2}`);
  } finally { delete process.env.ORCH_LOAD_FILE; }
});

test("run advance holds a ready node while the load is above max_load", () => {
  const home = seedHome();
  const f = join(tempDir(), "load"); writeFileSync(f, "999");
  const o = orch(home, { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_LOAD_FILE: f });
  const R = o("run", "start", "load run").out.trim();
  o("node", "add", R, "a", "A", "--profile", "p-claude");
  mkdirSync(join(home, "runs", R, "prompts"), { recursive: true }); writeFileSync(join(home, "runs", R, "prompts", "a.md"), "do a");
  const r = o("run", "advance", R);
  expect(r.out).toMatch(/held: load 999\.0 > \d+: a/);
  expect(r.out).toMatch(/dispatched: \n/);
});
