import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  addWorkflowNode,
  canConnectWorkflowNodes,
  createWorkflowCanvasGraph,
  serializeWorkflowGraph,
} from '../src/components/workflow/workflowGraph.js'
import {
  buildExecutionScope,
  createWorkflowRequestGuard,
  runStatusMeta,
  shouldPollWorkflowRun,
  workflowErrorMeta,
} from '../src/components/workflow/workflowRuns.js'
import {
  assertWorkflowGraphResponse,
  assertWorkflowRunListResponse,
  assertWorkflowRunResponse,
  createWorkflowOperationGuard,
  dramaIdPath,
  workflowUidPath,
} from '../src/security/workflowBoundary.js'
import { useWorkflowCanvas } from '../src/composables/useWorkflowCanvas.js'

const SOURCE = Object.freeze({
  type: 'source.selection',
  title: '原文选区',
  inputs: [{ id: 'document', valueType: 'SourceDocument', cardinality: 'one', required: true }],
  outputs: [{ id: 'selection', valueType: 'SourceSelection', cardinality: 'one', required: true }],
})

const FACTS = Object.freeze({
  type: 'story.facts',
  title: '故事事实',
  inputs: [{ id: 'selection', valueType: 'SourceSelection', cardinality: 'one', required: true }],
  outputs: [{ id: 'facts', valueType: 'StoryFacts', cardinality: 'one', required: true }],
})

const WORKFLOW_DRAMA_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function workflowRegistryFixture() {
  return {
    schemaVersion: '4.0',
    registryVersion: '4.0.0',
    valueTypes: ['SourceDocument', 'SourceSelection', 'StoryFacts'],
    nodes: [SOURCE, FACTS],
  }
}

function workflowDefinitionFixture(uid, name) {
  return {
    uid,
    dramaUid: WORKFLOW_DRAMA_UID,
    name,
    version: 1,
    status: 'draft',
    description: null,
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    registryVersion: '4.0.0',
    graphRevision: 0,
  }
}

test('builds a disabled editable canvas graph and serializes the saved v2 contract', () => {
  const graph = createWorkflowCanvasGraph({
    definition: { uid: 'workflow', graphRevision: 3 },
    nodes: [],
    edges: [],
  }, [SOURCE, FACTS])
  const first = addWorkflowNode(graph, SOURCE, {
    uid: 'source-node',
    position: { x: 120, y: 80 },
  })
  const second = addWorkflowNode(first, FACTS, {
    uid: 'facts-node',
    position: { x: 420, y: 80 },
  })
  assert.equal(second.nodes[0].data.status, 'disabled')
  assert.equal(second.nodes[1].data.definition.title, '故事事实')

  const connected = canConnectWorkflowNodes(second, {
    source: 'source-node',
    sourceHandle: 'out:selection',
    target: 'facts-node',
    targetHandle: 'in:selection',
  })
  assert.deepEqual(connected, { ok: true, code: null, message: '' })

  const payload = serializeWorkflowGraph({
    ...second,
    edges: [{
      id: 'edge-one',
      source: 'source-node',
      sourceHandle: 'out:selection',
      target: 'facts-node',
      targetHandle: 'in:selection',
    }],
  }, 3)
  assert.deepEqual(payload, {
    expected_revision: 3,
    nodes: [
      {
        uid: 'source-node', node_type: 'source.selection', position: { x: 120, y: 80 },
        config: {}, status: 'disabled',
      },
      {
        uid: 'facts-node', node_type: 'story.facts', position: { x: 420, y: 80 },
        config: {}, status: 'disabled',
      },
    ],
    edges: [{
      uid: 'edge-one', source_node_uid: 'source-node', source_port: 'selection',
      target_node_uid: 'facts-node', target_port: 'selection',
    }],
  })
})

