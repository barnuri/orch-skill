import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { orch, seedHome, tempHome, tempDir, editJson, readJson, readText, runCmd, DISPATCH, REPO_ROOT, ORCH_DIR, autoCleanup } from "../helpers";
autoCleanup();

const initIn = (home: string, env: Record<string, string> = {}) => orch(home, env)("init");
const mig = (profiles: any, markers: string[] = []) => {
  const home = tempHome(); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "profiles.json"), JSON.stringify(profiles));
  for (const m of markers) writeFileSync(join(home, `.${m}-migrated`), "");
  initIn(home);
  return { home, p: () => readJson(join(home, "profiles.json")) };
};
const E = { flags: [], env: {}, auth: [] };

test("fresh init and shipped profiles", () => {
  const home = tempHome();
  const o = orch(home, { ORCH_PROFILES_OVERLAY: join(tempDir(), "none.json") });
  const ini = o("init");
  expect(ini.rc).toBe(0); expect(ini.all).toContain(home);
  for (const f of ["profiles.json", "serve.json", "memory.json"]) expect(existsSync(join(home, f))).toBe(true);
  expect(existsSync(join(home, "index.html"))).toBe(false);
  expect(existsSync(join(home, "data"))).toBe(false);
  const out = o("profile", "list").out;
  expect(out).toMatch(/^\*claude-default\tclaude\tclaude-sonnet/m);
  expect(out).toMatch(/claude-planner\tclaude\tclaude-opus-1m/);
  expect(out).toMatch(/claude-haiku\tclaude\tclaude-haiku/);
  expect(readJson(join(home, "profiles.json")).settings.planner_profile).toBe("claude-planner");
  expect(o("profile", "pick", "fix a typo", "--complexity", "small").out.split("\n")[0]).toBe("profile=claude-haiku");
  expect(o("profile", "pick", "rewrite the scheduler", "--complexity", "large").out.split("\n")[0]).toBe("profile=claude-default");
  const p = readJson(join(home, "profiles.json"));
  expect(p.settings.disabled_harnesses).toEqual([]);
  expect(Object.keys(p.profiles).length).toBe(8);
  expect(Object.keys(p.profiles).filter((k) => /llm-hub|smart-auto|local-llm-fast/.test(k))).toEqual([]);
  expect(Object.keys(p.models).filter((k) => /hub|local-/.test(k)).length).toBe(0);
  expect([...Object.values<any>(p.models), ...Object.values<any>(p.profiles)].filter((x) => x == null).length).toBe(0);
  expect(readText(join(ORCH_DIR, "templates/profiles.json"))).not.toMatch(/2026-10-04/);
  const cur = o("profile", "show", "cursor-default").all;
  expect(cur).toMatch(/"model": "cursor-auto"/); expect(cur).toMatch(/"cursor-auto"/);
  const ml = o("model", "list", "--profile", "cursor-default").all;
  expect(ml).toMatch(/cursor-auto\tauto/); expect(ml).not.toMatch(/composer-1/);
});

test("overlay", () => {
  const home = tempHome();
  const overlay = join(tempDir(), "overlay.json");
  writeFileSync(overlay, JSON.stringify({ models: { "custom-model": { slug: "custom/slug", harnesses: ["claude"], description: "mine" } },
    profiles: { "my-custom": { harness: "claude", model: "custom-model", allowed_models: ["custom-model"], description: "overlay only", enabled: true, priority: 3, ...E },
      "claude-haiku": { harness: "claude", model: "claude-haiku", allowed_models: ["claude-haiku"], description: "overridden by the overlay", enabled: true, priority: 10, ...E } } }));
  expect(orch(home, { ORCH_PROFILES_OVERLAY: overlay })("init").rc).toBe(0);
  const p = readJson(join(home, "profiles.json"));
  expect([p.profiles["my-custom"].model, p.profiles["claude-default"].model, p.profiles["claude-haiku"].description, p.models["custom-model"].slug])
    .toEqual(["custom-model", "claude-sonnet", "overridden by the overlay", "custom/slug"]);
  expect(Object.keys(p.profiles).filter((k) => /llm-hub/.test(k)).length).toBe(0);
  const real = join(ORCH_DIR, "templates/profiles.local.json");
  if (existsSync(real)) {
    const h2 = tempHome();
    expect(orch(h2, { ORCH_PROFILES_OVERLAY: real })("init").rc).toBe(0);
    const b = readJson(join(h2, "profiles.json"));
    expect(Object.keys(b.profiles).length).toBeGreaterThanOrEqual(18);
    expect([b.settings.planner_profile, b.profiles["claude-llm-hub"].model, b.models["hub-smart-auto-balance"].slug]).toEqual(["claude-planner", "local-qwen3.6-35b", "hub/smart-auto-balance"]);
  }
});

