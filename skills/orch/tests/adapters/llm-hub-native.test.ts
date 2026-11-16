import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { orch, seedHome, editJson, runState, fakeBin, readText, autoCleanup } from "../helpers";
autoCleanup();

test("hub setup, tiers, headers, resolve, outcome", () => {
  const posts: string[] = [];
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET") {
      if (u.pathname === "/healthz") return new Response("ok");
      if (u.pathname === "/api/smart-auto/current") return Response.json({ selection: { main: { worker: "salted-" + (u.searchParams.get("worker") ?? ""), model: "used/model", tier: "intelligence", role: "planning", reason: "fresh", state: "completed" } } });
      return Response.json({}, { status: 404 });
    }
    const body = await req.text();
    posts.push(`${u.pathname} ${body}`);
    if (u.pathname === "/api/smart-auto/resolve") { const r = JSON.parse(body); return Response.json({ model: "expected/" + r.tier, tier: r.tier, role: r.role ?? null, reason: "fresh", alternatives: [] }); }
    if (u.pathname === "/api/smart-auto/outcome") return Response.json({});
    return Response.json({}, { status: 404 });
  } });
  const home = seedHome();
  const shims = fakeBin({
    opencode: `printf "%s\\n" "\${OPENCODE_CONFIG_CONTENT-unset}"\nprintf "%s\\n" "$@"`,
    copilot: `printf "%s\\n" "$@"`,
  });
  writeFileSync(join(home, "env"), `LLM_HUB_URL=http://127.0.0.1:${srv.port}\nLLM_HUB_KEY=k\n`);
  const o = orch(home, { PATH: `${shims}:${process.env.PATH}` });
  o("profile", "list");
  expect(o("hub", "setup", "--harness", "nope").rc).toBe(2);
  const r = o("hub", "setup");
  expect(r.rc).toBe(0);
  expect(r.out).toMatch(/^mode: smart-auto$/m);
  expect(r.out).toMatch(/^harness: opencode$/m);
  expect(r.out).toMatch(/^planner_profile: opencode-smart-auto$/m);
  const pf = join(home, "profiles.json");
  expect(JSON.parse(readText(pf)).settings.disabled_harnesses?.includes("opencode") ?? false).toBe(false);
  const before = readText(pf);
  o("hub", "setup");
  expect(readText(pf)).toBe(before);
  expect(o("hub", "resolve", "fast").all).toMatch(/"model":"expected\/fast"/);
  o("run", "start", "Hub", "--id", "hub-1");
  o("node", "add", "hub-1", "plan", "Plan", "--role", "planning");
  o("node", "add", "hub-1", "check", "Check", "--role", "validation", "--tier", "fast", "--acceptance", "tests pass");
  o("node", "add", "hub-1", "bare", "Bare");
  const n = (i: number) => runState(home, "hub-1").nodes[i];
  expect(n(0).profile).toBe("opencode-smart-auto");
  expect(n(0).tier).toBe("intelligence");
  expect(n(1).tier).toBe("fast");
  expect(n(2).tier ?? null).toBeNull();
  const job = o("node", "dispatch", "hub-1", "plan", "do it").out.trim();
  o("wait", job, "--timeout", "60", "--interval", "1");
  const log = readText(join(home, "jobs", job, "log"));
  expect(log).toMatch(/"x-llm-hub-smart-auto-tier":"intelligence"/);
  expect(log).toMatch(/"x-llm-hub-smart-auto-worker":"hub-1\/plan\/1"/);
  expect(n(0).metadata_transport).toBe("headers");
  expect(posts.join("\n")).toMatch(/\/api\/smart-auto\/resolve .*"tier":"intelligence".*"role":"planning"/);
  expect(n(0).hub.expected.model).toBe("expected/intelligence");
  const check = o("node", "dispatch", "hub-1", "check", "check it").out.trim();
  o("wait", check, "--timeout", "60", "--interval", "1");
  o("run", "sync", "hub-1");
  expect(n(0).hub.actual.model).toBe("used/model");
  expect(n(0).hub.outcome ?? null).toBeNull();
  expect(n(1).hub.outcome).toBe("tests_passed");
  expect(posts.join("\n")).toMatch(/\/api\/smart-auto\/outcome .*"worker":"salted-hub-1\/check\/1".*"code":"tests_passed"/);
  editJson(pf, (p) => { p.settings.llm_hub.role_tiers.validation = "turbo"; });
  o("node", "add", "hub-1", "bad-tier", "Bad", "--role", "validation");
  expect(runState(home, "hub-1").nodes.find((x: any) => x.id === "bad-tier").tier).toBe("efficiency");
  expect(o("hub", "off").out).toMatch(/^mode: off$/m);
  o("node", "add", "hub-1", "after-off", "After", "--role", "planning");
  expect(runState(home, "hub-1").nodes.find((x: any) => x.id === "after-off").tier ?? null).toBeNull();
  srv.stop(true);
}, 240000);
