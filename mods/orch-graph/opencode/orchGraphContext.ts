import type { GraphView } from '../types'

/** An OpenTUI element built by the host's Solid runtime. */
export type TuiElement = unknown

/** OpenTUI's `jsx`, loaded from the one copy every opencode plugin shares. */
export interface TuiRuntime {
  readonly jsx: (type: string, props: Record<string, unknown>) => TuiElement
}

interface OrchGraphCommand {
  readonly id: string
  readonly title: string
  readonly group: string
  readonly description: string
  readonly palette: true
  readonly slash: { readonly name: string; readonly arguments: true }
  readonly run: (input?: string) => void
}

/** The narrow slice of opencode 2's TUI plugin `Context` the orch graph uses. */
export interface OrchGraphContext {
  readonly options?: Readonly<Record<string, unknown>>
  readonly storage: {
    memory(key: string, options: { readonly initial: { view: GraphView } }): readonly [{ readonly view: GraphView }, (mutation: (draft: { view: GraphView }) => void) => void]
  }
  readonly keymap: { layer(factory: () => { readonly mode: 'global'; readonly commands: readonly OrchGraphCommand[] }): void }
  readonly ui: {
    readonly slot: (claim: {
      readonly append: 'sidebar.content' | 'app' | 'session.panel'
      readonly render: (input: { readonly name: string; readonly width: number }) => TuiElement | null
    }) => () => void
    readonly panel: { open(name: string, options?: { readonly presentation?: 'panel' | 'fullscreen' }): boolean }
    readonly toast: { show(toast: { readonly title?: string; readonly message: string; readonly variant: 'info' }): void }
  }
}
