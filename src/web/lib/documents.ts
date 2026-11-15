import type { MemoryEntry } from "../../shared/types/memory-entry";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import type { SuggestionsDocument } from "../../shared/types/suggestions-document";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** profiles.json is an object with `settings` and `profiles`; anything else is a corrupt file. */
export function asProfilesDocument(value: unknown): ProfilesDocument | null {
  if (!isObject(value) || !isObject(value["profiles"]) || !isObject(value["settings"])) {
    return null;
  }
  return value as unknown as ProfilesDocument;
}

/** memory.json is an array of entries. */
export function asMemoryDocument(value: unknown): MemoryEntry[] | null {
  return Array.isArray(value) ? (value as MemoryEntry[]) : null;
}

export function asSuggestionsDocument(value: unknown): SuggestionsDocument | null {
  if (!isObject(value) || !Array.isArray(value["suggestions"])) {
    return null;
  }
  return value as unknown as SuggestionsDocument;
}
