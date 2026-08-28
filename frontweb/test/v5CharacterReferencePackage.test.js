import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CHARACTER_REFERENCE_ITEM_KINDS,
  characterReferencePackageRequest,
  characterReferencePackageView,
  characterUidPath,
} from '../src/assets/characterReferencePackage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

function packageRecord() {
  const characterUid = uid(1)
  const packageUid = uid(2)
  return {
    schemaVersion: '5.0',
    packageUid,
    characterUid,
    identityVersionUid: uid(3),
    candidateUid: uid(4),
    lockEventUid: uid(5),
    lockStateVersion: 1,
    appearanceVersion: {
      uid: uid(6),
      name: '默认外貌',
      description: '椭圆脸，黑色直发，琥珀色眼睛。',
      colorAnchors: ['#112233', '#d6a77a'],
    },
    defaultCostumeVersion: {
      uid: uid(7),
      name: '默认服装',
      description: '深灰夹克与米白衬衫。',
      colorAnchors: ['#232323', '#f5f0df'],
    },
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      uid: uid(20 + ordinal),
      ordinal,
      kind,
      assetVersionUid: uid(40 + ordinal),
      logicalUri: `asset://characters/${characterUid}/reference-packages/${packageUid}/${kind}`,
      mediaType: 'image/png',
      width: 1024,
      height: 1024,
      contentSha256: `${ordinal + 1}`.padStart(64, '0'),
    })),
    createdAtEpochMs: 0,
  }
}

test('reference package view exposes every required view and expression with version identity', () => {
  const view = characterReferencePackageView(packageRecord())
  assert.equal(view.title, '角色参考包 #1')
  assert.equal(view.items.length, 10)
  assert.deepEqual(view.items.map((item) => item.kind), CHARACTER_REFERENCE_ITEM_KINDS)
  assert.deepEqual(view.items.map((item) => item.label), [
    '正面半身', '脸部四分之三侧', '左侧面', '右侧面', '正面全身',
    '中性表情', '喜悦', '愤怒', '悲伤', '恐惧',
  ])
  assert.equal(view.appearance.description, '椭圆脸，黑色直发，琥珀色眼睛。')
  assert.equal(view.defaultCostume.name, '默认服装')
  assert.ok(Object.isFrozen(view))
  assert.ok(Object.isFrozen(view.items))
});

test('reference package UI boundary fails closed on missing items and mismatched asset URIs', () => {
  const record = packageRecord()
  assert.throws(
    () => characterReferencePackageView({ ...record, items: record.items.slice(0, 9) }),
    /Character reference package response is invalid/,
  )
  assert.throws(
    () => characterReferencePackageView({
      ...record,
      items: record.items.map((item, index) => index === 0
        ? { ...item, logicalUri: 'asset://characters/other/reference-packages/other/front_half_body' }
        : item),
    }),
    /Character reference package response is invalid/,
  )
});

test('reference package UI uses Unicode code-point limits shared by backend and Schema', () => {
  const record = packageRecord()
  assert.doesNotThrow(() => characterReferencePackageView({
    ...record,
    appearanceVersion: {
      ...record.appearanceVersion,
      name: '😀'.repeat(120),
      description: '😀'.repeat(2001),
    },
  }))
  assert.throws(() => characterReferencePackageView({
    ...record,
    appearanceVersion: {
      ...record.appearanceVersion,
      name: '😀'.repeat(121),
    },
  }), /Character reference package response is invalid/)
  assert.throws(() => characterReferencePackageView({
    ...record,
    appearanceVersion: {
      ...record.appearanceVersion,
      description: '😀'.repeat(4001),
    },
  }), /Character reference package response is invalid/)
});

test('reference package request serializes only exact version references in canonical order', () => {
  const input = {
    appearanceVersionUid: uid(60),
    costumeVersionUid: uid(61),
    expectedLockStateVersion: 2,
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      kind,
      assetVersionUid: uid(70 + ordinal),
    })),
  }
  assert.deepEqual(characterReferencePackageRequest(input), {
    appearance_version_uid: uid(60),
    costume_version_uid: uid(61),
    expected_lock_state_version: 2,
    items: CHARACTER_REFERENCE_ITEM_KINDS.map((kind, ordinal) => ({
      kind,
      asset_version_uid: uid(70 + ordinal),
    })),
  })
  assert.throws(() => characterReferencePackageRequest({
    ...input,
    extra: 'not allowed',
  }), /Character reference package request is invalid/)
  assert.equal(characterUidPath(uid(99)), uid(99))
  assert.throws(() => characterUidPath('../99'), /Character uid is invalid/)
});

test('reference package component remains a bounded package viewer', () => {
  const componentPath = path.resolve(
    __dirname,
    '../src/components/assets/CharacterReferencePackageCard.vue',
  )
  const source = fs.readFileSync(componentPath, 'utf8')
  assert.match(source, /characterReferencePackageView/)
  assert.match(source, /reference-package__items/)
  assert.doesNotMatch(source, /axios|fetch\(|provider|api[_-]?key|secret/i)
});
