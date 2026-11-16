export type NodeView = {
  id: string
  label: string
  status: string
  harness: string
  profile: string
  model: string
  /** Smart Auto tier (`balance`, ...) when the hub picked the model, else null. */
  tier: string | null
  /** `$0.42`, `<$0.01` or `12,400 tok`, as the dashboard prints it; null when none was reported. */
  cost: string | null
  /** `attempt 2/5`, `attempt 2/∞` or `manual retry 6`. */
  attempt: string
  after: string[]
  error: string | null
  isCyclic: boolean
}

export type RunView = {
  runId: string
  title: string
  status: string
  started: string | null
  finished: string | null
  session: string
  /** Time since start while running, the run's length once finished. */
  elapsed: string
  layers: NodeView[][]
}

/** One running or needs-attention loop or monitor, summarized to a single line for a sidebar or pane. */
export type ActiveView = { kind: 'loop' | 'watch'; name: string; status: string; line: string }

// `dashboard` is the run's page on the orch dashboard, null while the server is not answering.
export type GraphView = { run: RunView | null; error: string | null; dashboard: string | null; active?: ActiveView[] }

declare module 'claude-code' {
  interface PluginState {
    'orch-graph': { view: GraphView; pinned: string }
  }
}
