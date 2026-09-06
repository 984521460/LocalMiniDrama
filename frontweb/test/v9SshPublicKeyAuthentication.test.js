import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  remoteConnectionCreatePayload,
  remoteCredentialReplacementPayload,
  remoteConnectionView,
  sshPublicKeyView,
} from '../src/remote/connectionProfile.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

function keyRecord() {
  return {
    uid: uid(19200), name: 'Featurize 3090', host: 'workspace.example.invalid', port: 33044,
    username: 'featurize', hostFingerprint: null, status: 'unverified',
    createdAt: '2026-09-06T09:00:00.000Z', updatedAt: '2026-09-06T09:00:00.000Z',
    authMethod: 'publickey', comfyHost: '127.0.0.1', comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio', environmentReport: null,
    environmentCheckedAtEpochMs: null, stateVersion: 0,
    connectionEvidenceSha256: 'a'.repeat(64), credentialKind: 'ssh_private_key',
    credentialConfigured: true,
  }
}

test('frontend contracts accept only matching public-key authentication records and payloads', () => {
  assert.deepEqual(remoteConnectionView(keyRecord()), keyRecord())
  assert.throws(() => remoteConnectionView({ ...keyRecord(), credentialKind: 'ssh_password' }))
  const form = {
    name: 'Featurize 3090', host: 'workspace.example.invalid', port: 33044,
    username: 'featurize', authMethod: 'publickey', password: '', comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  }
  assert.deepEqual(remoteConnectionCreatePayload(form), {
    name: form.name, host: form.host, port: form.port, username: form.username,
    authMethod: 'publickey', comfyHost: '127.0.0.1', comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  })
  assert.deepEqual(remoteCredentialReplacementPayload(keyRecord(), {
    authMethod: 'publickey', password: '',
  }), { expectedStateVersion: 0, authMethod: 'publickey' })
});

test('public-key response is strict, non-secret, and ready for authorized_keys', () => {
  const view = sshPublicKeyView({
    contractVersion: 'ssh-public-key.v1',
    connectionUid: uid(19200),
    algorithm: 'ssh-ed25519',
    publicKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)} local-mini-drama`,
    fingerprint: `SHA256:${'A'.repeat(43)}`,
  })
  assert.ok(Object.isFrozen(view))
  assert.equal(Object.hasOwn(view, 'privateKey'), false)
  assert.throws(() => sshPublicKeyView({ ...view, privateKey: 'must-not-pass' }))
  assert.throws(() => sshPublicKeyView({
    ...view,
    publicKey: `ssh-ed25519 ${'A'.repeat(68)} local-mini-drama`,
  }))
});

test('remote connection UI offers generated-key rotation without a private-key input', () => {
  const component = fs.readFileSync(
    path.resolve(__dirname, '../src/views/RemoteConnections.vue'),
    'utf8',
  )
  assert.match(component, /SSH 密钥/u)
  assert.match(component, /生成 Ed25519/u)
  assert.match(component, /查看公钥/u)
  assert.doesNotMatch(component, /私钥.*v-model|privateKey/u)
})
