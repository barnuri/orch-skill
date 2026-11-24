// Adapter spawn: `run` (sync, stdio inherited) and `start` (detached job, stdio to job files).
// Ported from lib/adapters/adapters.sh and the run/start part of dispatch.ts. Bun built-ins only.
// ${VAR} references in a profile's env are resolved into the spawn env only, never written to state.
import { existsSync, mkdirSync, readdirSync, symlinkSync, lstatSync, unlinkSync, writeFileSync, renameSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { orchHome, paths } from "../state/home.ts";
import { confirmMiss, selfCheckReason } from "../ghosts.ts";
import { trashPath } from "../state/trash.ts";
import {
  hasHarnessDisabled,
  modelIdAllowed,
  modelIdResolve,
  modelSlugResolve,
  readCatalog,
  type Catalog,
} from "./routing.ts";
import { usageRefusal } from "../../../../src/shared/profile-usage.ts";
import { SMART_AUTO_TIERS } from "./hub.ts";
import { sharedServiceUsable } from "./opencode-service.ts";
import { loadProfilesDoc, settingFrom } from "../state/settings.ts";
import { harnessFindBinary } from "./harness.ts";
import { writeStatusSnapshot } from "../delivery/attribution.ts";

export const VALID_HARNESSES = "claude cursor-agent opencode local-llm copilot pi".split(" ");
export const PROFILE_UNCONFIGURED_RC = 3;
export type Env = Record<string, string | undefined>;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SMART_AUTO_HEADER_WORKER = "x-llm-hub-smart-auto-worker";
const SMART_AUTO_HEADER_PARENT = "x-llm-hub-smart-auto-parent";
const SMART_AUTO_HEADER_ROLE = "x-llm-hub-smart-auto-role";
const SMART_AUTO_HEADER_TIER = "x-llm-hub-smart-auto-tier";
const PI_HUB_PROVIDER = "hub";

const err = (s: string) => void process.stderr.write(s);
const out = (s: string) => void process.stdout.write(s);

export async function resolvePrompt(p: string): Promise<string | null> {
  if (!p.startsWith("@")) return p;
  const f = p.slice(1);
  const file = Bun.file(f);
  if (!(await file.exists())) {
    err(`resolve_prompt: prompt file not found: ${f}\n`);
    return null;
  }
  return await file.text();
}

// orch_load_env_file + llm_hub_derive_v1_url, on a copy of the environment. A name the caller set wins.
export async function loadEnv(home: string, base: Env = process.env): Promise<Env> {
  const e: Env = { ...base };
  const text = await Bun.file(join(home, "env")).text().catch(() => "");
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const name = line.slice(0, i);
    if (!IDENT.test(name) || name in e) continue;
    e[name] = line.slice(i + 1);
  }
  if (e.LLM_HUB_URL && !("LLM_HUB_V1_URL" in e)) {
    let b = e.LLM_HUB_URL;
    while (b.endsWith("/")) b = b.slice(0, -1);
    if (b.endsWith("/v1")) b = b.slice(0, -3);
    e.LLM_HUB_V1_URL = `${b}/v1`;
  }
  return e;
}

export interface LoadedProfile {
  name: string;
  harness: string;
  model: string;
  modelId: string;
  behavesAs: string;
  flags: string[];
}
export type ProfileResult = { ok: true; profile: LoadedProfile } | { ok: false; rc: number };

function behavesAsOf(cat: Catalog, name: string, ref: string): string {
  const prof = cat.profiles?.[name];
  if (!prof) return "";
  const m = cat.models?.[ref];
  if (m) return m.behaves_as ?? "";
  const hit: any = Object.values(cat.models ?? {}).find((x: any) => x.slug === ref && Array.isArray(x.harnesses) && x.harnesses.includes(prof.harness));
  return hit?.behaves_as ?? "";
}

