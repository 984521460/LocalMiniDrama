import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  bgmLibraryTrackListView,
  bgmLibraryTrackView,
  parseBgmLibraryTrackJson,
  parseBgmLibraryTrackListJson,
} from '../src/audio/bgmLibrary.js'
import { createBgmLibraryState } from '../src/composables/useBgmLibrary.js'

const DRAMA_UID = '00000000-0000-4000-8000-000000000001'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function rawTrack(overrides = {}) {
  return {
    schemaVersion: 'bgm-library-track.v1',
    uid: '00000000-0000-4000-8000-000000000002',
    dramaUid: DRAMA_UID,
    title: 'MVP score',
    mimeType: 'audio/wav',
    durationMs: 1000,
    license: {
      basis: 'licensed',
      commercialUseAllowed: true,
      derivativesAllowed: true,
    },
    exportEligible: true,
    createdAtEpochMs: 100,
    ...overrides,
  }
}

function parsedTrack(overrides = {}) {
  return parseBgmLibraryTrackJson(JSON.stringify(rawTrack(overrides)), DRAMA_UID)
}

test('BGM library accepts only branded strict JSON with exact rights projection', () => {
  const track = parsedTrack()
  assert.equal(bgmLibraryTrackView(track, DRAMA_UID), track)
  const list = parseBgmLibraryTrackListJson(JSON.stringify([rawTrack()]), DRAMA_UID)
  assert.equal(bgmLibraryTrackListView(list, DRAMA_UID), list)
  assert.ok(Object.isFrozen(track))
  assert.ok(Object.isFrozen(track.license))
  assert.ok(Object.isFrozen(list))

  assert.throws(() => bgmLibraryTrackView(rawTrack(), DRAMA_UID))
  assert.throws(() => parsedTrack({ exportEligible: false }))
  assert.throws(() => parsedTrack({ dramaUid: '00000000-0000-4000-8000-000000000009' }))
  assert.throws(() => parseBgmLibraryTrackJson(
    JSON.stringify({ ...rawTrack(), relativePath: 'C:/Users/private/score.wav' }), DRAMA_UID,
  ))
  assert.throws(() => parseBgmLibraryTrackJson(
    '{"schemaVersion":"bgm-library-track.v1","schemaVersion":"forged"}', DRAMA_UID,
  ))

  let traps = 0
  const proxy = new Proxy(rawTrack(), {
    getPrototypeOf(target) { traps += 1; return Reflect.getPrototypeOf(target) },
    ownKeys(target) { traps += 1; return Reflect.ownKeys(target) },
  })
  assert.throws(() => bgmLibraryTrackView(proxy, DRAMA_UID))
  assert.equal(traps, 0)
})

test('BGM library state never auto-selects and only explicitly selects exportable tracks', async () => {
  const eligible = parsedTrack()
  const denied = parsedTrack({
    uid: '00000000-0000-4000-8000-000000000003',
    title: 'Restricted score',
    license: {
      basis: 'licensed', commercialUseAllowed: true, derivativesAllowed: false,
    },
    exportEligible: false,
  })
  const initial = parseBgmLibraryTrackListJson(
    JSON.stringify([rawTrack(), {
      ...rawTrack(),
      uid: denied.uid,
      title: denied.title,
      license: denied.license,
      exportEligible: false,
    }]),
    DRAMA_UID,
  )
  const state = createBgmLibraryState({
    async list() { return initial },
    async importTrack() { return eligible },
  })

  assert.equal(await state.load(DRAMA_UID), true)
  assert.equal(state.selectedTrackUid.value, '')
  assert.equal(state.select(denied.uid), false)
  assert.equal(state.selectedTrackUid.value, '')
  assert.equal(state.select(eligible.uid), true)
  assert.equal(state.selectedTrackUid.value, eligible.uid)

  state.invalidate()
  assert.equal(state.selectedTrackUid.value, '')
  assert.equal(await state.importTrack(DRAMA_UID, { file: {}, title: 'x' }), true)
  assert.equal(state.selectedTrackUid.value, '')
})

test('workflow UI exposes explicit local import and selection without automatic execution', () => {
  const panel = fs.readFileSync(
    path.join(ROOT, 'src/components/audio/BgmLibraryPanel.vue'), 'utf8',
  )
  const canvas = fs.readFileSync(path.join(ROOT, 'src/views/WorkflowCanvas.vue'), 'utf8')
  assert.match(panel, /type="file"/u)
  assert.match(panel, /\$emit\('select', track\.uid\)/u)
  assert.match(panel, /不会联网获取音乐/u)
  assert.doesNotMatch(panel, /onMounted|execute-next|preflight/u)
  assert.match(canvas, /@import="importBgmTrack"/u)
  assert.match(canvas, /@select="selectBgmTrack"/u)
  assert.match(canvas, /尚未创建成片导出计划/u)
})
