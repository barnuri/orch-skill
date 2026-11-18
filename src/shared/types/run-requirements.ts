/** One requirement of a run's ledger (`<run>/requirements.json`) with the facts of its linked nodes. */
export interface RequirementNodeFacts {
  id: string;
  status: string;
  done: boolean;
  handoff: boolean;
  unverified: boolean;
}

export interface RequirementView {
  id: string;
  text: string;
  status: string;
  reason: string | null;
  ok: boolean;
  nodes: RequirementNodeFacts[];
  evidence: Array<{ note: string; file: string | null; test: string | null; at: string }>;
}

export interface RunRequirementsEnvelope {
  generated_at: string;
  requirements: RequirementView[];
}