// profile_load: resolves the profile and writes its env into `e` (the spawn env).
export async function loadProfile(home: string, name: string, e: Env): Promise<ProfileResult> {
  const fail = (rc: number, msg: string): ProfileResult => (err(msg), { ok: false, rc });
  let cat: Catalog;
  try {
    cat = await readCatalog(paths.profiles(home));
  } catch {
    return fail(1, `orch: cannot read ${paths.profiles(home)}\n`);
  }
  const prof = cat.profiles?.[name];
  if (!prof) return fail(2, `profile ${name}: unknown profile. Available: ${Object.keys(cat.profiles ?? {}).sort().join(", ")}\n`);
  const harness: string = prof.harness ?? "";
  let modelId = e.ORCH_MODEL_ID ?? "";
  if (modelId === "") modelId = modelIdResolve(cat, name) ?? "";
  else if (!modelIdAllowed(cat, name, modelId)) return fail(2, `profile ${name}: model ${modelId} is not in allowed_models\n`);
  let model = "";
  let behavesAs = "";
  if (modelId !== "") {
    model = modelSlugResolve(cat, name, modelId) ?? "";
    behavesAs = behavesAsOf(cat, name, modelId);
  }
  if (!VALID_HARNESSES.includes(harness)) return fail(2, `profile ${name}: harness "${harness}" must be one of: ${VALID_HARNESSES.join(" ")}\n`);
  if (hasHarnessDisabled(cat, harness)) return fail(2, `profile ${name}: harness "${harness}" is disabled (settings.disabled_harnesses); enable it on the Harnesses page first\n`);
  const refusal = e.ORCH_USE === "any" ? null : usageRefusal(cat, name, e.ORCH_USE === "chat" ? "chat" : "runs");
  if (refusal) return fail(2, `${refusal}\n`);
  const flags = (Array.isArray(prof.flags) ? prof.flags : []).filter((f: unknown) => f !== null && f !== false).map(String);
  for (const [key, raw] of Object.entries(prof.env ?? {})) {
    if (!IDENT.test(key)) return fail(2, `profile ${name}: env key "${key}" is not a valid variable name\n`);
    let value = String(raw);
    const m = /^\$\{(.*)\}$/.exec(value);
    if (m) {
      const ref = m[1]!;
      const own: Record<string, string> = { PROFILE_NAME: name, PROFILE_HARNESS: harness, PROFILE_MODEL: model, PROFILE_MODEL_ID: modelId, PROFILE_MODEL_BEHAVES_AS: behavesAs };
      const got = IDENT.test(ref) ? (own[ref] || e[ref]) : "";
      if (!got) return fail(PROFILE_UNCONFIGURED_RC, `profile ${name}: env ${key} references unset \${${ref}}\n`);
      value = got;
    }
    e[key] = value;
  }
  for (const v of Array.isArray(prof.auth) ? prof.auth : []) {
    if (!IDENT.test(String(v)) || !e[String(v)]) return fail(PROFILE_UNCONFIGURED_RC, `profile ${name}: required auth env var ${v} is not set\n`);
  }
  return { ok: true, profile: { name, harness, model, modelId, behavesAs, flags } };
}

// hub_tier_model: a Smart Auto selector moved to <tier>; any other model comes back unchanged.
export function hubTierModel(model: string, tier: string): string {
  if (tier === "" || !(model === "hub/smart-auto" || model.startsWith("hub/smart-auto-"))) return model;
  const base = model.replace(new RegExp(`-(${SMART_AUTO_TIERS.join("|")})$`), "");
  return `${base}-${tier}`;
}

export function smartAutoHeaders(e: Env): string[] {
  if (!e.ORCH_RUN_ID || !e.ORCH_NODE_ID || !e.ORCH_NODE_ATTEMPT) return [];
  if (!(e.ORCH_NODE_ROLE || e.ORCH_NODE_TIER || e.ORCH_NODE_ACCEPTANCE)) return [];
  const h = [`${SMART_AUTO_HEADER_WORKER}: ${e.ORCH_RUN_ID}/${e.ORCH_NODE_ID}/${e.ORCH_NODE_ATTEMPT}`, `${SMART_AUTO_HEADER_PARENT}: ${e.ORCH_RUN_ID}`];
  if (e.ORCH_NODE_ROLE) h.push(`${SMART_AUTO_HEADER_ROLE}: ${e.ORCH_NODE_ROLE}`);
  if (e.ORCH_NODE_TIER) h.push(`${SMART_AUTO_HEADER_TIER}: ${e.ORCH_NODE_TIER}`);
  return h;
}

