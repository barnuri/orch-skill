import { expect, test } from 'claude-code/testing'
import { usesOrch } from './orchUse'

const tool = (name: string, input: Record<string, unknown>) => ({ type: 'tool', name, state: { status: 'completed', input } })

test('usesOrch: a session that never touched orch does not use it', async () => {
  expect(usesOrch([{ type: 'user', text: 'fix the bug' }, { type: 'assistant', content: [tool('bash', { command: 'git status' })] }])).toBe(false)
})

test('usesOrch: a skill call that loads orch uses it', async () => {
  expect(usesOrch([{ type: 'assistant', content: [tool('skill', { name: 'orch' })] }])).toBe(true)
})

test('usesOrch: a prompt that invokes the orch skill uses it', async () => {
  expect(usesOrch([{ type: 'user', skills: [{ name: 'orch' }] }])).toBe(true)
})

test('usesOrch: a shell call that runs dispatch.sh uses it', async () => {
  expect(usesOrch([{ type: 'assistant', content: [tool('bash', { command: 'bash skills/orch/scripts/dispatch.sh run advance r1' })] }])).toBe(true)
})

test('usesOrch: another skill does not count', async () => {
  expect(usesOrch([{ type: 'assistant', content: [tool('skill', { name: 'orchestrate-thing' })] }])).toBe(false)
})

test('usesOrch: malformed messages are ignored', async () => {
  expect(usesOrch([null, 'x', { content: [null] }])).toBe(false)
})
