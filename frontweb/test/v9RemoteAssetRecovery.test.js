import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createRemoteAssetRecoveryRequest,
  remoteAssetRecoveryListView,
  remoteAssetRecoveryRequestView,
  remoteAssetRecoveryResponseView,
} from '../src/remoteAssets/recovery.js'
import { useRemoteAssetRecovery } from '../src/composables/useRemoteAssetRecovery.js'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const uid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const sha = (character) => character.repeat(64)

function request(operationUid = uid(1)) {
  return {
    schemaVersion: 'remote-asset-recovery-request.v1',
    operationUid,
    dramaUid: uid(2),
    characterUid: uid(3),
    extractionResultUid: uid(4),
    characterFactId: 'character-alan',
    connectionUid: uid(5),
    connectionEvidenceSha256: sha('a'),
    remoteTaskUid: uid(6),
  }
}

function response(requestValue = request()) {
  return {
    recovery: {
      schemaVersion: 'remote-asset-recovery.v1',
      operationUid: requestValue.operationUid,
      requestSha256: sha('b'),
      request: requestValue,
      sourceSha256: sha('c'),
      source: {
        schemaVersion: 'character-candidate-source.v1',
        dramaUid: requestValue.dramaUid,
        characterUid: requestValue.characterUid,
        characterName: '阿澜',
        characterDescription: '剑客',
        characterPersonality: '沉着',
        characterAppearance: '黑发青衣',
        sourceSelectionUid: uid(7),
        extractionResultUid: requestValue.extractionResultUid,
        extractionResultHash: sha('d'),
        extractionEnvelopeHash: sha('e'),
        extractionApprovalRef: `review:v1:${uid(8)}`,
        characterFactId: requestValue.characterFactId,
        characterFactName: '阿澜',
        characterFactDescription: '二十岁的黑发剑客',
      },
      sourceCurrent: true,
      state: 'succeeded',
      quarantineStatus: 'unapproved',
      manifestSha256: sha('f'),
      manifest: {
        schemaVersion: 'remote-asset-recovery-manifest.v1',
        remoteTaskUid: requestValue.remoteTaskUid,
        characterName: '阿澜',
        sourceFormat: 'standard.v1',
        sourceManifestSha256: sha('1'),
        items: [{
          ordinal: 0,
          remoteRelativePath: 'outputs/candidate-0.png',
          remoteSha256: sha('2'),
          width: 512,
          height: 512,
        }],
      },
      itemCount: 1,
      errorCode: null,
      createdAtEpochMs: 1,
      updatedAtEpochMs: 2,
      items: [{
        ordinal: 0,
        remoteRelativePath: 'outputs/candidate-0.png',
        remoteSha256: sha('2'),
        remoteByteLength: 2048,
        assetUid: uid(9),
        assetVersionUid: uid(10),
        logicalUri: `asset://characters/${requestValue.characterUid}/remote-recoveries/${requestValue.operationUid}/0`,
        relativePath: `characters/${requestValue.characterUid}/remote-recoveries/${requestValue.operationUid}/0.png`,
        contentSha256: sha('3'),
        byteLength: 1024,
        width: 512,
        height: 512,
        createdAtEpochMs: 2,
      }],
    },
  }
}

