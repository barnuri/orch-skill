import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { orch, seedHome, nodeOf, fakeBin, pidAlive, autoCleanup, editJson } from "../helpers";
autoCleanup();

// A job whose log stopped growing `min` minutes ago.
function ageLog(home: string, job: string, min: number): void {
  const t = new Date(Date.now() - min * 60_000);
  utimesSync(join(home, "jobs", job, "log"), t, t);
}

function setup(id: string) {
  const home = seedHome();
  const shim = fakeBin({ claude: "sleep 60" });
  const o = orch(home, { PATH: `${shim}:${process.env.PATH}` });
  o("run", "start", "Reap test", "--id", id);
  o("node", "add", id, "p2", "finished but alive");
  const job = o("node", "dispatch", id, "p2", "claude", "do it").out.trim();
  const pid = Number(readFileSync(join(home, "jobs", job, "pid"), "utf8").trim());
  expect(pid).toBeGreaterThan(0);
  return { home, o, job, pid };
}

test("run sync reports a finished-but-alive node once, node reap kills only its job and keeps the result", () => {
  const { home, o, job, pid } = setup("reap-1");
  // No result yet: an idle running job is not stuck-after-result.
  ageLog(home, job, 10);
  expect(o("run", "sync", "reap-1").out).not.toMatch(/stuck-after-result/);
  expect(o("node", "reap", "reap-1", "p2").rc).toBe(1);

  expect(o("node", "result", "reap-1", "p2", "--verdict", "full", "--summary", "done it", "--follow-up", "none").rc).toBe(0);
  ageLog(home, job, 10);
  let r = o("run", "sync", "reap-1");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(new RegExp(`^stuck-after-result: p2 idle 10 min \\(job ${job}\\): dispatch.ts node reap reap-1 p2$`, "m"));
  expect(nodeOf(home, "reap-1", "p2").status).toBe("running");
  expect(nodeOf(home, "reap-1", "p2").stuck_after_result.job).toBe(job);
  // Second sync: the line again, but no second message.
  ageLog(home, job, 11);
  expect(o("run", "sync", "reap-1").out).toMatch(/^stuck-after-result: p2 /m);
  const msgs = o("msg", "read", "reap-1", "--for", "orch", "--all").out;
  expect(msgs.match(/finished but alive/g)?.length).toBe(1);
  expect(msgs).toMatch(/node reap reap-1 p2/);

  r = o("node", "reap", "reap-1", "p2");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^reaped: p2 \(job killed, result kept: full\)$/m);
  expect(pidAlive(pid)).toBe(false);
  const n = nodeOf(home, "reap-1", "p2");
  expect(n.status).toBe("done");
  expect(n.result.verdict).toBe("full");
  expect(n.result.summary).toBe("done it");
  expect(n.reaped.job).toBe(job);
  expect(n.stuck_after_result).toBeNull();
  // A later sync leaves the reaped node done.
  o("run", "sync", "reap-1");
  expect(nodeOf(home, "reap-1", "p2").status).toBe("done");
  expect(o("node", "reap", "reap-1", "p2").rc).toBe(1);
});

test("a growing log clears the mark; settings 0 turns detection off", () => {
  const { home, o, job } = setup("reap-2");
  o("node", "result", "reap-2", "p2", "--verdict", "partial", "--summary", "s", "--follow-up", "none");
  ageLog(home, job, 6);
  expect(o("run", "sync", "reap-2").out).toMatch(/^stuck-after-result: p2 /m);
  // Fresh log activity: not stuck any more.
  utimesSync(join(home, "jobs", job, "log"), new Date(), new Date());
  expect(o("run", "sync", "reap-2").out).not.toMatch(/stuck-after-result/);
  expect(nodeOf(home, "reap-2", "p2").stuck_after_result ?? null).toBeNull();
  ageLog(home, job, 6);
  editJson(join(home, "profiles.json"), (d) => { d.settings = { ...(d.settings ?? {}), stuck_after_result_min: 0 }; });
  expect(o("run", "sync", "reap-2").out).not.toMatch(/stuck-after-result/);
  o("run", "stop", "reap-2");
});

test("a handoff alone counts; settings.reap_after_result_min reaps on sync", () => {
  const { home, o, job, pid } = setup("reap-3");
  const out = join(home, "runs", "reap-3", "out", "p2");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "handoff.md"), "# p2\nDone.\n");
  ageLog(home, job, 3);
  expect(o("run", "sync", "reap-3").out).not.toMatch(/stuck-after-result/);
  editJson(join(home, "profiles.json"), (d) => { d.settings = { ...(d.settings ?? {}), reap_after_result_min: 2 }; });
  const r = o("run", "sync", "reap-3");
  expect(r.out).toMatch(/^reaped-after-result: p2 idle 3 min$/m);
  expect(pidAlive(pid)).toBe(false);
  const n = nodeOf(home, "reap-3", "p2");
  expect(n.status).toBe("done");
  expect(n.reaped.reason).toMatch(/auto-reap/);
});
