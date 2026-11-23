import type { RunSummary } from "./run-summary";

export interface ApiCacheInfo {
  mode: "cache" | "bypass";
  source: "hit" | "miss" | "fresh";
  age_ms: number;
}

export interface RunsEnvelope {
  generated_at: string;
  runs: RunSummary[];
  cache?: ApiCacheInfo;
}
