import { isOrchCommand, isOrchSkill } from '../hooks/graph'

type Part = { type?: string; name?: string; tool?: string; state?: { input?: Record<string, unknown> } }
type Message = { skills?: { name?: string }[]; content?: Part[]; parts?: Part[] }

const SKILL_TOOL = 'skill'
const SHELL_TOOLS = new Set(['bash', 'shell'])

/** Whether an opencode session used orch: a prompt with the orch skill, a skill call that loads it, or a shell call that runs it. */
export const usesOrch = (messages: readonly unknown[]): boolean =>
  (messages as readonly Message[]).some(message => {
    if ((message?.skills ?? []).some(skill => isOrchSkill(skill?.name ?? ''))) {
      return true
    }
    return [...(message?.content ?? []), ...(message?.parts ?? [])].some(part => {
      const tool = (part?.name ?? part?.tool ?? '').toLowerCase()
      const input = part?.state?.input ?? {}
      if (part?.type !== 'tool') {
        return false
      }
      if (tool === SKILL_TOOL) {
        return isOrchSkill(String(input['name'] ?? input['skill'] ?? ''))
      }
      return SHELL_TOOLS.has(tool) && isOrchCommand(String(input['command'] ?? ''))
    })
  })
