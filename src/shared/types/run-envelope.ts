import type { RunState } from "./run-state";

export interface RunEnvelope {
  generated_at: string;
  run: RunState;
}
