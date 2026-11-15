import type { RunSummary } from "./run-summary";

export interface RunsEnvelope {
  generated_at: string;
  runs: RunSummary[];
}
