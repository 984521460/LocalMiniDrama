import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import {
  createIdentityVersionRequest,
  createVoiceProfileActivationRequest,
  createVoiceProfileRequest,
  createVoiceVersionRequest,
  voiceProfileConfigurationView,
} from '../src/audio/voiceProfileConfiguration.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const sourceRoot = path.resolve(directory, '../src')
const schemasRoot = path.resolve(directory, '../../schemas')
const uid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const credentialRef = `credential:v1:${uid(1)}`

function stateFixture() {
  return {
    schemaVersion: 'voice-profile-configuration.v1',
    dramaUid: uid(2),
    characterUid: uid(3),
    identityVersions: [{
      schemaVersion: '5.0', kind: 'identity', uid: uid(4), characterUid: uid(3),
      parentUid: null,
      metadata: { name: 'Hero', visualSignature: 'silver hair', colorAnchors: ['#112233'] },
      createdAtEpochMs: 1,
    }],
    voiceVersions: [{
      schemaVersion: '5.0', kind: 'voice', uid: uid(5), characterUid: uid(3),
      identityVersionUid: uid(4), parentUid: null,
      metadata: { name: 'Mandarin calm', language: 'zh-CN', style: 'calm' },
      createdAtEpochMs: 2,
    }],
    profiles: [{
      schemaVersion: '8.0', uid: uid(6), dramaUid: uid(2), characterUid: uid(3),
      characterVoiceVersionUid: uid(5), parentUid: null, revision: 1,
      provider: 'openai-compatible', model: 'gpt-4o-mini-tts', voiceKey: 'alloy',
      sourceKind: 'provider-preset', status: 'ready', defaultEmotion: 'neutral',
      emotionMap: {
        neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
        fearful: 'fearful', surprised: 'surprised',
      },
      minimumSpeedPermille: 500, defaultSpeedPermille: 1000,
      maximumSpeedPermille: 2000,
      voiceVersion: {
        uid: uid(5), identityVersionUid: uid(4), parentUid: null,
        name: 'Mandarin calm', language: 'zh-CN', style: 'calm', createdAtEpochMs: 2,
      },
      credentialConfigured: true,
      createdAtEpochMs: 3,
    }],
    active: { profileUid: uid(6), stateVersion: 1, changedAtEpochMs: 4 },
  }
}

test('frontend voice configuration contract is exact and secret-free', () => {
  const state = voiceProfileConfigurationView(stateFixture())
  assert.equal(state.identityVersions[0].kind, 'identity')
  assert.equal(state.voiceVersions[0].identityVersionUid, uid(4))
  assert.equal(state.profiles[0].credentialConfigured, true)
  assert.equal(state.active.profileUid, uid(6))
  assert.equal('credentialRef' in state.profiles[0], false)
  assert.throws(() => voiceProfileConfigurationView({ ...stateFixture(), extra: true }))
  assert.throws(() => voiceProfileConfigurationView({
    ...stateFixture(), profiles: [{ ...stateFixture().profiles[0], credentialRef }],
  }))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  for (const relativePath of [
    'v5/character-version.schema.json', 'v8/voice-profile.schema.json',
  ]) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(schemasRoot, relativePath), 'utf8')))
  }
  const validate = ajv.compile(JSON.parse(fs.readFileSync(
    path.join(schemasRoot, 'v9/voice-profile-configuration.schema.json'), 'utf8',
  )))
  assert.equal(validate(state), true, JSON.stringify(validate.errors))
})

test('frontend builds exact identity, voice, profile, and activation requests', () => {
  assert.deepEqual(createIdentityVersionRequest({
    parentUid: null, expectedVersionCount: 0, name: 'Hero',
    visualSignature: 'silver hair', colorAnchors: ['#112233'],
  }), {
    parent_uid: null, expected_version_count: 0, name: 'Hero',
    visual_signature: 'silver hair', color_anchors: ['#112233'],
  })
  assert.deepEqual(createVoiceVersionRequest({
    identityVersionUid: uid(4), parentUid: null, expectedVersionCount: 0,
    name: 'Mandarin calm', language: 'zh-CN', style: 'calm',
  }), {
    identity_version_uid: uid(4), parent_uid: null, expected_version_count: 0,
    name: 'Mandarin calm', language: 'zh-CN', style: 'calm',
  })
  const profile = createVoiceProfileRequest({
    characterVoiceVersionUid: uid(5), parentUid: null, expectedRevision: 0,
    provider: 'openai-compatible', model: 'gpt-4o-mini-tts', voiceKey: 'alloy',
    credentialRef, defaultEmotion: 'neutral',
    emotionMap: {
      neutral: 'neutral', happy: 'happy', sad: 'sad', angry: 'angry',
      fearful: 'fearful', surprised: 'surprised',
    },
    minimumSpeedPermille: 500, defaultSpeedPermille: 1000,
    maximumSpeedPermille: 2000,
  })
  assert.equal(profile.credential_ref, credentialRef)
  assert.deepEqual(createVoiceProfileActivationRequest({ expectedStateVersion: 1 }), {
    expected_state_version: 1,
  })
  assert.throws(() => createVoiceProfileActivationRequest({ expectedStateVersion: -1 }))
})

test('DramaDetail mounts an explicit per-character voice configuration panel', () => {
  const page = fs.readFileSync(path.join(sourceRoot, 'views/DramaDetail.vue'), 'utf8')
  const panel = fs.readFileSync(path.join(
    sourceRoot, 'components/CharacterVoiceProfilePanel.vue',
  ), 'utf8')
  const api = fs.readFileSync(path.join(sourceRoot, 'api/v2/voiceProfiles.js'), 'utf8')
  assert.match(page, /CharacterVoiceProfilePanel/u)
  assert.match(page, /音色配置/u)
  assert.match(panel, /身份版本/u)
  assert.match(panel, /音色版本/u)
  assert.match(panel, /Voice Profile/u)
  assert.match(panel, /credentialRef/u)
  assert.doesNotMatch(panel, /localStorage|sessionStorage/u)
  assert.match(api, /workflowJsonTextRequest/u)
  assert.match(api, /voiceProfileConfigurationView/u)
})
