import type { ModelSpec } from "../../shared/types/model-spec";
import { isAllowedModelPattern, modelAllowEntryMatches } from "../../shared/types/model-pattern";
import type { ProfileSpec } from "../../shared/types/profile-spec";

export type Models = Readonly<Record<string, ModelSpec>>;

export function modelIdsForHarness(models: Models, harness: string): string[] {
  return Object.entries(models)
    .filter(([, spec]) => spec.harnesses.includes(harness))
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

export function allowedByEntries(models: Models, entries: readonly string[], id: string): boolean {
  const slug = models[id]?.slug ?? "";
  return entries.some((entry) => modelAllowEntryMatches(entry, id, slug));
}

/**
 * Offers only what the profile's own `allowed_models` permits: the validator rejects a model outside
 * that list, so listing the rest just invites a save that 400s.
 */
export function selectableModelIds(models: Models, spec: ProfileSpec): string[] {
  const ids = modelIdsForHarness(models, spec.harness);
  const entries = spec.allowed_models;
  return entries === undefined || entries.length === 0 ? ids : ids.filter((id) => allowedByEntries(models, entries, id));
}

/** "Any model" ticked or cleared: any drops the list; clearing seeds it with the default model or the first one. */
export function setAnyModels(spec: ProfileSpec, useAny: boolean, ids: readonly string[]): string[] | undefined {
  if (useAny) {
    return undefined;
  }
  if (spec.allowed_models !== undefined) {
    return spec.allowed_models;
  }
  const defaultModel = spec.model ?? "";
  const first = ids[0] ?? "";
  return defaultModel !== "" && ids.includes(defaultModel) ? [defaultModel] : first !== "" ? [first] : [];
}

/**
 * One model ticked or cleared. Clearing a model a `prefix*` pattern covers expands the pattern into
 * the explicit ids it still allows, so the other models stay allowed.
 */
export function toggleAllowedModel(
  entries: readonly string[],
  id: string,
  checked: boolean,
  ids: readonly string[],
  models: Models,
): string[] {
  const patterns = entries.filter((entry) => isAllowedModelPattern(entry));
  const explicit = new Set(entries.filter((entry) => !isAllowedModelPattern(entry)));
  if (checked) {
    explicit.add(id);
  } else {
    explicit.delete(id);
    for (const pattern of patterns) {
      for (const other of ids) {
        if (other !== id && allowedByEntries(models, [pattern], other)) {
          explicit.add(other);
        }
      }
    }
  }
  return [...explicit].sort((a, b) => a.localeCompare(b));
}