export function claudeCustomHeaders(e: Env): string {
  const inherited = (e.ANTHROPIC_CUSTOM_HEADERS ?? "")
    .split("\n")
    .filter((l) => !/^\s*x-llm-hub-smart-auto-/i.test(l))
    .join("\n")
    .replace(/\n+$/, "");
  return [inherited, ...smartAutoHeaders(e)].filter((s) => s !== "").join("\n");
}

async function resolveBin(caller: string, name: string, e: Env): Promise<string | null> {
  const p = harnessFindBinary(name, e);
  if (p) return p;
  err(`${caller}: ${name} not found on PATH\n`);
  return null;
}

// Runs argv, stdout inherited unless `capture`. Returns the exit code (and stdout when captured).
async function exec(argv: string[], e: Env, capture = false): Promise<{ rc: number; stdout: string }> {
  const proc = Bun.spawn(argv, { env: e as Record<string, string>, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  const stdout = capture ? await new Response(proc.stdout as ReadableStream).text() : "";
  return { rc: await proc.exited, stdout };
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function claudeUsage(raw: any): Record<string, unknown> {
  const mu = Object.entries<any>(raw.modelUsage ?? {});
  const basis = mu.map(([, v]) => v.costBasis).filter((x) => x != null)[0];
  const u = raw.usage ?? {};
  return {
    usd: raw.total_cost_usd ?? 0,
    cost_basis: basis ?? "unknown",
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
    models: mu.map(([k, v]) => ({
      model: k,
      usd: v.costUSD ?? 0,
      input_tokens: v.inputTokens ?? 0,
      output_tokens: v.outputTokens ?? 0,
      cache_read_tokens: v.cacheReadInputTokens ?? 0,
      cache_creation_tokens: v.cacheCreationInputTokens ?? 0,
    })),
  };
}

async function adapterClaude(prompt: string, args: string[], e: Env): Promise<number> {
  const bin = await resolveBin("adapter_claude", "claude", e);
  if (!bin) return 127;
  const headers = claudeCustomHeaders(e);
  if (headers) e.ANTHROPIC_CUSTOM_HEADERS = headers;
  else delete e.ANTHROPIC_CUSTOM_HEADERS;
  const session: string[] = e.ORCH_RESUME_SESSION ? ["--resume", e.ORCH_RESUME_SESSION] : e.ORCH_SESSION_ID ? ["--session-id", e.ORCH_SESSION_ID] : [];
  const settings: string[] = [];
  if (e.ORCH_MODEL_BEHAVES_AS && e.ORCH_MODEL_SLUG) {
    const f = join(e.TMPDIR || tmpdir(), `orch-model-picker-${crypto.randomUUID().slice(0, 8)}`);
    try {
      writeFileSync(f, JSON.stringify({ modelPicker: { options: [{ model: e.ORCH_MODEL_SLUG, label: e.ORCH_MODEL_SLUG, behavesAs: e.ORCH_MODEL_BEHAVES_AS }] } }) + "\n");
      settings.push("--settings", f);
    } catch {}
  }
  const { rc, stdout } = await exec([bin, "-p", prompt, "--output-format", "json", ...session, ...settings, ...args], e, true);
  let obj: any = null;
  try {
    obj = JSON.parse(stdout);
  } catch {}
  if (rc !== 0 || obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    out(stdout + "\n");
    return rc;
  }
  out(`${obj.result ?? ""}\n`);
  const dir = e.ORCH_JOB_DIR;
  if (dir && existsSync(dir)) {
    try {
      writeAtomic(join(dir, "usage.json"), JSON.stringify(claudeUsage(obj)) + "\n");
    } catch {}
  }
  return obj.is_error === true ? 1 : 0;
}

async function adapterCursor(prompt: string, args: string[], e: Env): Promise<number> {
  const bin = await resolveBin("adapter_cursor_agent", "cursor-agent", e);
  if (!bin) return 127;
  const session = e.ORCH_RESUME_SESSION ? ["--resume", e.ORCH_RESUME_SESSION] : [];
  return (await exec([bin, "-p", prompt, "--output-format", "text", ...session, ...args], e)).rc;
}

function opencodeSmartAutoConfig(e: Env): void {
  const lines = smartAutoHeaders(e);
  if (lines.length === 0) return;
  const h: Record<string, string> = {};
  for (const l of lines) {
    const m = /^([^:]+): (.*)$/.exec(l);
    if (m) h[m[1]!] = m[2]!;
  }
  try {
    const cfg = JSON.parse(e.OPENCODE_CONFIG_CONTENT ?? "");
    if (cfg?.provider?.hub == null) return;
    cfg.provider.hub.options = cfg.provider.hub.options ?? {};
    cfg.provider.hub.options.headers = { ...(cfg.provider.hub.options.headers ?? {}), ...h };
    e.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);
  } catch {}
}

// Flags that orch reads for itself (node add / dispatch). None of them may reach `opencode run`.
export const OPENCODE_ORCH_VALUE_FLAGS = ["--prompt", "--role", "--tier", "--acceptance", "--plan", "--task", "--after", "--origin"];
export const OPENCODE_ORCH_BOOL_FLAGS = ["--plan-backed"];
// Flags dropped here because orch passes its own standalone/server mode.
const OPENCODE_DROPPED_FLAGS = ["--pure", "--standalone"];

// opencodeArgs: split the dispatch args into the opencode server choice and the args that go to `opencode run`.
// Value flags are dropped with their value, in both `--flag value` and `--flag=value` form.
export function opencodeArgs(args: string[]): { server: string; rest: string[] } {
  let server = "--standalone";
  const rest: string[] = [];
  const isFlag = (a: string, flags: string[]) => flags.some((f) => a === f || a.startsWith(`${f}=`));
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? "";
    if (OPENCODE_DROPPED_FLAGS.includes(a)) continue;
    if (isFlag(a, OPENCODE_ORCH_BOOL_FLAGS)) continue;
    if (isFlag(a, OPENCODE_ORCH_VALUE_FLAGS)) {
      if (!a.includes("=")) i += 1;
      continue;
    }
    if (a === "--server" || a.startsWith("--server=")) server = "";
    rest.push(a);
  }
  return { server, rest };
}

/** settings.opencode_shared_service: default on, "false" turns it off. */
async function opencodeSharedWanted(): Promise<boolean> {
  return settingFrom(await loadProfilesDoc(orchHome()), "opencode_shared_service", "true") !== "false";
}

async function adapterOpencode(prompt: string, args: string[], e: Env): Promise<number> {
  const bin = await resolveBin("adapter_opencode", "opencode", e);
  if (!bin) return 127;
  opencodeSmartAutoConfig(e);
  let session: string[] = [];
  if ((e.ORCH_RESUME_SESSION ?? "").startsWith("ses")) session = ["--session", e.ORCH_RESUME_SESSION!];
  if (e.ORCH_SESSION_TITLE && session.length === 0) session = ["--title", e.ORCH_SESSION_TITLE];
  let { server, rest } = opencodeArgs(args);
  // Shared service: no private server per node (measured: 96 MB and 6 s against 495 MB and 48 s with --standalone).
  // OPENCODE_CONFIG_CONTENT is read by the server process, so a node that sets it keeps its own private server.
  if (server === "--standalone" && !e.OPENCODE_CONFIG_CONTENT && (await opencodeSharedWanted()) && (await sharedServiceUsable())) server = "";
  return (await exec([bin, "run", prompt, "--auto", ...(server ? [server] : []), ...session, ...rest], e)).rc;
}

async function adapterCopilot(prompt: string, args: string[], e: Env): Promise<number> {
  const bin = await resolveBin("adapter_copilot", "copilot", e);
  if (!bin) return 127;
  const sid = e.ORCH_RESUME_SESSION || e.ORCH_SESSION_ID;
  return (await exec([bin, "-p", prompt, "--silent", ...(sid ? ["--session-id", sid] : []), ...args], e)).rc;
}

function piAgentDir(model: string, e: Env): string {
  const userDir = e.PI_CODING_AGENT_DIR || join(e.HOME || homedir(), ".pi", "agent");
  let dir: string;
  if (e.ORCH_JOB_DIR && existsSync(e.ORCH_JOB_DIR)) {
    dir = join(e.ORCH_JOB_DIR, "pi-agent");
    mkdirSync(dir, { recursive: true });
  } else {
    dir = join(e.TMPDIR || tmpdir(), `orch-pi-agent-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
  }
  if (existsSync(userDir)) {
    for (const name of readdirSync(userDir)) {
      if (name === "models.json") continue;
      const target = join(dir, name);
      try {
        if (lstatSync(target, { throwIfNoEntry: false })) unlinkSync(target);
      } catch {}
      symlinkSync(join(userDir, name), target);
    }
  }
  const models = {
    providers: {
      [PI_HUB_PROVIDER]: {
        baseUrl: e.LLM_HUB_V1_URL,
        api: "openai-completions",
        apiKey: e.LLM_HUB_KEY ? "$LLM_HUB_KEY" : "llm-hub",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: false, maxTokensField: "max_tokens", requiresToolResultName: true },
        models: [{ id: model, name: model, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 32768 }],
      },
    },
  };
  writeFileSync(join(dir, "models.json"), JSON.stringify(models, null, 2) + "\n");
  return dir;
}

async function adapterPi(prompt: string, args: string[], e: Env): Promise<number> {
  const bin = await resolveBin("adapter_pi", "pi", e);
  if (!bin) return 127;
  if (!e.LLM_HUB_V1_URL) return (err("adapter_pi: LLM_HUB_URL not set (or set LLM_HUB_V1_URL directly)\n"), 1);
  const model = e.LLM_HUB_MODEL ?? "";
  if (model === "") return (err("adapter_pi: no model — give the profile a model or set LLM_HUB_MODEL\n"), 2);
  let dir: string;
  try {
    dir = piAgentDir(model, e);
  } catch {
    return (err("adapter_pi: cannot prepare the pi agent dir\n"), 1);
  }
  let session = ["--no-session"];
  const sid = e.ORCH_RESUME_SESSION || e.ORCH_SESSION_ID;
  if (e.ORCH_PI_SESSION_DIR && sid) {
    mkdirSync(e.ORCH_PI_SESSION_DIR, { recursive: true });
    session = ["--session-dir", e.ORCH_PI_SESSION_DIR, "--session-id", sid];
  }
  const env2 = { ...e, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const { rc } = await exec([bin, "--model", `${PI_HUB_PROVIDER}/${model}`, "--approve", ...session, "-p", prompt, ...args], env2);
  if (!(e.ORCH_JOB_DIR && dir === join(e.ORCH_JOB_DIR, "pi-agent"))) await trashPath(orchHome(), dir).catch(() => undefined);
  return rc;
}

async function adapterLocalLlm(prompt: string, _args: string[], e: Env): Promise<number> {
  if (!e.LLM_HUB_V1_URL) return (err("adapter_local_llm: LLM_HUB_URL not set (or set LLM_HUB_V1_URL directly)\n"), 1);
  const payload = { model: e.LLM_HUB_MODEL || "local-model", messages: [{ role: "user", content: prompt }], stream: false };
  try {
    const res = await fetch(`${e.LLM_HUB_V1_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(e.LLM_HUB_TIMEOUT || 120) * 1000),
    });
    const j: any = await res.json();
    const v = j?.choices?.[0]?.message?.content ?? j?.error;
    if (v !== undefined && v !== null) out(`${typeof v === "string" ? v : JSON.stringify(v)}\n`);
    return 0;
  } catch {
    return (err(`adapter_local_llm: request to ${e.LLM_HUB_V1_URL} failed\n`), 1);
  }
}

