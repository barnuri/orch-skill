import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GraphView } from '../types'
import { STATUS_STYLE, drawGraph } from './canvas'
import { clockText, isOrchCommand, isOrchSkill, newestFirst, runUrl, statusCounts, toRunView } from './graph'
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

// `serve status --json` is read-only; asked at most every 15 s, not on every poll.
async function dashboard($: EngineInterface, isForced = false): Promise<string | null> {
  const now = await $.clock.now()
  if (!isForced && now - dashboardCheckedAt < DASHBOARD_RECHECK_MS) return dashboardBase
  dashboardCheckedAt = now
  const status = await $.process
    .run(['bash', dispatchPath($), 'serve', 'status', '--json'], { env: { HARNESS_ORCH_HOME: await resolveHome($) } })
    .catch(() => null)
  const parsed = status ? (JSON.parse(status.stdout || '{}') as { healthy?: boolean; url?: string }) : {}
  dashboardBase = parsed.healthy && parsed.url ? parsed.url : null

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

// Once per load: closing the pane afterwards keeps it closed.
async function autoOpen($: EngineInterface): Promise<void> {
  if (isAutoOpened) return
  isAutoOpened = true
  await refresh($)
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
    const chosen = parsed.find(run => run.status === 'running') ?? parsed[0]
    const base = await dashboard($)
    const { profiles, maxAttempts } = await readProfiles($)
    next = chosen
      ? { run: toRunView(chosen, profiles, maxAttempts, await $.clock.now()), error: null, dashboard: base && runUrl(base, chosen.run_id) }
      : { run: null, error: want ? `run ${want} not found` : null, dashboard: null }
  } catch (error) {
    next = { run: null, error: String(error), dashboard: null }
  }
  const serial = JSON.stringify(next)
  if (serial === last) return
  last = serial
  await update($, view, () => next)
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
    await $.ui.open({ id: PANE, title: 'orch graph' })

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
    const { run, error, dashboard: href } = await read($, view)
    if (!run) return <Text dimColor>{error ?? 'No orch runs yet.'}</Text>

    const nodes = run.layers.flat()
    const hasFailed = nodes.some(node => node.status === 'error')
    const columns = e.component === 'Pane' ? e.props.bodyColumns : 120

    // The dashboard's run meta: id, start, elapsed or finish, node counts by status, session.
    return (
      <Box flexDirection="column">
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
