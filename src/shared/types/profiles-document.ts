import type { ModelSpec } from "./model-spec";
import type { ProfileSpec } from "./profile-spec";
import type { ProfilesSettings } from "./profiles-settings";

export interface ProfilesDocument {
  settings: ProfilesSettings;
  /** The profile defaults. `max_parallel` is the global cap the effective cap reads first. */
  defaults?: { max_parallel?: number } & Record<string, unknown>;
  models: Record<string, ModelSpec>;
  profiles: Record<string, ProfileSpec>;
}
