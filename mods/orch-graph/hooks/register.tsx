import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GraphView } from '../types'
import { STATUS_STYLE, drawGraph } from './canvas'
import { clockText, isLiveRun, isOrchCommand, isOrchSkill, newestFirst, runUrl, statusCounts, toActiveViews, toRunView } from './graph'
import type { ProfileInfo } from './graph'

const PANE = 'orch-graph'
const POLL_MS = 2000
const SCAN = 5
const view = atom({ plugin: 'orch-graph', key: 'view' } as const, { run: null, error: null, dashboard: null } as GraphView)
const pinned = atom({ plugin: 'orch-graph', key: 'pinned' } as const, '')

let home = ''
let last = ''
let isAutoOpened = false
let dashboardBase: string | null = null
let dashboardCheckedAt = 0
const DASHBOARD_RECHECK_MS = 15_000

function dispatchPath($: EngineInterface): string {
  return `${$.plugin.root}/../../skills/orch/scripts/dispatch.sh`
}

// Probes the server's port file and `/api/health` directly (`serve status --json` takes ~4 s and
// reports stale after a `src/` edit). Asked at most every 15 s, not on every poll.
async function dashboard($: EngineInterface, isForced = false): Promise<string | null> {
  const now = await $.clock.now()
  if (!isForced && now - dashboardCheckedAt < DASHBOARD_RECHECK_MS) return dashboardBase
  dashboardCheckedAt = now
  const script =
    'p=$(cat "$HARNESS_ORCH_HOME/serve/port" 2>/dev/null); case "$p" in ""|*[!0-9]*) exit 1;; esac; ' +
    'c=$(curl -s -o /dev/null -m 2 -w "%{http_code}" "http://127.0.0.1:$p/api/health"); case "$c" in [1-9][0-9][0-9]) ;; *) exit 1;; esac; ' +
    't=""; grep -q "\\"require_token\\": *true" "$HARNESS_ORCH_HOME/serve.json" 2>/dev/null && t=$(cat "$HARNESS_ORCH_HOME/serve.token" 2>/dev/null); ' +
    'if [ -n "$t" ]; then printf "http://127.0.0.1:%s/?token=%s" "$p" "$t"; else printf "http://127.0.0.1:%s/" "$p"; fi'
  const status = await $.process
    .run(['bash', '-c', script], { env: { HARNESS_ORCH_HOME: await resolveHome($) }, timeoutMs: 5_000 })
    .catch(() => null)
  dashboardBase = status?.exitCode === 0 && status.stdout ? status.stdout.trim() : null

  return dashboardBase
}

// Starts the dashboard when it is down (`ui` reuses a running server), then opens the run.
async function openInDashboard($: EngineInterface, runId: string): Promise<void> {
  let base = await dashboard($, true)
  if (!base) {
    await $.process
      .run(['bash', dispatchPath($), 'ui'], {
        env: { HARNESS_ORCH_HOME: await resolveHome($), ORCH_NO_OPEN: '1' },
        timeoutMs: 60_000,
      })
      .catch(() => null)
    base = await dashboard($, true)
  }
  if (!base) {
    $.ui.toast('orch dashboard did not start; try `orch ui`')
    return
  }
  const url = runUrl(base, runId)
  const opened = await $.process
    .run(['sh', '-c', 'if command -v open >/dev/null; then open "$1"; else xdg-open "$1"; fi', 'sh', url])
    .catch(() => null)
  if (opened?.exitCode !== 0) $.ui.toast(`open ${url}`)
  await refresh($)
}

async function resolveHome($: EngineInterface): Promise<string> {
  if (home) return home
  const { stdout } = await $.process.run([
    'sh',
    '-c',
    'printf %s "${HARNESS_ORCH_HOME:-$HOME/.harness-orch}"',
  ])
  home = stdout

  return home
}

type ProfilesRead = { profiles: Record<string, ProfileInfo>; maxAttempts: number }

// profiles.json gives each profile's harness and model, for nodes not yet dispatched, and the
// retry limit the attempt counter is read against (the dashboard's default is 5).
async function readProfiles($: EngineInterface): Promise<ProfilesRead> {
  const text = await $.fs.read(`${await resolveHome($)}/profiles.json`).catch(() => '{}')
  const document = JSON.parse(text)
  const specs: Record<string, { harness?: string; model?: string }> = document.profiles ?? {}
  const limit = document.settings?.max_attempts
  const profiles = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [name, { harness: spec.harness ?? '', model: spec.model ?? '' }]),
  )

  return { profiles, maxAttempts: Number.isInteger(limit) && (limit === -1 || limit >= 1) ? limit : 5 }
}

