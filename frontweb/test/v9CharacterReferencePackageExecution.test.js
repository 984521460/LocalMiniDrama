import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { CHARACTER_REFERENCE_ITEM_KINDS } from '../src/assets/characterReferencePackage.js'
import {
  characterReferencePackageExecutionRequestView,
  characterReferencePackageExecutionResponseView,
  createCharacterReferencePackageExecutionRequest,
} from '../src/characterCandidates/characterReferencePackageExecution.js'
import {
  useCharacterReferencePackageExecution,
} from '../src/composables/useCharacterReferencePackageExecution.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

function request() {
  return {
    schemaVersion: 'character-reference-package-execution-request.v1',
    operationUid: uid(1),
    dramaUid: uid(2),
    characterUid: uid(3),
    candidateExecutionUid: uid(4),
    candidateUid: uid(5),
    width: 512,
    height: 512,
    seed: 42,
  }
}

function packageRecord() {
  const input = request()
  return {
    schemaVersion: '5.0',
    packageUid: input.operationUid,
    characterUid: input.characterUid,
    identityVersionUid: uid(6),
    candidateUid: input.candidateUid,
    lockEventUid: uid(7),
    lockStateVersion: 1,
    appearanceVersion: {
      uid: uid(8),
      name: '默认外貌',
      description: '黑色短发，深灰工作夹克。',
      colorAnchors: ['#1f2937', '#d6a77a'],
    },
    defaultCostumeVersion: {
      uid: uid(9),
      name: '默认服装',
      description: '深灰工作夹克。',
      colorAnchors: ['#374151', '#f3f4f6'],
    },
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      uid: uid(20 + ordinal),
      ordinal,
      kind,
      assetVersionUid: uid(40 + ordinal),
      logicalUri: `asset://characters/${input.characterUid}/reference-packages/${input.operationUid}/${kind}`,
      mediaType: 'image/png',
      width: 512,
      height: 512,
      contentSha256: String(ordinal + 1).padStart(64, '0'),
    })),
    createdAtEpochMs: 0,
  }
}

test('reference package execution request and response bind the selected candidate', () => {
  const parsed = characterReferencePackageExecutionRequestView(request())
  assert.equal(parsed.candidateUid, uid(5))
  const { schemaVersion: _schemaVersion, ...requestInput } = request()
  assert.deepEqual(createCharacterReferencePackageExecutionRequest(requestInput), parsed)
  const response = characterReferencePackageExecutionResponseView(
    { package: packageRecord() },
    request(),
  )
  assert.equal(response.view.candidateUid, parsed.candidateUid)
  assert.equal(response.view.items.length, 10)
  assert.throws(() => characterReferencePackageExecutionRequestView({
    ...request(), extra: true,
  }))
  assert.throws(() => characterReferencePackageExecutionResponseView({
    package: { ...packageRecord(), candidateUid: uid(99) },
  }, request()))
})

test('reference package execution composable keeps only the latest completion', async () => {
  const pending = []
  const composable = useCharacterReferencePackageExecution({
    packageApi: {
      execute(dramaId, body) {
        return new Promise((resolve) => pending.push({ dramaId, body, resolve }))
      },
    },
  })
  const first = composable.execute({ dramaId: 1, ...request() })
  const secondRequest = { ...request(), operationUid: uid(10) }
  const second = composable.execute({ dramaId: 1, ...secondRequest })
  pending[0].resolve({ package: packageRecord() })
  assert.equal(await first, null)
  pending[1].resolve({ package: { ...packageRecord(), packageUid: uid(10) } })
  assert.equal((await second).package.packageUid, uid(10))
  assert.equal(composable.last.value.package.packageUid, uid(10))
})

test('candidate panel requires explicit ten-call confirmation and renders the package card', () => {
  const source = fs.readFileSync(path.resolve(
    __dirname,
    '../src/components/assets/CharacterCandidateExecutionPanel.vue',
  ), 'utf8')
  assert.match(source, /锁定并生成 10 项参考包/u)
  assert.match(source, /独立提交 10 次参考图生成请求/u)
  assert.match(source, /CharacterReferencePackageCard/u)
  assert.match(source, /candidateExecutionUid/u)
  assert.match(source, /selectedCandidateUid/u)
  assert.match(source, /referenceExecution\.execute/u)
  assert.match(source, /paidActionBusy\.value \|\| busy\.value \|\| referenceExecution\.busy\.value/u)
  assert.match(source, /:disabled="!selectedCandidateUid \|\| busy\.value \|\| paidActionBusy"/u)
})
