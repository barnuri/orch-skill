import type { ModelSpec } from "./model-spec";
import type { ProfileSpec } from "./profile-spec";
import type { ProfilesSettings } from "./profiles-settings";

export interface ProfilesDocument {
  settings: ProfilesSettings;
  models: Record<string, ModelSpec>;
  profiles: Record<string, ProfileSpec>;
}
