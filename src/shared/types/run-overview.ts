/** The run overview from `dispatch.ts run overview <run> --json`. Mirrors skills/orch/core/commands/overview.ts (RunOverview). */
export interface OverviewRepo { repo: string; nodes: string[]; commits: number }
export interface OverviewCommit { repo: string; sha: string; subject: string }
export interface OverviewPull { repo: string; url: string }
export interface OverviewCount { name: string; nodes: number }
export interface OverviewNode { id: string; label: string; status: string; profile: string; model: string; repo: string; skills: string[] }
export interface OverviewHandoff { id: string; status: string; state: "yes" | "empty" | "missing"; bytes: number; file: string }

export interface RunOverview {
  run_id: string;
  title: string;
  description: string | null;
  status: string;
  started: string | null;
  finished: string | null;
  generated_at: string;
  node_count: number;
  repos: OverviewRepo[];
  commits: OverviewCommit[];
  pull_requests: OverviewPull[];
  pull_requests_unavailable: string[];
  models: OverviewCount[];
  skills: OverviewCount[];
  nodes: OverviewNode[];
  handoffs: OverviewHandoff[];
}
