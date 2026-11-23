import type { Suggestion } from "../../shared/types/suggestion";
import type { SuggestionApplyEnvelope } from "../../shared/types/suggestion-apply-envelope";

export const ALL_VALUE = "";
export const DEFAULT_FILTERS = { status: "pending", kind: ALL_VALUE, confidence: ALL_VALUE } as const;

export interface SuggestionFilters {
  status: string;
  kind: string;
  confidence: string;
}

const AUTO_APPLY_KINDS: ReadonlySet<string> = new Set(["memory_record", "profile_description", "model_description"]);

export const kindLabel = (kind: string): string => kind.replaceAll("_", " ");

export function filtersActive(f: SuggestionFilters): boolean {
  return f.status !== DEFAULT_FILTERS.status || f.kind !== ALL_VALUE || f.confidence !== ALL_VALUE;
}

export function matchesFilters(item: Suggestion, f: SuggestionFilters): boolean {
  return (
    (f.status === ALL_VALUE || item.status === f.status) &&
    (f.kind === ALL_VALUE || item.kind === f.kind) &&
    (f.confidence === ALL_VALUE || item.confidence === f.confidence)
  );
}

export function kindOptions(items: readonly Suggestion[], catalog: readonly string[]): string[] {
  const seen = new Set<string>([...catalog, ...items.map((item) => item.kind)]);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export const pendingCount = (items: readonly Suggestion[]): number => items.filter((s) => s.status === "pending").length;

export const isApplicable = (item: Suggestion): boolean => item.status === "pending" && AUTO_APPLY_KINDS.has(item.kind);

// Pending first, then newest.
export function sortSuggestions(list: readonly Suggestion[]): Suggestion[] {
  return [...list].sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") {
      return -1;
    }
    if (b.status === "pending" && a.status !== "pending") {
      return 1;
    }
    // Learned `orch-fix` entries have no `created`; they sort last instead of crashing the page.
    return (b.created ?? "").localeCompare(a.created ?? "");
  });
}

export function previewText(item: Suggestion): string | null {
  if (item.kind === "profile_description" || item.kind === "model_description") {
    const desc = item.action.description;
    return typeof desc === "string" && desc !== "" ? desc : null;
  }
  if (item.kind === "memory_record" && item.action.memory !== undefined) {
    const mem = item.action.memory;
    const parts = [mem.profile, mem.outcome, mem.task_kind, mem.note].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : null;
  }
  return null;
}

export function applyToastFor(result: SuggestionApplyEnvelope): { kind: "ok" | "error"; text: string } {
  const reason = result.results.find((r) => !r.ok && r.error)?.error;
  if (result.failed === 0) {
    return { kind: "ok", text: result.applied === 1 ? "Applied" : `Applied ${result.applied}` };
  }
  if (result.applied === 0) {
    return { kind: "error", text: result.failed === 1 ? (reason ?? "Apply failed") : `${result.failed} failed${reason ? `: ${reason}` : ""}` };
  }
  return { kind: "error", text: `Applied ${result.applied}, ${result.failed} failed${reason ? `: ${reason}` : ""}` };
}
