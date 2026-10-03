import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GraphView } from '../types'
import { drawGraph } from './canvas'
import { isOrchCommand, isOrchSkill, newestFirst, toRunView } from './graph'
import type { ProfileInfo } from './graph'

const PANE = 'orch-graph'
const POLL_MS = 2000
const SCAN = 5
const view = atom({ plugin: 'orch-graph', key: 'view' } as const, { run: null, error: null } as GraphView)
const pinned = atom({ plugin: 'orch-graph', key: 'pinned' } as const, '')

let home = ''
let last = ''
let isAutoOpened = false

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

// profiles.json gives each profile's harness and model, for nodes not yet dispatched.
async function profileInfo($: EngineInterface): Promise<Record<string, ProfileInfo>> {
  const text = await $.fs.read(`${await resolveHome($)}/profiles.json`).catch(() => '{}')
  const document = JSON.parse(text)
  const profiles: Record<string, { harness?: string; model?: string }> = document.profiles ?? {}
  const models: Record<string, { slug?: string }> = document.models ?? {}

  return Object.fromEntries(
    Object.entries(profiles).map(([name, spec]) => [
      name,
      { harness: spec.harness ?? '', model: models[spec.model ?? '']?.slug ?? spec.model ?? '' },
    ]),
  )
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
    next = chosen ? { run: toRunView(chosen), error: null } : { run: null, error: want ? `run ${want} not found` : null }
  } catch (error) {
    next = { run: null, error: String(error) }
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
    const { Box, Text } = $.ui.resolve(e)
    const { run, error } = await read($, view)
    if (!run) return <Text dimColor>{error ?? 'No orch runs yet.'}</Text>

    const nodes = run.layers.flat()
    const done = nodes.filter(node => node.status === 'done').length
    const columns = e.component === 'Pane' ? e.props.bodyColumns : 120

    return (
      <Box flexDirection="column">
        <Text bold>{run.title}</Text>
        <Text dimColor>
          {run.runId} · {run.status} · {done}/{nodes.length} done
        </Text>
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
