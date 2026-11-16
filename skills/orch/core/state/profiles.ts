// Config home bootstrap and the profiles.json migrations. Ported from lib/core/config.sh
// (ensure_home, profiles_migrate*, profiles_template_merged). Bun built-ins only.
// Every migration only fills in what is missing and is marker-guarded where it must not run twice.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nowIso } from "./clock.ts";
import { paths } from "./home.ts";
import { stamp } from "./trash.ts";

export const TEMPLATES_DIR = resolve(import.meta.dir, "../../templates");
const MIGRATION_VERSION = "2";
type Obj = Record<string, any>;

export const overlayFile = (env: NodeJS.ProcessEnv = process.env) => env.ORCH_PROFILES_OVERLAY || join(TEMPLATES_DIR, "profiles.local.json");

// jq truthiness: only null and false are falsy.
const jt = (v: unknown) => v !== null && v !== undefined && v !== false;
// jq `.k //= v`
function alt(o: Obj, k: string, v: unknown): void {
  if (!jt(o[k])) o[k] = v;
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const readText = (f: string) => readFileSync(f, "utf8");
const readJsonSync = (f: string): Obj => JSON.parse(readText(f));

function deepMerge(a: Obj, b: Obj): Obj {
  const r: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    r[k] = v && typeof v === "object" && !Array.isArray(v) && r[k] && typeof r[k] === "object" && !Array.isArray(r[k]) ? deepMerge(r[k], v) : v;
  }
  return r;
}

// The profiles template with the overlay merged over it. Without an overlay it is the template bytes.
export function profilesTemplateMerged(env: NodeJS.ProcessEnv = process.env): { text: string; doc: Obj } {
  const raw = readText(join(TEMPLATES_DIR, "profiles.json"));
  const tpl = JSON.parse(raw);
  const ov = overlayFile(env);
  if (!existsSync(ov)) return { text: raw, doc: tpl };
  const o = readJsonSync(ov);
  const doc = {
    ...tpl,
    defaults: deepMerge(tpl.defaults ?? {}, o.defaults ?? {}),
    settings: deepMerge(tpl.settings ?? {}, o.settings ?? {}),
    models: { ...(tpl.models ?? {}), ...(o.models ?? {}) },
    profiles: { ...(tpl.profiles ?? {}), ...(o.profiles ?? {}) },
  };
  return { text: JSON.stringify(doc, null, 2) + "\n", doc };
}

