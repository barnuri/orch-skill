import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { orch, seedHome, runState, nodeOf, addLocalFast, readText, fakeBin, fakeHub, tempDir, autoCleanup } from "../helpers";
autoCleanup();

const hdrShims = () => fakeBin({
  claude: `printf "%s\\n" "\${ANTHROPIC_CUSTOM_HEADERS-unset}"`,
  copilot: `printf "%s\\n" "$@"`,
});

test("worker identity headers", () => {
  const home = seedHome();
  const sh = hdrShims();
  const o = orch(home, { PATH: `${sh}:${process.env.PATH}` });
  const wait = (j: string) => o("wait", j, "--timeout", "60", "--interval", "0.1");
  const log = (j: string) => readText(join(home, "jobs", j, "log"));
  const n = (run: string, i = 0) => runState(home, run).nodes[i];
  o("run", "start", "Worker identity", "--id", "wid-1");
  o("node", "add", "wid-1", "impl", "Implement", "--role", "implementation", "--tier", "balance");
  const job = o("node", "dispatch", "wid-1", "impl", "claude", "do it").out.trim(); wait(job);
  expect(log(job)).toMatch(/x-llm-hub-smart-auto-worker: wid-1\/impl\/1/);
  expect(log(job)).toMatch(/x-llm-hub-smart-auto-parent: wid-1/);
  expect(log(job)).toMatch(/x-llm-hub-smart-auto-role: implementation/);
  expect(log(job)).toMatch(/x-llm-hub-smart-auto-tier: balance/);
  expect([n("wid-1").metadata_transport, n("wid-1").worker_identity]).toEqual(["headers", "wid-1/impl/1"]);
  o("node", "update", "wid-1", "impl", "error", "--error", "exit=1");
  const retry = o("node", "retry", "wid-1", "impl").out.trim(); wait(retry);
  expect(log(retry)).toMatch(/x-llm-hub-smart-auto-worker: wid-1\/impl\/2/);
  o("node", "update", "wid-1", "impl", "error", "--error", "exit=1");
  const inh = o.env({ ANTHROPIC_CUSTOM_HEADERS: "x-custom-tag: keep" }, "node", "retry", "wid-1", "impl").out.trim(); wait(inh);
  expect(log(inh).split("\n")[0]).toBe("x-custom-tag: keep");

  o("run", "start", "Preset only", "--id", "wid-2");
  o("node", "add", "wid-2", "cop", "Copilot node", "--role", "validation");
  const cop = o("node", "dispatch", "wid-2", "cop", "copilot", "check").out.trim(); wait(cop);
  expect(log(cop)).not.toMatch(/x-llm-hub-smart-auto/);
  expect(n("wid-2").metadata_transport).toBe("preset-model");
  expect(n("wid-2").worker_identity ?? null).toBeNull();

  o("run", "start", "Nested identity", "--id", "wid-3");
  o("node", "add", "wid-3", "plain", "Plain child"); o("node", "add", "wid-3", "plain2", "Plain child two");
  o("node", "add", "wid-3", "opt", "Child with options", "--tier", "balance");
  const parent = ["x-llm-hub-smart-auto-worker: wid-1/impl/1", "x-llm-hub-smart-auto-parent: wid-1", "x-llm-hub-smart-auto-role: implementation", "x-custom-tag: keep"].join("\n");
  const nj = o.env({ ANTHROPIC_CUSTOM_HEADERS: parent }, "node", "dispatch", "wid-3", "plain", "claude", "nested").out.trim(); wait(nj);
  expect(log(nj)).not.toMatch(/x-llm-hub-smart-auto/);
  expect(log(nj)).toMatch(/^x-custom-tag: keep$/m);
  const no = o.env({ ANTHROPIC_CUSTOM_HEADERS: "x-llm-hub-smart-auto-worker: wid-1/impl/1" }, "node", "dispatch", "wid-3", "plain2", "claude", "nested").out.trim(); wait(no);
  expect(log(no).trim()).toBe("unset");
  const op = o.env({ ANTHROPIC_CUSTOM_HEADERS: parent }, "node", "dispatch", "wid-3", "opt", "claude", "nested").out.trim(); wait(op);
  expect(log(op)).toMatch(/x-llm-hub-smart-auto-worker: wid-3\/opt\/1/);
  expect(log(op)).not.toMatch(/wid-1\/impl\/1/);
}, 240000);

