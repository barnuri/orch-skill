import type { NodeView, RunView } from '../types'

type RawCost = {
  usd?: number
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_creation_tokens?: number
}

type RawNode = {
  id: string
  label?: string
  adapter?: string | null
  status?: string
  profile?: string | null
  model?: string | null
  model_id?: string | null
  attempts?: unknown[]
  cost?: RawCost | null
  error?: string | null
}

type RawRun = {
  run_id: string
  title?: string
  status?: string
  started?: string | null
  finished?: string | null
  harness_session?: string
  nodes?: RawNode[]
  edges?: [string, string][]
}

export type ProfileInfo = { harness: string; model: string }

export type Layering = { layer: Map<string, number>; cyclic: string[] }

// The dashboard's layering: 0 with no incoming edge, else 1 + the deepest dependency. A node
// still unplaced after one pass per node sits in a cycle; it drops to layer 0 with a badge.
export const layerOf = (ids: string[], edges: [string, string][]): Layering => {
  const known = new Set(ids)
  const incoming = new Map(ids.map(id => [id, [] as string[]]))
  for (const [from, to] of edges) if (known.has(from)) incoming.get(to)?.push(from)
  const layer = new Map<string, number>()
  for (let pass = 0; pass < ids.length; pass++) {
    for (const id of ids) {
      if (layer.has(id)) continue
      const deps = (incoming.get(id) ?? []).map(dep => layer.get(dep))
      if (deps.every(depth => depth !== undefined)) layer.set(id, Math.max(-1, ...(deps as number[])) + 1)
    }
  }
  const cyclic = ids.filter(id => !layer.has(id))
  for (const id of cyclic) layer.set(id, 0)

  return { layer, cyclic }
}

// fmtUsd + costOf from the dashboard: dollars when reported, else the token volume.
export const costText = (cost: RawCost | null | undefined): string | null => {
  if (!cost) return null
  const usd = cost.usd ?? 0
  if (Number.isFinite(usd) && usd > 0) return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
  const tokens =
    (cost.input_tokens ?? 0) + (cost.output_tokens ?? 0) + (cost.cache_read_tokens ?? 0) + (cost.cache_creation_tokens ?? 0)

  return tokens > 0 ? `${tokens.toLocaleString('en-US')} tok` : null
}

// `settings.max_attempts`: -1 retries forever; past the limit only a manual retry runs.
export const attemptText = (attempts: number, maxAttempts: number): string => {
  if (maxAttempts === -1) return `attempt ${attempts}/∞`
  if (attempts > maxAttempts) return `manual retry ${attempts}`

  return `attempt ${attempts}/${maxAttempts}`
}

export const durationText = (startIso: string | null, endMs: number): string => {
  const ms = startIso ? endMs - new Date(startIso).getTime() : NaN
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds - minutes * 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// `adapter` and the model are recorded at dispatch; a node not dispatched yet falls back to its
// profile's harness and model.
export const toRunView = (
  raw: RawRun,
  profiles: Record<string, ProfileInfo> = {},
  maxAttempts = 5,
  nowMs = Date.now(),
): RunView => {
  const nodes = raw.nodes ?? []
  const edges = (raw.edges ?? []).filter(edge => Array.isArray(edge) && edge.length === 2)
  const { layer, cyclic } = layerOf(
    nodes.map(node => node.id),
    edges,
  )
  const layers: NodeView[][] = []
  for (const node of nodes) {
    const profile = profiles[node.profile ?? '']
    const view: NodeView = {
      id: node.id,
      label: node.label || node.id,
      harness: node.adapter || profile?.harness || '',
      status: node.status ?? 'waiting',
      profile: node.profile || node.adapter || '-',
      model: node.model_id || node.model || profile?.model || '-',
      cost: costText(node.cost),
      attempt: attemptText((node.attempts?.length ?? 0) + 1, maxAttempts),
      after: edges.filter(([, to]) => to === node.id).map(([from]) => from),
      error: node.error ?? null,
      isCyclic: cyclic.includes(node.id),
    }
    ;(layers[layer.get(node.id) ?? 0] ??= []).push(view)
  }

  return {
    runId: raw.run_id,
    title: raw.title || raw.run_id,
    status: raw.status ?? 'running',
    started: raw.started ?? null,
    finished: raw.finished ?? null,
    session: raw.harness_session ?? '',
    elapsed: durationText(raw.started ?? null, raw.finished ? new Date(raw.finished).getTime() : nowMs),
    layers: layers.filter(Boolean),
  }
}

// The dashboard's run meta order: the statuses that need attention first.
export const STATUS_ORDER = ['running', 'error', 'done', 'skipped', 'waiting'] as const

export const statusCounts = (run: RunView): [string, number][] => {
  const nodes = run.layers.flat()

  return STATUS_ORDER.map(status => [status, nodes.filter(node => node.status === status).length] as [string, number]).filter(
    ([, count]) => count > 0,
  )
}

export const clockText = (iso: string | null): string => {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// Run ids are timestamp-prefixed, so a reverse name sort is newest first.
export const newestFirst = (names: string[]): string[] => [...names].sort().reverse()

// The orch skill loading, or a command that starts or advances a run, opens the pane.
export const isOrchSkill = (skill: string): boolean => /(^|:)orch$/.test(skill)
export const isOrchCommand = (command: string): boolean =>
  /dispatch\.sh\b|(^|[\s;&|])orch\s+(run|start|plan|node)\b/.test(command)

// A Link may only point at https or http://localhost, so a loopback or wildcard bind host is
// spelled `localhost`. The server lets any loopback peer in without a token.
export const runUrl = (base: string, runId: string): string => {
  const url = new URL(base)
  if (['127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(url.hostname)) url.hostname = 'localhost'
  url.hash = `#/run/${encodeURIComponent(runId)}`

  return url.href
}