// Running loops and monitors from `orch active --json`, the same reader the dashboard uses.
let activeCache: GraphView['active'] = []
let activeCheckedAt = 0
const ACTIVE_RECHECK_MS = 10_000

// Spawns a shell, so it is asked at most every 10 s, not on every 2 s poll.
async function readActive($: EngineInterface): Promise<GraphView['active']> {
  const now = await $.clock.now()
  if (now - activeCheckedAt < ACTIVE_RECHECK_MS) return activeCache
  activeCheckedAt = now
  activeCache = await fetchActive($)

  return activeCache
}

async function fetchActive($: EngineInterface): Promise<GraphView['active']> {
  const ran = await $.process
    .run(['bash', dispatchPath($), 'active', '--json'], { env: { HARNESS_ORCH_HOME: await resolveHome($) }, timeoutMs: 5_000 })
    .catch(() => null)
  try {
    return ran?.exitCode === 0 ? toActiveViews(JSON.parse(ran.stdout || '[]'), await $.clock.now()) : []
  } catch {
    return []
  }
}

// The dashboard's "Retry failed nodes", through the same subcommand its API calls.
async function retryFailed($: EngineInterface, runId: string): Promise<void> {
  const ran = await $.process
    .run(['bash', dispatchPath($), 'run', 'retry', runId], {
      env: { HARNESS_ORCH_HOME: await resolveHome($) },
      timeoutMs: 60_000,
    })
    .catch(() => null)
  $.ui.toast(ran?.exitCode === 0 ? `retrying failed nodes of ${runId}` : `retry failed: ${(ran?.stderr ?? '').trim().slice(0, 80)}`)
  await refresh($)
}

const HERDR_MODS_PLUGIN_ID = 'barnuri.mods'
const HERDR_MODS_VIEW = '../opencode/view.ts'
const HERDR_STATE_FILE = '.cache/herdr-mods/orch-graph/run.json'
const HERDR_PANE_KEY = 'run'
const HERDR_TIMEOUT_MS = 10000
let herdrModsRoot: string | null | undefined

// The herdr-mods plugin's folder (https://github.com/barnuri/herdr-mods), or null when it is not installed.
async function herdrModsPluginRoot($: EngineInterface): Promise<string | null> {
  if (herdrModsRoot !== undefined) return herdrModsRoot
  const listed = await $.process.run(['herdr', 'plugin', 'list', '--json'], { timeoutMs: HERDR_TIMEOUT_MS }).catch(() => null)
  const plugins = listed?.exitCode === 0 ? ((JSON.parse(listed.stdout || '{}') as { result?: { plugins?: { plugin_id?: string; plugin_root?: string }[] } }).result?.plugins ?? []) : []
  herdrModsRoot = plugins.find(plugin => plugin.plugin_id === HERDR_MODS_PLUGIN_ID)?.plugin_root ?? null
  return herdrModsRoot
}

// This Claude pane's herdr pane id, or null outside herdr or without the herdr-mods plugin.
async function herdrBesidePane($: EngineInterface): Promise<string | null> {
  if ((await $.env.get('HERDR_ENV')) !== '1') return null
  const paneId = await $.env.get('HERDR_PANE_ID')
  if (!paneId || (await herdrModsPluginRoot($)) === null) return null
  return paneId
}

// Inside herdr with herdr-mods, the graph runs in a herdr pane beside Claude (the orch-graph herdr mod's view).
async function openHerdrPane($: EngineInterface, isForced: boolean): Promise<boolean> {
  const besidePaneId = await herdrBesidePane($)
  const root = await herdrModsPluginRoot($)
  if (besidePaneId === null || root === null) return false
  await publishHerdrState($)
  await $.process
    .run(
      ['sh', `${root}/bin/bun.sh`, `${root}/bin/open.ts`, '--mod-id', PANE, '--view', `${$.plugin.root}/${HERDR_MODS_VIEW}`, '--key', HERDR_PANE_KEY, '--beside', besidePaneId, ...(isForced ? ['--force'] : ['--once'])],
      { timeoutMs: HERDR_TIMEOUT_MS },
    )
    .catch(() => null)
  return true
}

async function publishHerdrState($: EngineInterface): Promise<void> {
  const home = await $.env.get('HOME')
  if (home === undefined || (await herdrBesidePane($)) === null) return
  await $.fs.write(`${home}/${HERDR_STATE_FILE}`, JSON.stringify({ view: await read($, view), pinned: await read($, pinned) })).catch(() => undefined)
}

// Once per load: closing the pane afterwards keeps it closed.
async function autoOpen($: EngineInterface): Promise<void> {
  if (isAutoOpened) return
  isAutoOpened = true
  await refresh($)
  if (await openHerdrPane($, false)) return
  await $.ui.open({ id: PANE, title: 'orch graph' })
}