test("migrations", () => {
  // cursor retarget
  let m = mig({ settings: { default_profile: "cursor-default", retention_days: 7, budget_threshold: 85 },
    models: { "cursor-composer": { slug: "composer-1", harnesses: ["cursor-agent"], description: "" } },
    profiles: { "cursor-default": { harness: "cursor-agent", model: "cursor-composer", ...E }, "cursor-pinned": { harness: "cursor-agent", model: "cursor-composer", ...E } } });
  let p = m.p();
  expect([p.profiles["cursor-default"].model, p.profiles["cursor-default"].allowed_models.join(","), p.models["cursor-auto"].slug, p.profiles["cursor-pinned"].model, p.profiles["copilot-default"].harness])
    .toEqual(["cursor-auto", "cursor-auto", "auto", "cursor-composer", "copilot"]);
  expect(existsSync(join(m.home, ".copilot-profile-migrated"))).toBe(true);

  // claude rename
  m = mig({ settings: { default_profile: "claude-sub", retention_days: 7, budget_threshold: 85, disabled_harnesses: ["claude", "opencode"] },
    models: { "claude-sonnet": { slug: "sonnet", harnesses: ["claude"], description: "" } },
    profiles: { "claude-sub": { harness: "claude", model: "claude-sonnet", enabled: false, parallel_ok: false, max_complexity: "medium", ...E },
      "claude-llm-hub": { harness: "claude", model: "claude-sonnet", fallback: "claude-sub", ...E } } }, ["copilot-planner"]);
  p = m.p();
  expect(p.profiles["claude-sub"]).toBeUndefined();
  expect([p.profiles["claude-default"].enabled, p.profiles["claude-default"].parallel_ok]).toEqual([false, true]);
  expect(`${p.models[p.profiles["claude-planner"].model].slug} ${p.profiles["claude-planner"].flags.join(" ")}`).toMatch(/^opus\[1m\] --effort xhigh/);
  expect(p.settings.disabled_harnesses).toEqual(["claude", "opencode"]);
  expect([p.profiles["claude-llm-hub"].model, Object.keys(p.profiles["claude-llm-hub"].env).length]).toEqual(["claude-sonnet", 0]);
  expect([p.settings.default_profile, p.profiles["claude-llm-hub"].fallback]).toEqual(["claude-default", "claude-default"]);
  expect(existsSync(join(m.home, ".claude-planner-migrated"))).toBe(true);

  // bench migration
  const bench = () => ({ settings: { default_profile: "local-qwen", planner_profile: "copilot-planner", retention_days: 7, budget_threshold: 85, disabled_harnesses: ["cursor-agent", "local-llm", "opencode", "pi"] },
    models: { "local-lfm-8b": { slug: "llama_swap/lfm2.5-8b-a1b", harnesses: ["local-llm", "claude", "cursor-agent"], description: "" },
      "local-lfm-2.6b": { slug: "llama_swap/lfm2.5-2.6b", harnesses: ["local-llm"], description: "" }, "local-qwen3-4b": { slug: "llama_swap/qwen3-4b-2507", harnesses: ["local-llm"], description: "" },
      "local-ornith-1.0-35b": { slug: "llama_swap/ornith-1.0-35b", harnesses: ["claude", "cursor-agent"], description: "", behaves_as: "claude-haiku-4-5-20251001" }, "cursor-auto": { slug: "auto", harnesses: ["cursor-agent"], description: "" } },
    profiles: { "claude-llm-hub": { harness: "claude", model: "local-ornith-1.0-35b", allowed_models: ["llama_swap*"], parallel_ok: true, fallback: "cursor-llm-hub", flags: [], env: { ANTHROPIC_BASE_URL: "${LLM_HUB_URL}", ANTHROPIC_MODEL: "mine" }, auth: [] },
      "cursor-llm-hub": { harness: "cursor-agent", model: "local-lfm-8b", enabled: false, ...E },
      "local-qwen": { harness: "local-llm", model: "local-lfm-8b", allowed_models: ["local-lfm-8b", "local-qwen3-4b"], ...E }, "local-qwen3": { harness: "local-llm", model: "local-qwen3-4b", fallback: "local-qwen", ...E } } });
  const marks = ["copilot-planner", "claude-planner", "claude-tiers"];
  m = mig(bench(), marks); p = m.p();
  const h = p.profiles["claude-llm-hub"];
  expect([h.model, h.parallel_ok, h.fallback]).toEqual(["local-qwen3.6-35b", false, "copilot-llm-hub"]);
  expect([h.env.ANTHROPIC_DEFAULT_SONNET_MODEL, h.env.ANTHROPIC_MODEL, h.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS]).toEqual(["${PROFILE_MODEL}", "mine", "1"]);
  expect(["cursor-llm-hub", "local-qwen", "local-qwen3"].map((k) => k in p.profiles)).toEqual([false, false, false]);
  expect([p.settings.default_profile, p.settings.planner_profile]).toEqual(["local-llm-fast", "copilot-planner"]);
  expect(["local-lfm-8b", "local-lfm-2.6b", "local-qwen3-4b"].filter((k) => k in p.models).length).toBe(0);
  expect(Object.keys(p.profiles).filter((k) => k !== "claude-llm-hub" && k !== "copilot-default").sort().join(" "))
    .toBe("claude-llm-hub-planner claude-smart-auto copilot-llm-hub copilot-smart-auto local-llm-fast opencode-llm-hub opencode-smart-auto pi-llm-hub pi-smart-auto");
  expect(p.models[p.profiles["local-llm-fast"].model].slug).toBe("llama_swap/ornith-1.5-9b");
  expect(p.models["local-ornith-1.0-35b"].harnesses.join(",")).toBe("claude");
  expect(p.settings.disabled_harnesses).toEqual(["cursor-agent", "local-llm", "opencode", "pi"]);
  expect(existsSync(join(m.home, ".bench-local-migrated"))).toBe(true);
  editJson(join(m.home, "profiles.json"), (x) => { x.profiles["claude-llm-hub"].model = "local-ornith-1.0-35b"; });
  initIn(m.home);
  expect(m.p().profiles["claude-llm-hub"].model).toBe("local-ornith-1.0-35b");

  const b2 = bench(); b2.profiles["cursor-llm-hub"].model = "cursor-auto"; (b2.profiles as any).mine = { harness: "local-llm", model: "local-lfm-8b", ...E };
  m = mig(b2, marks); p = m.p();
  expect([p.profiles["cursor-llm-hub"].model, p.profiles["claude-llm-hub"].fallback]).toEqual(["cursor-auto", "cursor-llm-hub"]);
  expect(["local-lfm-8b" in p.models, "local-qwen3-4b" in p.models]).toEqual([true, false]);

  // tiers
  m = mig({ settings: { default_profile: "copilot-default", planner_profile: "copilot-planner", retention_days: 7, budget_threshold: 85 },
    models: { "claude-sonnet": { slug: "sonnet", harnesses: ["claude"], description: "" }, "claude-haiku": { slug: "haiku", harnesses: ["claude"], description: "Fast and cheap: typos, formatting, tiny edits, boilerplate.", cost: "low" } },
    profiles: { "claude-default": { harness: "claude", model: "claude-sonnet", ...E }, "claude-planner": { harness: "claude", model: "claude-sonnet", description: "mine", ...E },
      "claude-haiku": { harness: "claude", model: "claude-haiku", max_complexity: "trivial", cost: "low", ...E } } }, ["copilot-profile", "copilot-planner", "claude-planner", "bench-local"]);
  p = m.p();
  expect([p.settings.default_profile, p.settings.planner_profile]).toEqual(["claude-default", "claude-planner"]);
  expect([p.profiles["claude-haiku"].max_complexity, p.profiles["claude-haiku"].cost, p.models["claude-haiku"].cost]).toEqual(["small", "subscription", "subscription"]);
  expect(p.profiles["claude-planner"].description).toBe("mine");
  expect(existsSync(join(m.home, ".claude-tiers-migrated"))).toBe(true);
  editJson(join(m.home, "profiles.json"), (x) => { x.settings.default_profile = "custom"; });
  initIn(m.home);
  expect(m.p().settings.default_profile).toBe("custom");

  // smart-auto
  m = mig({ settings: { default_profile: "claude-default", planner_profile: "claude-planner", retention_days: 7, budget_threshold: 85 }, models: {},
    profiles: { "copilot-smart-auto": { harness: "local-llm", model: "", ...E } } }, ["copilot-profile", "copilot-planner", "claude-planner", "bench-local", "claude-tiers"]);
  p = m.p();
  expect([p.profiles["copilot-smart-auto"].harness, p.profiles["claude-smart-auto"].model, p.profiles["opencode-smart-auto"].harness, p.profiles["pi-smart-auto"].harness, p.models["hub-smart-auto-balance"].slug])
    .toEqual(["local-llm", "hub-smart-auto-balance", "opencode", "pi", "hub/smart-auto-balance"]);
  expect(existsSync(join(m.home, ".smart-auto-migrated"))).toBe(true);
  editJson(join(m.home, "profiles.json"), (x) => { delete x.profiles["pi-smart-auto"]; });
  initIn(m.home);
  expect("pi-smart-auto" in m.p().profiles).toBe(false);

  // first-start keeps user choices
  m = mig({ settings: { default_profile: "opencode-smart-auto", planner_profile: "opencode-smart-auto", retention_days: 7, budget_threshold: 85, disabled_harnesses: ["claude", "copilot", "cursor-agent", "local-llm", "pi"] },
    models: { "claude-sonnet": { slug: "sonnet", harnesses: ["claude"], description: "" }, "hub-smart-auto-balance": { slug: "hub/smart-auto-balance", harnesses: ["opencode"], description: "" } },
    profiles: { "claude-default": { harness: "claude", model: "claude-sonnet", enabled: false, ...E }, "claude-planner": { harness: "claude", model: "claude-sonnet", enabled: false, ...E },
      "copilot-default": { harness: "copilot", model: "", enabled: false, ...E }, "opencode-smart-auto": { harness: "opencode", model: "hub-smart-auto-balance", enabled: true, ...E } } });
  p = m.p();
  expect([p.settings.default_profile, p.settings.planner_profile]).toEqual(["opencode-smart-auto", "opencode-smart-auto"]);
  expect(p.settings.disabled_harnesses).toEqual(["claude", "copilot", "cursor-agent", "local-llm", "pi"]);
  expect([p.profiles["claude-default"].enabled, p.profiles["claude-planner"].enabled, p.profiles["copilot-default"].enabled]).toEqual([false, false, false]);
});

