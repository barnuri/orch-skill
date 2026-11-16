/**
 * Where a profile or harness may be used: `chat` (the chat page) and/or `runs` (orch runs, nodes, loops,
 * schedules, the planner). A missing value means both, so older profiles.json files keep working.
 * A profile is available for a use only when the profile AND its harness allow it and the harness is not disabled.
 */

export const USAGE_VALUES = ["chat", "runs"] as const;
export type Use = (typeof USAGE_VALUES)[number];
export type UsageChoice = Use | "both";

export const USAGE_CHOICES: readonly UsageChoice[] = ["chat", "runs", "both"];

interface UsageDoc {
  settings?: { disabled_harnesses?: string[]; harness_usage?: Record<string, unknown> };
  defaults?: { usage?: unknown };
  profiles?: Record<string, { harness?: string; usage?: unknown } | undefined>;
}

function clean(value: unknown): Use[] | null {
  if (!Array.isArray(value)) return null;
  const uses = USAGE_VALUES.filter((u) => value.includes(u));
  return uses.length === 0 ? null : uses;
}

export function usageFromChoice(choice: UsageChoice): Use[] {
  return choice === "both" ? [...USAGE_VALUES] : [choice];
}

export function choiceFromUsage(uses: readonly Use[]): UsageChoice {
  return uses.length === 2 ? "both" : (uses[0] ?? "both");
}

/** The uses a harness allows (settings.harness_usage); both when unset. */
export function harnessUsage(doc: UsageDoc, harness: string): Use[] {
  return clean(doc.settings?.harness_usage?.[harness]) ?? [...USAGE_VALUES];
}

/** The uses a profile allows by itself: its `usage`, else defaults.usage, else both. */
export function profileUsage(doc: UsageDoc, name: string): Use[] {
  return clean(doc.profiles?.[name]?.usage) ?? clean(doc.defaults?.usage) ?? [...USAGE_VALUES];
}

/** Why a profile cannot be used for `use`, or null when it can. Names the setting to change. */
export function usageRefusal(doc: UsageDoc, name: string, use: Use): string | null {
  const p = doc.profiles?.[name];
  if (p === undefined) return null;
  const only = use === "chat" ? "runs-only" : "chat-only";
  const harness = p.harness ?? "";
  if (!profileUsage(doc, name).includes(use)) {
    return `profile ${name} is ${only} (profiles.${name}.usage); run \`dispatch.ts profile set-usage ${name} both\` or change it on the Profiles page`;
  }
  if (!harnessUsage(doc, harness).includes(use)) {
    return `harness ${harness} is ${only} (settings.harness_usage.${harness}); run \`dispatch.ts harness set-usage ${harness} both\` or change it on the Harnesses page`;
  }
  return null;
}

export function profileAllowedFor(doc: UsageDoc, name: string, use: Use): boolean {
  const p = doc.profiles?.[name];
  if (p === undefined) return false;
  return usageRefusal(doc, name, use) === null && !(doc.settings?.disabled_harnesses ?? []).includes(p.harness ?? "");
}