test('rejects incompatible, duplicate, cardinality, and cyclic connections locally', () => {
  const base = createWorkflowCanvasGraph({
    definition: { uid: 'workflow', graphRevision: 0 },
    nodes: [
      { uid: 'source', nodeType: SOURCE.type, position: { x: 0, y: 0 }, config: {}, status: 'disabled' },
      { uid: 'facts', nodeType: FACTS.type, position: { x: 200, y: 0 }, config: {}, status: 'disabled' },
    ],
    edges: [],
  }, [SOURCE, FACTS])
  assert.equal(canConnectWorkflowNodes(base, {
    source: 'facts', sourceHandle: 'out:facts', target: 'source', targetHandle: 'in:document',
  }).code, 'type_mismatch')

  const connected = {
    ...base,
    edges: [{ id: 'edge', source: 'source', sourceHandle: 'out:selection', target: 'facts', targetHandle: 'in:selection' }],
  }
  assert.equal(canConnectWorkflowNodes(connected, {
    source: 'source', sourceHandle: 'out:selection', target: 'facts', targetHandle: 'in:selection',
  }).code, 'duplicate')
  const additionalSource = addWorkflowNode(connected, SOURCE, {
    uid: 'source-two', position: { x: 0, y: 200 },
  })
  assert.equal(canConnectWorkflowNodes(additionalSource, {
    source: 'source-two', sourceHandle: 'out:selection', target: 'facts', targetHandle: 'in:selection',
  }).code, 'cardinality')
  assert.equal(canConnectWorkflowNodes(connected, {
    source: 'facts', sourceHandle: 'out:facts', target: 'facts', targetHandle: 'in:selection',
  }).code, 'self_edge')

  const loop = Object.freeze({
    type: 'loop.node', title: 'Loop',
    inputs: [{ id: 'value', valueType: 'StoryFacts', cardinality: 'one', required: true }],
    outputs: [{ id: 'value', valueType: 'StoryFacts', cardinality: 'one', required: true }],
  })
  const loopGraph = createWorkflowCanvasGraph({
    definition: { uid: 'loop-workflow', graphRevision: 0 },
    nodes: [
      { uid: 'loop-a', nodeType: loop.type, position: { x: 0, y: 0 }, config: {}, status: 'disabled' },
      { uid: 'loop-b', nodeType: loop.type, position: { x: 200, y: 0 }, config: {}, status: 'disabled' },
    ],
    edges: [{
      uid: 'loop-edge', sourceNodeUid: 'loop-a', sourcePort: 'value',
      targetNodeUid: 'loop-b', targetPort: 'value',
    }],
  }, [loop])
  assert.equal(canConnectWorkflowNodes(loopGraph, {
    source: 'loop-b', sourceHandle: 'out:value', target: 'loop-a', targetHandle: 'in:value',
  }).code, 'cycle')
})

test('creates exact backend execution scopes and stable run UI state', () => {
  assert.deepEqual(buildExecutionScope('full', []), { mode: 'full' })
  assert.deepEqual(buildExecutionScope('node', ['node-a']), { mode: 'node', node_uid: 'node-a' })
  assert.deepEqual(buildExecutionScope('downstream', ['node-a']), { mode: 'downstream', node_uid: 'node-a' })
  assert.deepEqual(buildExecutionScope('selection', ['node-a', 'node-b']), {
    mode: 'selection', node_uids: ['node-a', 'node-b'],
  })
  assert.throws(() => buildExecutionScope('node', []), /scope selection is invalid/i)
  assert.deepEqual(runStatusMeta('failed'), { label: '失败', tone: 'danger' })
  assert.equal(shouldPollWorkflowRun({ status: 'queued' }), true)
  assert.equal(shouldPollWorkflowRun({ status: 'running' }), true)
  assert.equal(shouldPollWorkflowRun({ status: 'cancelled' }), false)
  assert.deepEqual(workflowErrorMeta({ response: { data: { error: {
    code: 'WORKFLOW_GRAPH_INVALID', message: 'Workflow graph is invalid',
  } } } }), {
    code: 'WORKFLOW_GRAPH_INVALID',
    message: '工作流图未通过校验，请检查端口、必填输入、状态和领域绑定',
  })
})

test('invalidates stale workflow requests and keeps orchestration behind thin modules', () => {
  const guard = createWorkflowRequestGuard()
  const oldRequest = guard.begin()
  const latestRequest = guard.begin()
  assert.equal(guard.isCurrent(oldRequest), false)
  assert.equal(guard.isCurrent(latestRequest), true)
  guard.invalidate()
  assert.equal(guard.isCurrent(latestRequest), false)

  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceRoot = path.join(testDirectory, '..', 'src')
  const view = fs.readFileSync(path.join(sourceRoot, 'views', 'WorkflowCanvas.vue'), 'utf8')
  const api = fs.readFileSync(path.join(sourceRoot, 'api', 'v2', 'workflows.js'), 'utf8')
  const workflowRequest = fs.readFileSync(path.join(sourceRoot, 'api', 'v2', 'workflowRequest.js'), 'utf8')
  const controller = fs.readFileSync(path.join(sourceRoot, 'composables', 'useWorkflowCanvas.js'), 'utf8')
  assert.match(view, /VueFlow/)
  assert.match(view, /WorkflowRunPanel/)
  assert.match(view, /useWorkflowCanvas/)
  assert.match(view, /onBeforeRouteLeave/)
  assert.match(view, /:delete-key-code="null"/)
  assert.doesNotMatch(view, /for\s*\([^)]*\)\s*\{[^}]*startRun/s)
  assert.match(api, /startRun/)
  assert.match(api, /retryNode/)
  assert.match(api, /cancelRun/)
  assert.match(api, /\.\/workflowRequest/)
  assert.doesNotMatch(api, /utils\/request/)
  assert.doesNotMatch(workflowRequest, /ElMessage|apiError\.message|error\.message\s*=/)
  assert.match(controller, /createWorkflowOperationGuard/)
  assert.match(controller, /assertWorkflowGraphResponse/)
  assert.match(controller, /assertWorkflowRunResponse/)
})

