import { test, expect } from "bun:test";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { orch, seedHome, autoCleanup } from "../helpers";
autoCleanup();

// A paused run must not get a health monitor, and `run watch` must not restart `run wait`.
test("paused runs get no health monitor and no run watch; resumed runs do", () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HERDR: "0", ORCH_NO_ANNOUNCE: "1" });
  const paused = o("run", "start", "paused run", "--id", "paused-1").out.trim();
  o("run", "pause", paused);
  const watchesFor = (run: string) => existsSync(join(home, "watches"))
    ? readdirSync(join(home, "watches")).filter((w) => {
        const f = join(home, "watches", w, "state.json");
        return existsSync(f) && readFileSync(f, "utf8").includes(run);
      })
    : [];

  expect(o("run", "health", "--ensure-monitors").out).toBe("");
  expect(watchesFor(paused)).toEqual([]);

  const watch = o("run", "watch", paused);
  expect(watch.rc).toBe(0);
  expect(watch.out).not.toMatch(/run wait/);
  expect(watchesFor(paused)).toEqual([]);
});

test("resumed run gets a health monitor again", () => {
  const home = seedHome();
  const o = orch(home, { ORCH_HERDR: "0", ORCH_NO_ANNOUNCE: "1" });
  const run = o("run", "start", "resumed run", "--id", "resumed-1").out.trim();
  o("run", "pause", run);
  o("run", "resume", run);
  const out = o("run", "health", "--ensure-monitors").out;
  expect(out).toMatch(new RegExp(`^started watch-.* for ${run}`, "m"));
  // Stop the monitor this test started.
  const wdir = join(home, "watches");
  for (const w of readdirSync(wdir)) {
    const f = join(wdir, w, "state.json");
    if (!existsSync(f)) continue;
    const st = JSON.parse(readFileSync(f, "utf8"));
    if (st.run === run && st.pid) { try { process.kill(-st.pid, "SIGTERM"); } catch {} }
  }
});
