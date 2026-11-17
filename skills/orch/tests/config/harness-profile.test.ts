import { test, expect } from "bun:test";
import { join } from "node:path";
import { orch, seedHome, tempDir, editJson, runCmd, pathWithout, autoCleanup } from "../helpers";
autoCleanup();

test("harness list and profile show", () => {
  const home = seedHome(), o = orch(home);
  let out = JSON.parse(o("harness", "list", "--json").out);
  const ids = out.harnesses.map((h: any) => h.id);
  expect(ids).toContain("claude"); expect(ids).toContain("local-llm"); expect(ids).toContain("pi");
  expect(out.harnesses.find((h: any) => h.id === "claude").wired).toBe(true);
  editJson(join(home, "profiles.json"), (p) => { p.settings.disabled_harnesses = ["opencode"]; });
  out = JSON.parse(o("harness", "list", "--json").out);
  expect(out.harnesses.find((h: any) => h.id === "opencode").enabled).toBe(false);
  let s = o("profile", "show", "claude-llm-hub").all;
  expect(s).toMatch(/\$\{LLM_HUB_URL\}/);
  expect(s).toMatch(/"ANTHROPIC_DEFAULT_SONNET_MODEL": "\$\{PROFILE_MODEL\}"/);
  for (const p of ["claude-llm-hub-planner", "copilot-llm-hub", "opencode-llm-hub", "pi-llm-hub"])
    expect(o("profile", "show", p).all).toMatch(/\$\{(LLM_HUB_URL|LLM_HUB_V1_URL|LLM_HUB_KEY|PROFILE_MODEL)\}|\{env:LLM_HUB_V1_URL\}/);
  const r = o("profile", "show", "nope");
  expect(r.all).toMatch(/claude-llm-hub/); expect(r.rc).toBe(2);
});

test("profile_load via run --profile: unset env refs and auth", () => {
  const home = seedHome();
  const o = orch(home, { LLM_HUB_URL: undefined, LLM_HUB_KEY: undefined, CURSOR_API_KEY: undefined });
  let r = o("run", "--profile", "claude-llm-hub", "x");
  expect(r.all).toMatch(/env ANTHROPIC_BASE_URL references unset \$\{LLM_HUB_URL\}/); expect(r.rc).toBe(3);
  editJson(join(home, "profiles.json"), (p) => { p.profiles["needs-auth"] = { harness: "cursor-agent", model: "cursor-auto", flags: [], env: {}, auth: ["CURSOR_API_KEY"] }; });
  r = o("run", "--profile", "needs-auth", "x");
  expect(r.all).toMatch(/required auth env var CURSOR_API_KEY is not set/); expect(r.rc).toBe(3);
  expect(o("run", "--profile", "bogus", "x").rc).toBe(2);
  const hub = o.env({ LLM_HUB_URL: "http://hub:9", LLM_HUB_KEY: "dummy" }, "profile", "show", "claude-llm-hub");
  expect(hub.rc).toBe(0);
});
