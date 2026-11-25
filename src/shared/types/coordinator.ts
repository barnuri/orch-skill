// Orchestrator state shown on the run page. Legacy coordinator exports remain aliases.
export interface OrchestratorCandidate {
  transport?: "herdr" | "hc";
  socket_path: string;
  pane_id: string;
  workspace_id: string;
  cwd: string;
  session_id: string;
  agent: string;
}

export interface OrchestratorState {
  transport?: "herdr" | "hc" | "session";
  pane_id: string;
  /** The orchestrator's harness session id (run.coordinator.session_id); "" when unknown. */
  session_id?: string;
  harness?: string;
  model?: string | null;
  reachable: boolean;
  unreachable_since: string | null;
  unreachable_reason: string | null;
  pending_asks: number;
  last_repoint: { at: string; from: string; to: string; reason: string } | null;
  candidates: OrchestratorCandidate[];
}

export type CoordinatorCandidate = OrchestratorCandidate;
export type CoordinatorState = OrchestratorState;
