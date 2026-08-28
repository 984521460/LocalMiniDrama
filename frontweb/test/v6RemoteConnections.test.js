import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  remoteConnectionCreatePayload,
  remoteConnectionListView,
  remoteConnectionUpdatePayload,
  remoteCredentialReplacementPayload,
  remoteConnectionView,
} from '../src/remote/connectionProfile.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

function record(overrides = {}) {
  return {
    uid: uid(17000),
    name: 'Featurize 4090',
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
    hostFingerprint: null,
    status: 'unverified',
    createdAt: '2026-08-28T06:00:00.000Z',
    updatedAt: '2026-08-28T06:00:00.000Z',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
    environmentReport: null,
    environmentCheckedAtEpochMs: null,
    stateVersion: 0,
    connectionEvidenceSha256: 'a'.repeat(64),
    credentialKind: 'ssh_password',
    credentialConfigured: true,
    ...overrides,
  }
}

test('remote connection response boundary is strict and secret-free', () => {
  const view = remoteConnectionView(record())
  assert.deepEqual(view, record())
  assert.ok(Object.isFrozen(view))
  assert.deepEqual(remoteConnectionListView([record()]), [record()])
  assert.throws(() => remoteConnectionView({ ...record(), credentialRef: `credential:v1:${uid(1)}` }))
  assert.throws(() => remoteConnectionView({ ...record(), credentialConfigured: 'yes' }))
  assert.throws(() => remoteConnectionView({ ...record(), connectionEvidenceSha256: 'A'.repeat(64) }))
  assert.throws(() => remoteConnectionView({
    ...record(),
    environmentReport: { password: 'synthetic-secret-must-not-persist' },
  }))
  assert.throws(() => remoteConnectionView({ ...record(), environmentCheckedAtEpochMs: 0 }))
  assert.throws(() => remoteConnectionListView({ 0: record(), length: 1 }))

  let reads = 0
  const hostile = record()
  Object.defineProperty(hostile, 'name', {
    enumerable: true,
    get() {
      reads += 1
      return 'must not run'
    },
  })
  assert.throws(() => remoteConnectionView(hostile))
  assert.equal(reads, 0)
})

test('create and update payloads keep password only in explicit submission payload', () => {
  const form = {
    name: 'Featurize 4090',
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
    password: 'synthetic-password-value',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  }
  const created = remoteConnectionCreatePayload(form)
  assert.deepEqual(created, {
    name: form.name,
    host: form.host,
    port: form.port,
    username: form.username,
    authMethod: 'password',
    secret: form.password,
    comfyHost: '127.0.0.1',
    comfyPort: form.comfyPort,
    remoteWorkDir: form.remoteWorkDir,
  })
  assert.ok(Object.isFrozen(created))
  assert.equal(Object.hasOwn(form, 'secret'), false)

  const update = remoteConnectionUpdatePayload(record(), {
    name: 'Renamed',
    host: 'gpu.example.invalid',
    port: 22,
    username: 'worker',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio/jobs',
  })
  assert.equal(update.expectedStateVersion, 0)
  assert.equal(Object.hasOwn(update, 'password'), false)
  assert.equal(Object.hasOwn(update, 'secret'), false)
  const replacement = remoteCredentialReplacementPayload(record(), 'replacement-password-value')
  assert.deepEqual(replacement, {
    expectedStateVersion: 0,
    secret: 'replacement-password-value',
  })
  assert.ok(Object.isFrozen(replacement))
  assert.throws(() => remoteCredentialReplacementPayload(record(), ''))
  assert.throws(() => remoteConnectionCreatePayload({ ...form, password: '' }))
})

test('remote connection UI never binds a persisted credential value back into the password field', () => {
  const component = fs.readFileSync(
    path.resolve(__dirname, '../src/views/RemoteConnections.vue'),
    'utf8',
  )
  assert.match(component, /type="password"/u)
  assert.match(component, /已配置/u)
  assert.doesNotMatch(component, /credentialRef/u)
  assert.doesNotMatch(component, /v-html|innerHTML|eval\s*\(/u)
})
