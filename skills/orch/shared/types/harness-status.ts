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
}

export interface HarnessesEnvelope {
  probed_at: string;
  harnesses: HarnessStatus[];
}
