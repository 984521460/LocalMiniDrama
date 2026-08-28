const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createHostIdentityConfirmationRequest,
  createRemoteHostIdentityService,
  isRemoteHostIdentityError,
} = require('../src/remote/hostIdentity');
const { createV2Repositories } = require('../src/repositories/v2');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');

const FINGERPRINT_A = `SHA256:${'A'.repeat(43)}`;
const FINGERPRINT_B = `SHA256:${'B'.repeat(43)}`;

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function createConnection(repository, connectionUid = uid(18000)) {
  return repository.createConnection({
    uid: connectionUid,
    name: 'Synthetic host identity',
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
    hostFingerprint: null,
    credentialRef: `credential:v1:${uid(18001)}`,
    status: 'unverified',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  });
}

test('host identity confirmation input is exact and canonical', () => {
  assert.deepEqual(createHostIdentityConfirmationRequest({
    expectedStateVersion: 0,
    fingerprint: FINGERPRINT_A,
  }), {
    expectedStateVersion: 0,
    fingerprint: FINGERPRINT_A,
  });
  for (const invalid of [
    { expectedStateVersion: 0, fingerprint: 'SHA256:fixture' },
    { expectedStateVersion: 0, fingerprint: `${FINGERPRINT_A}=` },
    { expectedStateVersion: -1, fingerprint: FINGERPRINT_A },
    { expectedStateVersion: 0, fingerprint: FINGERPRINT_A, accept: true },
  ]) assert.throws(() => createHostIdentityConfirmationRequest(invalid));
});

test('first trust requires explicit confirmation and a second probe of the same key', async (t) => {
  const database = createMigratedV2Database(t);
  const repository = createV2Repositories(database).remote;
  const connection = createConnection(repository);
  let probeCount = 0;
  const service = createRemoteHostIdentityService({
    repository,
    async probeHostIdentity(endpoint) {
      probeCount += 1;
      assert.deepEqual(endpoint, {
        host: connection.host,
        port: connection.port,
        username: connection.username,
      });
      return { algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT_A };
    },
  });

  const candidate = await service.probe(connection.uid);
  assert.deepEqual(candidate, {
    connectionUid: connection.uid,
    algorithm: 'ssh-ed25519',
    fingerprint: FINGERPRINT_A,
    stateVersion: 0,
    requiresConfirmation: true,
    status: 'pending',
  });
  assert.equal(repository.getConnection(connection.uid).hostFingerprint, null);

  const confirmed = await service.confirm(connection.uid, {
    expectedStateVersion: candidate.stateVersion,
    fingerprint: candidate.fingerprint,
  });
  assert.equal(probeCount, 2);
  assert.equal(confirmed.requiresConfirmation, false);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.stateVersion, 1);
  const persisted = repository.getConnection(connection.uid);
  assert.equal(persisted.hostFingerprint, FINGERPRINT_A);
  assert.equal(persisted.status, 'ready');

  const repeated = await service.probe(connection.uid);
  assert.equal(repeated.requiresConfirmation, false);
  assert.equal(repeated.status, 'confirmed');
  assert.equal(repeated.stateVersion, 1);
});

test('changed host keys are blocked and persisted as changed without accepting the new key', async (t) => {
  const database = createMigratedV2Database(t);
  const repository = createV2Repositories(database).remote;
  const connection = createConnection(repository, uid(18010));
  const first = createRemoteHostIdentityService({
    repository,
    async probeHostIdentity() {
      return { algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT_A };
    },
  });
  await first.confirm(connection.uid, {
    expectedStateVersion: 0,
    fingerprint: FINGERPRINT_A,
  });

  const changed = createRemoteHostIdentityService({
    repository,
    async probeHostIdentity() {
      return { algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT_B };
    },
  });
  await assert.rejects(
    changed.probe(connection.uid),
    (error) => isRemoteHostIdentityError(error)
      && error.code === 'REMOTE_HOST_FINGERPRINT_CHANGED',
  );
  const persisted = repository.getConnection(connection.uid);
  assert.equal(persisted.hostFingerprint, FINGERPRINT_A);
  assert.equal(persisted.status, 'changed');
  assert.equal(persisted.stateVersion, 2);

  const repeatedVersion = persisted.stateVersion;
  await assert.rejects(changed.probe(connection.uid), {
    code: 'REMOTE_HOST_FINGERPRINT_CHANGED',
  });
  assert.equal(repository.getConnection(connection.uid).stateVersion, repeatedVersion);

  const restored = createRemoteHostIdentityService({
    repository,
    async probeHostIdentity() {
      return { algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT_A };
    },
  });
  const restoration = await restored.probe(connection.uid);
  assert.equal(restoration.requiresConfirmation, true);
  const reconfirmed = await restored.confirm(connection.uid, {
    expectedStateVersion: restoration.stateVersion,
    fingerprint: restoration.fingerprint,
  });
  assert.equal(reconfirmed.status, 'confirmed');
  assert.equal(repository.getConnection(connection.uid).status, 'ready');
});