export async function adapterDispatch(adapter: string, prompt: string, args: string[], e: Env): Promise<number> {
  switch (adapter) {
    case "claude-native":
      out("claude-native: no subprocess spawned; do this work directly in the current session\n");
      return 0;
    case "claude": return adapterClaude(prompt, args, e);
    case "cursor-agent": return adapterCursor(prompt, args, e);
    case "local-llm": return adapterLocalLlm(prompt, args, e);
    case "opencode": return adapterOpencode(prompt, args, e);
    case "copilot": return adapterCopilot(prompt, args, e);
    case "pi": return adapterPi(prompt, args, e);
    default:
      err(`adapter_dispatch: unknown adapter "${adapter}"\n`);
      return 2;
  }
}

export async function dispatchWithProfile(home: string, name: string, prompt: string, args: string[], e: Env): Promise<number> {
  const r = await loadProfile(home, name, e);
  if (!r.ok) return r.rc;
  const p = r.profile;
  let model = p.model;
  const modelArgs: string[] = [];
  if (p.behavesAs) {
    e.ORCH_MODEL_BEHAVES_AS = p.behavesAs;
    e.ORCH_MODEL_SLUG = p.model;
  }
  if (model !== "") {
    if (p.harness === "copilot" || p.harness === "pi") model = hubTierModel(model, e.ORCH_NODE_TIER ?? "");
    if (p.harness === "claude" || p.harness === "cursor-agent" || p.harness === "copilot") modelArgs.push("--model", model);
    else if (p.harness === "opencode") modelArgs.push("-m", model);
    else if (p.harness === "local-llm" || p.harness === "pi") e.LLM_HUB_MODEL = model;
  }
  return adapterDispatch(p.harness, prompt, [...modelArgs, ...p.flags, ...args], e);
}

