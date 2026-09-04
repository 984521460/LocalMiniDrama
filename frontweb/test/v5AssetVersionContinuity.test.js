import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  continuityReuseSummary,
  shotContinuityComparisonView,
  shotContinuitySnapshotListView,
} from '../src/assets/shotContinuity.js'
import { CHARACTER_REFERENCE_ITEM_KINDS } from '../src/assets/characterReferencePackage.js'
import { useAssetVersionContinuity } from '../src/composables/useAssetVersionContinuity.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

function snapshot(ordinal, { propVersion = uid(90) } = {}) {
  return {
    schemaVersion: '5.0',
    snapshotUid: uid(10 + ordinal),
    dramaUid: uid(1),
    shotResultUid: uid(2),
    shotResultHash: 'a'.repeat(64),
    shotEnvelopeHash: 'b'.repeat(64),
    shotApprovalRef: `review:v1:${uid(3)}`,
    shotId: `shot-${ordinal}`,
    shotOrdinal: ordinal,
    scene: {
      sceneUid: uid(20),
      versionUid: uid(21),
      name: '雨夜车站',
      visualDescription: '潮湿站台与冷色灯光。',
      lighting: '冷色顶光',
      colorAnchors: ['#112233'],
    },
    characters: [{
      factRef: 'character-hero',
      characterUid: uid(30),
      referencePackageUid: uid(31),
      identityVersionUid: uid(32),
      costumeVersionUid: uid(33),
    }],
    props: [{
      factRef: 'prop-umbrella',
      propUid: uid(40),
      versionUid: propVersion,
      name: '黑伞',
      visualDescription: '磨砂黑色长柄伞。',
      colorAnchors: ['#101010'],
    }],
    createdAtEpochMs: ordinal,
  }
}

function comparison(first, second) {
  return {
    schemaVersion: '5.0',
    fromSnapshotUid: first.snapshotUid,
    toSnapshotUid: second.snapshotUid,
    adjacent: true,
    scene: {
      changed: false,
      fromSceneUid: first.scene.sceneUid,
      fromVersionUid: first.scene.versionUid,
      toSceneUid: second.scene.sceneUid,
      toVersionUid: second.scene.versionUid,
    },
    characters: {
      unchanged: [uid(30)],
      changed: [],
      entered: [],
      exited: [],
    },
    props: {
      unchanged: [],
      changed: [{ propUid: uid(40), fields: ['versionUid'] }],
      entered: [],
      exited: [],
    },
  }
}

function packageRecord(lockStateVersion = 1) {
  const packageUid = uid(31 + lockStateVersion - 1)
  const characterUid = uid(30)
  return {
    schemaVersion: '5.0',
    packageUid,
    characterUid,
    identityVersionUid: uid(32),
    candidateUid: uid(50 + lockStateVersion),
    lockEventUid: uid(60 + lockStateVersion),
    lockStateVersion,
    appearanceVersion: {
      uid: uid(70 + lockStateVersion),
      name: '固定外貌',
      description: '黑色短发与琥珀色眼睛。',
      colorAnchors: ['#112233'],
    },
    defaultCostumeVersion: {
      uid: uid(80 + lockStateVersion),
      name: '雨夜服装',
      description: '深灰风衣。',
      colorAnchors: ['#232323'],
    },
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      uid: uid(100 + lockStateVersion * 20 + ordinal),
      ordinal,
      kind,
      assetVersionUid: uid(200 + lockStateVersion * 20 + ordinal),
      logicalUri: `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`,
      mediaType: 'image/png',
      width: 1024,
      height: 1024,
      contentSha256: (ordinal + lockStateVersion).toString(16).padStart(64, '0'),
    })),
    createdAtEpochMs: lockStateVersion,
  }
}

