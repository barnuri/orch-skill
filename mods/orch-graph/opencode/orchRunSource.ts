import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GraphView } from '../types'
import { isLiveRun, newestFirst, runUrl, toActiveViews, toRunView } from '../hooks/graph'
import type { ProfileInfo } from '../hooks/graph'

type ProfilesRead = { profiles: Record<string, ProfileInfo>; maxAttempts: number }
type ProcessResult = { exitCode: number; stdout: string; stderr: string }

/** The orch runs on disk and the dashboard: what the orch graph shows and the actions it offers. Read-only on state.json. */
export class OrchRunSource {
  private static readonly SCAN = 5
  private static readonly DASHBOARD_RECHECK_MS = 15_000
  private static readonly DEFAULT_MAX_ATTEMPTS = 5
  private static readonly ACTIVE_RECHECK_MS = 10_000
  private static readonly SCRIPT_TIMEOUT_MS = 60_000
  private static readonly STATUS_TIMEOUT_MS = 5_000

  private readonly home = process.env['HARNESS_ORCH_HOME'] || join(process.env['HOME'] ?? '', '.harness-orch')
  private readonly dispatchPath = join(import.meta.dir, '..', '..', '..', 'skills', 'orch', 'scripts', 'dispatch.sh')
  private dashboardBase: string | null = null
  private dashboardCheckedAt = 0
  private activeCheckedAt = 0
  private activeCache: GraphView['active'] = []

  /** The running run, else the newest one, or the pinned run id. */
  async read(pinned: string): Promise<GraphView> {
    const view = await this.readRun(pinned)
    return { ...view, active: await this.readActive() }
  }

  /** Running loops and monitors, from the one reader the dashboard uses too. Empty when the call fails. */
  private async readActive(): Promise<GraphView['active']> {
    // Spawns a shell, so it is asked at most every 10 s, not on every 2 s poll.
    const now = Date.now()
    if (now - this.activeCheckedAt < OrchRunSource.ACTIVE_RECHECK_MS) {
      return this.activeCache
    }
    this.activeCheckedAt = now
    this.activeCache = await this.fetchActive()
    return this.activeCache
  }

  private async fetchActive(): Promise<GraphView['active']> {
    const ran = await this.dispatch(['active', '--json'], OrchRunSource.STATUS_TIMEOUT_MS)
    try {
      return ran?.exitCode === 0 ? toActiveViews(JSON.parse(ran.stdout || '[]'), Date.now()) : []
    } catch {
      return []
    }
  }

  private async readRun(pinned: string): Promise<GraphView> {
    try {
      const runs = join(this.home, 'runs')
      const names = pinned ? [pinned] : newestFirst(await this.runNames(runs)).slice(0, OrchRunSource.SCAN)
      const parsed = []
      for (const name of names) {
        const text = await readFile(join(runs, name, 'state.json'), 'utf8').catch(() => '')
        if (text) {
          parsed.push(JSON.parse(text))
        }
      }
      const chosen = parsed.find(isLiveRun) ?? parsed[0]
      const base = await this.dashboard()
      const { profiles, maxAttempts } = await this.readProfiles()
      return chosen
        ? { run: toRunView(chosen, profiles, maxAttempts, Date.now()), error: null, dashboard: base && runUrl(base, chosen.run_id) }
        : { run: null, error: pinned ? `run ${pinned} not found` : null, dashboard: null }
    } catch (error) {
      return { run: null, error: String(error), dashboard: null }
    }
  }

  /** Starts the dashboard when it is down (`ui` reuses a running server), then opens the run. Returns a message when it could not. */
  async openInDashboard(runId: string): Promise<string | null> {
    let base = await this.dashboard(true)
    if (!base) {
      await this.dispatch(['ui'], OrchRunSource.SCRIPT_TIMEOUT_MS, { ORCH_NO_OPEN: '1' })
      base = await this.dashboard(true)
    }
    if (!base) {
      return 'orch dashboard did not start; try `orch ui`'
    }
    const url = runUrl(base, runId)
    const opened = await this.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', url], OrchRunSource.STATUS_TIMEOUT_MS)
    return opened?.exitCode === 0 ? null : `open ${url}`
  }

  /** The dashboard's "Retry failed nodes", through the same subcommand its API calls. */
  async retryFailed(runId: string): Promise<string> {
    const ran = await this.dispatch(['run', 'retry', runId], OrchRunSource.SCRIPT_TIMEOUT_MS)
    return ran?.exitCode === 0 ? `retrying failed nodes of ${runId}` : `retry failed: ${(ran?.stderr ?? '').trim().slice(0, 80)}`
  }

  private async runNames(runs: string): Promise<string[]> {
    if (!existsSync(runs)) {
      return []
    }
    const entries = await readdir(runs, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  // profiles.json gives each profile's harness and model, and the retry limit the attempt counter is read against.
  private async readProfiles(): Promise<ProfilesRead> {
    const text = await readFile(join(this.home, 'profiles.json'), 'utf8').catch(() => '{}')
    const document = JSON.parse(text)
    const specs: Record<string, { harness?: string; model?: string }> = document.profiles ?? {}
    const limit = document.settings?.max_attempts
    const profiles = Object.fromEntries(
      Object.entries(specs).map(([name, spec]) => [name, { harness: spec.harness ?? '', model: spec.model ?? '' }]),
    )
    const isValidLimit = Number.isInteger(limit) && (limit === -1 || limit >= 1)
    return { profiles, maxAttempts: isValidLimit ? limit : OrchRunSource.DEFAULT_MAX_ATTEMPTS }
  }

  // `serve status --json` is read-only; asked at most every 15 s, not on every poll.
  private async dashboard(isForced = false): Promise<string | null> {
    const now = Date.now()
    if (!isForced && now - this.dashboardCheckedAt < OrchRunSource.DASHBOARD_RECHECK_MS) {
      return this.dashboardBase
    }
    this.dashboardCheckedAt = now
    const status = await this.dispatch(['serve', 'status', '--json'], OrchRunSource.STATUS_TIMEOUT_MS)
    const parsed = status ? (JSON.parse(status.stdout || '{}') as { healthy?: boolean; url?: string }) : {}
    this.dashboardBase = parsed.healthy && parsed.url ? parsed.url : null
    return this.dashboardBase
  }

  private dispatch(args: readonly string[], timeoutMs: number, env: Record<string, string> = {}): Promise<ProcessResult | null> {
    return this.spawn(['bash', this.dispatchPath, ...args], timeoutMs, { HARNESS_ORCH_HOME: this.home, ...env })
  }

  private async spawn(argv: readonly string[], timeoutMs: number, env: Record<string, string> = {}): Promise<ProcessResult | null> {
    try {
      const child = Bun.spawn([...argv], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = setTimeout(() => child.kill(), timeoutMs)
      try {
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { exitCode, stdout, stderr }
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  }
}
