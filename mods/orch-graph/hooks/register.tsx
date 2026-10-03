import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GraphView, NodeView } from '../types'
import { STATUS_COLOR, isOrchCommand, isOrchSkill, newestFirst, toRunView } from './graph'

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
    const card = (node: NodeView) => (
      <Box flexDirection="column" borderStyle="round" borderColor={STATUS_COLOR[node.status] ?? 'gray'} paddingX={1} marginRight={1}>
        <Text bold color={STATUS_COLOR[node.status]}>
          {node.id}
        </Text>
        <Text dimColor>
          {node.status} · {node.model}
          {node.attempts > 1 ? ` · try ${node.attempts}` : ''}
          {node.cost !== null ? ` · $${node.cost.toFixed(3)}` : ''}
        </Text>
        {node.after.length > 0 && <Text dimColor>after {node.after.join(', ')}</Text>}
        {node.error && <Text color="red">{node.error}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text bold>{run.title}</Text>
        <Text dimColor>
          {run.runId} · {run.status} · {done}/{nodes.length} done
        </Text>
        {run.layers.map((layer, index) => (
          <Box flexDirection="column">
            {index > 0 && <Text dimColor>  ↓</Text>}
            <Box flexDirection="row" flexWrap="wrap">
              {layer.map(card)}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
