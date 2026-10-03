import { expect, test } from 'claude-code/testing'

import { isOrchCommand, isOrchSkill, layerOf, newestFirst, toRunView } from './graph'

test('a node sits one layer below its deepest parent', async () => {
  const layer = layerOf(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['a', 'c']])
  expect(layer.get('a')).toBe(0)
  expect(layer.get('b')).toBe(1)
  expect(layer.get('c')).toBe(2)
  expect(layer.get('d')).toBe(0)
})

test('a cycle does not loop forever', async () => {
  const layer = layerOf(['a', 'b'], [['a', 'b'], ['b', 'a']])
  expect(layer.size).toBe(2)
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
  expect(run.layers[0]?.[0]?.attempts).toBe(2)
  expect(run.layers[1]?.[0]?.after).toEqual(['plan'])
  expect(run.layers[1]?.[0]?.model).toBe('-')
})

test('run ids sort newest first', async () => {
  expect(newestFirst(['20260930-1', '20261001-1', '20260101-1'])[0]).toBe('20261001-1')
})

test('the orch skill and run commands trigger the pane', async () => {
  expect(isOrchSkill('orch:orch')).toBe(true)
  expect(isOrchSkill('orch')).toBe(true)
  expect(isOrchSkill('orchestra')).toBe(false)
  expect(isOrchCommand('bash skills/orch/scripts/dispatch.sh start r1 n1')).toBe(true)
  expect(isOrchCommand('orch plan apply plan.json')).toBe(true)
  expect(isOrchCommand('orch profile list')).toBe(false)
  expect(isOrchCommand('ls orchard')).toBe(false)
})
