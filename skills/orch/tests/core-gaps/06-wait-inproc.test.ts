import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runHome, fakeJob, setNode } from "./common";
import { autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("run wait syncs finished jobs in-process", () => {
  const t = runHome({ ORCH_DISPATCH: "/nonexistent/dispatch.ts", ORCH_WAIT_POLL_SECS: "1", ORCH_WAIT_HEALTH_SECS: "3600" });
  fakeJob(t.home, "job-a", 0);
  // The job wrote its own handoff, so the sync marks the node done.
  mkdirSync(join(t.home, "runs/r1/out/a"), { recursive: true });
  writeFileSync(join(t.home, "runs/r1/out/a/handoff.md"), "# done\n");
  writeFileSync(join(t.home, "jobs/job-a/node"), "r1/a\n");
  setNode(t.home, "a", { status: "running", job_id: "job-a", seg_open: true });
  const r = t.o("run", "wait", "r1", "--timeout", "4");
  expect(r.err).not.toMatch(/nonexistent|ENOENT/);
  expect(t.node("a").status).toBe("done");
});
