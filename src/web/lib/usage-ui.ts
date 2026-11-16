import { choiceFromUsage, harnessUsage, profileUsage, type Use, type UsageChoice } from "../../shared/profile-usage";
import type { ProfilesDocument } from "../../shared/types/profiles-document";

export type UsageFilter = "all" | Use;
export const USAGE_FILTERS: ReadonlyArray<{ id: UsageFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chat" },
  { id: "runs", label: "Orch runs" },
];
export const USE_LABEL: Readonly<Record<Use, string>> = { chat: "Chat", runs: "Orch runs" };

const doc = (d: ProfilesDocument) => d as unknown as Parameters<typeof profileUsage>[0];

/** What a profile's chip shows for one use: on only when the profile and its harness allow it; `lock` names why a harness blocks it. */
export function profileUseState(d: ProfilesDocument, name: string, use: Use): { on: boolean; own: boolean; lock: string | null } {
  const harness = d.profiles[name]?.harness ?? "";
  const own = profileUsage(doc(d), name).includes(use);
  const blocked = !harnessUsage(doc(d), harness).includes(use);
  const lock = blocked ? `${USE_LABEL[use]} is off for the ${harness} harness. Change it on the Harnesses page.` : null;
  return { on: own && !blocked, own, lock };
}

export function harnessUseOn(d: ProfilesDocument | null, id: string, listed: readonly Use[] | undefined, use: Use): boolean {
  return (d === null ? (listed ?? ["chat", "runs"]) : harnessUsage(doc(d), id)).includes(use);
}

/** The choice to save when `use` is switched to `on`, or null when that would leave both uses off. */
export function nextChoice(current: readonly Use[], use: Use, on: boolean): UsageChoice | null {
  const next = new Set(current);
  if (on) next.add(use);
  else next.delete(use);
  if (next.size === 0) return null;
  return choiceFromUsage([...next]);
}

export function usageBadge(uses: readonly Use[]): string | null {
  if (uses.length >= 2) return null;
  return uses[0] === "chat" ? "Chat only" : "Orch runs only";
}
