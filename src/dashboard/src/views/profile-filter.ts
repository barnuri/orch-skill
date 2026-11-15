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

/** The harnesses switched off in settings, as a set for quick lookups. */
export function disabledHarnessSet(profiles: ProfilesDocument): ReadonlySet<string> {
  return new Set(profiles.settings.disabled_harnesses ?? []);
}

/** Why a profile cannot run: it is switched off itself, or its harness is. `null` means it can. */
export type OffReason = "profile" | "harness";

export function offReason(spec: ProfileSpec, disabledHarnesses: ReadonlySet<string>): OffReason | null {
  if (disabledHarnesses.has(spec.harness)) {
    return "harness";
  }
  return spec.enabled === false ? "profile" : null;
}

export function visibleProfiles(
  profiles: ProfilesDocument["profiles"],
  hideDisabled: boolean,
  disabledHarnesses: ReadonlySet<string> = new Set(),
): [string, ProfileSpec][] {
  const entries = Object.entries(profiles);
  return hideDisabled ? entries.filter(([, spec]) => offReason(spec, disabledHarnesses) === null) : entries;
}
