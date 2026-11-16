// Coordinator state shown on the run page. Pure types: this file must stay free of Node and Bun imports.
export interface CoordinatorCandidate {
  socket_path: string;
  pane_id: string;
  workspace_id: string;
  cwd: string;
  session_id: string;
  agent: string;
}

export interface CoordinatorState {
  pane_id: string;
  reachable: boolean;
  unreachable_since: string | null;
  unreachable_reason: string | null;
  pending_asks: number;
  last_repoint: { at: string; from: string; to: string; reason: string } | null;
  candidates: CoordinatorCandidate[];
}
