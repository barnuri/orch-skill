import type { NodeView, RunView } from '../types'

type RawNode = {
  id: string
  status?: string
  profile?: string
  model?: string | null
  attempts?: unknown[]
  cost?: number | null
  error?: string | null
}

type RawRun = {
  run_id: string
  title?: string
  status?: string
  nodes?: RawNode[]
  edges?: [string, string][]
}

export const STATUS_COLOR: Record<string, string> = {
  waiting: 'gray',
  running: 'yellow',
  done: 'green',
  error: 'red',
  skipped: 'gray',
}

// Longest path from a root decides the layer, so every node sits below all its parents.
// A cycle (never produced by `node add --after`) is cut after one pass per node.
export const layerOf = (ids: string[], edges: [string, string][]): Map<string, number> => {
  const layer = new Map(ids.map(id => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    let isMoved = false
    for (const [from, to] of edges) {
      const next = (layer.get(from) ?? 0) + 1
      if (layer.has(to) && next > (layer.get(to) ?? 0)) {
        layer.set(to, next)
        isMoved = true
      }
    }
    if (!isMoved) break
  }

  return layer
}

export const toRunView = (raw: RawRun): RunView => {
  const nodes = raw.nodes ?? []
  const edges = (raw.edges ?? []).filter(edge => Array.isArray(edge) && edge.length === 2)
  const layer = layerOf(
    nodes.map(node => node.id),
    edges,
  )
  const layers: NodeView[][] = []
  for (const node of nodes) {
    const view: NodeView = {
      id: node.id,
      status: node.status ?? 'waiting',
      profile: node.profile ?? '-',
      model: node.model ?? '-',
      attempts: (node.attempts?.length ?? 0) + 1,
      cost: typeof node.cost === 'number' ? node.cost : null,
      after: edges.filter(([, to]) => to === node.id).map(([from]) => from),
      error: node.error ?? null,
    }
    const at = layer.get(node.id) ?? 0
    ;(layers[at] ??= []).push(view)
  }

  return {
    runId: raw.run_id,
    title: raw.title ?? raw.run_id,
    status: raw.status ?? 'running',
    layers: layers.filter(Boolean),
  }
}

// Run ids are timestamp-prefixed, so a reverse name sort is newest first.
export const newestFirst = (names: string[]): string[] => [...names].sort().reverse()

// The orch skill loading, or a command that starts or advances a run, opens the pane.
export const isOrchSkill = (skill: string): boolean => /(^|:)orch$/.test(skill)
export const isOrchCommand = (command: string): boolean =>
  /dispatch\.sh\b|(^|[\s;&|])orch\s+(run|start|plan|node)\b/.test(command)