test("node selections from a fake hub", async () => {
  const events: Record<string, any[]> = { "wsel/nsel/1": [
    { seq: 1, worker_key: "k", attempt_key: "a1", stage: "solver", state: "selected", model: "llama_swap/qwen3.6-35b", requested_selector: "hub/smart-auto-balance", tier: "balance", role: "implementation", ts_ms: 1000, sent_effort: "medium" },
    { seq: 2, worker_key: "k", attempt_key: "a1", stage: "solver", state: "completed", model: "llama_swap/qwen3.6-35b", requested_selector: "hub/smart-auto-balance", tier: "balance", role: "implementation", ts_ms: 2000, selected_effort: "high", sent_effort: "medium" },
    { seq: 3, worker_key: "k", attempt_key: "a1", stage: "judge", state: "started", model: "llama_swap/ornith-1.5-35b", requested_selector: "hub/smart-auto-balance", tier: "balance", role: "review", ts_ms: 3000, selected_effort: "high" },
  ] };
  const hubSrc = `const events = ${JSON.stringify(events)};
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
  const u = new URL(req.url);
  if (u.pathname !== "/api/smart-auto/history") return new Response("", { status: 404 });
  const since = Number(u.searchParams.get("since_seq") ?? 0);
  const rows = u.searchParams.has("since_ts_ms") ? (events[u.searchParams.get("worker") ?? ""] ?? []).filter((e) => e.seq > since) : [];
  return Response.json({ events: rows });
} });
console.log(s.port);`;
  const hubProc = Bun.spawn(["bun", "-e", hubSrc], { stdout: "pipe" });
  const server = { port: Number((await hubProc.stdout.getReader().read().then((r) => new TextDecoder().decode(r.value))).trim()), stop: (_?: boolean) => hubProc.kill() };
  const home = seedHome();
  const o = orch(home, { LLM_HUB_URL: `http://127.0.0.1:${server.port}` });
  o("run", "start", "Selections", "--id", "wsel"); o("node", "add", "wsel", "nsel", "Solve");
  let r = o("node", "selections", "wsel", "nsel");
  expect(r.rc).toBe(0); expect(r.out).toMatch(/^selections: 3 new$/m);
  const n = () => nodeOf(home, "wsel", "nsel");
  expect(n().selection_history.map((e: any) => e.seq).join(",")).toBe("1,2,3");
  expect(n().last_event_sequence).toBe(3);
  expect([n().requested_selector, n().main_model, n().active_stages.join(","), n().actual_model, n().role, n().tier, n().effort])
    .toEqual(["hub/smart-auto-balance", "llama_swap/qwen3.6-35b", "judge", "llama_swap/qwen3.6-35b", "implementation", "balance", "high"]);
  expect(n().effort_history.map((e: any) => `${e.seq}:${e.effort}`).join(",")).toBe("1:medium,2:high");
  expect(o("node", "selections", "wsel", "nsel").out).toMatch(/^selections: 0 new$/m);
  expect(n().selection_history.length).toBe(3);
  expect(o.env({ LLM_HUB_URL: "" }, "node", "selections", "wsel", "nsel").rc).toBe(2);
  server.stop(true);
});

