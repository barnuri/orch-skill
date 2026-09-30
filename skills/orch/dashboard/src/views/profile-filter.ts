import type { ProfileSpec } from "../../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { PROFILES_HIDE_DISABLED_KEY } from "../constants";

export function loadHideDisabled(): boolean {
  try {
    return localStorage.getItem(PROFILES_HIDE_DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHideDisabled(hide: boolean): void {
  try {
    localStorage.setItem(PROFILES_HIDE_DISABLED_KEY, hide ? "1" : "0");
  } catch {
    // A blocked or full localStorage must not break the toggle for the session.
  }
}

export function visibleProfiles(
  profiles: ProfilesDocument["profiles"],
  hideDisabled: boolean,
): [string, ProfileSpec][] {
  const entries = Object.entries(profiles);
  return hideDisabled ? entries.filter(([, spec]) => spec.enabled !== false) : entries;
}
