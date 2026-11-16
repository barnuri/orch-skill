export interface HarnessStatus {
  id: string;
  kind: "cli" | "http";
  binary: string | null;
  /** True when orch has a dispatch adapter for this harness (profiles may reference it). */
  wired: boolean;
  description: string;
  needs: string[];
  available: boolean;
  reason: string;
  enabled: boolean;
  /** Where the harness may be used (settings.harness_usage); missing means both. */
  usage?: Array<"chat" | "runs">;
}

export interface HarnessesEnvelope {
  probed_at: string;
  harnesses: HarnessStatus[];
}
