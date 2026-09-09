export interface ProfileSpec {
  harness: string;
  model?: string;
  flags?: string[];
  env?: Record<string, string>;
  auth?: string[];
}
