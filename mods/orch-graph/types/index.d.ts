export type NodeView = {
  id: string
  label: string
  status: string
  harness: string
  profile: string
  model: string
  attempts: number
  cost: number | null
  after: string[]
  error: string | null
}

export type RunView = {
  runId: string
  title: string
  status: string
  layers: NodeView[][]
}

export type GraphView = { run: RunView | null; error: string | null }

declare module 'claude-code' {
  interface PluginState {
    'orch-graph': { view: GraphView; pinned: string }
  }
}