export interface Target {
  kind: "profile" | "adapter";
  name: string;
  prompt: string;
  rest: string[];
}

// parse_target: `(--profile <name> | <adapter>) <prompt|@file> [args...]`. Returns an exit code on failure.
export async function parseTarget(sub: string, args: string[]): Promise<Target | number> {
  const profile = args[0] === "--profile";
  const name = (profile ? args[1] : args[0]) ?? "";
  const raw = (profile ? args[2] : args[1]) ?? "";
  const rest = args.slice(profile ? 3 : 2);
  if (name === "" || raw === "") return (err(`usage: dispatch.ts ${sub} (--profile <name> | <adapter>) <prompt|@file> [args...]\n`), 2);
  const prompt = await resolvePrompt(raw);
  if (prompt === null) return 1;
  return { kind: profile ? "profile" : "adapter", name, prompt, rest };
}

export async function targetDispatch(t: Target, e: Env): Promise<number> {
  const home = orchHome();
  return t.kind === "profile" ? dispatchWithProfile(home, t.name, t.prompt, t.rest, e) : adapterDispatch(t.name, t.prompt, t.rest, e);
}

// `run`: synchronous, stdio inherited.
export async function cmdRun(args: string[]): Promise<number> {
  const t = await parseTarget("run", args);
  if (typeof t === "number") return t;
  return targetDispatch(t, await loadEnv(orchHome()));
}

