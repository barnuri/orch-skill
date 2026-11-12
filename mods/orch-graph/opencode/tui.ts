import { join } from 'node:path'

import { OrchGraphPlugin } from './orchGraphPlugin'
import type { OrchGraphContext, TuiRuntime } from './orchGraphContext'

// opencode loads OpenTUI once per physical path; a second copy fails to load. So the runtime comes
// from the folder the other opencode plugins (harness-status-line) already load it from.
const RUNTIME_DIR = process.env['OPENCODE_TUI_RUNTIME_DIR'] || join(process.env['HOME'] ?? '', 'sandbox', 'private', 'harness-status-line')

async function loadRuntime(): Promise<TuiRuntime> {
  const runtime = await import(Bun.resolveSync('@opentui/solid/jsx-runtime', RUNTIME_DIR))
  return { jsx: runtime.jsx }
}

export default {
  id: 'orch-graph',
  async setup(context: OrchGraphContext): Promise<(() => void) | undefined> {
    try {
      return new OrchGraphPlugin(context, await loadRuntime()).register()
    } catch {
      /* never throw into the TUI — a broken graph must not take opencode down */
      return undefined
    }
  },
}
