import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, runState, nodeOf, editJson, fakeBin, waitUntil, readText, autoCleanup } from "../helpers";
autoCleanup();

test("run lifecycle", () => {
  const home = seedHome(), o = orch(home);
  const st = () => runState(home, "life-1");
  let r = o("run", "start", "Lifecycle test", "--id", "life-1");
  expect(r.rc).toBe(0);
  expect(r.out.trim()).toBe("life-1");
  expect(existsSync(join(home, "runs/life-1/state.json"))).toBe(true);
  expect(o("run", "start", "dup", "--id", "life-1").rc).toBe(2);
  expect(o("run", "start", "bad", "--id", "bad id").rc).toBe(2);
  o("node", "add", "life-1", "n1", "Plan");
  o("node", "add", "life-1", "n2", "Implement", "--after", "n1", "--profile", "claude-default");
  o("node", "add", "life-1", "n3", "Review", "--after", "n1,n2");
  expect(o("node", "add", "life-1", "n1", "again").rc).toBe(2);
  r = o("node", "add", "life-1", "n4", "x", "--after", "nope");
  expect(r.all).toMatch(/dependency nope is not in run/);
  expect(r.rc).toBe(2);
  expect(o("node", "add", "life-1", "n4", "x", "--after", "n4").rc).toBe(2);
  expect(st().edges).toEqual([["n1", "n2"], ["n1", "n3"], ["n2", "n3"]]);
  expect(st().nodes[1].profile).toBe("claude-default");
  r = o("run", "sync", "life-1");
  expect(r.all).toMatch(/^ready: n1$/m);
  expect(r.all).toMatch(/^running: 0$/m);
  o("node", "update", "life-1", "n1", "running");
  expect(st().nodes[0].started).not.toBeNull();
  o("node", "update", "life-1", "n1", "done");
  expect(st().nodes[0].finished).not.toBeNull();
  expect(o("run", "sync", "life-1").all).toMatch(/^ready: n2$/m);
  r = o("node", "update", "life-1", "n2", "bogus");
  expect(r.all).toMatch(/status must be one of/);
  expect(r.rc).toBe(2);
  o("node", "update", "life-1", "n2", "error", "--error", "boom");
  expect(st().nodes[1].error).toBe("boom");
  expect(o("run", "finish", "life-1").out).toMatch(/^error$/m);
  expect(st().finished).not.toBeNull();
  expect(o("run", "list").out).toMatch(/life-1.error.Lifecycle test.1\/3/);

  o("run", "start", "Node options", "--id", "opts-1");
  expect(o("node", "add", "opts-1", "a", "planned", "--role", "implementation", "--tier", "balance", "--plan-backed", "--acceptance", "unit tests pass; no new deps").rc).toBe(0);
  const s = runState(home, "opts-1");
  expect([s.nodes[0].role, s.nodes[0].tier, s.nodes[0].plan_backed, s.nodes[0].acceptance]).toEqual(["implementation", "balance", true, "unit tests pass; no new deps"]);
  o("node", "add", "opts-1", "b", "plain");
  const b = runState(home, "opts-1").nodes[1];
  expect([b.role ?? null, b.tier ?? null, b.plan_backed]).toEqual([null, null, false]);
  r = o("node", "add", "opts-1", "c", "x", "--role", "coding");
  expect(r.rc).toBe(2); expect(r.all).toMatch(/--role must be one of/);
  r = o("node", "add", "opts-1", "c", "x", "--tier", "smart-auto");
  expect(r.rc).toBe(2); expect(r.all).toMatch(/--tier must be one of/);
  expect(o("--help").all).toMatch(/\[--role R\] \[--tier T\] \[--model M\] \[--plan-backed\] \[--acceptance/);
  o("run", "finish", "opts-1");
});

test("node dispatch with claude-native", async () => {
  const home = seedHome(), o = orch(home);
  const node = (i: number) => runState(home, "disp-1").nodes[i];
  o("run", "start", "Dispatch test", "--id", "disp-1");
  o("node", "add", "disp-1", "a", "native");
  o("node", "add", "disp-1", "b", "hub", "--profile", "local-llm-fast");
  let r = o("node", "dispatch", "disp-1", "a", "claude-native", "hello", "--flag", "value");
  expect(r.rc).toBe(0);
  o("wait", r.out.trim(), "--timeout", "60", "--interval", "1");
  expect(o("run", "sync", "disp-1").all).toMatch(/^a.done$/m);
  expect(node(0).adapter).toBe("claude-native");
  expect(node(0).log_tail[0]).toMatch(/no subprocess spawned/);
  expect(node(0).prompt).toBe("hello");
  expect(node(0).dispatch_args).toEqual(["--flag", "value"]);
  r = o("node", "dispatch", "disp-1", "a", "claude-native", "again");
  expect(r.all).toMatch(/is done, not waiting/);
  expect(r.rc).toBe(2);
  const { spawnEchoHub } = await import("../helpers/hub-proc.ts");
  const hub = await spawnEchoHub(600);
  const job = o.env({ LLM_HUB_URL: hub.url }, "node", "dispatch", "disp-1", "b", "ping").out.trim();
  expect(o("run", "sync", "disp-1").all).toMatch(/^b.running$/m);
  o("wait", job, "--timeout", "60", "--interval", "1");
  expect(o("run", "sync", "disp-1").all).toMatch(/^b.done$/m);
  expect(node(1).profile).toBe("local-llm-fast");
  expect(node(1).model_id).toBe("local-ornith-1.5-9b");
  expect(node(1).model).toBe("llama_swap/ornith-1.5-9b");
  expect(node(1).adapter).toBe("local-llm");
  hub.stop();
}, 180000);

test("prune with trash unavailable", async () => {
  const home = seedHome();
  const shim = fakeBin({ trash: "exit 1" });
  const env = { PATH: `${shim}:${process.env.PATH}`, LLM_HUB_URL: "http://127.0.0.1:1", LLM_HUB_KEY: "dummy" };
  const o = orch(home, env);
  o("run", "start", "live", "--id", "live-1");
  o("run", "start", "old", "--id", "old-1");
  o("node", "add", "old-1", "x", "x");
  const oldJob = o("node", "dispatch", "old-1", "x", "claude-native", "hi").out.trim();
  await waitUntil(() => existsSync(join(home, "jobs", oldJob, "exit_code")), 60);
  o("run", "sync", "old-1"); o("run", "finish", "old-1");
  editJson(join(home, "runs/old-1/state.json"), (s) => { s.finished = "2020-01-01T00:00:00Z"; });
  let r = o("prune", "--dry-run");
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/would prune: .*runs\/old-1/);
  expect(r.all).toMatch(new RegExp(`would prune: .*jobs/${oldJob}`));
  expect(r.all).not.toMatch(/live-1/);
  expect(existsSync(join(home, "runs/old-1/state.json"))).toBe(true);
  r = o("prune");
  expect(r.rc).toBe(0);
  expect(r.all).toMatch(/pruned: .*runs\/old-1/);
  expect(r.all).toMatch(/^pruned 1 run\(s\)/m);
  expect(existsSync(join(home, "runs/old-1"))).toBe(false);
  expect(existsSync(join(home, "jobs", oldJob))).toBe(false);
  const found = (n: string) => Bun.spawnSync(["find", join(home, ".trash"), "-maxdepth", "2", "-name", n]).stdout.toString();
  expect(found("old-1")).toMatch("old-1");
  expect(found(oldJob)).toMatch(oldJob);
  expect(existsSync(join(home, "runs/live-1/state.json"))).toBe(true);
  r = o("prune", "--older-than", "xyz");
  expect(r.all).toMatch(/expects <N>d, <N>h or <N>/);
  expect(r.rc).toBe(2);
  o("run", "start", "old2", "--id", "old-2"); o("run", "finish", "old-2");
  editJson(join(home, "runs/old-2/state.json"), (s) => { s.finished = "2020-01-01T00:00:00Z"; });
  editJson(join(home, "profiles.json"), (p) => { p.settings.retention_days = 1; });
  o("run", "start", "trigger", "--id", "trig-1");
  expect(existsSync(join(home, "runs/old-2"))).toBe(false);
  expect(existsSync(join(home, "runs/trig-1/state.json"))).toBe(true);
}, 180000);

