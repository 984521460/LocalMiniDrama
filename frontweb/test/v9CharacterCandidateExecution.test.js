import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  approvedCharacterCandidateOptions,
  characterCandidateExecutionRequestView,
  characterCandidateExecutionResponseView,
  createCharacterCandidateExecutionRequest,
} from '../src/characterCandidates/characterCandidateExecution.js'
import { useCharacterCandidateExecution } from '../src/composables/useCharacterCandidateExecution.js'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const uid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const sha = (character) => character.repeat(64)

function request(operationUid = uid(1)) {
  return {
    schemaVersion: 'character-candidate-execution-request.v1',
    operationUid,
    dramaUid: uid(2),
    characterUid: uid(3),
    extractionResultUid: uid(4),
    characterFactId: 'character-alan',
    width: 512,
    height: 512,
    seed: 42,
  }
}

function response(requestValue = request()) {
  const source = {
    schemaVersion: 'character-candidate-source.v1',
    dramaUid: requestValue.dramaUid,
    characterUid: requestValue.characterUid,
    characterName: '阿澜',
    characterDescription: '剑客',
    characterPersonality: '沉着',
    characterAppearance: '黑发青衣',
    sourceSelectionUid: uid(5),
    extractionResultUid: requestValue.extractionResultUid,
    extractionResultHash: sha('a'),
    extractionEnvelopeHash: sha('b'),
    extractionApprovalRef: `review:v1:${uid(6)}`,
    characterFactId: requestValue.characterFactId,
    characterFactName: '阿澜',
    characterFactDescription: '二十岁的黑发剑客',
  }
  const items = []
  const candidates = []
  for (let ordinal = 0; ordinal < 4; ordinal += 1) {
    const seed = (requestValue.seed + ordinal * 2_654_435_761) % 4_294_967_296
    const logicalUri = `asset://characters/${requestValue.characterUid}/candidate-batches/${requestValue.operationUid}/${ordinal}`
    const relativePath = `characters/${requestValue.characterUid}/candidate-batches/${requestValue.operationUid}/${ordinal}.png`
    const item = {
      ordinal,
      seed,
      promptSha256: sha(String(ordinal + 1)),
      provider: 'synthetic',
      model: 'fixture-image-model',
      parameters: {
        adapter: 'configured-image.v1', size: '512x512', requestedSeed: seed, ordinal,
      },
      parametersSha256: sha('c'),
      candidateUid: uid(100 + ordinal),
      assetUid: uid(200 + ordinal),
      assetVersionUid: uid(300 + ordinal),
      logicalUri,
      relativePath,
      contentSha256: sha(String(ordinal + 5)),
      byteLength: 1024 + ordinal,
      width: 512,
      height: 512,
      createdAtEpochMs: 1,
    }
    items.push(item)
    candidates.push({
      uid: item.candidateUid,
      ordinal,
      assetVersionUid: item.assetVersionUid,
      logicalUri,
      mediaType: 'image/png',
      width: 512,
      height: 512,
      contentSha256: item.contentSha256,
      presentation: 'single_portrait',
    })
  }
  return {
    execution: {
      schemaVersion: 'character-candidate-execution.v1',
      operationUid: requestValue.operationUid,
      requestSha256: sha('d'),
      request: requestValue,
      sourceSha256: sha('e'),
      source,
      profileSha256: '73631e09bfab773ba0063ff16396c510104280371c6ba8ce0ac92aeec82067bc',
      manifestSha256: 'd6aa8979f26464e26f3251582eb24750549c218e27de23a2c0ef0e9a39383a08',
      state: 'succeeded',
      batchUid: requestValue.operationUid,
      errorCode: null,
      createdAtEpochMs: 1,
      updatedAtEpochMs: 2,
      items,
    },
    batch: {
      schemaVersion: '5.0',
      batchUid: requestValue.operationUid,
      characterUid: requestValue.characterUid,
      requestSha256: sha('d'),
      request: {
        schemaVersion: '5.0',
        batchUid: requestValue.operationUid,
        characterUid: requestValue.characterUid,
        promptSemanticUid: requestValue.extractionResultUid,
        profileUid: 'c22f9231-0d79-43b9-93a6-d5e28d1d4401',
        manifestUid: '66512afd-a10f-447d-8f1f-1428b6dc1021',
        width: 512,
        height: 512,
        seed: 42,
        candidateCount: 4,
      },
      candidates,
    },
  }
}

