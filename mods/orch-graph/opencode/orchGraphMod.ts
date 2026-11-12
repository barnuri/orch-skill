import type { GraphView } from '../types'
import { OrchRunSource } from './orchRunSource'

/** The herdr-mods host API a mod gets inside opencode (the subset this mod uses). */
interface ModHostApi {
  publish(key: string, state: unknown): Promise<void>
  openPane(key: string, options?: { readonly isForced?: boolean }): Promise<boolean>
}

/**
 * The orch-graph mod for herdr-mods: polls the orch runs, publishes the active one, and opens the
 * graph pane beside opencode when a run starts in this session (or on `/orch-graph`).
 */
export class OrchGraphMod {
  static readonly ID = 'orch-graph'
  static readonly PANE_KEY = 'run'
  private static readonly POLL_MS = 2000
  private static readonly RUNNING = 'running'

  private readonly source = new OrchRunSource()
  private readonly loadedAt = Date.now()
  private pinned = ''
  private last = ''

  constructor(private readonly api: ModHostApi) {}

  /** The `HerdrMod` definition; `viewModule` is the absolute path of the pane view. */
  static definition(viewModule: string) {
    let instance: OrchGraphMod | null = null
    return {
      id: OrchGraphMod.ID,
      pane: { module: viewModule },
      command: {
        name: OrchGraphMod.ID,
        description: 'Show the orch run graph beside opencode (a run id to pin, "latest" to unpin, "open" for the dashboard, "retry" for failed nodes)',
        run: (args: string) => instance?.command(args),
      },
      setup: (api: ModHostApi) => {
        instance = new OrchGraphMod(api)
        return instance.start()
      },
    }
  }

  start(): () => void {
    const timer = setInterval(() => void this.refresh(false), OrchGraphMod.POLL_MS)
    void this.refresh(false)
    return () => clearInterval(timer)
  }

  async command(args: string): Promise<string | void> {
    if (args === 'open' || args === 'retry') {
      const { run } = await this.source.read(this.pinned)
      if (!run) {
        return 'No orch run to act on.'
      }
      return (args === 'open' ? await this.source.openInDashboard(run.runId) : await this.source.retryFailed(run.runId)) ?? undefined
    }
    this.pinned = args === 'latest' ? '' : args
    await this.refresh(true)
    const isOpen = await this.api.openPane(OrchGraphMod.PANE_KEY, { isForced: true })
    if (!isOpen) {
      return 'The orch graph pane did not open.'
    }
    return this.pinned ? `orch graph pinned to ${this.pinned}.` : undefined
  }

  private async refresh(isForced: boolean): Promise<void> {
    const view: GraphView = await this.source.read(this.pinned)
    const serial = JSON.stringify({ view, pinned: this.pinned })
    if (isForced || serial !== this.last) {
      this.last = serial
      await this.api.publish(OrchGraphMod.PANE_KEY, { view, pinned: this.pinned })
    }
    if (view.run && this.isActive(view.run.status, view.run.started)) {
      await this.api.openPane(OrchGraphMod.PANE_KEY)
    }
  }

  // Like the Claude mod, the graph opens once orch is in use: a running run, or a run started since opencode started.
  private isActive(status: string, started: string | null): boolean {
    if (status === OrchGraphMod.RUNNING) {
      return true
    }
    const startedAt = started ? Date.parse(started) : Number.NaN
    return Number.isFinite(startedAt) && startedAt >= this.loadedAt
  }
}