test('continuity UI contracts expose stable locked identity reuse and adjacent conflicts', () => {
  const first = snapshot(1)
  const second = snapshot(2, { propVersion: uid(91) })
  const snapshots = shotContinuitySnapshotListView([first, second])
  const transition = shotContinuityComparisonView(comparison(first, second))
  const summary = continuityReuseSummary(snapshots, [transition])

  assert.deepEqual(summary.stableCharacters, [{
    characterUid: uid(30),
    identityVersionUid: uid(32),
    referencePackageUid: uid(31),
    costumeVersionUid: uid(33),
    shotCount: 2,
  }])
  assert.equal(summary.conflictCount, 1)
  assert.equal(summary.comparisons[0].hasConflict, true)
  assert.deepEqual(summary.comparisons[0].changedLabels, ['道具版本'])
  assert.ok(Object.isFrozen(summary))
})

test('asset continuity workspace loads approved shots, package history, and clears stale state on failure', async () => {
  const first = snapshot(1)
  const second = snapshot(2, { propVersion: uid(91) })
  let malformed = false
  const workspace = useAssetVersionContinuity({
    dramaId: 1,
    reviewApi: {
      async listForDrama() {
        return [{
          uid: uid(2), resultType: 'shot', status: 'approved',
          createdAt: '1970-01-01T00:00:00.000Z', upstreamResultUid: null,
        }]
      },
    },
    continuityApi: {
      async list() { return malformed ? {} : [first, second] },
      async compare() { return comparison(first, second) },
    },
    packageApi: {
      async list(characterUid) {
        assert.equal(characterUid, uid(30))
        return [packageRecord(1), packageRecord(2)]
      },
    },
  })

  assert.equal(await workspace.load(), true)
  assert.equal(workspace.snapshots.value.length, 2)
  assert.equal(workspace.characterHistories.value[0].packages.length, 2)
  assert.equal(workspace.characterHistories.value[0].packages[0].view.packageUid, uid(31))
  assert.equal(workspace.characterHistories.value[0].packages[0].source.schemaVersion, '5.0')
  assert.equal(workspace.reuse.value.stableCharacters[0].shotCount, 2)
  assert.equal(workspace.error.value, null)

  malformed = true
  assert.equal(await workspace.load(), false)
  assert.deepEqual(workspace.snapshots.value, [])
  assert.deepEqual(workspace.characterHistories.value, [])
  assert.equal(workspace.error.value, 'ASSET_VERSION_CONTINUITY_INVALID')
})

test('approved empty continuity workspace explicitly materializes and reopens all local bindings', async () => {
  const first = snapshot(1)
  let materialized = false
  let materializeCalls = 0
  const workspace = useAssetVersionContinuity({
    dramaId: 1,
    reviewApi: {
      async listForDrama() {
        return [{
          uid: uid(2), resultType: 'shot', status: 'approved',
          createdAt: '1970-01-01T00:00:00.000Z', upstreamResultUid: null,
        }]
      },
    },
    continuityApi: {
      async list() { return materialized ? [first] : [] },
      async materialize(resultUid) {
        assert.equal(resultUid, uid(2))
        materializeCalls += 1
        materialized = true
        return [first]
      },
      async compare() { throw new Error('must not compare one shot') },
    },
    packageApi: { async list() { return [packageRecord(1)] } },
  })

  assert.equal(await workspace.load(), true)
  assert.equal(workspace.emptyReason.value, 'CONTINUITY_SNAPSHOTS_EMPTY')
  assert.equal(workspace.shotResultUid.value, uid(2))
  assert.equal(await workspace.materialize(), true)
  assert.equal(materializeCalls, 1)
  assert.equal(workspace.materializing.value, false)
  assert.equal(workspace.snapshots.value.length, 1)
  assert.equal(workspace.emptyReason.value, '')
  assert.equal(workspace.error.value, null)
})

