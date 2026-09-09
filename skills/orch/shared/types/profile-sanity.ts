export interface ProfileSanityResult {
  profile: string;
  ok: boolean;
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