function moveToTrash(home: string, file: string): void {
  try {
    const dest = join(paths.trash(home), stamp());
    mkdirSync(dest, { recursive: true });
    renameSync(file, join(dest, file.split("/").pop()!));
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Moves profiles.json.tmp.<pid> files whose writer is gone into the trash dir.
function tmpSweep(home: string): void {
  const base = "profiles.json.tmp.";
  for (const f of readdirSync(home)) {
    if (!f.startsWith(base)) continue;
    const pid = f.slice(base.length);
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid || alive(Number(pid))) continue;
    moveToTrash(home, join(home, f));
  }
}

// Writes the document to profiles.json when its bytes differ. Atomic rename via <file>.tmp.<pid>.
export function profilesCommit(home: string, doc: Obj): void {
  const file = paths.profiles(home);
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (existsSync(file) && readText(file) === text) return;
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const SMART_AUTO_PROFILE_NAMES = ["claude-smart-auto", "copilot-smart-auto", "opencode-smart-auto", "pi-smart-auto"];
const COPILOT_WORKER_FLAGS = ["--allow-all-tools", "--allow-all-paths", "--allow-all", "--yolo", "--no-ask-user", "--autopilot"];
const COPILOT_PLANNER_FLAGS = ["--context", "long_context", "--reasoning-effort", "xhigh", ...COPILOT_WORKER_FLAGS];

const settingDangling = (d: Obj, k: string) => {
  const v = d.settings?.[k] ?? "";
  return v === "" || !jt(d.profiles?.[v]);
};
const uniqSorted = (a: string[]) => [...new Set(a)].sort();

function renameProfile(d: Obj, oldN: string, newN: string): void {
  if (!jt(d.profiles?.[oldN])) return;
  d.profiles[newN] = d.profiles[oldN];
  delete d.profiles[oldN];
  if ((d.settings?.default_profile ?? "") === oldN) d.settings.default_profile = newN;
  for (const p of Object.values<any>(d.profiles)) if (p?.fallback === oldN) p.fallback = newN;
}

function migrateMain(d: Obj, seedCopilot: boolean): void {
  d.models ??= {};
  d.settings ??= {};
  renameProfile(d, "claude-hub", "claude-llm-hub");
  renameProfile(d, "cursor-hub", "cursor-llm-hub");
  alt(d.models, "cursor-auto", {
    slug: "auto", harnesses: ["cursor-agent"], description: "Cursor picks the model per request (Auto).",
    cost: "metered", quality: "standard", speed: "fast", tags: ["cursor", "auto"],
  });
  if (seedCopilot) {
    alt(d.models, "copilot-auto", {
      slug: "auto", harnesses: ["copilot"], description: "Copilot CLI picks the model per request (auto routing).",
      cost: "subscription", quality: "standard", speed: "fast", tags: ["copilot", "auto"],
    });
    alt(d.profiles, "copilot-default", {
      harness: "copilot", model: "copilot-auto", allowed_models: ["copilot-auto"],
      description: "GitHub Copilot CLI on Copilot subscription (headless -p).",
      cost: "subscription", quality: "standard", speed: "balanced", risk: "medium", enabled: true,
      strengths: ["implement", "review", "debug"], parallel_ok: true, priority: 8,
      flags: ["--allow-all-tools"], env: {}, auth: [],
    });
  }
  const cd = d.profiles["cursor-default"];
  if (cd && (cd.model ?? "") === "cursor-composer") {
    cd.model = "cursor-auto";
    cd.allowed_models = ["cursor-auto"];
  }
  if (cd && JSON.stringify(cd.auth ?? []) === '["CURSOR_API_KEY"]') cd.auth = [];
  for (const p of Object.values<any>(d.profiles)) {
    if (p.harness === "cursor-agent") p.flags = (Array.isArray(p.flags) ? p.flags : []).filter((f: unknown) => f !== "--force");
  }
  alt(d.settings, "learning", {
    auto_record_memory: true, auto_scan_on_finish: true, auto_apply_safe: true, min_samples: 3, recency_days: 30, dismiss_ttl_days: 30,
  });
  alt(d.settings, "max_attempts", 5);
  alt(d.settings.learning, "auto_apply_safe", true);
  for (const name of Object.keys(d.profiles)) {
    const p = d.profiles[name];
    const m = p.model ?? "";
    if (m === "" || jt(d.models[m])) continue;
    const found = Object.entries<any>(d.models).find(([, v]) => v.slug === m && Array.isArray(v.harnesses) && v.harnesses.includes(p.harness))?.[0];
    if (found) p.model = found;
    else {
      const nid = `${String(p.harness).replace(/-/g, "_")}-${String(m).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      d.models[nid] = { slug: m, harnesses: [p.harness], description: "" };
      p.model = nid;
    }
  }
}

function migrateCopilotPlanner(d: Obj, seed: boolean): void {
  const joined = /^-[^\s"']*(\s+[^\s"']+)+$/;
  for (const p of Object.values<any>(d.profiles)) {
    if (Array.isArray(p.flags)) p.flags = p.flags.flatMap((f: unknown) => (typeof f === "string" && joined.test(f) ? f.split(/\s+/) : [f]));
  }
  if (!seed) return;
  d.models ??= {};
  d.settings ??= {};
  alt(d.models, "copilot-opus-5.5", {
    slug: "claude-opus-5.5", harnesses: ["copilot"],
    description: "Claude Opus 5.5 through Copilot CLI; pair with --context long_context for the 1M window.",
    cost: "high", quality: "best", speed: "slow", max_complexity: "large", tags: ["copilot", "planning", "architecture", "long-context"],
  });
  alt(d.profiles, "copilot-planner", {
    harness: "copilot", model: "copilot-opus-5.5", allowed_models: ["copilot-opus-5.5"],
    description: "Copilot CLI on Claude Opus 5.5, 1M context tier. Splits a goal into a task DAG for copilot-default workers.",
    cost: "high", quality: "best", speed: "slow", risk: "low", enabled: true,
    strengths: ["planning", "architecture", "decomposition"], avoid_for: ["trivial", "format"],
    min_complexity: "large", parallel_ok: false, priority: 8, flags: [...COPILOT_PLANNER_FLAGS], env: {}, auth: [],
  });
  const cd = d.profiles["copilot-default"];
  if (jt(cd)) {
    cd.model = "copilot-auto";
    cd.allowed_models = uniqSorted([...(cd.allowed_models ?? []), "copilot-auto"]);
    const f: string[] = cd.flags ?? [];
    cd.flags = [...f, ...COPILOT_WORKER_FLAGS.filter((w) => !f.includes(w))];
    if (settingDangling(d, "default_profile")) d.settings.default_profile = "copilot-default";
  }
  alt(d.settings, "max_parallel", 4);
  alt(d.settings, "max_nodes", 12);
  alt(d.settings, "max_attempts", 5);
  alt(d.settings, "planner_profile", "copilot-planner");
}

function migrateClaudePlanner(d: Obj): void {
  d.models ??= {};
  d.settings ??= {};
  const ren = (v: string) => (v === "claude-sub" ? "claude-default" : v);
  if (jt(d.profiles["claude-sub"]) && !jt(d.profiles["claude-default"])) {
    const p = d.profiles["claude-sub"];
    p.parallel_ok = true;
    p.priority = 8;
    p.description = "Claude Code on Anthropic subscription (Sonnet). Default Claude worker, the Claude twin of copilot-default.";
    delete p.min_complexity;
    delete p.max_complexity;
    d.profiles["claude-default"] = p;
    delete d.profiles["claude-sub"];
  }
  for (const p of Object.values<any>(d.profiles)) if (jt(p.fallback)) p.fallback = ren(p.fallback);
  for (const k of ["default_profile", "planner_profile"]) d.settings[k] = jt(d.settings[k]) ? ren(d.settings[k]) : (d.settings[k] ?? null);
  alt(d.models, "claude-opus-1m", {
    slug: "opus[1m]", harnesses: ["claude"], description: "Claude Opus with the 1M context window; the planner tier.",
    cost: "high", quality: "best", speed: "slow", max_complexity: "large", tags: ["planning", "architecture", "long-context"],
  });
  alt(d.profiles, "claude-planner", {
    harness: "claude", model: "claude-opus-1m", allowed_models: ["claude-opus-1m"],
    description: "Claude Code on Opus, 1M context, xhigh effort. Splits a goal into a task DAG for claude-default workers.",
    cost: "high", quality: "best", speed: "slow", risk: "low", enabled: true,
    strengths: ["planning", "architecture", "decomposition"], avoid_for: ["trivial", "format"],
    min_complexity: "large", parallel_ok: false, priority: 8,
    flags: ["--effort", "xhigh", "--dangerously-skip-permissions"], env: {}, auth: [],
  });
  if (jt(d.profiles["copilot-default"]) && jt(d.profiles["claude-default"])) alt(d.profiles["copilot-default"], "fallback", "claude-default");
  if (jt(d.profiles["copilot-planner"])) alt(d.profiles["copilot-planner"], "fallback", "claude-planner");
}

function migrateBenchLocal(d: Obj, tpl: Obj): void {
  d.settings ??= {};
  const notfit = ["local-lfm-8b", "local-lfm-2.6b", "local-qwen3-4b"];
  const newModels = ["local-qwen3.6-35b", "local-ornith-1.0-35b", "local-ornith-1.5-35b", "local-qwen3-coder-next", "local-ornith-1.5-9b"];
  const newProfiles = ["claude-llm-hub-planner", "copilot-llm-hub", "opencode-llm-hub", "pi-llm-hub", "local-llm-fast"];
  const pinRe = /^ANTHROPIC_(MODEL|DEFAULT_.*_MODEL|SMALL_FAST_MODEL)$|^CLAUDE_CODE_/;
  const pins: Obj = Object.fromEntries(Object.entries<any>(tpl.profiles?.["claude-llm-hub"]?.env ?? {}).filter(([k]) => pinRe.test(k)));
  const notfitModel = (p: Obj) => {
    const m = p.model ?? "";
    return m === "" || notfit.includes(m);
  };
  const patternAllows = (entry: string, slug: string) => entry.endsWith("*") && slug.startsWith(entry.slice(0, -1));
  for (const id of newModels) if (jt(tpl.models?.[id])) alt(d.models, id, tpl.models[id]);
  const ch = d.profiles["claude-llm-hub"];
  if (jt(ch) && ((notfitModel(ch) && (ch.model ?? "") !== "") || ch.model === "local-ornith-1.0-35b")) {
    const slug = String(d.models["local-qwen3.6-35b"]?.slug ?? "");
    ch.model = "local-qwen3.6-35b";
    ch.parallel_ok = false;
    if (Array.isArray(ch.allowed_models) && !ch.allowed_models.some((a: string) => a === "local-qwen3.6-35b" || patternAllows(a, slug))) {
      ch.allowed_models = [...ch.allowed_models, "local-qwen3.6-35b"];
    }
  }
  for (const p of Object.values<any>(d.profiles)) {
    const ref = String(d.models[p.model ?? ""]?.slug ?? p.model ?? "");
    if (p.harness === "claude" && ref.startsWith("llama_swap/")) p.env = { ...pins, ...(p.env ?? {}) };
  }
  const gone: string[] = [];
  const cl = d.profiles["cursor-llm-hub"];
  if (cl && cl.harness === "cursor-agent" && notfitModel(cl)) gone.push("cursor-llm-hub");
  for (const n of ["local-qwen", "local-qwen3"]) {
    const p = d.profiles[n];
    if (p && notfitModel(p) && (p.model ?? "") !== "") gone.push(n);
  }
  const retarget = (r: string) => (!gone.includes(r) ? r : r === "cursor-llm-hub" ? "copilot-llm-hub" : "local-llm-fast");
  for (const n of gone) delete d.profiles[n];
  for (const p of Object.values<any>(d.profiles)) if (jt(p.fallback)) p.fallback = retarget(p.fallback);
  for (const k of ["default_profile", "planner_profile"]) d.settings[k] = jt(d.settings[k]) ? retarget(d.settings[k]) : (d.settings[k] ?? null);
  for (const n of newProfiles) if (jt(tpl.profiles?.[n])) alt(d.profiles, n, tpl.profiles[n]);
  const used = Object.values<any>(d.profiles).map((p) => p.model).filter((m) => jt(m));
  for (const id of notfit) if (!used.includes(id)) delete d.models[id];
  for (const p of Object.values<any>(d.profiles)) {
    if (Array.isArray(p.allowed_models)) p.allowed_models = p.allowed_models.filter((a: string) => !notfit.includes(a) || jt(d.models[a]));
  }
  const cursorModels = Object.values<any>(d.profiles).filter((p) => p.harness === "cursor-agent").map((p) => p.model).filter((m) => jt(m));
  const o = d.models["local-ornith-1.0-35b"];
  if (jt(o) && !cursorModels.includes("local-ornith-1.0-35b")) o.harnesses = (o.harnesses ?? []).filter((h: string) => h !== "cursor-agent");
}

function migrateClaudeTiers(d: Obj, t: Obj): void {
  d.models ??= {};
  d.settings ??= {};
  const m = d.models["claude-haiku"];
  if (!jt(m) || m.description === "Fast and cheap: typos, formatting, tiny edits, boilerplate.") d.models["claude-haiku"] = t.models?.["claude-haiku"] ?? null;
  const h = d.profiles["claude-haiku"];
  if (!jt(h) || h.max_complexity === "trivial") d.profiles["claude-haiku"] = t.profiles?.["claude-haiku"] ?? null;
  const pl = d.profiles["claude-planner"];
  if (pl?.description === "Claude Code on Opus, 1M context, xhigh effort. Splits a goal into a task DAG for claude-default workers.") {
    pl.description = t.profiles?.["claude-planner"]?.description ?? null;
  }
  if (d.profiles["claude-default"]?.priority === 8) d.profiles["claude-default"].priority = 9;
  if (d.profiles["copilot-default"]?.priority === 9) d.profiles["copilot-default"].priority = 8;
  if (jt(d.profiles["claude-default"]) && settingDangling(d, "default_profile")) d.settings.default_profile = "claude-default";
  if (jt(d.profiles["claude-planner"]) && settingDangling(d, "planner_profile")) d.settings.planner_profile = "claude-planner";
}

function migrateSmartAuto(d: Obj, tpl: Obj): void {
  if (jt(tpl.models?.["hub-smart-auto-balance"])) alt(d.models, "hub-smart-auto-balance", tpl.models["hub-smart-auto-balance"]);
  for (const n of SMART_AUTO_PROFILE_NAMES) if (jt(tpl.profiles?.[n])) alt(d.profiles, n, tpl.profiles[n]);
}

// Runs every profiles.json migration in order and writes the result once. Markers under <home> as before.
export function profilesMigrate(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = paths.profiles(home);
  if (!existsSync(file)) return;
  const d = readJsonSync(file);
  d.profiles ??= {};
  const tpl = profilesTemplateMerged(env).doc;
  const marker = (n: string) => join(home, n);
  const touch = (n: string) => writeFileSync(marker(n), "");
  const copilotSeed = !existsSync(marker(".copilot-profile-migrated"));
  migrateMain(d, copilotSeed);
  const planSeed = !existsSync(marker(".copilot-planner-migrated"));
  migrateCopilotPlanner(d, planSeed);
  const steps: Array<[string, (x: Obj) => void]> = [
    [".claude-planner-migrated", migrateClaudePlanner],
    [".bench-local-migrated", (x) => migrateBenchLocal(x, tpl)],
    [".claude-tiers-migrated", (x) => migrateClaudeTiers(x, tpl)],
    [".smart-auto-migrated", (x) => migrateSmartAuto(x, tpl)],
  ];
  const todo = steps.filter(([m]) => !existsSync(marker(m)));
  for (const [, fn] of todo) fn(d);
  profilesCommit(home, d);
  if (copilotSeed) touch(".copilot-profile-migrated");
  if (planSeed) touch(".copilot-planner-migrated");
  for (const [m] of todo) touch(m);
}

function migrationSig(home: string): string {
  const s = statSync(paths.profiles(home), { throwIfNoEntry: false });
  return `${s ? `${Math.floor(s.mtimeMs / 1000)}:${s.size}` : ""}|${MIGRATION_VERSION}`;
}

// ensure_home: dirs, seeded profiles/memory/serve.json/suggestions, and the migrations (rerun only when the
// profiles file or MIGRATION_VERSION changed).
export async function ensureHome(home: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    for (const d of ["", "jobs", "runs"]) mkdirSync(join(home, d), { recursive: true });
    const profiles = paths.profiles(home);
    if (!existsSync(profiles)) {
      const seed = `${profiles}.tmp.${process.pid}`;
      writeFileSync(seed, profilesTemplateMerged(env).text);
      renameSync(seed, profiles);
    }
    const mem = join(home, "memory.json");
    if (!existsSync(mem)) writeFileSync(mem, "[]\n");
    const sj = join(home, "serve.json");
    if (!existsSync(sj)) {
      try {
        copyFileSync(join(TEMPLATES_DIR, "serve.json"), sj);
      } catch {}
    }
    const marker = join(home, ".migrations", "profiles-main");
    tmpSweep(home);
    const cur = existsSync(marker) ? readText(marker).replace(/\n$/, "") : "";
    if (cur !== migrationSig(home)) {
      profilesMigrate(home, env);
      mkdirSync(join(home, ".migrations"), { recursive: true });
      writeFileSync(marker, migrationSig(home) + "\n");
    }
    const sug = join(home, "suggestions.json");
    if (!existsSync(sug)) {
      try {
        copyFileSync(join(TEMPLATES_DIR, "suggestions.json"), sug);
      } catch {
        writeFileSync(sug, `{"generated_at":"${nowIso()}","suggestions":[]}\n`);
      }
    }
    return true;
  } catch (e) {
    process.stderr.write(`orch: cannot create ${home}\n`);
    return false;
  }
}
