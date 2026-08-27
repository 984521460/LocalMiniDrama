import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { useWorkflowCanvas } from '../src/composables/useWorkflowCanvas.js'

const DRAFT_UID = '11111111-1111-4111-8111-111111111111'
const DRAMA_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function registry() {
  return {
    schemaVersion: '4.0',
    registryVersion: '4.0.0',
    valueTypes: ['SourceDocument', 'SourceSelection'],
    nodes: [{
      type: 'source.selection',
      title: '原文选区',
      inputs: [{ id: 'document', valueType: 'SourceDocument', cardinality: 'one', required: true }],
      outputs: [{ id: 'selection', valueType: 'SourceSelection', cardinality: 'one', required: true }],
    }],
  }
}

function definition(uid, name) {
  return {
    uid,
    dramaUid: DRAMA_UID,
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

function graph(uid = DRAFT_UID, name = 'v1 兼容草稿') {
  return {
    definition: definition(uid, name),
    nodes: [],
    edges: [],
  }
}

function createCanvas(api) {
  const originalWarn = console.warn
  console.warn = () => {}
  const canvas = useWorkflowCanvas({ dramaId: 1, api })
  console.warn = originalWarn
  return canvas
}

test('creates the compatibility draft only when the v2 workflow list is empty', async () => {
  const calls = []
  const draft = graph()
  const api = {
    getRegistry: async () => registry(),
    list: async () => [],
    ensureLegacyDraft: async (dramaId) => { calls.push(['ensure', dramaId]); return draft },
    get: async (workflowUid) => { calls.push(['get', workflowUid]); return draft },
    listRuns: async () => [],
  }
  const canvas = createCanvas(api)

  await canvas.load()

  assert.deepEqual(calls, [['ensure', 1], ['get', DRAFT_UID]])
  assert.equal(canvas.workflows.value.length, 1)
  assert.equal(canvas.activeWorkflowUid.value, DRAFT_UID)
  assert.equal(canvas.activeWorkflow.value.name, 'v1 兼容草稿')
});

test('keeps existing v2 workflows and never calls the legacy adapter again', async () => {
  let ensureCalls = 0
  const existing = graph(DRAFT_UID, '已有 v2 工作流')
  const api = {
    getRegistry: async () => registry(),
    list: async () => [existing.definition],
    ensureLegacyDraft: async () => { ensureCalls += 1; return graph() },
    get: async () => existing,
    listRuns: async () => [],
  }
  const canvas = createCanvas(api)

  await canvas.load()

  assert.equal(ensureCalls, 0)
  assert.equal(canvas.activeWorkflow.value.name, '已有 v2 工作流')
});

test('drops a late compatibility draft when a newer load already found a v2 workflow', async () => {
  const existingUid = '22222222-2222-4222-8222-222222222222'
  const existing = graph(existingUid, '较新的 v2 工作流')
  let listCalls = 0
  let resolveDraft
  const delayedDraft = new Promise((resolve) => { resolveDraft = resolve })
  const api = {
    getRegistry: async () => registry(),
    list: async () => (listCalls++ === 0 ? [] : [existing.definition]),
    ensureLegacyDraft: async () => delayedDraft,
    get: async () => existing,
    listRuns: async () => [],
  }
  const canvas = createCanvas(api)

  const oldLoad = canvas.load()
  await Promise.resolve()
  const currentLoad = canvas.load()
  await currentLoad
  resolveDraft(graph())
  await oldLoad

  assert.equal(canvas.workflows.value.length, 1)
  assert.equal(canvas.activeWorkflowUid.value, existingUid)
  assert.equal(canvas.activeWorkflow.value.name, '较新的 v2 工作流')
});

test('fails closed on malformed catalog or draft responses without replacing valid state', async () => {
  const existingUid = '22222222-2222-4222-8222-222222222222'
  const existing = graph(existingUid, '保留的 v2 工作流')
  let registryResponse = registry()
  let listResponse = [existing.definition]
  let draftResponse = graph()
  let ensureCalls = 0
  const api = {
    getRegistry: async () => registryResponse,
    list: async () => listResponse,
    ensureLegacyDraft: async () => { ensureCalls += 1; return draftResponse },
    get: async () => existing,
    listRuns: async () => [],
  }
  const canvas = createCanvas(api)
  await canvas.load()

  listResponse = { unexpected: true }
  await canvas.load()
  assert.equal(ensureCalls, 0)
  assert.equal(canvas.activeWorkflowUid.value, existingUid)

  registryResponse = { nodes: [] }
  listResponse = []
  await canvas.load()
  assert.equal(ensureCalls, 0)
  assert.equal(canvas.activeWorkflowUid.value, existingUid)

  registryResponse = registry()
  draftResponse = { definition: definition(DRAFT_UID, '坏响应'), nodes: 'invalid', edges: [] }
  await canvas.load()
  assert.equal(ensureCalls, 1)
  assert.equal(canvas.activeWorkflowUid.value, existingUid)

  registryResponse = registry()
  registryResponse.valueTypes = new Array(3)
  registryResponse.valueTypes[1] = 'SourceDocument'
  registryResponse.valueTypes[2] = 'SourceSelection'
  listResponse = []
  await canvas.load()
  assert.equal(ensureCalls, 1)
  assert.equal(canvas.activeWorkflowUid.value, existingUid)

  registryResponse = registry()
  draftResponse = { definition: { uid: DRAFT_UID }, nodes: [], edges: [] }
  await canvas.load()
  assert.equal(ensureCalls, 2)
  assert.equal(canvas.activeWorkflowUid.value, existingUid)
  assert.equal(canvas.activeWorkflow.value.name, '保留的 v2 工作流')
  assert.deepEqual(canvas.lastError.value, {
    code: 'WORKFLOW_REQUEST_FAILED',
    message: '工作流请求失败，请稍后重试',
  })
});

test('keeps the compatibility adapter behind the v2 API and controller modules', () => {
  const testDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceRoot = path.join(testDirectory, '..', 'src')
  const api = fs.readFileSync(path.join(sourceRoot, 'api', 'v2', 'workflows.js'), 'utf8')
  const controller = fs.readFileSync(path.join(sourceRoot, 'composables', 'useWorkflowCanvas.js'), 'utf8')
  const legacyCanvas = fs.readFileSync(path.join(sourceRoot, 'views', 'DramaCanvas.vue'), 'utf8')
  assert.match(api, /ensureLegacyDraft/)
  assert.match(api, /legacy-draft/)
  assert.match(controller, /availableWorkflows\.length\s*===\s*0/)
  assert.match(controller, /assertWorkflowRegistryResponse/)
  assert.match(controller, /assertWorkflowDefinitionListResponse/)
  assert.doesNotMatch(controller, /saveCanvasLayout|workflow_groups|canvas_layout/)
  assert.doesNotMatch(legacyCanvas, /ensureLegacyDraft|legacy-draft/)
})
