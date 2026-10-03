import { expect, test } from 'claude-code/testing'

import { drawGraph, profileColors } from './canvas'
import { toRunView } from './graph'

const run = toRunView(
  {
    run_id: 'r1',
    nodes: [
      { id: 'plan', status: 'done', profile: 'claude-planner', adapter: 'claude' },
      { id: 'api', status: 'running', profile: 'cursor-default' },
      { id: 'review', status: 'waiting', profile: 'claude-default' },
    ],
    edges: [['plan', 'api'], ['api', 'review'], ['plan', 'review']],
  },
  { 'cursor-default': { harness: 'cursor-agent', model: 'auto' } },
)
const lines = drawGraph(run, 120).map(row => row.map(span => span.text).join(''))
const picture = lines.join('\n')

test('every node is a box with its harness glyph and status icon', async () => {
  expect(picture).toContain('✻ plan')
  expect(picture).toContain('◆ api')
  expect(picture).toContain('✓')
  expect(picture).toContain('●')
  expect(picture).toContain('○')
  expect(picture).toContain('auto')
})

test('the orch node feeds the entry node and every edge ends in an arrow', async () => {
  expect(picture).toContain('│ orch │')
  // plan (from orch), api and review (twice, merged into one arrow)
  expect(picture.split('▶').length - 1).toBe(3)
})

test('an edge that skips a layer runs on a lane below the boxes', async () => {
  expect(lines[lines.length - 1]).toMatch(/^\s*╰─+╯$/)
})

test('profiles in one run never share a colour', async () => {
  const colors = profileColors(['a', 'b', 'c', 'a'])
  expect(new Set(colors.values()).size).toBe(3)
})