// Read-only: state.json is written by dispatch.sh alone.
async function refresh($: EngineInterface): Promise<void> {
  let next: GraphView
  try {
    const runs = `${await resolveHome($)}/runs`
    const want = await read($, pinned)
    const names = want
      ? [want]
      : newestFirst((await $.fs.list(runs)).filter(entry => entry.kind === 'dir').map(entry => entry.name)).slice(0, SCAN)
    const parsed = []
    for (const name of names) {
      const text = await $.fs.read(`${runs}/${name}/state.json`).catch(() => '')
      if (text) parsed.push(JSON.parse(text))
    }
    const chosen = parsed.find(isLiveRun) ?? parsed[0]
    const base = await dashboard($)
    const { profiles, maxAttempts } = await readProfiles($)
    next = chosen
      ? { run: toRunView(chosen, profiles, maxAttempts, await $.clock.now()), error: null, dashboard: base && runUrl(base, chosen.run_id) }
      : { run: null, error: want ? `run ${want} not found` : null, dashboard: null }
  } catch (error) {
    next = { run: null, error: String(error), dashboard: null }
  }
  next = { ...next, active: await readActive($) }
  const serial = JSON.stringify(next)
  if (serial === last) return
  last = serial
  await update($, view, () => next)
  await publishHerdrState($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'orch-graph',
      description: 'Show the active orch run graph in a pane (optional: a run id to pin, "latest" to unpin)',
    })
    $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'orch-graph' }, async ($, e) => {
    const arg = e.args.trim()
    await update($, pinned, () => (arg === 'latest' ? '' : arg || ''))
    await refresh($)
    if (!(await openHerdrPane($, true))) {
      await $.ui.open({ id: PANE, title: 'orch graph' })
    }

    return { text: arg && arg !== 'latest' ? `orch graph pinned to ${arg}.` : 'orch graph opened.' }
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const ran = await next(e)
    if (isOrchSkill(e.skill)) void autoOpen($)

    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (isOrchCommand(e.command)) void autoOpen($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const { run, error, dashboard: href, active = [] } = await read($, view)
    const activeRows = active.length === 0 ? null : (
      <Box flexDirection="column">
        <Text dimColor>{`active · ${active.length}`}</Text>
        {active.map(item => (
          <Text color={item.status === 'running' ? (item.kind === 'loop' ? 'cyan' : 'magenta') : 'red'}>
            {`${item.kind === 'loop' ? '↻' : '◉'} ${item.name} · ${item.line}`}
          </Text>
        ))}
        <Text> </Text>
      </Box>
    )
    if (!run) {
      return activeRows ? <Box flexDirection="column">{activeRows}</Box> : <Text dimColor>{error ?? 'No orch runs yet.'}</Text>
    }

    const nodes = run.layers.flat()
    const hasFailed = nodes.some(node => node.status === 'error')
    const columns = e.component === 'Pane' ? e.props.bodyColumns : 120

    // The dashboard's run meta: id, start, elapsed or finish, node counts by status, session.
    return (
      <Box flexDirection="column">
        {activeRows}
        <Text>
          <Text bold>{run.title}</Text>
          <Text color={STATUS_STYLE[run.status]?.color}>{`  ${run.status}`}</Text>
        </Text>
        <Text dimColor>
          {`run ${run.runId} · started ${clockText(run.started)} · `}
          {run.finished ? `finished ${clockText(run.finished)} (${run.elapsed})` : `elapsed ${run.elapsed}`}
        </Text>
        <Text>
          <Text dimColor>{`nodes ${nodes.length}`}</Text>
          {statusCounts(run).map(([status, count]) => (
            <Text color={STATUS_STYLE[status]?.color}>{` · ${status} ${count}`}</Text>
          ))}
          {run.session ? <Text dimColor>{` · session ${run.session}`}</Text> : null}
        </Text>
        <Box flexDirection="row">
          <Button hotkey="o" plain onPress={() => void openInDashboard($, run.runId)}>
            {href ? 'open in dashboard' : 'start dashboard and open'}
          </Button>
          {hasFailed && (
            <Button hotkey="r" plain onPress={() => void retryFailed($, run.runId)}>
              {'  retry failed nodes'}
            </Button>
          )}
          {href && (
            <Text dimColor>
              {'  '}
              <Link href={href}>{href}</Link>
            </Text>
          )}
        </Box>
        <Text> </Text>
        {drawGraph(run, columns).map(row => (
          <Text>
            {row.length === 0
              ? ' '
              : row.map(span => (
                  <Text color={span.color} bold={span.bold} dimColor={span.dim}>
                    {span.text}
                  </Text>
                ))}
          </Text>
        ))}
      </Box>
    )
  })
}
