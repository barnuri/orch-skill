import type { ProfileSpec } from "../../../shared/types/profile-spec";
import type { ProfilesDocument } from "../../../shared/types/profiles-document";

export function visibleProfiles(
  profiles: ProfilesDocument["profiles"],
  hideDisabled: boolean,
): [string, ProfileSpec][] {
  const entries = Object.entries(profiles);
  return hideDisabled ? entries.filter(([, spec]) => spec.enabled !== false) : entries;
}
