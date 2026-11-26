import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, runState, nodeOf, editJson, fakeBin, waitUntil, readText, autoCleanup } from "../helpers";
autoCleanup();

test("node retry, run retry, auto retry, backoff, fallback", async () => {
  // node retry
  let home = seedHome(), o = orch(home);
  const sf = () => join(home, "runs/retry-1/state.json");
  o("run", "start", "Retry test", "--id", "retry-1");
  o("node", "add", "retry-1", "a", "retry me");
  const job = o("node", "dispatch", "retry-1", "a", "claude-native", "again", "--same", "args").out.trim();
  o("wait", job, "--timeout", "60", "--interval", "0.1");
  o("run", "sync", "retry-1");
  o("node", "update", "retry-1", "a", "error", "--force", "--job", job, "--error", "exit=1");
  o("run", "finish", "retry-1");
  let r = o("node", "retry", "retry-1", "a");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^[0-9]/m);
  let s = runState(home, "retry-1");
  expect([s.status, s.finished ?? null, s.nodes[0].status, nodeOf(home, "retry-1", "a").attempts[0].job_id, nodeOf(home, "retry-1", "a").attempts[0].retry_mode, s.nodes[0].dispatch_args]).toEqual(["running", null, "running", job, "restarted", ["--same", "args"]]);
  o("wait", r.out.trim(), "--timeout", "60", "--interval", "0.1");
  o("run", "sync", "retry-1");
  // The job exited 0 without a handoff, so the node is an error and a retry is allowed.
  r = o("node", "retry", "retry-1", "a");
  expect(r.rc).toBe(0);

  home = seedHome(); o = orch(home);
  o("run", "start", "Old retry", "--id", "retry-old"); o("node", "add", "retry-old", "a", "a");
  editJson(join(home, "runs/retry-old/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", adapter: "claude-native", job_id: "old", error: "exit=1", finished: "2026-09-01T00:00:00Z" }); });
  r = o("node", "retry", "retry-old", "a", "--no-dispatch", "@/tmp/old-prompt.md");
  expect(r.rc).toBe(0);
  const n = runState(home, "retry-old").nodes[0];
  // A supplied prompt is continuation context, never the node prompt.
  expect([n.status, n.prompt]).toEqual(["waiting", null]);

  // run retry
  home = seedHome(); o = orch(home);
  editJson(join(home, "profiles.json"), (p) => { p.defaults.max_parallel = 1; });
  o("run", "start", "Run retry", "--id", "retry-2"); o("node", "add", "retry-2", "a", "a"); o("node", "add", "retry-2", "b", "b");
  editJson(join(home, "runs/retry-2/state.json"), (s) => {
    s.status = "error"; s.finished = "2026-09-01T00:00:00Z";
    s.nodes[0] = { ...s.nodes[0], status: "error", adapter: "claude-native", prompt: "a", job_id: "old-a", error: "exit=1", finished: "2026-09-01T00:00:00Z" };
    s.nodes[1] = { ...s.nodes[1], status: "error", adapter: "claude-native", prompt: "b", job_id: "old-b", error: "exit=1", finished: "2026-09-01T00:00:00Z" };
  });
  r = o("run", "retry", "retry-2");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^retried: a$/m);
  expect(r.out).toMatch(/^waiting: b$/m);
  const c = runState(home, "retry-2").nodes.map((x: any) => x.status);
  expect([c.filter((x: string) => x === "running").length, c.filter((x: string) => x === "waiting").length]).toEqual([1, 1]);

  // auto retry
  home = seedHome(); o = orch(home);
  editJson(join(home, "profiles.json"), (p) => { p.settings.max_attempts = 2; });
  o("run", "start", "Auto retry", "--id", "retry-3"); o("node", "add", "retry-3", "first", "first"); o("node", "add", "retry-3", "spent", "spent");
  editJson(join(home, "runs/retry-3/state.json"), (s) => {
    Object.assign(s.nodes[0], { status: "error", adapter: "claude-native", prompt: "first", job_id: "old-first", error: "exit=1", finished: "2026-09-01T00:00:00Z", next_retry_at: "2000-01-01T00:00:00Z" });
    Object.assign(s.nodes[1], { status: "error", adapter: "claude-native", prompt: "spent", job_id: "old-spent", error: "exit=1", finished: "2026-09-01T00:00:00Z", next_retry_at: "2000-01-01T00:00:00Z", attempts: [{ job_id: "older", error: "exit=1", finished: "2026-09-01T00:00:00Z", log_tail: [], profile: null }] });
  });
  expect(o("run", "sync", "retry-3").rc).toBe(0);
  s = runState(home, "retry-3");
  expect([s.nodes[0].status, nodeOf(home, "retry-3", s.nodes[0].id).attempts.length, s.nodes[1].status]).toEqual(["running", 1, "error"]);

  // backoff
  home = seedHome(); o = orch(home);
  o("run", "start", "Backoff retry", "--id", "retry-backoff"); o("node", "add", "retry-backoff", "a", "a");
  const bf = join(home, "runs/retry-backoff/state.json");
  editJson(bf, (s) => { Object.assign(s.nodes[0], { status: "error", adapter: "claude-native", prompt: "a", job_id: "old", error: "exit=1", finished: "2026-09-01T00:00:00Z", next_retry_at: "2999-01-01T00:00:00Z" }); });
  expect(o("run", "sync", "retry-backoff").rc).toBe(0);
  expect(runState(home, "retry-backoff").nodes[0].status).toBe("error");
  editJson(join(home, "profiles.json"), (p) => { p.settings.max_attempts = -1; });
  editJson(bf, (s) => { s.nodes[0].next_retry_at = "2000-01-01T00:00:00Z"; s.nodes[0].attempts = [1, 2, 3, 4, 5].map((i) => ({ job_id: String(i) })); });
  expect(o("run", "sync", "retry-backoff").rc).toBe(0);
  expect(runState(home, "retry-backoff").nodes[0].status).toBe("running");
  editJson(join(home, "profiles.json"), (p) => { p.settings.max_attempts = 0; });
  o("node", "update", "retry-backoff", "a", "error", "--force", "--error", "again");
  r = o("run", "sync", "retry-backoff");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/settings.max_attempts must be -1 or an integer >= 1/);

  // quota fallback
  home = seedHome();
  const shim = fakeBin({ copilot: "printf 'copilot fallback ok\\n'" });
  o = orch(home, { PATH: `${shim}:${process.env.PATH}`, LLM_HUB_URL: "http://127.0.0.1:1", LLM_HUB_KEY: "dummy" });
  editJson(join(home, "profiles.json"), (p) => { p.settings.disabled_harnesses = [];
    // The shipped template has no hub profiles: a claude one falling back to a copilot one.
    const E = { enabled: true, flags: [], env: {}, auth: [] };
    p.profiles["copilot-llm-hub"] = { ...p.profiles["copilot-default"], ...E, fallback: null };
    p.profiles["claude-llm-hub"] = { ...p.profiles["claude-default"], ...E, fallback: "copilot-llm-hub" };
  });
  o("run", "start", "Fallback retry", "--id", "retry-4"); o("node", "add", "retry-4", "a", "a", "--profile", "claude-llm-hub");
  editJson(join(home, "runs/retry-4/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", prompt: "again", job_id: "old", error: "exit=1", finished: "2026-09-01T00:00:00Z", next_retry_at: "2000-01-01T00:00:00Z", log_tail: ["You have exceeded your monthly quota"] }); });
  expect(o("run", "sync", "retry-4").rc).toBe(0);
  const f = nodeOf(home, "retry-4", "a");
  expect(f.profile).toBe("copilot-llm-hub");
  expect(f.attempts[0].reason).toMatch(/fallback profile copilot-llm-hub/);
  expect(f.attempts[0].retry_mode).toBe("restarted");
}, 300000);