test('rejects stale or cross-workflow responses before they can replace canvas state', () => {
  const guard = createWorkflowOperationGuard()
  const oldOperation = guard.begin('11111111-1111-4111-8111-111111111111')
  const currentOperation = guard.begin('22222222-2222-4222-8222-222222222222')
  assert.equal(guard.isCurrent(oldOperation, oldOperation.workflowUid), false)
  assert.equal(guard.isCurrent(currentOperation, currentOperation.workflowUid), true)
  assert.equal(guard.isCurrent(currentOperation, oldOperation.workflowUid), false)

  assert.throws(() => assertWorkflowGraphResponse({
    definition: { uid: oldOperation.workflowUid }, nodes: [], edges: [],
  }, currentOperation.workflowUid), /response identity is invalid/i)
  assert.throws(() => assertWorkflowRunResponse({
    run: { workflowUid: oldOperation.workflowUid }, nodes: [],
  }, currentOperation.workflowUid), /response identity is invalid/i)
  assert.throws(() => assertWorkflowRunListResponse([
    { uid: '33333333-3333-4333-8333-333333333333', workflowUid: oldOperation.workflowUid },
  ], currentOperation.workflowUid), /response identity is invalid/i)

  guard.invalidate()
  assert.equal(guard.isCurrent(currentOperation, currentOperation.workflowUid), false)
})

test('does not expose unknown backend error text in the workflow UI', () => {
  const sentinel = 'C:\\private\\provider-response.txt'
  const result = workflowErrorMeta({
    response: { data: { error: { code: 'INTERNAL_ERROR', message: sentinel } } },
    message: sentinel,
  })
  assert.deepEqual(result, {
    code: 'WORKFLOW_REQUEST_FAILED',
    message: '工作流请求失败，请稍后重试',
  })
  assert.equal(JSON.stringify(result).includes(sentinel), false)
})

test('accepts only canonical identifiers in workflow API path segments', () => {
  const uid = '11111111-1111-4111-8111-111111111111'
  assert.equal(workflowUidPath(uid), uid)
  assert.equal(dramaIdPath(7), '7')
  assert.throws(() => workflowUidPath('../workflow-runs/other'), /path identifier is invalid/i)
  assert.throws(() => workflowUidPath(`${uid}/cancel`), /path identifier is invalid/i)
  assert.throws(() => dramaIdPath('7'), /path identifier is invalid/i)
})

test('drops a late save response after the user switches workflows', async () => {
  const firstUid = '11111111-1111-4111-8111-111111111111'
  const secondUid = '22222222-2222-4222-8222-222222222222'
  const graph = (uid, name) => ({
    definition: workflowDefinitionFixture(uid, name),
    nodes: [],
    edges: [],
  })
  let resolveSave
  const pendingSave = new Promise((resolve) => { resolveSave = resolve })
  const api = {
    getRegistry: async () => workflowRegistryFixture(),
    list: async () => [
      workflowDefinitionFixture(firstUid, '旧工作流'),
      workflowDefinitionFixture(secondUid, '新工作流'),
    ],
    get: async (uid) => graph(uid, uid === firstUid ? '旧工作流' : '新工作流'),
    listRuns: async () => [],
    saveGraph: async () => pendingSave,
  }
  const originalWarn = console.warn
  console.warn = () => {}
  const canvas = useWorkflowCanvas({ dramaId: 1, api })
  console.warn = originalWarn

  await canvas.load()
  canvas.markDirty()
  const savePromise = canvas.save()
  await canvas.selectWorkflow(secondUid)
  resolveSave(graph(firstUid, '旧工作流'))

  assert.equal(await savePromise, null)
  assert.equal(canvas.activeWorkflowUid.value, secondUid)
  assert.equal(canvas.activeWorkflow.value.uid, secondUid)
  assert.equal(canvas.dirty.value, false)
})

test('drops a late run acceptance instead of opening it under another workflow', async () => {
  const firstUid = '11111111-1111-4111-8111-111111111111'
  const secondUid = '22222222-2222-4222-8222-222222222222'
  const runUid = '33333333-3333-4333-8333-333333333333'
  const graph = (uid) => ({
    definition: workflowDefinitionFixture(uid, uid),
    nodes: [],
    edges: [],
  })
  let resolveStart
  let getRunCalls = 0
  const pendingStart = new Promise((resolve) => { resolveStart = resolve })
  const api = {
    getRegistry: async () => workflowRegistryFixture(),
    list: async () => [
      workflowDefinitionFixture(firstUid, firstUid),
      workflowDefinitionFixture(secondUid, secondUid),
    ],
    get: async (uid) => graph(uid),
    listRuns: async () => [],
    startRun: async () => pendingStart,
    getRun: async () => { getRunCalls += 1 },
  }
  const originalWarn = console.warn
  console.warn = () => {}
  const canvas = useWorkflowCanvas({ dramaId: 1, api })
  console.warn = originalWarn

  await canvas.load()
  const executePromise = canvas.execute('full', 0)
  await canvas.selectWorkflow(secondUid)
  resolveStart({ run_uid: runUid })

  assert.equal(await executePromise, null)
  assert.equal(getRunCalls, 0)
  assert.equal(canvas.activeWorkflowUid.value, secondUid)
  assert.equal(canvas.activeWorkflow.value.uid, secondUid)
})
