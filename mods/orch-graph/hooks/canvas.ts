import type { NodeView, RunView } from '../types'

// A character-grid drawing of the run graph, laid out like the dashboard's: one column per
// layer left to right, an `orch` node feeding the entry nodes, and arrows into each node.

export type Style = { color?: string; bold?: boolean; dim?: boolean }
export type Span = { text: string } & Style
export type Row = Span[]

type Cell = { ch: string; style: Style; links: number }

const N = 1
const E = 2
const S = 4
const W = 8

// Joins by which neighbours a line cell touches; rounded corners like the dashboard's curves.
const LINE: Record<number, string> = {
  [N | S]: '│',
  [E | W]: '─',
  [E | S]: '╭',
  [W | S]: '╮',
  [N | E]: '╰',
  [N | W]: '╯',
  [N | E | S]: '├',
  [N | W | S]: '┤',
  [E | W | S]: '┬',
  [N | E | W]: '┴',
  [N | E | S | W]: '┼',
  [N]: '│',
  [S]: '│',
  [E]: '─',
  [W]: '─',
}

export const HARNESS_GLYPH: Record<string, { glyph: string; color: string }> = {
  claude: { glyph: '✻', color: '#d97757' },
  'cursor-agent': { glyph: '◆', color: '#e8eaf0' },
  codex: { glyph: '◎', color: '#9b8cd8' },
  gemini: { glyph: '✦', color: '#8e75b2' },
  copilot: { glyph: '◉', color: '#e8eaf0' },
  opencode: { glyph: '❯', color: '#7aa2f7' },
  'local-llm': { glyph: '▣', color: '#7dcfff' },
  pi: { glyph: 'π', color: '#c0caf5' },
  aider: { glyph: '∞', color: '#9ece6a' },
}
const UNKNOWN_GLYPH = { glyph: '○', color: 'gray' }
const UNKNOWN_GLYPH_STATUS = { icon: '?', color: 'gray' }

export const STATUS_STYLE: Record<string, { icon: string; color: string }> = {
  waiting: { icon: '○', color: 'gray' },
  running: { icon: '●', color: 'yellow' },
  done: { icon: '✓', color: 'green' },
  error: { icon: '✗', color: 'red' },
  skipped: { icon: '⊘', color: 'gray' },
}

// The dashboard's profile hues, assigned by index in the run's sorted profile list so no two
// profiles in one graph share a colour.
const PROFILE_HUES = [212, 32, 168, 328, 96, 268, 8, 188, 48, 288, 142, 358]

const hslToHex = (hue: number, saturation: number, lightness: number): string => {
  const s = saturation / 100
  const l = lightness / 100
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))
      .toString(16)
      .padStart(2, '0')

  return `#${channel(0)}${channel(8)}${channel(4)}`
}

export const profileColors = (profiles: string[]): Map<string, string> =>
  new Map(
    [...new Set(profiles)]
      .sort()
      .map((name, index) => [name, hslToHex(PROFILE_HUES[index % PROFILE_HUES.length] ?? 212, 58, 60)]),
  )

const BOX_H = 6
const GAP_Y = 1
const GAP_X = 7
const MIN_BOX_W = 18
const MAX_BOX_W = 30
const SESSION_MAX = 14

const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

