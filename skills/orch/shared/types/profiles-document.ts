import type { ProfileSpec } from "./profile-spec";
import type { ProfilesSettings } from "./profiles-settings";

export interface ProfilesDocument {
  settings: ProfilesSettings;
  profiles: Record<string, ProfileSpec>;
}
