/**
 * Effective profile values and where each one came from. Same rule as `profile_effective` in
 * skills/orch/scripts/lib/core/config.sh: node override, then profile, then defaults, then built-in.
 * env is merged key by key (defaults first, profile wins, node wins over both); flags are replaced.
 */

export type ValueSource = "node" | "profile" | "defaults" | "builtin";

export interface Effective<T> {
  value: T;
  source: ValueSource;
}

export interface ProfileDefaults {
  parallel_ok?: boolean;
  max_parallel?: number;
  flags?: string[];
  env?: Record<string, string>;
  timeout_min?: number | null;
  retry?: number | null;
  stall_min?: number | null;
  effort?: string | null;
  tier?: string | null;
  role?: string | null;
  cost?: string | null;
  quality?: string | null;
  speed?: string | null;
  risk?: string | null;
}

export const BUILTIN_DEFAULTS: ProfileDefaults = {
  parallel_ok: true,
  max_parallel: 7,
  flags: [],
  env: {},
};

export const EFFECTIVE_KEYS: (keyof ProfileDefaults)[] = [
  "parallel_ok", "max_parallel", "flags", "env", "timeout_min", "retry", "stall_min",
  "effort", "tier", "role", "cost", "quality", "speed", "risk",
];

export type EffectiveProfile = { [K in keyof ProfileDefaults]-?: Effective<ProfileDefaults[K]> };

const has = (o: object | undefined | null, k: string): boolean =>
  o !== undefined && o !== null && Object.prototype.hasOwnProperty.call(o, k);

/** Resolves every profile key. `profile` and `node` are raw objects; `defaults` is settings.defaults. */
export function effectiveProfile(
  profile: Record<string, unknown>,
  defaults: ProfileDefaults = {},
  node: Record<string, unknown> = {},
): EffectiveProfile {
  const out: Record<string, Effective<unknown>> = {};
  for (const k of EFFECTIVE_KEYS) {
    if (k === "env") continue;
    if (has(node, k)) out[k] = { value: node[k], source: "node" };
    else if (has(profile, k)) out[k] = { value: profile[k], source: "profile" };
    else if (has(defaults, k)) out[k] = { value: defaults[k], source: "defaults" };
    else if (has(BUILTIN_DEFAULTS, k)) out[k] = { value: BUILTIN_DEFAULTS[k], source: "builtin" };
    else out[k] = { value: null, source: "builtin" };
  }
  const env = { ...(defaults.env ?? {}), ...((profile.env as object) ?? {}), ...((node.env as object) ?? {}) };
  const envSource: ValueSource = has(node, "env") ? "node" : has(profile, "env") ? "profile" : has(defaults, "env") ? "defaults" : "builtin";
  out["env"] = { value: env, source: envSource };
  return out as EffectiveProfile;
}
