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

const BOX_H = 5
const GAP_Y = 1
const GAP_X = 7
const ORCH_W = 8
const ORCH_H = 3
const MIN_BOX_W = 16
const MAX_BOX_W = 28

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

const boxWidthFor = (run: RunView, columns: number): number => {
  const longest = Math.max(...run.layers.flat().map(node => Math.max(node.label.length + 6, node.profile.length + 4)))
  const wanted = Math.min(MAX_BOX_W, Math.max(MIN_BOX_W, longest))
  const layers = run.layers.length
  const fits = Math.floor((columns - ORCH_W - GAP_X) / layers) - GAP_X

  return Math.max(MIN_BOX_W, Math.min(wanted, fits))
}

const costText = (cost: number | null): string => (cost === null ? '' : ` · $${cost.toFixed(cost < 1 ? 3 : 2)}`)

/** Draws the run into rows of styled spans, sized to `columns` where it can be. */
export const drawGraph = (run: RunView, columns: number): Row[] => {
  const boxW = boxWidthFor(run, columns)
  const colors = profileColors(run.layers.flat().map(node => node.profile))
  const tallest = Math.max(...run.layers.map(layer => layer.length * (BOX_H + GAP_Y) - GAP_Y))
  const placed = new Map<string, Placed>()
  run.layers.forEach((layer, index) => {
    const x = ORCH_W + GAP_X + index * (boxW + GAP_X)
    const top = Math.floor((tallest - (layer.length * (BOX_H + GAP_Y) - GAP_Y)) / 2)
    layer.forEach((node, row) => placed.set(node.id, { node, x, y: top + row * (BOX_H + GAP_Y) }))
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
  const width = ORCH_W + GAP_X + run.layers.length * (boxW + GAP_X)
  const canvas = new Canvas(width, tallest + (lanes > 0 ? lanes + 1 : 0))

  const orchY = Math.max(0, Math.floor((tallest - ORCH_H) / 2))
  canvas.box(0, orchY, ORCH_W, ORCH_H, { color: 'cyan' })
  canvas.text(2, orchY + 1, 'orch', { color: 'cyan', bold: true })

  let lane = tallest + 1
  for (const edge of edges) {
    const [source, target] = edge
    const node = source?.node
    const style: Style =
      node?.status === 'running' || (!node && target.node.status === 'running') ? { color: 'yellow' } : { dim: true }
    const startX = source ? source.x + boxW : ORCH_W
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
    canvas.box(x, y, boxW, BOX_H, { color: status.color, bold: node.status === 'running' })
    canvas.text(x + 2, y + 1, harness.glyph, { color: harness.color, bold: true })
    canvas.text(x + 4, y + 1, clip(node.label, inner - 4), { bold: true })
    canvas.text(x + boxW - 3, y + 1, status.icon, { color: status.color, bold: true })
    canvas.text(x + 2, y + 2, clip(node.profile, inner), { color: colors.get(node.profile) })
    const meta = `${node.model}${costText(node.cost)}${node.attempts > 1 ? ` · ×${node.attempts}` : ''}`
    canvas.text(x + 2, y + 3, clip(node.error ?? meta, inner), node.error ? { color: 'red' } : { dim: true })
  }

  return canvas.rows()
}
