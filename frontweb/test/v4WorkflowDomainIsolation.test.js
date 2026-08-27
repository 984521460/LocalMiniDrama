import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  removeWorkflowSelection,
  serializeWorkflowGraph,
} from '../src/components/workflow/workflowGraph.js'

test('removing a view node only changes the canvas graph and keeps domain references external', () => {
  const domainRef = Object.freeze({
    type: 'asset_version',
    uid: '11111111-1111-4111-8111-111111111111',
  })
  const graph = {
    workflowUid: '22222222-2222-4222-8222-222222222222',
    revision: 4,
    nodes: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        position: { x: 20, y: 40 },
        data: { nodeType: 'asset.character', config: {}, domainRef, status: 'disabled' },
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        position: { x: 220, y: 40 },
        data: { nodeType: 'asset.character_pack', config: {}, domainRef: null, status: 'disabled' },
      },
    ],
    edges: [{
      id: '55555555-5555-4555-8555-555555555555',
      source: '33333333-3333-4333-8333-333333333333',
      sourceHandle: 'out:character',
      target: '44444444-4444-4444-8444-444444444444',
      targetHandle: 'in:character',
    }],
  }
  const original = structuredClone(graph)
  const removed = removeWorkflowSelection(
    graph,
    ['33333333-3333-4333-8333-333333333333'],
  )

  assert.deepEqual(graph, original)
  assert.deepEqual(removed.nodes.map((node) => node.id), ['44444444-4444-4444-8444-444444444444'])
  assert.deepEqual(removed.edges, [])
  assert.equal(domainRef.uid, '11111111-1111-4111-8111-111111111111')
})

test('serialized canvas payload contains references but never embeds or deletes domain records', () => {
  const payload = serializeWorkflowGraph({
    nodes: [{
      id: '33333333-3333-4333-8333-333333333333',
      position: { x: 90, y: 120 },
      data: {
        nodeType: 'asset.character',
        config: {},
        domainRef: { type: 'asset_version', uid: '11111111-1111-4111-8111-111111111111' },
        status: 'disabled',
      },
    }],
    edges: [],
  }, 2)
  assert.deepEqual(Object.keys(payload.nodes[0]).sort(), [
    'config', 'domain_ref', 'node_type', 'position', 'status', 'uid',
  ])
  assert.deepEqual(payload.nodes[0].domain_ref, {
    type: 'asset_version', uid: '11111111-1111-4111-8111-111111111111',
  })

  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const controller = fs.readFileSync(
    path.join(testDirectory, '..', 'src', 'composables', 'useWorkflowCanvas.js'),
    'utf8',
  )
  assert.doesNotMatch(controller, /api\.(?:delete|remove)(?:Character|Storyboard|Asset)/)
  assert.doesNotMatch(controller, /api\/(?:character|storyboard|asset)/)
  assert.match(controller, /removeWorkflowSelection/)
  assert.match(controller, /api\.saveGraph/)
})
