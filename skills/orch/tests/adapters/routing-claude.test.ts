import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { orch, seedHome, editJson, readJson, readText, runState, fakeBin, fakeHub, tempDir, pathWithout, runCmd, DISPATCH, autoCleanup } from "../helpers";
autoCleanup();

const joined = (s: string) => s.replace(/\n/g, " ").trim();
const echoShims = () => fakeBin(Object.fromEntries(["claude", "cursor-agent", "opencode", "copilot"].map((t) => [t, `printf "%s\\n" "$@"`])));

test("profile pick, model list, suggest scan/apply, profile sanity", () => {
  const home = seedHome(), o = orch(home);
  const pf = join(home, "profiles.json"), sf = join(home, "suggestions.json");
  let out = o("profile", "pick", "fix a typo", "--complexity", "trivial").all;
  expect(out).toMatch(/^profile=/m); expect(out).toMatch(/^model=/m);
  expect(o("model", "list", "--profile", "claude-default").all).toMatch(/claude-sonnet/);
  editJson(pf, (p) => {
    p.models["local-lfm-8b"] = { slug: "llama_swap/lfm2.5-8b-a1b", harnesses: ["local-llm", "claude"], description: "bench winner" };
    p.models["local-qwen3-4b"] = { slug: "llama_swap/qwen3-4b-2507", harnesses: ["local-llm", "claude"], description: "backup" };
    p.profiles["claude-llm-hub"] = { harness: "claude", model: "local-lfm-8b", allowed_models: ["llama_swap*"], flags: [], env: {}, auth: [] };
  });
  out = o("model", "list", "--profile", "claude-llm-hub").all;
  expect(out).toMatch(/local-lfm-8b/); expect(out).toMatch(/local-qwen3-4b/); expect(out).not.toMatch(/claude-sonnet/);
  editJson(pf, (p) => { p.profiles["opencode-default"].description = ""; });
  let r = o("suggest", "scan");
  expect(r.all).toMatch(/scanned/); expect(r.rc).toBe(0);
  expect(o("suggest", "list", "--pending").all).toMatch(/profile_description/);
  const descId = o("suggest", "list", "--pending").out.split("\n").map((l) => l.split("\t")).find((c) => c[2] === "profile_description" && /opencode-default/.test(c[3] ?? ""))?.[0];
  expect(o("suggest", "apply", descId!).rc).toBe(0);
  expect(readJson(pf).profiles["opencode-default"].description).toBeTruthy();
  editJson(sf, (s) => { s.suggestions.push({ id: "sug-test", status: "pending", created: "2026-01-01T00:00:00Z", confidence: "medium", kind: "memory_record", title: "Record memory", reason: "test", evidence: [], fingerprint: "memory_record:claude-default:test", action: { type: "memory_record", memory: { profile: "claude-default", outcome: "success", task_kind: "test", note: "from test" } } }); });
  expect(o("suggest", "apply", "sug-test").rc).toBe(0);
  expect(o("memory", "list", "--profile", "claude-default").all).toMatch(/from test/);
  expect(o("suggest", "apply", "--json", "--id", "sug-test").all).toMatch(/"ok":false/);
  editJson(pf, (p) => { p.models["claude-haiku"].description = ""; });
  o("suggest", "scan");
  r = o("suggest", "apply", "--json", "--all");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/"results":/);
  o("run", "start", "Ids", "--id", "sug-ids");
  for (const n of ["one", "two", "three"]) { o("node", "add", "sug-ids", n, `Kind ${n}`, "--profile", "local-llm-fast"); o("node", "update", "sug-ids", n, "done"); }
  editJson(pf, (p) => { p.settings.learning.auto_record_memory = false; });
  expect(o("run", "finish", "sug-ids").all).not.toMatch(/not pending/);
  const ids = readJson(sf).suggestions.map((s: any) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
  editJson(pf, (p) => { p.settings.learning.auto_record_memory = true; });
  editJson(sf, (s) => { for (const k of ["a", "b"]) s.suggestions.push({ id: "sug-dup", status: "pending", created: "2026-01-01T00:00:00Z", kind: "memory_record", fingerprint: `memory_record:local-llm-fast:dup-${k}`, action: { type: "memory_record", memory: { profile: "local-llm-fast", outcome: "success", task_kind: `dup-${k}` } } }); });
  expect(o("suggest", "apply", "sug-dup").rc).toBe(0);
  expect(readJson(sf).suggestions.filter((s: any) => s.id.startsWith("sug-dup-")).length).toBe(1);
  r = o("profile", "sanity", "--profile", "nope");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/"ok":false/); expect(r.all).toMatch(/unknown profile/);
  editJson(pf, (p) => { p.profiles["claude-default"].enabled = false; });
  r = o("profile", "sanity", "--profile", "claude-default");
  expect(r.rc).toBe(0); expect(r.all).toMatch(/"ok":false/); expect(r.all).toMatch(/profile disabled/);
});

