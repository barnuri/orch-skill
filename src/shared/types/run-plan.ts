/** What `orch plan` / `plan apply` recorded on a planned run. */
export interface RunPlan {
  node: string;
  profile?: string;
  /** When the plan's tasks were added as nodes; null while the planner is still working. */
  applied: string | null;
  summary: string | null;
  tasks: number;
}
