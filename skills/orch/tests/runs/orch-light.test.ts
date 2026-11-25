// orch-light: one watcher per run, nudges over HTTP, stale-service report, shared service for opencode nodes.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { orch, seedHome, editJson, tempDir, fakeBin, opencodeFixture, ndjson, events, DISPATCH, cleanEnv, waitUntil, autoCleanup } from "../helpers";
autoCleanup();

const fx = await opencodeFixture();
const PW = "s3cret";
const BASIC = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64");

// Fake opencode service in its own process: GET /api/info (needs Basic auth), every POST is logged.
async function fakeService(version = "2.4.1") {
  const dir = tempDir("orch-svc-");
  const log = join(dir, "requests");
  const script = join(dir, "svc.ts");
  writeFileSync(script, `
    import { appendFileSync } from "node:fs";
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
      const u = new URL(req.url);
      if (req.headers.get("authorization") !== ${JSON.stringify(BASIC)}) return new Response("no", { status: 401 });
      if (req.method === "GET" && u.pathname === "/api/info") return Response.json({ version: ${JSON.stringify(version)} });
      if (req.method === "GET" && u.pathname === "/api/model") return Response.json({ data: [
        { id: "hub/smart-auto-fast", providerID: "llm-hub", enabled: true, settings: { baseURL: "http://localhost:8888/v1" } },
        { id: "copilot/claude-opus-5-5[1m]", providerID: "llm-hub", enabled: true, settings: { baseURL: "http://localhost:8888/v1" } },
      ] });
      return req.text().then((b) => { appendFileSync(${JSON.stringify(log)}, req.method + " " + u.pathname + " " + b + "\\n"); return Response.json({ ok: true }); });
    } });
    process.stdout.write(String(s.port));
  `);
  const p = Bun.spawn([process.execPath, script], { stdout: "pipe" });
  const reader = p.stdout.getReader();
  const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
  const file = join(dir, "service.json");
  writeFileSync(file, JSON.stringify({ id: "x", version, url: `http://0.0.0.0:${port}`, pid: p.pid, password: PW }));
  return { file, requests: () => (existsSync(log) ? readFileSync(log, "utf8") : ""), stop: () => p.kill() };
}

const stalled = (o: any) => {
  const R = o("run", "start", "light").out.trim();
  o.in(ndjson([{ op: "add", id: "stall", label: "stall" }, { op: "update", id: "stall", status: "running", owner: "ses_stall1" }]), "node", "batch", R);
  return R;
};

test("nudge goes over HTTP to a healthy shared service, once per gap, and falls back to the CLI", async () => {
  const svc = await fakeService();
  try {
    const home = seedHome();
    const o = orch(home, { ...fx.env, ORCH_OPENCODE_SERVICE_JSON: svc.file });
    const R = stalled(o);
    writeFileSync(join(fx.dir, "calls"), "");
    o("run", "health", R, "--nudge");
    expect(svc.requests()).toMatch(/^POST \/api\/session\/ses_stall1\/prompt .*You stopped mid-task/);
    expect(fx.calls()).toBe("");
    expect(events(home, R).filter((e) => e.kind === "nudge").length).toBe(1);
    o("run", "health", R, "--nudge"); o("run", "health", R, "--nudge");
    expect(svc.requests().trim().split("\n").length).toBe(1);

    // Service down: the CLI is the fallback.
    svc.stop();
    await Bun.sleep(300);
    o.env({ ORCH_HEALTH_NUDGE_GAP_SECS: "0" }, "run", "health", R, "--nudge");
    expect(fx.calls()).toMatch(/api POST \/api\/session\/ses_stall1\/prompt/);
  } finally { svc.stop(); }
});

test("a second nudger for the same run skips while the nudge lock is held", async () => {
  const home = seedHome();
  const o = orch(home, fx.env);
  const R = stalled(o);
  writeFileSync(join(fx.dir, "calls"), "");
  const holder = Bun.spawn(["sleep", "30"]);
  try {
    writeFileSync(join(home, "locks", `nudge-${R}.pid`), `${holder.pid}\n`);
    o("run", "health", R, "--nudge");
    expect(fx.calls()).toBe("");
  } finally { holder.kill(); await holder.exited; }
  o("run", "health", R, "--nudge");
  expect(fx.calls()).toMatch(/prompt/);
});

for (const [label, args, lock] of [["run watch", ["run", "watch"], "run-watch"], ["run wait --follow", ["run", "wait"], "run-follow"]] as const) {
  test(`${label} is single-instance per run`, async () => {
    const home = seedHome();
    const env = cleanEnv({ HARNESS_ORCH_HOME: home, ...fx.env, ORCH_WAIT_POLL_SECS: "0.2" });
    const o = orch(home, fx.env);
    const R = o("run", "start", "single").out.trim();
    o("node", "add", R, "a", "a"); o("node", "update", R, "a", "running", "--owner", "coordinator");
    const tail = lock === "run-follow" ? [R, "--follow"] : [R];
    const first = Bun.spawn([process.execPath, DISPATCH, ...args, ...tail], { env, stdout: "pipe", stderr: "pipe" });
    try {
      const f = join(home, "locks", `${lock}-${R}.pid`);
      expect(await waitUntil(() => existsSync(f) && readFileSync(f, "utf8").trim() === String(first.pid), 60)).toBe(true);
      const second = Bun.spawnSync([process.execPath, DISPATCH, ...args, ...tail], { env });
      expect(second.exitCode).toBe(0);
      expect(second.stdout.toString()).toBe(`already watched by pid ${first.pid}\n`);
    } finally { first.kill(); }
  });
}