// Hidden `job-run <job-dir> <kind> <name> <prompt> [args...]`: the detached child of `start`. Its
// stdout and stderr are the job log. Writes exit_code last (128+N on a signal).
export async function cmdJobRun(args: string[]): Promise<number> {
  const [jobDir, kind, name, prompt, ...rest] = args;
  if (!jobDir || !kind || !name || prompt === undefined) return 2;
  const write = (rc: number) => {
    try {
      writeAtomic(join(jobDir, "exit_code"), String(rc));
      Bun.spawn(["bun", join(import.meta.dir, "..", "cli.ts"), "herdr", "close-ended", jobDir], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch {}
  };
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.on(sig, () => {
      write(code);
      process.exit(code);
    });
  }
  // Self-check: the job dir and its state (exit_code absent) every 5 s. A confirmed miss is a ghost: exit 0.
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    const miss = await confirmMiss(() => selfCheckReason("job", orchHome(), jobDir, process.pid), (s) => new Promise((r) => setTimeout(r, s * 1000)));
    checking = false;
    if (miss !== null) {
      process.stderr.write(`ghost: ${miss}\n`);
      process.exit(0);
    }
  }, 5000);
  const rc = await targetDispatch({ kind: kind as Target["kind"], name, prompt, rest }, await loadEnv(orchHome()));
  clearInterval(timer);
  write(rc);
  return rc;
}

