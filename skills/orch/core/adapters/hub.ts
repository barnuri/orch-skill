// llm-hub native mode helpers. Ported from lib/adapters/hub.sh: the pure profile and role lookups.
// Network calls (hub setup, resolve, status probe) are not ported yet. Bun built-ins only.
import type { Catalog } from "./routing.ts";

export const HUB_MODE = "smart-auto";
export const HUB_PROFILE_SUFFIX = "-smart-auto";
export const SMART_AUTO_TIERS = "efficiency balance intelligence fast".split(" ");
export const HUB_ROLE_TIERS_DEFAULT: Record<string, string> = {
  planning: "intelligence",
  investigation: "balance",
  implementation: "balance",
  validation: "efficiency",
  conversation: "fast",
};

export function hubModeOn(cat: Catalog): boolean {
  return (cat.settings?.llm_hub?.mode ?? "") === HUB_MODE;
}

// The profile every hub-mode node runs on unless it names its own.
export function hubProfile(cat: Catalog): string {
  return `${cat.settings?.llm_hub?.harness || "opencode"}${HUB_PROFILE_SUFFIX}`;
}

// The tier for a role: the configured value when it is a tier, else the default ("" for no role).
export function hubRoleTier(cat: Catalog, role: string): string {
  if (role === "") return "";
  const tier = cat.settings?.llm_hub?.role_tiers?.[role] ?? "";
  if (SMART_AUTO_TIERS.includes(tier)) return tier;
  return HUB_ROLE_TIERS_DEFAULT[role] ?? "";
}
