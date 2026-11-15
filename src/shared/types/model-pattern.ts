/** Trailing-* prefix pattern or exact catalog id / slug match for profile allowed_models. */

export function modelAllowEntryMatches(
  entry: string,
  catalogId: string,
  slug: string,
): boolean {
  if (entry.endsWith("*")) {
    const prefix = entry.slice(0, -1);
    if (prefix.length === 0) {
      return true;
    }
    return catalogId.startsWith(prefix) || slug.startsWith(prefix);
  }
  return entry === catalogId || entry === slug;
}

export function isAllowedModelPattern(entry: string): boolean {
  return entry.endsWith("*");
}

/** Characters allowed in an allowed_models entry (id, slug fragment, or trailing *). */
const ALLOWED_MODEL_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._/-]*(\*)?$/;

export function isValidAllowedModelEntry(entry: string, maxLen: number): boolean {
  if (entry.length === 0 || entry.length > maxLen || entry === "*") {
    return false;
  }
  if (!ALLOWED_MODEL_ENTRY.test(entry)) {
    return false;
  }
  if (entry.includes("*") && !entry.endsWith("*")) {
    return false;
  }
  return true;
}