test("herdr off, run stop, claude path, profile jobs", async () => {
  const sh = fakeBin(Object.fromEntries(["claude", "cursor-agent", "opencode", "copilot"].map((t) => [t, `printf "%s\\n" "$@"`])));
  const home = seedHome();
  addLocalFast(home);
  const o = orch(home, { PATH: `${sh}:${process.env.PATH}`, CURSOR_API_KEY: "shim" });
  mkdirSync(join(home, "jobs/herdr-race"), { recursive: true });
  writeFileSync(join(home, "jobs/herdr-race/herdr-launch.sh"), "#!/usr/bin/env bash\n");
  writeFileSync(join(home, "jobs/herdr-race/herdr_pane"), "w1:p9\n");
  expect(o("status", "herdr-race").out.trim()).toBe("running");
  expect(o("herdr", "off").all).toMatch(/^herdr: off/m);
  const off = o("start", "claude", "off probe").out.trim();
  o("wait", off, "--timeout", "60", "--interval", "0.1");
  expect(readText(join(home, "jobs", off, "herdr_pane")).trim()).toBe("");
  expect(o("herdr", "maybe").rc).toBe(2);

  const sleepSh = fakeBin({ claude: "sleep 30" });
  const os = orch(home, { PATH: `${sleepSh}:${process.env.PATH}` });
  os("run", "start", "Stop me", "--id", "stop-run"); os("node", "add", "stop-run", "a", "a"); os("node", "add", "stop-run", "b", "b", "--after", "a");
  const sj = os("node", "dispatch", "stop-run", "a", "claude", "sleep").out.trim();
  let r = os("run", "stop", "stop-run");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/killed 1 job/);
  os("wait", sj, "--timeout", "60", "--interval", "0.1");
  expect(os("status", sj).out.trim()).toBe("done exit=143");
  const s = runState(home, "stop-run");
  expect([s.stopped, s.status, s.nodes.map((n: any) => n.status).join(" ")]).toEqual([true, "running", "stopped waiting"]);
  os("run", "sync", "stop-run");
  expect(runState(home, "stop-run").nodes[0].status).toBe("stopped");
  expect(os("run", "stop").rc).toBe(2);
  expect(os("run", "stop", "no-such-run").rc).toBe(2);

  const bunDir = tempDir("orch-bun-");
  symlinkSync(process.execPath, join(bunDir, "bun"));
  const bare = `${bunDir}:/usr/bin:/bin`;
  const noClaude = orch(home, { ORCH_BIN_DIRS: "", PATH: bare });
  r = noClaude("run", "claude", "hi");
  expect(r.all).toMatch(/claude not found on PATH/); expect(r.rc).toBe(127);
  r = orch(home, { ORCH_BIN_DIRS: sh, PATH: bare })("run", "claude", "off-path");
  expect(r.rc).toBe(0);
  expect(r.all.replace(/\n/g, " ")).toMatch(/^-p off-path --output-format json/);
  r = o("run", "--profile", "claude-default");
  expect(r.all).toMatch(/usage: dispatch.ts run \(--profile <name> \| <adapter>\)/); expect(r.rc).toBe(2);
  expect(o("start", "--profile", "bogus", "hi").rc).toBe(2);
  const jid = o("start", "--profile", "claude-default", "bg").out.trim();
  o("wait", jid, "--timeout", "60", "--interval", "0.1");
  expect(o("list").all).toMatch(new RegExp(`${jid}.done exit=0.claude-default`));
  expect(o("tail", jid).all).toMatch(/--model/);
  const hubSrc = `const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { let content = "", model = ""; try { const b = await req.json(); content = b.messages?.[0]?.content ?? ""; model = b.model ?? ""; } catch {} return Response.json({ choices: [{ message: { content: "echo:" + content + "|model=" + model } }] }); } }); console.log(s.port);`;
  const hubProc = Bun.spawn(["bun", "-e", hubSrc], { stdout: "pipe" });
  const hub = { url: `http://127.0.0.1:${(await hubProc.stdout.getReader().read().then((x) => new TextDecoder().decode(x.value))).trim()}`, stop: () => hubProc.kill() };
  r = o.env({ LLM_HUB_URL: hub.url }, "run", "--profile", "local-llm-fast", "ping");
  expect(r.all).toMatch(/echo:ping.model=llama_swap\/ornith-1.5-9b/);
  hub.stop();
}, 240000);