test("node retry, run retry, auto retry, backoff, fallback", async () => {
  // node retry
  let home = seedHome(), o = orch(home);
  const sf = () => join(home, "runs/retry-1/state.json");
  o("run", "start", "Retry test", "--id", "retry-1");
  o("node", "add", "retry-1", "a", "retry me");
  const job = o("node", "dispatch", "retry-1", "a", "claude-native", "again", "--same", "args").out.trim();
  o("wait", job, "--timeout", "60", "--interval", "1");
  o("run", "sync", "retry-1");
  o("node", "update", "retry-1", "a", "error", "--force", "--job", job, "--error", "exit=1");
  o("run", "finish", "retry-1");
  let r = o("node", "retry", "retry-1", "a");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^[0-9]/m);
  let s = runState(home, "retry-1");
  expect([s.status, s.finished ?? null, s.nodes[0].status, s.nodes[0].attempts[0].job_id, s.nodes[0].attempts[0].retry_mode, s.nodes[0].dispatch_args]).toEqual(["running", null, "running", job, "restarted", ["--same", "args"]]);
  o("wait", r.out.trim(), "--timeout", "60", "--interval", "1");
  o("run", "sync", "retry-1");
  r = o("node", "retry", "retry-1", "a");
  expect(r.rc).toBe(2);
  expect(r.all).toMatch(/not error or skipped/);

  home = seedHome(); o = orch(home);
  o("run", "start", "Old retry", "--id", "retry-old"); o("node", "add", "retry-old", "a", "a");
  editJson(join(home, "runs/retry-old/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", adapter: "claude-native", job_id: "old", error: "exit=1", finished: "2026-09-01T00:00:00Z" }); });
  r = o("node", "retry", "retry-old", "a", "--no-dispatch", "@/tmp/old-prompt.md");
  expect(r.rc).toBe(0);
  const n = runState(home, "retry-old").nodes[0];
  expect([n.status, n.prompt]).toEqual(["waiting", "@/tmp/old-prompt.md"]);

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
  expect([s.nodes[0].status, s.nodes[0].attempts.length, s.nodes[1].status]).toEqual(["running", 1, "error"]);

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
  editJson(join(home, "profiles.json"), (p) => { p.settings.disabled_harnesses = []; });
  o("run", "start", "Fallback retry", "--id", "retry-4"); o("node", "add", "retry-4", "a", "a", "--profile", "claude-llm-hub");
  editJson(join(home, "runs/retry-4/state.json"), (s) => { Object.assign(s.nodes[0], { status: "error", prompt: "again", job_id: "old", error: "exit=1", finished: "2026-09-01T00:00:00Z", next_retry_at: "2000-01-01T00:00:00Z", log_tail: ["You have exceeded your monthly quota"] }); });
  expect(o("run", "sync", "retry-4").rc).toBe(0);
  const f = runState(home, "retry-4").nodes[0];
  expect(f.profile).toBe("copilot-llm-hub");
  expect(f.attempts[0].reason).toMatch(/fallback profile copilot-llm-hub/);
  expect(f.attempts[0].retry_mode).toBe("restarted");
}, 300000);