test('recovery views bind exact request, manifest, and quarantined local asset records', () => {
  assert.deepEqual(remoteAssetRecoveryRequestView(request()), request())
  const parsed = remoteAssetRecoveryResponseView(response())
  assert.equal(parsed.recovery.state, 'succeeded')
  assert.equal(parsed.recovery.quarantineStatus, 'unapproved')
  assert.equal(parsed.recovery.items.length, 1)
  assert.equal(Object.isFrozen(parsed.recovery.items), true)

  assert.throws(() => remoteAssetRecoveryRequestView({ ...request(), extra: true }))
  const promoted = structuredClone(response())
  promoted.recovery.quarantineStatus = 'approved'
  assert.throws(() => remoteAssetRecoveryResponseView(promoted))
  const rebound = structuredClone(response())
  rebound.recovery.items[0].assetUid = uid(99)
  rebound.recovery.items[0].relativePath = 'characters/other.png'
  assert.throws(() => remoteAssetRecoveryResponseView(rebound))
  const wrongCharacter = structuredClone(response())
  wrongCharacter.recovery.manifest.characterName = '夏弦'
  assert.throws(() => remoteAssetRecoveryResponseView(wrongCharacter))
  const invalidFailure = structuredClone(response())
  invalidFailure.recovery.state = 'failed'
  invalidFailure.recovery.manifestSha256 = null
  invalidFailure.recovery.manifest = null
  invalidFailure.recovery.itemCount = null
  invalidFailure.recovery.items = []
  invalidFailure.recovery.errorCode = 'UNDECLARED_FAILURE'
  assert.throws(() => remoteAssetRecoveryResponseView(invalidFailure))
})

test('recovery list and composable preserve character scope and ignore stale completions', async () => {
  const parsedResponse = remoteAssetRecoveryResponseView(response())
  const list = remoteAssetRecoveryListView({
    schemaVersion: 'remote-asset-recovery-list.v1',
    dramaUid: uid(2),
    characterUid: uid(3),
    recoveries: [parsedResponse.recovery],
  })
  assert.equal(list.recoveries.length, 1)
  assert.throws(() => remoteAssetRecoveryListView({ ...list, characterUid: uid(99) }))

  const pending = []
  const composable = useRemoteAssetRecovery({
    createOperationUid: (() => {
      let next = 20
      return () => uid(next++)
    })(),
    api: {
      execute(dramaId, requestValue) {
        return new Promise((resolve) => pending.push({ dramaId, request: requestValue, resolve }))
      },
      async list() { return list },
    },
  })
  const input = {
    dramaId: 1,
    dramaUid: uid(2),
    characterUid: uid(3),
    extractionResultUid: uid(4),
    characterFactId: 'character-alan',
    connectionUid: uid(5),
    connectionEvidenceSha256: sha('a'),
    remoteTaskUid: uid(6),
  }
  const first = composable.execute(input)
  const second = composable.execute(input)
  pending[1].resolve(remoteAssetRecoveryResponseView(response(pending[1].request)))
  assert.equal((await second).recovery.operationUid, uid(21))
  pending[0].resolve(remoteAssetRecoveryResponseView(response(pending[0].request)))
  assert.equal(await first, null)
  assert.equal(composable.recoveries.value[0].operationUid, uid(21))
  const { dramaId: _dramaId, ...requestInput } = input
  assert.deepEqual(createRemoteAssetRecoveryRequest({
    ...requestInput,
    operationUid: uid(22),
  }).operationUid, uid(22))
})

test('UI exposes read-only recovery into an explicitly unapproved local quarantine', () => {
  const panel = fs.readFileSync(
    path.join(sourceRoot, 'components/assets/RemoteAssetRecoveryPanel.vue'),
    'utf8',
  )
  const candidatePanel = fs.readFileSync(
    path.join(sourceRoot, 'components/assets/CharacterCandidateExecutionPanel.vue'),
    'utf8',
  )
  const api = fs.readFileSync(
    path.join(sourceRoot, 'api/v2/remoteAssetRecoveries.js'),
    'utf8',
  )
  assert.match(panel, /只读下载/u)
  assert.match(panel, /不会重新生图/u)
  assert.match(panel, /隔离 · 未批准/u)
  assert.match(panel, /不能锁定身份或进入参考包/u)
  assert.match(panel, /target="_blank"/u)
  assert.doesNotMatch(panel, /锁定并生成|批准并锁定/u)
  assert.match(candidatePanel, /RemoteAssetRecoveryPanel/u)
  assert.match(api, /parseStrictJson/u)
  assert.match(api, /workflowJsonTextRequest/u)
})
