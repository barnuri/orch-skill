import type { GraphView } from '../types'
import { STATUS_STYLE, drawGraph } from '../hooks/canvas'
import { clockText, statusCounts } from '../hooks/graph'
import { OrchRunSource } from './orchRunSource'

interface PaneUi {
  readonly elements: { readonly Box: string; readonly Text: string; readonly Button: string; readonly Link: string }
  readonly columns: number
  notice(message: string): void
}

type Node = { readonly type: string; readonly props: Record<string, unknown>; readonly children: readonly unknown[] }

const ERROR = 'error'
const source = new OrchRunSource()
const node = (type: string, props: Record<string, unknown>, ...children: unknown[]): Node => ({ type, props, children })

// The orch graph pane: run meta, "open in dashboard" and "retry failed nodes" buttons (o / r), then the DAG.
export default function view(state: { view: GraphView } | null, ui: PaneUi): unknown {
  const { Box, Text, Button } = ui.elements
  const run = state?.view.run
  if (!run) {
    return node(Text, { dimColor: true }, state?.view.error ?? 'No orch runs yet.')
  }
  const act = (action: () => Promise<string | null>) => () => void action().then(message => ui.notice(message ?? ''))
  const hasFailed = run.layers.flat().some(graphNode => graphNode.status === ERROR)
  const timing = run.finished ? `finished ${clockText(run.finished)} (${run.elapsed})` : `elapsed ${run.elapsed}`
  return node(
    Box,
    { flexDirection: 'column' },
    node(Text, {}, node(Text, { bold: true }, run.title), node(Text, { color: STATUS_STYLE[run.status]?.color }, `  ${run.status}`)),
    node(Text, { dimColor: true }, `run ${run.runId} · started ${clockText(run.started)} · ${timing}`),
    node(
      Text,
      {},
      node(Text, { dimColor: true }, `nodes ${run.layers.flat().length}`),
      ...statusCounts(run).map(([status, count]) => node(Text, { color: STATUS_STYLE[status]?.color }, ` · ${status} ${count}`)),
      run.session ? node(Text, { dimColor: true }, ` · session ${run.session}`) : null,
    ),
    node(
      Box,
      { flexDirection: 'row', columnGap: 2 },
      node(Button, { hotkey: 'o', onPress: act(() => source.openInDashboard(run.runId)) }, node(Text, { underline: true, color: 'cyan' }, state?.view.dashboard ? 'open in dashboard' : 'start dashboard and open')),
      hasFailed ? node(Button, { hotkey: 'r', onPress: act(() => source.retryFailed(run.runId)) }, node(Text, { underline: true, color: 'cyan' }, 'retry failed nodes')) : null,
    ),
    node(Text, {}, ' '),
    ...drawGraph(run, ui.columns).map(row =>
      node(Text, {}, ...(row.length === 0 ? [' '] : row.map(span => node(Text, { color: span.color, bold: span.bold, dimColor: span.dim }, span.text)))),
    ),
  )
}