test('continuity UI fails closed on mismatched comparisons and invalid package history', async () => {
  const first = snapshot(1)
  const second = snapshot(2, { propVersion: uid(91) })
  assert.throws(
    () => continuityReuseSummary(
      shotContinuitySnapshotListView([first, second]),
      [shotContinuityComparisonView({
        ...comparison(first, second),
        fromSnapshotUid: uid(999),
      })],
    ),
    /Shot continuity response is invalid/,
  )
  assert.throws(
    () => continuityReuseSummary(
      shotContinuitySnapshotListView([first, second]),
      [shotContinuityComparisonView({
        ...comparison(first, second),
        props: { unchanged: [uid(40)], changed: [], entered: [], exited: [] },
      })],
    ),
    /Shot continuity response is invalid/,
  )

  const workspace = useAssetVersionContinuity({
    dramaId: 1,
    reviewApi: { async listForDrama() { return [{
      uid: uid(2), resultType: 'shot', status: 'approved', createdAt: '', upstreamResultUid: null,
    }] } },
    continuityApi: {
      async list() { return [first] },
      async compare() { throw new Error('must not compare one shot') },
    },
    packageApi: { async list() { return [{ ...packageRecord(1), items: [] }] } },
  })
  assert.equal(await workspace.load(), false)
  assert.deepEqual(workspace.snapshots.value, [])
})

test('a slow previous drama response cannot replace the current continuity workspace', async () => {
  const first = snapshot(1)
  let dramaId = 1
  let releaseOld
  const oldRequest = new Promise((resolve) => { releaseOld = resolve })
  const workspace = useAssetVersionContinuity({
    dramaId: () => dramaId,
    reviewApi: {
      async listForDrama(requestedDramaId) {
        if (requestedDramaId === 1) return oldRequest
        return [{
          uid: uid(2), resultType: 'shot', status: 'approved',
          createdAt: '1970-01-01T00:00:00.000Z', upstreamResultUid: null,
        }]
      },
    },
    continuityApi: {
      async list() { return [first] },
      async compare() { throw new Error('must not compare one shot') },
    },
    packageApi: { async list() { return [packageRecord(1)] } },
  })

  const staleLoad = workspace.load()
  dramaId = 2
  assert.equal(await workspace.load(), true)
  assert.equal(workspace.snapshots.value.length, 1)
  releaseOld([])
  assert.equal(await staleLoad, false)
  assert.equal(workspace.snapshots.value.length, 1)
  assert.equal(workspace.error.value, null)
})

test('slow same-drama refreshes cannot hide current snapshots or install an old error', async () => {
  const first = snapshot(1)
  const pending = []
  const reviewApi = {
    listForDrama() {
      return new Promise((resolve, reject) => pending.push({ resolve, reject }))
    },
  }
  const workspace = useAssetVersionContinuity({
    dramaId: 1,
    reviewApi,
    continuityApi: {
      async list() { return [first] },
      async compare() { throw new Error('must not compare one shot') },
    },
    packageApi: { async list() { return [packageRecord(1)] } },
  })
  const approved = [{
    uid: uid(2), resultType: 'shot', status: 'approved',
    createdAt: '1970-01-01T00:00:00.000Z', upstreamResultUid: null,
  }]

  const staleEmptyLoad = workspace.load()
  const currentLoad = workspace.load()
  pending[1].resolve(approved)
  assert.equal(await currentLoad, true)
  pending[0].resolve([])
  assert.equal(await staleEmptyLoad, false)
  assert.equal(workspace.snapshots.value.length, 1)
  assert.equal(workspace.emptyReason.value, '')

  const staleErrorLoad = workspace.load()
  const newestLoad = workspace.load()
  pending[3].resolve(approved)
  assert.equal(await newestLoad, true)
  pending[2].reject(new Error('synthetic stale failure'))
  assert.equal(await staleErrorLoad, false)
  assert.equal(workspace.snapshots.value.length, 1)
  assert.equal(workspace.error.value, null)
})

test('continuity component is integrated into the local narrative workflow without provider controls', () => {
  const component = fs.readFileSync(path.resolve(
    __dirname,
    '../src/components/assets/AssetVersionContinuityWorkspace.vue',
  ), 'utf8')
  const page = fs.readFileSync(path.resolve(__dirname, '../src/views/NarrativeWorkflow.vue'), 'utf8')
  assert.match(component, /CharacterReferencePackageCard/)
  assert.match(component, /连续性冲突/)
  assert.match(component, /锁定身份复用/)
  assert.match(component, /建立镜头版本引用/)
  assert.match(component, /不调用模型或产生费用/)
  assert.match(page, /AssetVersionContinuityWorkspace/)
  assert.doesNotMatch(component, /api[_-]?key|credential|secret|provider/i)
})