test("adapter argv per profile", () => {
  const home = seedHome();
  const sh = echoShims();
  const o = orch(home, { PATH: `${sh}:${process.env.PATH}`, CURSOR_API_KEY: "shim" });
  const run = (...a: string[]) => joined(o("run", ...a).all);
  expect(run("--profile", "claude-default", "hi there", "--extra")).toBe("-p hi there --output-format json --model sonnet --dangerously-skip-permissions --extra");
  let r = o("profile", "sanity", "--profile", "claude-default");
  expect(r.rc).toBe(0);
  for (const m of [/"ok":true/, /"profile":"claude-default"/, /"ms":/, /"harness":"claude"/]) expect(r.all).toMatch(m);
  editJson(join(home, "profiles.json"), (p) => { p.profiles["cursor-default"].model = "gpt-5"; });
  const cur = run("--profile", "cursor-default", "x");
  expect(cur).toBe("-p x --output-format text --model gpt-5"); expect(cur).not.toMatch(/--force/);
  expect(run("--profile", "opencode-default", "x")).toBe("run x --auto --standalone");
  const cop = run("--profile", "copilot-default", "x");
  expect(cop).toBe("-p x --silent --model auto --allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot");
  expect(run("--profile", "copilot-planner", "x")).toBe("-p x --silent --model claude-opus-5.5 --context long_context --reasoning-effort xhigh --allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot");
  expect(run("copilot", "plain")).toBe("-p plain --silent");
  expect(run("claude", "plain")).toBe("-p plain --output-format json");
  const resume = (sess: string, ...a: string[]) => joined(o.env({ ORCH_RESUME_SESSION: sess }, "run", ...a).all);
  expect(resume("resume-123", "claude", "continue")).toBe("-p continue --output-format json --resume resume-123");
  expect(resume("resume-123", "copilot", "continue")).toBe("-p continue --silent --session-id resume-123");
  expect(resume("ses_resume123", "opencode", "continue")).toBe("run continue --auto --standalone --session ses_resume123");
  expect(resume("resume-123", "opencode", "continue")).toBe("run continue --auto --standalone");
  expect(run("opencode", "x", "--server", "http://127.0.0.1:4096", "--pure")).toBe("run x --auto --server http://127.0.0.1:4096");
  expect(resume("cursor:abc", "cursor-agent", "continue")).toBe("-p continue --output-format text --resume cursor:abc");
});

