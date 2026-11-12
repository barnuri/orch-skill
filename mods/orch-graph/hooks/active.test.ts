import { describe, expect, test } from 'bun:test'
import { toActiveViews } from './graph'

const NOW = Date.parse('2026-11-12T10:00:00Z')

describe('toActiveViews', () => {
  test('a loop reads as iteration and time to the next tick', () => {
    const [loop] = toActiveViews([{ kind: 'loop', name: 'ci-fix', status: 'running', iteration: 3, max: 20, next: NOW / 1000 + 250 }], NOW)
    expect(loop).toEqual({ kind: 'loop', name: 'ci-fix', status: 'running', line: '3/20 · next 4m' })
  })

  test('a loop with no maximum shows its iteration count', () => {
    const [loop] = toActiveViews([{ kind: 'loop', name: 'l', iteration: 7, max: 0, next: NOW / 1000 + 30 }], NOW)
    expect(loop?.line).toBe('iter 7 · next 30s')
  })

  test('a monitor reads as its event count', () => {
    const [watch] = toActiveViews([{ kind: 'watch', name: 'ci', status: 'running', events: 1 }], NOW)
    expect(watch?.line).toBe('1 event')
  })

  test('a failed or lost item carries its status as a flag', () => {
    const [lost] = toActiveViews([{ kind: 'watch', name: 'ci', status: 'lost', events: 2 }], NOW)
    expect(lost?.line).toBe('2 events [lost]')
  })

  test('anything that is not a loop or monitor row is dropped', () => {
    expect(toActiveViews([{ kind: 'job' }, null, 'x'], NOW)).toEqual([])
    expect(toActiveViews({ not: 'an array' }, NOW)).toEqual([])
  })
})
