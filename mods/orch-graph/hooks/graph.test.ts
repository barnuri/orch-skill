import { expect, test } from 'claude-code/testing'

import {
  attemptText,
  costText,
  durationText,
  isOrchCommand,
  isOrchSkill,
  isLiveRun,
  isStaleRun,
  layerOf,
  newestFirst,
  runUrl,
  statusCounts,
  toRunView,
} from './graph'

test('a node sits one layer below its deepest parent', async () => {
  const { layer } = layerOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['a', 'c']])
  expect(layer.get('a')).toBe(0)
  expect(layer.get('b')).toBe(1)
  expect(layer.get('c')).toBe(2)
  expect(layer.get('d')).toBe(0)
})

test('a cycle drops to the first layer and is flagged', async () => {
  const { layer, cyclic } = layerOf(['a', 'b', 'c'], [['a', 'b'], ['b', 'a']])
  expect(cyclic).toEqual(['a', 'b'])
  expect(layer.get('a')).toBe(0)
  expect(layer.get('c')).toBe(0)
})

test('the run view groups nodes by layer and lists their parents', async () => {
  const run = toRunView({
    run_id: 'r1',
    title: 'demo',
    status: 'running',
    nodes: [
      { id: 'plan', status: 'done', model: 'sonnet', attempts: [{}] },
      { id: 'build', status: 'running' },
    ],
    edges: [['plan', 'build']],
  })
  expect(run.layers.length).toBe(2)
  expect(run.layers[0]?.[0]?.attempt).toBe('attempt 2/5')
  expect(run.layers[1]?.[0]?.after).toEqual(['plan'])
  expect(run.layers[1]?.[0]?.model).toBe('-')
})

test('a running run whose nodes all finished is stale, not live', async () => {
  const finished = { run_id: 'r1', status: 'running', nodes: [{ id: 'a', status: 'done' }, { id: 'b', status: 'error' }] }
  expect(isStaleRun(finished)).toBe(true)
  expect(isLiveRun(finished)).toBe(false)
  expect(toRunView(finished).status).toBe('stale')
  expect(isLiveRun({ run_id: 'r2', status: 'running', nodes: [{ id: 'a', status: 'done' }, { id: 'b', status: 'waiting' }] })).toBe(true)
  expect(isLiveRun({ run_id: 'r3', status: 'running', nodes: [] })).toBe(true)
  expect(isLiveRun({ run_id: 'r4', status: 'done', nodes: [{ id: 'a', status: 'done' }] })).toBe(false)
})

test('run ids sort newest first', async () => {
  expect(newestFirst(['20260930-1', '20261001-1', '20260101-1'])[0]).toBe('20261001-1')
})

test('the orch skill and run commands trigger the pane', async () => {
  expect(isOrchSkill('orch:orch')).toBe(true)
  expect(isOrchSkill('orch')).toBe(true)
  expect(isOrchSkill('orchestra')).toBe(false)
  expect(isOrchCommand('bun skills/orch/scripts/dispatch.ts start r1 n1')).toBe(true)
  expect(isOrchCommand('orch plan apply plan.json')).toBe(true)
  expect(isOrchCommand('orch profile list')).toBe(false)
  expect(isOrchCommand('ls orchard')).toBe(false)
})

test('the dashboard link is a localhost run page', async () => {
  expect(runUrl('http://127.0.0.1:6724/', 'r 1')).toBe('http://localhost:6724/#/run/r%201')
  expect(runUrl('http://0.0.0.0:6724/', 'r1')).toBe('http://localhost:6724/#/run/r1')
  expect(runUrl('https://orch.example:6724/?token=t', 'r1')).toBe('https://orch.example:6724/?token=t#/run/r1')
})

test('cost reads as the dashboard prints it', async () => {
  expect(costText({ usd: 0.4213 })).toBe('$0.42')
  expect(costText({ usd: 0.004 })).toBe('<$0.01')
  expect(costText({ usd: 0, input_tokens: 12000, output_tokens: 400 })).toBe('12,400 tok')
  expect(costText(null)).toBe(null)
})

test('the attempt counter follows settings.max_attempts', async () => {
  expect(attemptText(1, 5)).toBe('attempt 1/5')
  expect(attemptText(3, -1)).toBe('attempt 3/∞')
  expect(attemptText(6, 5)).toBe('manual retry 6')
})

test('durations and status counts match the run meta', async () => {
  const start = '2026-10-03T10:00:00Z'
  const at = (seconds: number) => new Date(start).getTime() + seconds * 1000
  expect(durationText(start, at(42))).toBe('42s')
  expect(durationText(start, at(185))).toBe('3m 5s')
  expect(durationText(start, at(3 * 3600 + 120))).toBe('3h 2m')
  const run = toRunView(
    { run_id: 'r', started: start, nodes: [{ id: 'a', status: 'done' }, { id: 'b', status: 'error' }, { id: 'c' }] },
    {},
    5,
    at(65),
  )
  expect(run.elapsed).toBe('1m 5s')
  expect(statusCounts(run)).toEqual([['error', 1], ['done', 1], ['waiting', 1]])
})

test('a Smart Auto node shows the hub pick and its tier', async () => {
  const run = toRunView({
    run_id: 'r1',
    nodes: [
      { id: 'a', model_id: 'hub-smart-auto-balance', hub: { actual: { model: 'copilot/claude-opus-5-5', tier: 'intelligence' } } },
      { id: 'b', model_id: 'hub-smart-auto-balance', hub: { expected: { model: 'copilot/claude-haiku-5-5', tier: 'efficiency' } } },
      { id: 'c', model_id: 'sonnet', tier: 'balance' },
    ],
  })
  const [a, b, c] = run.layers[0] ?? []
  expect(a?.model).toBe('claude-opus-5-5')
  expect(a?.tier).toBe('intelligence')
  expect(b?.model).toBe('~claude-haiku-5-5')
  expect(b?.tier).toBe('efficiency')
  expect(c?.model).toBe('sonnet')
  expect(c?.tier).toBe(null)
})