test("pi adapter", () => {
  const home = seedHome();
  const capture = tempDir(), user = tempDir();
  mkdirSync(join(user, "skills/demo"), { recursive: true }); mkdirSync(join(user, "extensions"), { recursive: true });
  writeFileSync(join(user, "models.json"), '{"providers":{"mine":{}}}'); writeFileSync(join(user, "settings.json"), "{}");
  const shim = fakeBin({ pi: `printf '%s\\n' "$@"
printf 'env PI_OFFLINE=%s PI_SKIP_VERSION_CHECK=%s PI_TELEMETRY=%s\\n' "$PI_OFFLINE" "$PI_SKIP_VERSION_CHECK" "$PI_TELEMETRY"
printf '%s\\n' "$PI_CODING_AGENT_DIR" > "${capture}/dir"
cp "$PI_CODING_AGENT_DIR/models.json" "${capture}/models.json"
for e in "$PI_CODING_AGENT_DIR"/*; do
  if [ -L "$e" ]; then printf '%s -> %s\\n' "\${e##*/}" "$(readlink "$e")"; else printf '%s\\n' "\${e##*/}"; fi
done > "${capture}/listing"` });
  const o = orch(home, { PATH: `${shim}:${process.env.PATH}`, PI_CODING_AGENT_DIR: user, LLM_HUB_URL: "http://hub:9", LLM_HUB_V1_URL: undefined, LLM_HUB_KEY: undefined });
  editJson(join(home, "profiles.json"), (p) => {
    p.models["hub-qwen"] = { slug: "qwen3-coder", harnesses: ["pi"], description: "hub model" };
    p.profiles["pi-test"] = { harness: "pi", model: "hub-qwen", flags: ["--thinking", "off"], env: {}, auth: [] };
  });
  let r = o("run", "--profile", "pi-test", "do it", "--extra");
  expect(r.rc).toBe(0);
  expect(joined(r.all)).toMatch(/^--model hub\/qwen3-coder --approve --no-session -p do it --thinking off --extra env/);
  expect(r.all).toMatch(/env PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0/);
  expect(r.all).not.toMatch(/--no-(skills|extensions)/);
  const models = readJson(join(capture, "models.json"));
  expect([models.providers.hub.baseUrl, models.providers.hub.api, models.providers.hub.apiKey]).toEqual(["http://hub:9/v1", "openai-completions", "llm-hub"]);
  expect(models.providers.hub.compat).toEqual({ supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false, maxTokensField: "max_tokens", requiresToolResultName: true });
  expect(models.providers.hub.models).toEqual([{ id: "qwen3-coder", name: "qwen3-coder", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 32768 }]);
  expect(Object.keys(models.providers)).toEqual(["hub"]);
  const listing = readText(join(capture, "listing"));
  expect(listing).toMatch(new RegExp(`^skills -> ${user}/skills$`, "m"));
  expect(listing).toMatch(new RegExp(`^extensions -> ${user}/extensions$`, "m"));
  expect(listing).toMatch(/^models\.json$/m);
  expect(existsSync(readText(join(capture, "dir")).trim())).toBe(false);
  expect(readText(join(user, "models.json"))).toMatch(/"mine"/);
  r = o.env({ LLM_HUB_KEY: "hub-secret" }, "run", "--profile", "pi-test", "x");
  expect(r.all).not.toMatch(/hub-secret/);
  expect(readJson(join(capture, "models.json")).providers.hub.apiKey).toBe("$LLM_HUB_KEY");
  expect(readText(join(capture, "models.json"))).not.toMatch(/hub-secret/);
  const jobDir = tempDir();
  r = o.env({ ORCH_JOB_DIR: jobDir, LLM_HUB_MODEL: "m1" }, "run", "pi", "x");
  expect(joined(r.all)).toMatch(/^--model hub\/m1 --approve --no-session -p x env/);
  expect(readText(join(capture, "dir")).trim()).toBe(`${jobDir}/pi-agent`);
  expect(existsSync(join(jobDir, "pi-agent/models.json"))).toBe(true);
  r = o("run", "--profile", "pi-llm-hub", "x");
  expect(r.rc).toBe(0);
  expect(joined(r.all)).toMatch(/^--model hub\/llama_swap\/ornith-1\.5-35b --approve --no-session -p x --thinking off env/);

  const hubShims = fakeBin({
    copilot: `printf '%s\\n' "$@"\nprintf 'env %s %s %s %s\\n' "$COPILOT_PROVIDER_BASE_URL" "$COPILOT_PROVIDER_TYPE" "$COPILOT_MODEL" "$COPILOT_OFFLINE"`,
    opencode: `printf '%s\\n' "$@"\nprintf 'config %s\\n' "$OPENCODE_CONFIG_CONTENT"`,
  });
  const oh = orch(home, { PATH: `${hubShims}:${process.env.PATH}`, LLM_HUB_URL: "http://127.0.0.1:8888", LLM_HUB_KEY: "dummy", LLM_HUB_V1_URL: undefined });
  r = oh("run", "--profile", "copilot-llm-hub", "x");
  expect(r.rc).toBe(0);
  expect(joined(r.all)).toMatch(/^-p x --silent --model llama_swap\/qwen3\.6-35b --allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot --no-auto-update --no-custom-instructions --disable-builtin-mcps env/);
  expect(r.all).toMatch(/^env http:\/\/127\.0\.0\.1:8888\/v1 openai llama_swap\/qwen3\.6-35b true$/m);
  r = oh("run", "--profile", "opencode-llm-hub", "x");
  expect(r.rc).toBe(0);
  expect(joined(r.all)).toMatch(/^run x --auto --standalone -m llama_swap\/qwen3-coder-next config/);
  const cfg = JSON.parse(r.out.split("\n").find((l) => l.startsWith("config "))!.slice(7));
  expect([cfg.provider.llama_swap.options.baseURL, cfg.provider.llama_swap.options.apiKey, cfg.provider.llama_swap.models["qwen3-coder-next"].id]).toEqual(["{env:LLM_HUB_V1_URL}", "{env:LLM_HUB_KEY}", "llama_swap/qwen3-coder-next"]);
  const tpl = readJson(join(import.meta.dir, "../../templates/profiles.json"));
  const disables = Object.entries<any>(tpl.profiles).filter(([k]) => k.startsWith("opencode-")).flatMap(([, v]) => Object.keys(v.env ?? {})).filter((k) => k.startsWith("OPENCODE_DISABLE"));
  expect(disables.length).toBe(0);
  editJson(join(home, "profiles.json"), (p) => { p.profiles["opencode-smart-auto"].env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1"; });
  expect(o("profile", "unset-env", "opencode-smart-auto", "OPENCODE_DISABLE_EXTERNAL_SKILLS").rc).toBe(0);
  expect(Object.keys(readJson(join(home, "profiles.json")).profiles["opencode-smart-auto"].env).join(",")).toBe("OPENCODE_CONFIG_CONTENT");
  expect(o("profile", "unset-env", "opencode-smart-auto").rc).toBe(2);
  r = o("run", "pi", "x");
  expect(r.rc).toBe(2); expect(r.all).toMatch(/adapter_pi: no model/);
  r = o.env({ LLM_HUB_URL: "", LLM_HUB_MODEL: "m1" }, "run", "pi", "x");
  expect(r.rc).toBe(1); expect(r.all).toMatch(/adapter_pi: LLM_HUB_URL not set/);
  r = orch(home, { ORCH_BIN_DIRS: "", PATH: pathWithout("pi") })("run", "pi", "hi");
  expect(r.all).toMatch(/pi not found on PATH/); expect(r.rc).toBe(127);
});

test("session id, resumed retry, jq batching", () => {
  const sh = echoShims();
  let home = seedHome();
  let o = orch(home, { PATH: `${sh}:${process.env.PATH}` });
  const job = o("start", "claude", "session probe").out.trim();
  expect(job).toMatch(/^\d{14}-/);
  o("wait", job, "--timeout", "60", "--interval", "1");
  const session = readText(join(home, "jobs", job, "session")).trim();
  expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(joined(readText(join(home, "jobs", job, "log")))).toContain(`--session-id ${session}`);

  home = seedHome(); o = orch(home, { PATH: `${sh}:${process.env.PATH}` });
  o("run", "start", "Resume retry", "--id", "resume-retry"); o("node", "add", "resume-retry", "a", "a");
  const first = o("node", "dispatch", "resume-retry", "a", "claude", "full original task").out.trim();
  o("wait", first, "--timeout", "60", "--interval", "1"); o("run", "sync", "resume-retry");
  const rs = runState(home, "resume-retry").nodes[0].session;
  o("node", "update", "resume-retry", "a", "error", "--force", "--error", "exit=1");
  const second = o("node", "retry", "resume-retry", "a").out.trim();
  o("wait", second, "--timeout", "60", "--interval", "1");
  const log = readText(join(home, "jobs", second, "log"));
  expect(joined(log)).toContain(`--resume ${rs}`);
  expect(log).toMatch(/Continue the same task from where you left off/);
  expect(log).not.toMatch(/full original task/);
  const n = runState(home, "resume-retry").nodes[0];
  expect([n.attempts[0].retry_mode, n.attempts[0].retry_session, n.prompt]).toEqual(["resumed", rs, "full original task"]);

  home = seedHome();
  for (const r of ["a", "b", "c"]) {
    mkdirSync(join(home, "runs", r), { recursive: true });
    writeFileSync(join(home, "runs", r, "state.json"), JSON.stringify({ id: r, status: "error", finished: "2026-01-01T00:00:00Z", nodes: [{ id: "n1", label: "Build", status: "done", profile: "claude-default" }, { id: "n2", label: "Fix", status: "error", profile: "opencode-default" }] }));
  }
  const out = orch(home)("suggest", "scan");
  expect(out.all).toMatch(/scanned/);
  expect(readJson(join(home, "suggestions.json")).suggestions.map((s: any) => s.kind).join(" ")).toMatch(/memory_record/);
}, 240000);
