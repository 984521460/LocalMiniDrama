import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostIdentityConfirmationPayload,
  hostIdentityProbeView,
} from '../src/remote/hostIdentity.js'

const FINGERPRINT = `SHA256:${'A'.repeat(43)}`
const CONNECTION_UID = '00000000-0000-4000-8000-000000004650'

function candidate(overrides = {}) {
  return {
    connectionUid: CONNECTION_UID,
    algorithm: 'ssh-ed25519',
    fingerprint: FINGERPRINT,
    stateVersion: 0,
    requiresConfirmation: true,
    status: 'pending',
    ...overrides,
  }
}

test('host identity response and confirmation boundaries are exact', () => {
  const parsed = hostIdentityProbeView(candidate())
  assert.deepEqual(parsed, candidate())
  assert.ok(Object.isFrozen(parsed))
  assert.deepEqual(hostIdentityConfirmationPayload(parsed), {
    expectedStateVersion: 0,
    fingerprint: FINGERPRINT,
  })
  assert.throws(() => hostIdentityProbeView({ ...candidate(), fingerprint: 'SHA256:fixture' }))
  assert.throws(() => hostIdentityProbeView({ ...candidate(), secret: 'must-not-pass' }))
  assert.throws(() => hostIdentityProbeView(candidate({ status: 'confirmed', requiresConfirmation: true })))
})