// Returns true when the job was handed to a herdr pane.
async function herdrStart(jobDir: string, t: Target, e: Env): Promise<boolean> {
  if (e.ORCH_HERDR === "0" || e.ORCH_HERDR === "false" || e.ORCH_HERDR === "off") return false;
  const { startJob } = await import("./herdr.ts");
  for (const [k, v] of Object.entries(e)) if (v !== undefined && /^(ORCH_|HARNESS_ORCH_)/.test(k)) process.env[k] = v;
  return startJob(orchHome(), jobDir, [process.execPath, join(import.meta.dir, "..", "cli.ts"), "job-run", jobDir, t.kind, t.name, t.prompt, ...t.rest]);
}

// `start`: validates the profile, makes the job dir, then runs `job-run` detached (own session, unref).
export async function cmdStart(args: string[]): Promise<number> {
  const t = await parseTarget("start", args);
  if (typeof t === "number") return t;
  const home = orchHome();
  const e = await loadEnv(home);
  let adapter = t.name;
  let loaded: LoadedProfile | null = null;
  if (t.kind === "profile") {
    const r = await loadProfile(home, t.name, { ...e });
    if (!r.ok) return r.rc;
    loaded = r.profile;
    adapter = loaded.harness;
  }
  const jobsHome = paths.jobs(home);
  try {
    mkdirSync(jobsHome, { recursive: true });
  } catch {
    return (err(`cmd_start: cannot create ${jobsHome}\n`), 1);
  }
  const d = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const sid = e.CLAUDE_CODE_SESSION_ID || e.OPENCODE_SESSION_ID || `pid-${process.ppid}`;
  const jobId = `${d}-${sid}-${process.pid}-${Math.floor(Math.random() * 32768)}`;
  const jobDir = join(jobsHome, jobId);
  mkdirSync(jobDir, { recursive: true });
  const w = (f: string, v: string) => writeFileSync(join(jobDir, f), v + "\n");
  w("adapter", adapter);
  const repo = process.cwd();
  const repoProbe = Bun.spawnSync(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  if (repoProbe.exitCode === 0) {
    const repoRoot = repoProbe.stdout.toString().trim();
    const headProbe = Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    if (headProbe.exitCode === 0) {
      w("repo", repoRoot);
      w("start_commit", headProbe.stdout.toString().trim());
      // Uncommitted files at dispatch, so delivery can tell this node's edits from earlier ones.
      writeStatusSnapshot(jobDir, repoRoot);
    }
  }
  if (loaded) {
    w("profile", t.name);
    w("model", loaded.model);
    w("model_id", loaded.modelId);
  }
  const session = e.ORCH_RESUME_SESSION || crypto.randomUUID();
  e.ORCH_SESSION_ID = session;
  w("session", session);
  e.ORCH_JOB_DIR = jobDir;

  if (await herdrStart(jobDir, t, e)) return (out(`${jobId}\n`), 0);

  const log = openSync(join(jobDir, "log"), "a");
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "cli.ts"), "job-run", jobDir, t.kind, t.name, t.prompt, ...t.rest], {
    env: { ...e, ORCH_DIRECT: "1" } as Record<string, string>,
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
  });
  proc.unref();
  w("pid", String(proc.pid));
  out(`${jobId}\n`);
  return 0;
}

export { setSpawnNode, spawnNode } from "./spawn-node.ts";
