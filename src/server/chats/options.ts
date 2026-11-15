import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ModelSpec { slug?: string; harnesses?: string[]; description?: string; behaves_as?: string; cost?: string; quality?: string }
interface ProfileSpec {
  harness?: string; model?: string; allowed_models?: string[]; enabled?: boolean; description?: string;
  flags?: string[]; env?: Record<string, string>; auth?: string[];
}
interface ProfilesDoc {
  settings?: { disabled_harnesses?: string[]; default_profile?: string };
  models?: Record<string, ModelSpec>;
  profiles?: Record<string, ProfileSpec>;
}

export interface ModelOption { id: string; label: string; slug: string; description: string; default: boolean }
export interface ProfileOption { name: string; description: string; enabled: boolean; configured: boolean; problem: string | null; models: ModelOption[] }
export interface HarnessOption { id: string; label: string; enabled: boolean; available: boolean; persistent: boolean; memory: "process" | "session" | "replay"; profiles: ProfileOption[] }
export interface ChatOptions { harnesses: HarnessOption[]; default_harness: string | null; default_profile: string | null }

const LABELS: Record<string, string> = {
  claude: "Claude Code", "cursor-agent": "Cursor", opencode: "opencode", "local-llm": "Local LLM", copilot: "Copilot CLI", pi: "pi",
};
const BINARY: Record<string, string> = { claude: "claude", "cursor-agent": "cursor-agent", opencode: "opencode", copilot: "copilot", pi: "pi", "local-llm": "curl" };
/** How a chat keeps its memory: one live process, a harness session resumed per message, or the history replayed in the prompt. */
export const MEMORY: Readonly<Record<string, "process" | "session" | "replay">> = {
  claude: "process", copilot: "session", pi: "session", "cursor-agent": "session", opencode: "session", "local-llm": "replay",
};
export const PERSISTENT_HARNESSES: ReadonlySet<string> = new Set(["claude"]);

export function readProfiles(home: string): ProfilesDoc {
  try {
    return JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")) as ProfilesDoc;
  } catch {
    return {};
  }
}

/** Same rule as `model_allowed` in routing.sh: an exact catalog id or slug, or a `prefix*` pattern. */
function matches(id: string, slug: string, entry: string): boolean {
  if (entry.endsWith("*")) {
    const pre = entry.slice(0, -1);
    return pre === "" || id.startsWith(pre) || slug.startsWith(pre);
  }
  return entry === id || entry === slug;
}

function modelsOf(doc: ProfilesDoc, profile: ProfileSpec): ModelOption[] {
  const allowed = profile.allowed_models ?? [];
  const out: ModelOption[] = [];
  for (const [id, spec] of Object.entries(doc.models ?? {})) {
    const slug = spec.slug ?? id;
    if (!(spec.harnesses ?? []).includes(profile.harness ?? "")) {
      continue;
    }
    if (allowed.length > 0 && !allowed.some((entry) => matches(id, slug, entry))) {
      continue;
    }
    out.push({ id, label: id, slug, description: spec.description ?? "", default: id === profile.model });
  }
  return out;
}

/** Variables a profile's `${NAME}` references read: the process env, then `<home>/env` for names the process left unset. */
export function profileEnvSource(home: string, modelSlug: string): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = { ...process.env };
  const file = join(home, "env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const at = line.indexOf("=");
      const name = at > 0 ? line.slice(0, at) : "";
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !(name in vars)) {
        vars[name] = line.slice(at + 1);
      }
    }
  }
  const base = (vars.LLM_HUB_URL ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
  if (base !== "" && vars.LLM_HUB_V1_URL === undefined) {
    vars.LLM_HUB_V1_URL = `${base}/v1`;
  }
  vars.PROFILE_MODEL = modelSlug;
  return vars;
}

function problemOf(profile: ProfileSpec, vars: Record<string, string | undefined>): string | null {
  for (const name of profile.auth ?? []) {
    if (!vars[name]) {
      return `required auth env var ${name} is not set`;
    }
  }
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    if (ref !== undefined && !vars[ref]) {
      return `env ${key} references unset \${${ref}}`;
    }
  }
  return null;
}

export function buildOptions(home: string, harnessIds: readonly string[]): ChatOptions {
  const doc = readProfiles(home);
  const disabled = new Set(doc.settings?.disabled_harnesses ?? []);
  const entries = Object.entries(doc.profiles ?? {});
  const harnesses: HarnessOption[] = harnessIds.map((id) => {
    const enabled = !disabled.has(id);
    const profiles = entries.filter(([, p]) => p.harness === id).map(([name, p]): ProfileOption => {
      const models = modelsOf(doc, p);
      const problem = problemOf(p, profileEnvSource(home, models.find((m) => m.default)?.slug ?? ""));
      return {
        name, description: p.description ?? "", enabled: enabled && p.enabled !== false, configured: problem === null, problem, models,
      };
    });
    return { id, label: LABELS[id] ?? id, enabled, available: Bun.which(BINARY[id] ?? id) !== null, persistent: PERSISTENT_HARNESSES.has(id), memory: MEMORY[id] ?? "replay", profiles };
  });
  const def = doc.settings?.default_profile ?? null;
  const defHarness = def === null ? null : (doc.profiles?.[def]?.harness ?? null);
  return { harnesses, default_harness: defHarness, default_profile: defHarness === null ? null : def };
}

export interface Launch {
  harness: string;
  modelSlug: string;
  behavesAs: string;
  flags: string[];
  env: Record<string, string>;
}

export type Resolved = { ok: true; launch: Launch } | { ok: false; error: string };

/**
 * The checks every create/send/config change applies, and the spawn parameters on success: harness
 * and profile enabled, the model inside the profile's allowed list, and every `${VAR}` set.
 */
export function resolveLaunch(home: string, harness: string, profileName: string, modelId: string | null): Resolved {
  const doc = readProfiles(home);
  const profile = doc.profiles?.[profileName];
  if (profile === undefined) {
    return { ok: false, error: `unknown profile "${profileName}"` };
  }
  if (profile.harness !== harness) {
    return { ok: false, error: `profile "${profileName}" belongs to harness "${profile.harness ?? "?"}", not "${harness}"` };
  }
  if ((doc.settings?.disabled_harnesses ?? []).includes(harness)) {
    return { ok: false, error: `harness "${harness}" is disabled (settings.disabled_harnesses)` };
  }
  if (profile.enabled === false) {
    return { ok: false, error: `profile "${profileName}" is disabled` };
  }
  const models = modelsOf(doc, profile);
  let chosen: ModelOption | undefined;
  if (modelId !== null) {
    chosen = models.find((m) => m.id === modelId);
    if (chosen === undefined) {
      return { ok: false, error: `model "${modelId}" is not allowed for profile "${profileName}"` };
    }
  } else {
    chosen = models.find((m) => m.default);
  }
  const slug = chosen?.slug ?? "";
  const vars = profileEnvSource(home, slug);
  const problem = problemOf(profile, vars);
  if (problem !== null) {
    return { ok: false, error: `profile "${profileName}": ${problem}` };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
    env[key] = ref === undefined ? value : (vars[ref] as string);
  }
  const behavesAs = chosen === undefined ? "" : (doc.models?.[chosen.id]?.behaves_as ?? "");
  return { ok: true, launch: { harness, modelSlug: slug, behavesAs, flags: profile.flags ?? [], env } };
}
