// Draws one run through the mod's own graph code into a terminal-styled page, then captures it
// from an already-running, visible Chrome over CDP. Driven by scripts/mod-screenshot.sh.
//
//   bun screenshot.ts --home=DIR --run=ID --port=P --out=FILE.png [--columns=N]

import { CdpSession } from '../../../skills/orch/scripts/lib/cdp-session'
import { drawGraph } from '../hooks/canvas'
import type { Span } from '../hooks/canvas'
import { STATUS_STYLE } from '../hooks/canvas'
import { clockText, runUrl, statusCounts, toRunView } from '../hooks/graph'
import type { ProfileInfo } from '../hooks/graph'

const NAMED: Record<string, string> = {
  gray: '#7f848e',
  yellow: '#e5c07b',
  green: '#98c379',
  red: '#e06c75',
  cyan: '#56b6c2',
}

const arg = (name: string): string => {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`))
  if (!hit) throw new Error(`missing --${name}`)

  return hit.slice(name.length + 3)
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// A terminal gives every glyph one cell; a browser draws symbols from a fallback font at its own
// width, which would push the rest of the row out of line. Pin each non-ASCII glyph to 1ch.
const cells = (text: string): string =>
  [...text].map(ch => (ch.charCodeAt(0) > 0x7e ? `<i>${ch}</i>` : escape(ch))).join('')

const spanHtml = (span: Span): string => {
  const style = [
    span.color ? `color:${NAMED[span.color] ?? span.color}` : '',
    span.bold ? 'font-weight:700' : '',
    span.dim ? 'opacity:.55' : '',
  ].filter(Boolean)

  return style.length ? `<span style="${style.join(';')}">${cells(span.text)}</span>` : cells(span.text)
}

type ProfilesDocument = {
  profiles?: Record<string, { harness?: string; model?: string }>
  settings?: { max_attempts?: number }
}

const home = arg('home')
const profiles: ProfilesDocument = JSON.parse(await Bun.file(`${home}/profiles.json`).text())
const raw = JSON.parse(await Bun.file(`${home}/runs/${arg('run')}/state.json`).text())
const run = toRunView(
  raw,
  Object.fromEntries(
    Object.entries(profiles.profiles ?? {}).map(([name, spec]) => [name, { harness: spec.harness ?? '', model: spec.model ?? '' }]),
  ),
  profiles.settings?.max_attempts ?? 5,
  // A fixed clock, so the picture does not change with the time it was taken.
  new Date(raw.started).getTime() + 754_000,
)
const columns = Number(process.argv.find(value => value.startsWith('--columns='))?.slice(10) ?? 250)
const nodes = run.layers.flat()
const tint = (status: string, text: string): string =>
  `<span style="color:${NAMED[STATUS_STYLE[status]?.color ?? 'gray'] ?? '#7f848e'}">${escape(text)}</span>`
const meta = [
  `<span style="opacity:.55">${escape(`run ${run.runId} · started ${clockText(run.started)} · elapsed ${run.elapsed}`)}</span>`,
  `<span style="opacity:.55">nodes ${nodes.length}</span>${statusCounts(run)
    .map(([status, count]) => tint(status, ` · ${status} ${count}`))
    .join('')}`,
].join('\n')
const graph = drawGraph(run, columns)
  .map(row => row.map(spanHtml).join(''))
  .join('\n')

const page = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; background: #16171d; font: 14px/1.25 Menlo, 'SF Mono', monospace; color: #d7dae0; }
  .term { display: inline-block; padding: 18px 22px 22px; }
  .prompt { color: #d7dae0; } .prompt b { color: #d97757; } .reply { color: #7f848e; margin: 2px 0 14px; }
  .pane { border: 1px solid #3a3d48; border-radius: 6px; padding: 10px 14px 12px; }
  .tab { color: #7f848e; margin-bottom: 8px; } .tab b { color: #d7dae0; }
  pre { margin: 0; font: inherit; }
  pre i { display: inline-block; width: 1ch; font-style: normal; text-align: center; overflow: visible; }
</style><div class="term">
<div class="prompt"><b>&gt;</b> /orch-graph</div>
<div class="reply">  ⎿  orch graph opened.</div>
<div class="pane"><div class="tab">pane · <b>orch graph</b></div><pre><b>${escape(run.title)}</b>${tint(run.status, `  ${run.status}`)}
${meta}
<span style="color:#d97757">o</span>: open in dashboard  <span style="opacity:.55;text-decoration:underline">${escape(runUrl('http://127.0.0.1:6724/', run.runId))}</span>  <span style="color:#d97757">r</span>: retry failed nodes

${graph}</pre></div></div>`

const pagePath = `${home}/orch-graph.html`
await Bun.write(pagePath, page)

const session = await CdpSession.attach(Number(arg('port')), 20_000)
try {
  await session.setViewport(1600, 900)
  await session.navigate(`file://${pagePath}`)
  await Bun.sleep(800)
  const size = (await session.evaluate(
    "(() => { const r = document.querySelector('.term').getBoundingClientRect(); return [Math.ceil(r.width), Math.ceil(r.height)] })()",
  )) as [number, number]
  await session.setViewport(size[0], size[1])
  await Bun.sleep(300)
  await Bun.write(arg('out'), await session.screenshot())
} finally {
  session.close()
}
