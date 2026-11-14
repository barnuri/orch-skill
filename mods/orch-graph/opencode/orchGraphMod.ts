import type { GraphView } from '../types'
import { OrchRunSource } from './orchRunSource'
import { usesOrch } from './orchUse'

type SessionData = { session?: { message?: { list?: (sessionId: string) => readonly unknown[] } } }

/** The herdr-mods host API a mod gets inside opencode (the subset this mod uses). */
interface ModHostApi {
  readonly opencode: unknown
  currentSessionId(): string | undefined
  publish(key: string, state: unknown): Promise<void>
  openPane(key: string, options?: { readonly isForced?: boolean }): Promise<boolean>
}

/**
 * The orch-graph mod for herdr-mods: polls the orch runs, publishes the active one, and opens the
 * graph pane beside opencode once the session on screen uses orch (or on `/orch-graph`).
 */
export class OrchGraphMod {
  static readonly ID = 'orch-graph'
  static readonly PANE_KEY = 'run'
  private static readonly POLL_MS = 2000

  private readonly source = new OrchRunSource()
  private readonly orchSessions = new Set<string>()
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
    if (view.run && this.isOrchSession()) {
      await this.api.openPane(OrchGraphMod.PANE_KEY)
    }
  }

  // Like the Claude mod, the graph opens only once the session on screen uses orch. A run from another session never opens it.
  private isOrchSession(): boolean {
    const sessionId = this.api.currentSessionId()
    if (!sessionId) {
      return false
    }
    if (this.orchSessions.has(sessionId)) {
      return true
    }
    try {
      const messages = (this.api.opencode as { data?: SessionData } | null)?.data?.session?.message?.list?.(sessionId) ?? []
      if (usesOrch(messages)) {
        this.orchSessions.add(sessionId)
        return true
      }
    } catch {
      // opencode's message store is not ready; the next poll asks again.
    }
    return false
  }
}