function approvedExtraction() {
  return {
    uid: uid(4),
    dramaUid: uid(2),
    sourceSelectionUid: uid(5),
    resultType: 'extraction',
    taskType: 'NovelExtractionTask',
    schemaVersion: 'novel-extraction.v1',
    inputHash: sha('2'),
    resultHash: sha('a'),
    envelopeHash: sha('b'),
    result: { output: { characters: [{ factId: 'character-alan', name: '阿澜' }] } },
    upstreamResultUid: null,
    status: 'approved',
    currentReviewUid: uid(6),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    staleOperationUid: null,
    staleReasonCode: null,
    staleRootKind: null,
    staleRootUid: null,
    staledAtEpochMs: null,
  }
}

test('request and response views bind four exact candidate records', () => {
  assert.deepEqual(characterCandidateExecutionRequestView(request()), request())
  const parsed = characterCandidateExecutionResponseView(response())
  assert.equal(parsed.execution.items.length, 4)
  assert.equal(parsed.batch.candidates.length, 4)
  assert.equal(Object.isFrozen(parsed.execution.items), true)

  const drifted = structuredClone(response())
  drifted.execution.items[2].relativePath = 'characters/elsewhere.png'
  assert.throws(() => characterCandidateExecutionResponseView(drifted))
  const batchHashDrift = structuredClone(response())
  batchHashDrift.batch.requestSha256 = sha('9')
  assert.throws(() => characterCandidateExecutionResponseView(batchHashDrift))
  const profileDrift = structuredClone(response())
  profileDrift.batch.request.profileUid = uid(7)
  assert.throws(() => characterCandidateExecutionResponseView(profileDrift))
  assert.throws(() => characterCandidateExecutionRequestView({ ...request(), width: 2048, height: 2049 }))
})

test('approved option projection only exposes current matching extraction facts', () => {
  const options = approvedCharacterCandidateOptions({
    dramaUid: uid(2),
    characters: [{ uid: uid(3), name: '阿澜' }, { uid: uid(9), name: '旁观者' }],
    results: [approvedExtraction()],
  })
  assert.deepEqual(options, [Object.freeze({
    identity: `${uid(4)}\0character-alan\0${uid(3)}`,
    characterUid: uid(3),
    characterName: '阿澜',
    extractionResultUid: uid(4),
    characterFactId: 'character-alan',
  })])
  assert.deepEqual(approvedCharacterCandidateOptions({
    dramaUid: uid(2), characters: [{ uid: uid(3), name: '其他' }], results: [approvedExtraction()],
  }), [])
})

test('composable ignores stale completion and constructs an exact request', async () => {
  const pending = []
  const composable = useCharacterCandidateExecution({
    createOperationUid: (() => {
      let next = 10
      return () => uid(next++)
    })(),
    api: {
      execute(dramaId, requestValue) {
        return new Promise((resolve) => pending.push({ dramaId, request: requestValue, resolve }))
      },
    },
  })
  const input = {
    dramaId: 1,
    dramaUid: uid(2),
    characterUid: uid(3),
    extractionResultUid: uid(4),
    characterFactId: 'character-alan',
    width: 512,
    height: 512,
    seed: 42,
  }
  const first = composable.execute(input)
  const second = composable.execute(input)
  pending[1].resolve(characterCandidateExecutionResponseView(response(pending[1].request)))
  assert.equal((await second).execution.operationUid, uid(11))
  pending[0].resolve(characterCandidateExecutionResponseView(response(pending[0].request)))
  assert.equal(await first, null)
  assert.equal(composable.last.value.execution.operationUid, uid(11))
  const { dramaId: _dramaId, ...requestInput } = input
  assert.deepEqual(createCharacterCandidateExecutionRequest({
    ...requestInput, operationUid: uid(12),
  }).operationUid, uid(12))
})

test('UI and API expose an explicit paid four-call confirmation through strict JSON transport', () => {
  const component = fs.readFileSync(
    path.join(sourceRoot, 'components/assets/CharacterCandidateExecutionPanel.vue'),
    'utf8',
  )
  const api = fs.readFileSync(
    path.join(sourceRoot, 'api/v2/characterCandidateExecutions.js'),
    'utf8',
  )
  const workspace = fs.readFileSync(
    path.join(sourceRoot, 'components/narrative/NarrativeReviewWorkspace.vue'),
    'utf8',
  )
  assert.match(component, /独立提交 4 次生成请求/u)
  assert.match(component, /ElMessageBox\.confirm/u)
  assert.match(api, /parseStrictJson/u)
  assert.match(api, /workflowJsonTextRequest/u)
  assert.match(workspace, /CharacterCandidateExecutionPanel/u)
})
