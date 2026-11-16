import { test, expect, setDefaultTimeout } from "bun:test";
import { runHome, fakeJob, setNode } from "./common";
import { autoCleanup } from "../helpers";
setDefaultTimeout(120000);
autoCleanup();

test("run wait syncs finished jobs in-process", () => {
  const t = runHome({ ORCH_DISPATCH: "/nonexistent/dispatch.ts", ORCH_WAIT_POLL_SECS: "1", ORCH_WAIT_HEALTH_SECS: "3600" });
  fakeJob(t.home, "job-a", 0);
  setNode(t.home, "a", { status: "running", job_id: "job-a", seg_open: true });
  const r = t.o("run", "wait", "r1", "--timeout", "4");
  expect(r.err).not.toMatch(/nonexistent|ENOENT/);
  expect(t.node("a").status).toBe("done");
});
