import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  localRecoveryPackageListView,
  localRecoveryPackageResponseView,
} from '../src/remoteAssets/localRecovery.js'
import { createLocalRecoveryPackageAPI } from '../src/api/v2/localRecoveryPackages.js'

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')
const uid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`
const sha = (character) => character.repeat(64)

function record() {
  const recordUid = uid(1)
  const characterUid = uid(2)
  const relativePath = `characters/${characterUid}/local-recoveries/${recordUid}/0.png`
  return {
    uid: recordUid,
    dramaUid: uid(3),
    characterUid,
    packageSha256: sha('a'),
    sourceManifestSha256: sha('b'),
    remoteTaskUid: uid(4),
    characterName: '阿澜',
    quarantineStatus: 'unapproved',
    sourceCurrent: true,
    createdAt: '2026-09-08T00:00:00.000Z',
    items: [{
      ordinal: 0,
      assetUid: uid(5),
      assetVersionUid: uid(6),
      logicalUri: `asset://${relativePath}`,
      relativePath,
      sha256: sha('c'),
      byteLength: 1024,
      width: 256,
      height: 256,
      originalName: 'alan-1.png',
      originalSha256: sha('d'),
    }],
  }
}

test('local recovery response is exact, character-bound, and always unapproved', () => {
  const expected = record()
  const response = localRecoveryPackageResponseView({ record: expected }, expected.characterUid)
  assert.deepEqual(response.record, expected)
  assert.equal(Object.isFrozen(response.record), true)
  assert.equal(Object.isFrozen(response.record.items), true)
  const list = localRecoveryPackageListView({ records: [expected] }, expected.characterUid)
  assert.equal(list.records.length, 1)

  assert.throws(() => localRecoveryPackageResponseView({
    record: { ...expected, quarantineStatus: 'approved' },
  }, expected.characterUid))
  assert.throws(() => localRecoveryPackageListView({ records: [expected] }, uid(99)))
  const moved = structuredClone(expected)
  moved.items[0].relativePath = 'characters/other/recovery.png'
  assert.throws(() => localRecoveryPackageResponseView({ record: moved }, expected.characterUid))
  assert.throws(() => localRecoveryPackageResponseView({
    record: { ...expected, unexpected: true },
  }, expected.characterUid))
})

test('local recovery UI uses the strict multipart API and guards stale role changes', () => {
  const panel = fs.readFileSync(
    path.join(sourceRoot, 'components/assets/LocalRecoveryPackagePanel.vue'),
    'utf8',
  )
  const api = fs.readFileSync(
    path.join(sourceRoot, 'api/v2/localRecoveryPackages.js'),
    'utf8',
  )
  const transport = fs.readFileSync(
    path.join(sourceRoot, 'api/v2/workflowRequest.js'),
    'utf8',
  )
  assert.match(panel, /localRecoveryPackageAPI/u)
  assert.match(panel, /不会重新生图/u)
  assert.match(panel, /本地恢复 · 未批准/u)
  assert.match(panel, /role="alert"/u)
  assert.match(panel, /token === generation/u)
  assert.match(panel, /刷新记录/u)
  assert.match(api, /parseStrictJson/u)
  assert.match(api, /workflowFormJsonTextRequest/u)
  assert.match(transport, /responseType: 'text'/u)
  assert.match(transport, /form instanceof FormData/u)
})

test('local recovery API sends bounded multipart fields and strictly parses responses', async () => {
  const expected = record()
  const calls = []
  const api = createLocalRecoveryPackageAPI({
    formRequest: {
      async post(url, body) {
        calls.push(['post', url, [...body.keys()]])
        return JSON.stringify({ record: expected })
      },
    },
    jsonRequest: {
      async get(url) {
        calls.push(['get', url])
        return JSON.stringify({ records: [expected] })
      },
    },
  })
  const file = new Blob(['synthetic zip'], { type: 'application/zip' })
  const imported = await api.importPackage({
    dramaId: 7,
    characterUid: expected.characterUid,
    extractionResultUid: uid(7),
    characterFactId: 'character-alan',
    file,
  })
  assert.equal(imported.record.uid, expected.uid)
  assert.equal((await api.list(7, expected.characterUid)).records.length, 1)
  assert.deepEqual(calls, [
    ['post', `/v2/dramas/7/characters/${expected.characterUid}/local-recovery-packages`, [
      'package', 'extractionResultUid', 'characterFactId',
    ]],
    ['get', `/v2/dramas/7/characters/${expected.characterUid}/local-recovery-packages`],
  ])

  const invalidApi = createLocalRecoveryPackageAPI({
    formRequest: { async post() { return '{"record":{},"record":{}}' } },
    jsonRequest: { async get() { return '{"records":[],"records":[]}' } },
  })
  await assert.rejects(invalidApi.list(7, expected.characterUid))
})