test("doctor reports a stale shared service once, with the fix", () => {
  const home = seedHome();
  const dir = tempDir("orch-stale-");
  const svc = join(dir, "service.json");
  writeFileSync(svc, JSON.stringify({ url: "http://127.0.0.1:1", version: "1.0.0", pid: 1, password: "x" }));
  const o = orch(home, { ORCH_OPENCODE_SERVICE_JSON: svc, ORCH_OPENCODE_CLI_VERSION: "2.0.0" });
  const r = o("doctor").out;
  expect(r.match(/opencode service restart/g)?.length).toBe(1);
  expect(r).toMatch(/service 1\.0\.0, cli 2\.0\.0/);
  // Same version, but the log shows a port conflict.
  writeFileSync(svc, JSON.stringify({ url: "http://127.0.0.1:1", version: "2.0.0", pid: 1, password: "x" }));
  const log = join(dir, "opencode.log");
  writeFileSync(log, `timestamp=${new Date().toISOString()} level=ERROR message="cli process failed" cause="Cause([Fail(Error: Managed service port 1 on 0.0.0.0 is already in use by PID 99 (x)\n`);
  expect(o.env({ ORCH_OPENCODE_LOG: log }, "doctor").out).toMatch(/already in use by PID 99\)?\. Fix: opencode service restart/);
  // An old conflict line is ignored.
  writeFileSync(log, `timestamp=2020-01-01T00:00:00.000Z level=ERROR message="cli process failed" cause="already in use by PID 99"\n`);
  expect(o.env({ ORCH_OPENCODE_LOG: log }, "doctor").out).not.toMatch(/opencode service restart/);
});

test("opencode nodes use the shared service when healthy and the same version, else --standalone", async () => {
  const svc = await fakeService("2.4.1");
  try {
    const home = seedHome();
    const sh = fakeBin({ opencode: `printf "%s\\n" "$@"` });
    const base = { PATH: `${sh}:${process.env.PATH}`, ORCH_OPENCODE_SERVICE_JSON: svc.file, ORCH_OPENCODE_CLI_VERSION: "2.4.1" };
    const argv = (env: Record<string, string>, ...a: string[]) => orch(home, { ...base, ...env })("run", "opencode", "x", ...a).all.replace(/\n/g, " ").trim();
    expect(argv({})).toBe("run x --auto");
    // Per-node config with no model the service serves: that node keeps a private server.
    expect(argv({ OPENCODE_CONFIG_CONTENT: "{}" })).toBe("run x --auto --standalone");
    // Hub and smart-auto nodes: the model is mapped to the service's provider, so no private server starts.
    const hub = (models: Record<string, unknown>) => JSON.stringify({ provider: { hub: { options: { baseURL: "{env:LLM_HUB_V1_URL}" }, models } } });
    const smart = { OPENCODE_CONFIG_CONTENT: hub({ "smart-auto-balance": { id: "hub/smart-auto-balance" } }), LLM_HUB_V1_URL: "http://127.0.0.1:8888/v1", ORCH_NODE_TIER: "fast" };
    expect(argv(smart, "-m", "hub/smart-auto-balance")).toBe("run x --auto -m llm-hub/hub/smart-auto-fast");
    const opus = { OPENCODE_CONFIG_CONTENT: hub({ "claude-opus-5-5": { id: "copilot/claude-opus-5-5[1m]" } }), LLM_HUB_V1_URL: "http://localhost:8888/v1" };
    expect(argv(opus, "-m", "hub/claude-opus-5-5")).toBe("run x --auto -m llm-hub/copilot/claude-opus-5-5[1m]");
    // Same model on another hub, or a model the service lacks: private server.
    expect(argv({ ...opus, LLM_HUB_V1_URL: "http://other:8888/v1" }, "-m", "hub/claude-opus-5-5")).toBe("run x --auto --standalone -m hub/claude-opus-5-5");
    expect(argv({ ...smart, ORCH_NODE_TIER: "" }, "-m", "hub/smart-auto-balance")).toBe("run x --auto --standalone -m hub/smart-auto-balance");
    // Version differs: private server.
    expect(argv({ ORCH_OPENCODE_CLI_VERSION: "2.5.0" })).toBe("run x --auto --standalone");
    // Setting off: private server.
    editJson(join(home, "profiles.json"), (p: any) => { p.settings = { ...(p.settings ?? {}), opencode_shared_service: false }; });
    expect(argv({})).toBe("run x --auto --standalone");
  } finally { svc.stop(); }
});

test("watchdog reports a stale shared service once and never restarts it", async () => {
  const { WatchdogService } = await import("../../../../src/server/watchdog/watchdog-service");
  const home = seedHome();
  let problem: string | null = "opencode service is stale: service 1, cli 2. Fix: opencode service restart";
  const logs: string[] = [], ran: string[][] = [];
  const dog = new WatchdogService(home, { serviceProblem: () => problem, log: (l: string) => logs.push(l), run: async (a: string[]) => { ran.push(a); return 0; } } as any);
  dog.checkService(); dog.checkService();
  expect(logs.filter((l) => /opencode service restart/.test(l)).length).toBe(1);
  expect(ran).toEqual([]);
  problem = null; dog.checkService();
  problem = "again. Fix: opencode service restart"; dog.checkService();
  expect(logs.filter((l) => /opencode service restart/.test(l)).length).toBe(2);
});