class Canvas {
  readonly cells: Cell[][] = []

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    for (let y = 0; y < height; y++) {
      this.cells.push(Array.from({ length: width }, () => ({ ch: ' ', style: {}, links: 0 })))
    }
  }

  text(x: number, y: number, text: string, style: Style): void {
    const row = this.cells[y]
    if (!row) return
    ;[...text].forEach((ch, offset) => {
      const cell = row[x + offset]
      if (cell) Object.assign(cell, { ch, style, links: 0 })
    })
  }

  box(x: number, y: number, w: number, h: number, style: Style): void {
    this.text(x, y, `╭${'─'.repeat(w - 2)}╮`, style)
    for (let row = y + 1; row < y + h - 1; row++) {
      this.text(x, row, '│', style)
      this.text(x + w - 1, row, '│', style)
    }
    this.text(x, y + h - 1, `╰${'─'.repeat(w - 2)}╯`, style)
  }

  private link(x: number, y: number, links: number, style: Style): void {
    const cell = this.cells[y]?.[x]
    if (!cell || (cell.links === 0 && cell.ch !== ' ')) return
    cell.links |= links
    cell.ch = LINE[cell.links] ?? '┼'
    cell.style = style
  }

  hline(x1: number, x2: number, y: number, style: Style): void {
    const [from, to] = x1 <= x2 ? [x1, x2] : [x2, x1]
    for (let x = from; x <= to; x++) this.link(x, y, (x > from ? W : 0) | (x < to ? E : 0), style)
  }

  vline(x: number, y1: number, y2: number, style: Style): void {
    const [from, to] = y1 <= y2 ? [y1, y2] : [y2, y1]
    for (let y = from; y <= to; y++) this.link(x, y, (y > from ? N : 0) | (y < to ? S : 0), style)
  }

  rows(): Row[] {
    return this.cells.map(row => {
      const spans: Row = []
      for (const cell of row) {
        const last = spans[spans.length - 1]
        if (last && last.color === cell.style.color && last.bold === cell.style.bold && last.dim === cell.style.dim) {
          last.text += cell.ch
        } else {
          spans.push({ text: cell.ch, ...cell.style })
        }
      }
      const tail = spans[spans.length - 1]
      if (tail) tail.text = tail.text.trimEnd()

      return spans.filter(span => span.text !== '')
    })
  }
}

type Placed = { node: NodeView; x: number; y: number }

const metricsWidth = (node: NodeView): number => (node.cost?.length ?? 0) + node.attempt.length + 5

const boxWidthFor = (run: RunView, columns: number, orchW: number): number => {
  const longest = Math.max(
    ...run.layers.flat().map(node => Math.max(node.label.length + 8, node.profile.length + 4, metricsWidth(node))),
  )
  const wanted = Math.min(MAX_BOX_W, Math.max(MIN_BOX_W, longest))
  const fits = Math.floor((columns - orchW - GAP_X) / run.layers.length) - GAP_X

  return Math.max(MIN_BOX_W, Math.min(wanted, fits))
}

