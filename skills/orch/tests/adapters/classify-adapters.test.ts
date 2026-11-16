import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, tempDir, fakeBin, fakeHub, runCmd, runCmdAsync, DISPATCH, readText, pathWithout, autoCleanup } from "../helpers";
autoCleanup();

const d = (env: Record<string, string | undefined>, ...a: string[]) => runCmd(["bun", DISPATCH, ...a], { env });
const snap = (rate: object) => JSON.stringify({ api: { type: "subscription" }, captured_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), rate_limits: rate });

test("classify chooses a harness", () => {
  const t = tempDir();
  const none = { CLAUDE_USAGE_SNAPSHOT: join(t, "no-such-file.json"), LLM_HUB_URL: "" };
  expect(d(none, "classify", "fix a typo").out.trim()).toBe("claude-native");
  expect(d(none, "classify", "anything", "--complexity", "trivial").out.trim()).toBe("claude-native");
  expect(d(none, "classify", "anything", "--complexity", "large").out.trim()).toBe("claude-native");
  expect(d({ ...none, LLM_HUB_URL: "http://127.0.0.1:1" }, "classify", "anything", "--complexity", "medium").out.trim()).toBe("local-llm");
  expect(d({ ...none, LLM_HUB_URL: "http://127.0.0.1:1" }, "classify", "anything", "--complexity", "large", "--prefer-local").out.trim()).toBe("local-llm");
  expect(d(none, "classify", "anything", "--complexity", "medium").out.trim()).toBe("claude-native");

  const busy = join(tempDir(), "busy.json");
  writeFileSync(busy, snap({ five_hour: { used_percentage: 99 } }));
  const env = { CLAUDE_USAGE_SNAPSHOT: busy };
  const cursor = fakeBin({ "cursor-agent": "exit 0" });
  expect(d({ ...env, PATH: `${cursor}:${process.env.PATH}` }, "classify", "anything", "--complexity", "trivial").out.trim()).toBe("cursor-agent");
  const oc = fakeBin({ opencode: "exit 0" });
  expect(d({ ...env, PATH: `${oc}:${pathWithout("cursor-agent")}` }, "classify", "anything", "--complexity", "trivial").out.trim()).toBe("opencode");
  const cp = fakeBin({ copilot: "exit 0" });
  const filtered = pathWithout("cursor-agent", "opencode", "copilot");
  expect(d({ ...env, PATH: `${cp}:${filtered}` }, "classify", "anything", "--complexity", "trivial").out.trim()).toBe("copilot");
  expect(d({ ...env, PATH: filtered, LLM_HUB_URL: "http://127.0.0.1:1" }, "classify", "anything", "--complexity", "trivial").out.trim()).toBe("local-llm");
  const full = d({ ...env, PATH: filtered, LLM_HUB_URL: "" }, "classify", "anything", "--complexity", "trivial");
  expect(full.all).toMatch(/claude-native/);
  expect(full.all).toMatch(/no alternate harness available/);
});

test("budget-check", () => {
  const t = tempDir();
  const bc = (file: string) => d({ CLAUDE_USAGE_SNAPSHOT: file }, "budget-check");
  let r = bc(join(t, "missing.json"));
  expect(r.all).toMatch(/no snapshot at/); expect(r.rc).toBe(0);
  writeFileSync(join(t, "nonsub.json"), '{"api":{"type":"api_key"}}');
  r = bc(join(t, "nonsub.json")); expect(r.all).toMatch(/not subscription/); expect(r.rc).toBe(0);
  writeFileSync(join(t, "under.json"), snap({ five_hour: { used_percentage: 10 }, day: { used_percentage: 20 } }));
  r = bc(join(t, "under.json")); expect(r.all).toMatch(/all windows below/); expect(r.rc).toBe(0);
  writeFileSync(join(t, "over.json"), snap({ five_hour: { used_percentage: 10 }, week: { used_percentage: 91 } }));
  r = bc(join(t, "over.json")); expect(r.all).toMatch(/week window at 91/); expect(r.rc).toBe(1);
  writeFileSync(join(t, "stale.json"), '{"api":{"type":"subscription"},"captured_at":"2020-01-01T00:00:00Z","rate_limits":{"five_hour":{"used_percentage":99}}}');
  r = bc(join(t, "stale.json")); expect(r.all).toMatch(/old/); expect(r.rc).toBe(0);
});

