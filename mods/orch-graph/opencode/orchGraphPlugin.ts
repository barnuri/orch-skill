import { join } from 'node:path'
import type { GraphView } from '../types'
import { STATUS_STYLE, drawGraph } from '../hooks/canvas'
import { clockText, statusCounts } from '../hooks/graph'
import type { OrchGraphContext, TuiElement, TuiRuntime } from './orchGraphContext'
import { OrchRunSource } from './orchRunSource'

/**
 * The orch graph drawn inside opencode: the run summary in the sidebar and the DAG in the session panel.
 * The herdr pane version is the herdr-mods mod in `mod.ts`. Polled from state.json.
 */
export class OrchGraphPlugin {
  private static readonly COMMAND = 'orch-graph'
  private static readonly POLL_MS = 2000
  private static readonly RUNNING = 'running'
  private static readonly ERROR = 'error'

  private readonly state: ReturnType<OrchGraphContext['storage']['memory']>
  private readonly source = new OrchRunSource()
  private readonly loadedAt = Date.now()
  private pinned = ''
  private isOpened = false
  private last = ''

  constructor(
    private readonly context: OrchGraphContext,
    private readonly runtime: TuiRuntime,
  ) {
    this.state = context.storage.memory(OrchGraphPlugin.COMMAND, { initial: { view: { run: null, error: null, dashboard: null } } })
  }

  register(): () => void {
    const timer = setInterval(() => void this.refresh(), OrchGraphPlugin.POLL_MS)
    void this.refresh()
    const releases = [
      this.context.ui.slot({ append: 'sidebar.content', render: () => this.column(() => this.summaryLines()) }),
      this.context.ui.slot({ append: 'session.panel', render: input => this.column(() => (input.name === OrchGraphPlugin.COMMAND ? this.graphLines(input.width) : [])) }),
      this.context.ui.slot({ append: 'app', render: () => this.registerCommand() }),
    ]
    return () => {
      clearInterval(timer)
      for (const release of releases) {
        release()
      }
    }
  }

  private column(lines: () => TuiElement[]): TuiElement {
    return this.runtime.jsx('box', {
      style: { flexDirection: 'column', width: '100%' },
      get children() {
        return lines()
      },
    })
  }

  // Running loops and monitors, one line each. Shown whenever any exist, even with no run on screen.
  private activeLines(): TuiElement[] {
    const active = this.state[0].view.active ?? []
    if (active.length === 0) {
      return []
    }
    return [
      this.runtime.jsx('text', { fg: 'gray', children: `active · ${active.length}` }),
      ...active.map(item =>
        this.runtime.jsx('text', {
          fg: item.status === 'running' ? (item.kind === 'loop' ? 'cyan' : 'magenta') : 'red',
          children: `${item.kind === 'loop' ? '↻' : '◉'} ${item.name} · ${item.line}`,
        }),
      ),
    ]
  }

  private summaryLines(): TuiElement[] {
    const { run, error, dashboard } = this.state[0].view
    if (!this.isShown(run?.status, run?.started)) {
      return this.activeLines()
    }
    if (!run) {
      return [this.runtime.jsx('text', { fg: 'gray', children: error ?? 'No orch runs yet.' })]
    }
    const nodes = run.layers.flat()
    const counts = statusCounts(run).map(([status, count]) => `${status} ${count}`).join(' · ')
    const timing = run.finished ? `finished ${clockText(run.finished)} (${run.elapsed})` : `elapsed ${run.elapsed}`
    const actions = ['/orch-graph: graph', dashboard ? '/orch-graph open' : '/orch-graph open (starts the dashboard)', nodes.some(node => node.status === OrchGraphPlugin.ERROR) ? '/orch-graph retry' : '']
      .filter(action => action !== '')
      .join('  ')
    return [
      this.runtime.jsx('text', { fg: STATUS_STYLE[run.status]?.color, children: `orch · ${run.title}  ${run.status}` }),
      this.runtime.jsx('text', { fg: 'gray', children: `run ${run.runId} · started ${clockText(run.started)} · ${timing}` }),
      this.runtime.jsx('text', { fg: 'gray', children: `nodes ${nodes.length}${counts ? ` · ${counts}` : ''}${run.session ? ` · session ${run.session}` : ''}` }),
      this.runtime.jsx('text', { fg: 'gray', children: actions }),
      ...this.activeLines(),
    ]
  }

  private graphLines(width: number): TuiElement[] {
    const { run } = this.state[0].view
    if (!run) {
      return [this.runtime.jsx('text', { fg: 'gray', children: 'No orch runs yet.' })]
    }
    return [
      ...this.summaryLines(),
      this.runtime.jsx('text', { children: ' ' }),
      ...drawGraph(run, width).map(row =>
        this.runtime.jsx('box', {
          style: { flexDirection: 'row', overflow: 'hidden' },
          children: row.length === 0
            ? [this.runtime.jsx('text', { children: ' ' })]
            : row.map(span => this.runtime.jsx('text', { fg: span.dim ? 'gray' : span.color, flexShrink: 0, children: span.text })),
        }),
      ),
    ]
  }

  // Like the Claude pane, the graph shows once orch is in use: a running run, a run started in this session, or /orch-graph.
  private isShown(status: string | undefined, started: string | null | undefined): boolean {
    if (this.isOpened || status === OrchGraphPlugin.RUNNING) {
      return true
    }
    const startedAt = started ? Date.parse(started) : Number.NaN
    return Number.isFinite(startedAt) && startedAt >= this.loadedAt
  }

  // A keymap layer lives as long as the reactive owner that created it, so it is created inside a slot render.
  private registerCommand(): null {
    this.context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: OrchGraphPlugin.COMMAND,
          title: 'orch graph',
          group: 'Session',
          description: 'Show the active orch run graph in the sidebar (a run id to pin, "latest" to unpin, "open" for the dashboard, "retry" for failed nodes)',
          palette: true,
          slash: { name: OrchGraphPlugin.COMMAND, arguments: true },
          run: (input?: string) => void this.command(input ?? ''),
        },
      ],
    }))
    return null
  }

  private async command(input: string): Promise<void> {
    const word = input.trim()
    const runId = this.state[0].view.run?.runId
    if (word === 'open' || word === 'retry') {
      if (!runId) {
        this.toast('No orch run to act on.')
        return
      }
      const message = word === 'open' ? await this.source.openInDashboard(runId) : await this.source.retryFailed(runId)
      if (message) {
        this.toast(message)
      }
      await this.refresh()
      return
    }
    this.pinned = word === 'latest' ? '' : word
    this.isOpened = true
    await this.refresh()
    this.setView({ ...this.state[0].view })
    this.context.ui.panel.open(OrchGraphPlugin.COMMAND, { presentation: 'panel' })
    this.toast(this.pinned ? `orch graph pinned to ${this.pinned}.` : 'orch graph opened.')
  }

  private async refresh(): Promise<void> {
    const next: GraphView = await this.source.read(this.pinned)
    const serial = JSON.stringify(next)
    if (serial === this.last) {
      return
    }
    this.last = serial
    this.setView(next)
  }

  // The host's store is the reactive source the sidebar render reads.
  private setView(next: GraphView): void {
    this.state[1](draft => {
      draft.view = next
    })
  }

  private toast(message: string): void {
    this.context.ui.toast.show({ title: 'orch graph', message, variant: 'info' })
  }
}