/** Draws the run into rows of styled spans, sized to `columns` where it can be. */
export const drawGraph = (run: RunView, columns: number): Row[] => {
  const session = run.session ? clip(run.session, SESSION_MAX) : ''
  const orchW = session ? SESSION_MAX + 4 : 8
  const orchH = session ? 4 : 3
  const boxW = boxWidthFor(run, columns, orchW)
  const colors = profileColors(run.layers.flat().map(node => node.profile))
  // The stage labels take the top two rows once there is more than one stage.
  const top = run.layers.length > 1 ? 2 : 0
  const tallest = Math.max(...run.layers.map(layer => layer.length * (BOX_H + GAP_Y) - GAP_Y))
  const columnX = (index: number) => orchW + GAP_X + index * (boxW + GAP_X)
  const placed = new Map<string, Placed>()
  run.layers.forEach((layer, index) => {
    const offset = Math.floor((tallest - (layer.length * (BOX_H + GAP_Y) - GAP_Y)) / 2)
    layer.forEach((node, row) => placed.set(node.id, { node, x: columnX(index), y: top + offset + row * (BOX_H + GAP_Y) }))
  })

  const all = [...placed.values()]
  const edges: [Placed | null, Placed][] = []
  for (const target of all) {
    if (target.node.after.length === 0) edges.push([null, target])
    for (const from of target.node.after) {
      const source = placed.get(from)
      if (source) edges.push([source, target])
    }
  }
  // An edge that skips a layer runs along its own lane under the graph, never through a box.
  const isLong = ([source, target]: [Placed | null, Placed]) => source !== null && target.x - source.x > boxW + GAP_X
  const lanes = edges.filter(isLong).length
  const bottom = top + tallest
  const canvas = new Canvas(columnX(run.layers.length), bottom + (lanes > 0 ? lanes + 1 : 0))

  if (top > 0) {
    run.layers.forEach((layer, index) => {
      const label = layer.length > 1 ? `stage ${index + 1} · ${layer.length} parallel` : `stage ${index + 1}`
      canvas.text(columnX(index) + 1, 0, clip(label, boxW - 1), { dim: true })
    })
  }

  const orchY = top + Math.max(0, Math.floor((tallest - orchH) / 2))
  canvas.box(0, orchY, orchW, orchH, { color: 'cyan' })
  canvas.text(2, orchY + 1, 'orch', { color: 'cyan', bold: true })
  if (session) canvas.text(2, orchY + 2, session, { dim: true })

  let lane = bottom + 1
  for (const edge of edges) {
    const [source, target] = edge
    const node = source?.node
    const style: Style =
      node?.status === 'running' || (!node && target.node.status === 'running') ? { color: 'yellow' } : { dim: true }
    const startX = source ? source.x + boxW : orchW
    const startY = source ? source.y + 2 : orchY + 1
    const endX = target.x - 2
    const endY = target.y + 2
    const busX = target.x - Math.ceil(GAP_X / 2)
    if (isLong(edge)) {
      const outX = startX + 1
      canvas.hline(startX, outX, startY, style)
      canvas.vline(outX, startY, lane, style)
      canvas.hline(outX, busX, lane, style)
      canvas.vline(busX, lane, endY, style)
      lane += 1
    } else {
      canvas.hline(startX, busX, startY, style)
      canvas.vline(busX, startY, endY, style)
    }
    canvas.hline(busX, endX, endY, style)
    canvas.text(target.x - 1, endY, '▶', style.color ? style : { color: 'gray' })
  }

  for (const { node, x, y } of all) {
    const status = STATUS_STYLE[node.status] ?? UNKNOWN_GLYPH_STATUS
    const harness = HARNESS_GLYPH[node.harness] ?? UNKNOWN_GLYPH
    const inner = boxW - 4
    const badge = node.isCyclic ? 'cycle ' : ''
    canvas.box(x, y, boxW, BOX_H, { color: status.color, bold: node.status === 'running' })
    // Row 1: harness, label, status. Row 2: profile. Row 3: `status · model`, or the error.
    // Row 4: cost on the left, the attempt on the right, as the dashboard's metrics row.
    canvas.text(x + 2, y + 1, harness.glyph, { color: harness.color, bold: true })
    canvas.text(x + 4, y + 1, clip(node.label, inner - 4 - badge.length), { bold: true })
    if (badge) canvas.text(x + boxW - 3 - badge.length, y + 1, badge, { color: 'magenta' })
    canvas.text(x + boxW - 3, y + 1, status.icon, { color: status.color, bold: true })
    canvas.text(x + 2, y + 2, clip(node.profile, inner), { color: colors.get(node.profile) })
    canvas.text(
      x + 2,
      y + 3,
      clip(`${node.status} · ${node.error ?? node.model}`, inner),
      node.status === 'error' ? { color: 'red' } : { dim: true },
    )
    // The cost keeps its width; a tight box shortens `attempt 2/5` to `2/5` first.
    const isTight = (node.cost?.length ?? 0) + node.attempt.length + 1 > inner
    const attempt = isTight ? node.attempt.replace(/^attempt /, '').replace(/^manual retry /, 'retry ') : node.attempt
    if (node.cost) canvas.text(x + 2, y + 4, clip(node.cost, inner - attempt.length - 1), { color: 'green' })
    canvas.text(x + boxW - 2 - attempt.length, y + 4, attempt, { dim: true })
  }

  return canvas.rows()
}
