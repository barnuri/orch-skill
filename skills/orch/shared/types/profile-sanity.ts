export const SANITY_STATUSES = ["ok", "failed", "unconfigured", "disabled", "unknown"] as const;

export type SanityStatus = (typeof SANITY_STATUSES)[number];

export interface ProfileSanityResult {
  profile: string;
  /** True only for `ok`. Kept alongside `status` so existing callers keep working. */
  ok: boolean;
  /**
   * Why the probe ended as it did. `unconfigured` means the profile is fine but the env or
   * auth it declares is not set, so nothing was ever dispatched — that is not a failure.
   * Optional: a result produced before this field existed has none.
   */
  status?: SanityStatus;
  ms: number;
  harness: string;
  model_id: string;
  slug: string;
  exit_code: number;
  bytes: number;
  error: string;
}

export interface ProfileSanityEnvelope {
  generated_at: string;
  results: ProfileSanityResult[];
}