test("init idempotency and legacy cleanup, effective profile, settings, tmp leaks", async () => {
  const home = seedHome(), o = orch(home);
  editJson(join(home, "profiles.json"), (p) => { p.settings.default_profile = "custom"; });
  o("init");
  expect(readJson(join(home, "profiles.json")).settings.default_profile).toBe("custom");
  mkdirSync(join(home, "data"), { recursive: true }); writeFileSync(join(home, "index.html"), "");
  const err = o("init").err;
  expect(err).toMatch(/moved legacy dashboard leftover index.html/);
  expect(err).toMatch(/moved legacy dashboard leftover data/);
  expect(existsSync(join(home, "index.html"))).toBe(false); expect(existsSync(join(home, "data"))).toBe(false);

  // budget threshold and memory
  const snap = join(tempDir(), "over80.json");
  writeFileSync(snap, JSON.stringify({ api: { type: "subscription" }, captured_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), rate_limits: { day: { used_percentage: 82 } } }));
  editJson(join(home, "profiles.json"), (p) => { p.settings.budget_threshold = 80; });
  expect(o.env({ CLAUDE_USAGE_SNAPSHOT: snap }, "budget-check").rc).toBe(1);
  expect(o.env({ CLAUDE_USAGE_SNAPSHOT: snap, HARNESS_ORCH_BUDGET_THRESHOLD: "90" }, "budget-check").rc).toBe(0);
  expect(o("memory", "add", "--profile", "claude-default", "--outcome", "success", "--kind", "refactor", "--note", "fast and clean").rc).toBe(0);
  expect(o("memory", "list").all).toMatch(/claude-default.success.refactor.fast and clean/);
  expect(o("memory", "list", "--profile", "nope").all).not.toMatch(/claude-default/);
  expect(o("memory", "add", "--profile", "nope", "--outcome", "success").rc).toBe(2);
  const bad = o("memory", "add", "--profile", "claude-default", "--outcome", "meh");
  expect(bad.all).toMatch(/outcome must be one of/); expect(bad.rc).toBe(2);

  // effective profile and settings
  const oe = orch(home, { ORCH_PROFILES_OVERLAY: join(home, "none.json") });
  editJson(join(home, "profiles.json"), (p) => {
    p.profiles["p-own"] = { ...p.profiles["claude-default"], parallel_ok: false };
    const inh = { ...p.profiles["claude-default"] }; delete inh.parallel_ok; delete inh.max_parallel; p.profiles["p-inherit"] = inh;
    p.defaults = { parallel_ok: true, max_parallel: 7, env: { A: "defaults", C: "defaults" } };
    p.profiles["p-inherit"].env = { A: "profile" };
  });
  let out = oe("profile", "show", "p-own", "--effective").all;
  expect(out).toMatch(/^parallel_ok\tfalse\tprofile$/m); expect(out).toMatch(/^max_parallel\t7\tdefaults$/m); expect(out).toMatch(/^effort\tnull\tbuiltin$/m);
  out = oe("profile", "show", "p-inherit", "--effective").all;
  expect(out).toMatch(/^parallel_ok\ttrue\tdefaults$/m);
  expect(out).toMatch(/^env\t\{"A":"profile","C":"defaults"\}\tprofile$/m);
  expect(oe("settings", "get", "defaults.max_parallel").out.trim()).toBe("7");
  expect(oe("settings", "set", "defaults.max_parallel", "5").out.trim()).toBe("defaults.max_parallel = 5");
  expect(readJson(join(home, "profiles.json")).defaults.max_parallel).toBe(5);
  expect(oe("settings", "set", "defaults.max_parallel", "0").rc).toBe(2);
  expect(oe("settings", "set", "defaults.max_parallel", "33").rc).toBe(2);
  expect(oe("settings", "set", "defaults.parallel_ok", "yes").rc).toBe(2);
  expect(readJson(join(home, "profiles.json")).settings.max_parallel ?? null).toBeNull();

  // temp files
  const strays = (h: string) => readdirSync(h).filter((f) => f.startsWith("profiles.json.tmp.")).length;
  const th = tempHome(); mkdirSync(th, { recursive: true });
  const ot = orch(th);
  ot("init");
  expect(existsSync(join(th, ".migrations/profiles-main"))).toBe(true);
  for (let i = 0; i < 10; i++) ot("profile", "list");
  expect(strays(th)).toBe(0);
  writeFileSync(join(th, "profiles.json.tmp.999999"), readText(join(th, "profiles.json")));
  const live = Bun.spawn(["sleep", "30"]);
  writeFileSync(join(th, `profiles.json.tmp.${live.pid}`), readText(join(th, "profiles.json")));
  ot("profile", "list");
  expect(existsSync(join(th, "profiles.json.tmp.999999"))).toBe(false);
  expect(existsSync(join(th, `profiles.json.tmp.${live.pid}`))).toBe(true);
  live.kill(); await live.exited;
  ot("profile", "list");
  expect(strays(th)).toBe(0);
  const h2 = tempHome(); mkdirSync(h2, { recursive: true });
  writeFileSync(join(h2, "profiles.json"), '{"profiles":{},"settings":{}}\n');
  orch(h2)("profile", "list");
  expect(readText(join(h2, "profiles.json"))).toMatch(/max_attempts/);
  expect(strays(h2)).toBe(0);
  const h3 = tempHome(); mkdirSync(h3, { recursive: true });
  writeFileSync(join(h3, "profiles.json"), "{broken json\n");
  orch(h3)("profile", "list");
  expect(readText(join(h3, "profiles.json"))).toBe("{broken json\n");
  expect(strays(h3)).toBe(0);
  const mt = statSync(join(th, "profiles.json")).mtimeMs;
  Bun.sleepSync(30);
  ot("profile", "list");
  expect(statSync(join(th, "profiles.json")).mtimeMs).toBe(mt);
}, 240000);

test("opencode plugin install", () => {
  const install = join(REPO_ROOT, "scripts/install-opencode-plugin.ts");
  const src = join(REPO_ROOT, "mods/opencode/orch-nodes.js");
  const dir = tempDir();
  const run = () => runCmd(["bun", install], { env: { OPENCODE_PLUGIN_DIR: join(dir, "plugins") } });
  expect(run().all).toMatch(/^opencode: linked/m);
  expect(Bun.spawnSync(["readlink", join(dir, "plugins/orch-nodes.js")]).stdout.toString().trim()).toBe(src);
  expect(run().all).toMatch(/unchanged/);
  Bun.spawnSync(["trash", join(dir, "plugins/orch-nodes.js")]);
  writeFileSync(join(dir, "plugins/orch-nodes.js"), "old plugin\n");
  expect(run().all).toMatch(/backed up/);
  const backup = readdirSync(join(dir, "plugins")).find((f) => f.startsWith("orch-nodes.js.orch-backup-"))!;
  expect(readText(join(dir, "plugins", backup)).trim()).toBe("old plugin");
  expect(Bun.spawnSync(["readlink", join(dir, "plugins/orch-nodes.js")]).stdout.toString().trim()).toBe(src);
});
