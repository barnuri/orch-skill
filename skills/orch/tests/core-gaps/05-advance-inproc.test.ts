import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHome, fakeJob, setNode } from "./common";
import { autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("run advance syncs in-process (no dispatch.ts subprocess)", () => {
  const t = runHome({ ORCH_DISPATCH: "/nonexistent/dispatch.ts" });
  fakeJob(t.home, "job-a", 0);
  mkdirSync(join(t.home, "runs/r1/out/a"), { recursive: true });
  writeFileSync(join(t.home, "runs/r1/out/a/handoff.md"), "# done\n");
  writeFileSync(join(t.home, "jobs/job-a/node"), "r1/a\n");
  setNode(t.home, "a", { status: "running", job_id: "job-a", seg_open: true });
  const r = t.o("run", "advance", "r1");
  expect(r.err).not.toMatch(/nonexistent|ENOENT/);
  expect(t.node("a").status).toBe("done");
  expect(r.out).toMatch(/^running: 0/m);
});

test("run advance on a paused run does not touch it", () => {
  const t = runHome({ ORCH_DISPATCH: "/nonexistent/dispatch.ts" });
  fakeJob(t.home, "job-a", 0);
  setNode(t.home, "a", { status: "running", job_id: "job-a", seg_open: true });
  expect(t.o("run", "pause", "r1").rc).toBe(0);
  t.o("run", "advance", "r1");
  expect(t.node("a").status).toBe("running");
});