test("run/start argument errors and missing harnesses", () => {
  let r = d({}, "run"); expect(r.all).toMatch(/usage: dispatch.ts run/); expect(r.rc).toBe(2);
  r = d({}, "start", "claude-native"); expect(r.all).toMatch(/usage: dispatch.ts start/); expect(r.rc).toBe(2);
  r = d({}, "run", "claude-native", "@/no/such/promptfile"); expect(r.all).toMatch(/prompt file not found/); expect(r.rc).toBe(1);
  for (const h of ["cursor-agent", "opencode", "copilot"]) {
    r = d({ ORCH_BIN_DIRS: "", PATH: pathWithout(h) }, "run", h, "hi");
    expect(r.all).toMatch(`${h} not found on PATH`); expect(r.rc).toBe(127);
  }
});

test("local-llm env resolution and v1 url", async () => {
  const hubHome = join(tempDir(), "h");
  const run = (env: Record<string, string | undefined>) => runCmd(["bun", DISPATCH, "run", "local-llm", "hi"], { env: { HARNESS_ORCH_HOME: hubHome, LLM_HUB_URL: undefined, LLM_HUB_V1_URL: undefined, ...env } });
  let r = run({ LLM_HUB_URL: "" });
  expect(r.all).toMatch(/LLM_HUB_URL not set/); expect(r.rc).toBe(1);
  writeFileSync(join(Bun.spawnSync(["mkdir", "-p", hubHome]) && hubHome, "env"), "LLM_HUB_URL=http://127.0.0.1:9\n");
  expect(run({ LLM_HUB_URL: "" }).all).toMatch(/LLM_HUB_URL not set/);
  expect(run({}).all).not.toMatch(/LLM_HUB_URL not set/);
  const paths: string[] = [];
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { paths.push(new URL(req.url).pathname); return Response.json({ choices: [{ message: { content: "ok" } }] }); } });
  const base = `http://127.0.0.1:${srv.port}`;
  const post = async (env: Record<string, string>) => { paths.length = 0; await Bun.spawn(["bun", DISPATCH, "run", "local-llm", "hi"], { env: { ...process.env, HARNESS_ORCH_HOME: hubHome, ORCH_NO_ANNOUNCE: "1", ...env } as any, stdout: "ignore", stderr: "ignore" }).exited; return paths[0]; };
  expect(await post({ LLM_HUB_URL: base })).toBe("/v1/chat/completions");
  expect(await post({ LLM_HUB_URL: `${base}/` })).toBe("/v1/chat/completions");
  expect(await post({ LLM_HUB_URL: `${base}/v1` })).toBe("/v1/chat/completions");
  expect(await post({ LLM_HUB_URL: `${base}/v1/` })).toBe("/v1/chat/completions");
  expect(await post({ LLM_HUB_URL: base, LLM_HUB_V1_URL: `${base}/custom/v1` })).toBe("/custom/v1/chat/completions");
  srv.stop(true);
});

test("claude-native sentinel, jobs, local-llm timing", async () => {
  const home = seedHome(), o = orch(home);
  let r = o("run", "claude-native", "hi");
  expect(r.all).toMatch(/no subprocess spawned/); expect(r.rc).toBe(0);
  const job = o("start", "claude-native", "hi").out.trim();
  o("wait", job, "--timeout", "60", "--interval", "1");
  expect(o("status", job).out).toMatch(/^done exit=0$/m);
  expect(o("tail", job).all).toMatch(/no subprocess spawned/);
  expect(o("list").all).toMatch(new RegExp(`${job}.*done exit=0`));
  r = o("status", "no-such-job"); expect(r.all).toMatch(/unknown job/); expect(r.rc).toBe(2);
  r = o("tail", "no-such-job"); expect(r.all).toMatch(/no log for job/); expect(r.rc).toBe(2);

  const hub = fakeHub(3000);
  const pf = join(tempDir(), "prompt.txt"); writeFileSync(pf, "hello from a file");
  const oh = orch(home, { LLM_HUB_URL: hub.url });
  const lj = oh("start", "local-llm", `@${pf}`).out.trim();
  expect(oh("status", lj).out).toMatch(/^running$/m);
  const ow = (...a: string[]) => runCmdAsync(["bun", DISPATCH, ...a], { home, env: { LLM_HUB_URL: hub.url } });
  expect((await ow("wait", lj, "--timeout", "1", "--interval", "1")).rc).toBe(124);
  r = await ow("wait", lj, "--timeout", "60", "--interval", "1");
  expect(r.out).toMatch(/^done exit=0$/m); expect(r.rc).toBe(0);
  expect(oh("tail", lj).all).toMatch(/echo:hello from a file/);
  hub.stop();
}, 180000);
