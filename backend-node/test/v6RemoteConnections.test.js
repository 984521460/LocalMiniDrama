const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createRemoteConnectionRecord,
  createRemoteConnectionRequest,
  createRemoteConnectionUpdateRequest,
  createRemoteCredentialReplacementRequest,
  remoteConnectionEvidenceSha256,
} = require('../src/remote/connectionProfile');
const {
  createRemoteConnectionService,
  isRemoteConnectionError,
} = require('../src/remote/connectionService');
const {
  V2RepositoryConflictError,
  createV2Repositories,
} = require('../src/repositories/v2');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function request(overrides = {}) {
  return {
    name: 'Featurize 4090',
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
    authMethod: 'password',
    secret: 'synthetic-password-value',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
    ...overrides,
  };
}

function createFakeVault() {
  const records = new Map();
  let sequence = 16000;
  return Object.freeze({
    records,
    async store(input) {
      const ref = `credential:v1:${uid(sequence)}`;
      sequence += 1;
      records.set(ref, { kind: input.kind, secret: input.secret });
      return Object.freeze({ ref, kind: input.kind, configured: true });
    },
    async inspect(ref) {
      const record = records.get(ref);
      if (!record) {
        const error = new Error('not found');
        error.code = 'CREDENTIAL_NOT_FOUND';
        throw error;
      }
      return Object.freeze({ ref, kind: record.kind, configured: true });
    },
    async remove(ref) {
      return records.delete(ref);
    },
  });
}

test('remote connection requests are exact, bounded, and accessor safe', () => {
  const parsed = createRemoteConnectionRequest(request());
  assert.deepEqual(parsed, request());
  assert.ok(Object.isFrozen(parsed));

  for (const invalid of [
    request({ host: 'https://workspace.example.invalid' }),
    request({ host: 'user@workspace.example.invalid' }),
    request({ port: 0 }),
    request({ username: '../worker' }),
    request({ comfyHost: '0.0.0.0' }),
    request({ remoteWorkDir: '../jobs' }),
    request({ authMethod: 'keyboard-interactive' }),
    { ...request(), credentialRef: `credential:v1:${uid(1)}` },
  ]) assert.throws(() => createRemoteConnectionRequest(invalid));

  let reads = 0;
  const hostile = request();
  Object.defineProperty(hostile, 'secret', {
    enumerable: true,
    get() {
      reads += 1;
      return 'must-not-be-read';
    },
  });
  assert.throws(() => createRemoteConnectionRequest(hostile));
  assert.equal(reads, 0);

  assert.deepEqual(createRemoteConnectionUpdateRequest({
    expectedStateVersion: 0,
    name: 'Updated worker',
    host: 'gpu.example.invalid',
    port: 22,
    username: 'worker',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio/jobs',
  }), {
    expectedStateVersion: 0,
    name: 'Updated worker',
    host: 'gpu.example.invalid',
    port: 22,
    username: 'worker',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio/jobs',
  });
  assert.deepEqual(createRemoteCredentialReplacementRequest({
    expectedStateVersion: 3,
    secret: 'replacement-password-value',
  }), {
    expectedStateVersion: 3,
    secret: 'replacement-password-value',
  });
  assert.throws(() => createRemoteCredentialReplacementRequest({
    expectedStateVersion: 3,
    secret: '',
  }));
});

test('connection service persists only opaque references and exposes configured semantics', async (t) => {
  const database = createMigratedV2Database(t);
  const repository = createV2Repositories(database).remote;
  const vault = createFakeVault();
  const connectionUid = uid(16010);
  const service = createRemoteConnectionService({
    repository,
    vault,
    createUid: () => connectionUid,
  });

  const created = await service.create(request());
  assert.equal(created.uid, connectionUid);
  assert.equal(created.credentialConfigured, true);
  assert.equal(created.credentialKind, 'ssh_password');
  assert.match(created.connectionEvidenceSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(created, 'credentialRef'), false);
  assert.equal(JSON.stringify(created).includes('synthetic-password-value'), false);

  const stored = database.prepare('SELECT * FROM remote_connections WHERE uid = ?').get(connectionUid);
  assert.match(stored.credential_ref, /^credential:v1:/u);
  assert.equal(JSON.stringify(stored).includes('synthetic-password-value'), false);
  assert.equal(vault.records.get(stored.credential_ref).secret, 'synthetic-password-value');

  assert.deepEqual(await service.get(connectionUid), created);
  assert.deepEqual(await service.list(), [created]);

  const updated = await service.update(connectionUid, {
    expectedStateVersion: 0,
    name: 'Updated worker',
    host: 'gpu.example.invalid',
    port: 22,
    username: 'worker',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio/jobs',
  });
  assert.equal(updated.name, 'Updated worker');
  assert.equal(updated.stateVersion, 1);
  assert.equal(updated.status, 'unverified');
  assert.equal(updated.hostFingerprint, null);
  assert.notEqual(updated.connectionEvidenceSha256, created.connectionEvidenceSha256);
  const oldCredentialRef = stored.credential_ref;
  const replaced = await service.replaceCredential(connectionUid, {
    expectedStateVersion: 1,
    secret: 'replacement-password-value',
  });
  assert.equal(replaced.stateVersion, 2);
  assert.notEqual(replaced.connectionEvidenceSha256, updated.connectionEvidenceSha256);
  const replacedRow = database.prepare(
    'SELECT credential_ref, state_version FROM remote_connections WHERE uid = ?',
  ).get(connectionUid);
  assert.notEqual(replacedRow.credential_ref, oldCredentialRef);
  assert.equal(replacedRow.state_version, 2);
  assert.equal(vault.records.has(oldCredentialRef), false);
  assert.equal(vault.records.get(replacedRow.credential_ref).secret, 'replacement-password-value');
  assert.equal(JSON.stringify(replaced).includes('replacement-password-value'), false);
  assert.equal(
    replaced.connectionEvidenceSha256,
    remoteConnectionEvidenceSha256(repository.getConnection(connectionUid)),
  );
  await assert.rejects(
    service.update(connectionUid, {
      expectedStateVersion: 0,
      name: 'stale',
      host: 'gpu.example.invalid',
      port: 22,
      username: 'worker',
      comfyHost: '127.0.0.1',
      comfyPort: 8188,
      remoteWorkDir: 'ai-drama-studio/jobs',
    }),
    (error) => isRemoteConnectionError(error) && error.code === 'REMOTE_CONNECTION_CONFLICT',
  );
});

test('reserved environment reports fail closed at database and record boundaries', async (t) => {
  const database = createMigratedV2Database(t);
  const repository = createV2Repositories(database).remote;
  const service = createRemoteConnectionService({
    repository,
    vault: createFakeVault(),
    createUid: () => uid(16011),
  });
  await service.create(request());

  const syntheticReport = JSON.stringify({
    password: 'synthetic-secret-must-not-persist',
  });
  assert.throws(() => database.prepare(`
    UPDATE remote_connections
    SET environment_report_json = ?, environment_checked_at_epoch_ms = ?
    WHERE uid = ?
  `).run(syntheticReport, 0, uid(16011)));

  const persisted = repository.getConnection(uid(16011));
  assert.equal(persisted.environmentReport, null);
  assert.equal(persisted.environmentCheckedAtEpochMs, null);
  assert.throws(() => createRemoteConnectionRecord({
    ...persisted,
    environmentReport: { password: 'synthetic-secret-must-not-persist' },
  }));
  assert.throws(() => createRemoteConnectionRecord({
    ...persisted,
    environmentCheckedAtEpochMs: 0,
  }));

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-connection.schema.json'),
    'utf8',
  ));
  assert.deepEqual(schema.properties.environmentReport, { type: 'null' });
  assert.deepEqual(schema.properties.environmentCheckedAtEpochMs, { type: 'null' });
  const migrationReadme = fs.readFileSync(
    path.resolve(__dirname, '../migrations/v2/README.md'),
    'utf8',
  );
  assert.match(migrationReadme, /reserved for P6-09[\s\S]*must both remain `NULL`/u);
});

test('failed persistence removes the newly stored credential or reports cleanup deterministically', async () => {
  const vault = createFakeVault();
  const service = createRemoteConnectionService({
    repository: {
      createConnection() {
        throw new V2RepositoryConflictError('remote connection', 'created');
      },
      getConnection() {},
      listConnections() { return []; },
      replaceCredential() {},
      updateConnection() {},
    },
    vault,
    createUid: () => uid(16020),
  });

  await assert.rejects(
    service.create(request()),
    (error) => isRemoteConnectionError(error) && error.code === 'REMOTE_CONNECTION_CONFLICT',
  );
  assert.equal(vault.records.size, 0);

  const cleanupVault = createFakeVault();
  const originalRemove = cleanupVault.remove;
  const uncertainVault = Object.freeze({
    ...cleanupVault,
    async remove(ref) {
      await originalRemove(ref);
      throw new Error('synthetic cleanup uncertainty');
    },
  });
  const uncertainService = createRemoteConnectionService({
    repository: {
      createConnection() {
        throw new V2RepositoryConflictError('remote connection', 'created');
      },
      getConnection() {},
      listConnections() { return []; },
      replaceCredential() {},
      updateConnection() {},
    },
    vault: uncertainVault,
    createUid: () => uid(16021),
  });
  await assert.rejects(
    uncertainService.create(request()),
    (error) => isRemoteConnectionError(error)
      && error.code === 'REMOTE_CONNECTION_CONFLICT',
  );
  assert.equal(cleanupVault.records.size, 0);

  const retainedVault = createFakeVault();
  const retainedService = createRemoteConnectionService({
    repository: {
      createConnection() {
        throw new V2RepositoryConflictError('remote connection', 'created');
      },
      getConnection() {},
      listConnections() { return []; },
      replaceCredential() {},
      updateConnection() {},
    },
    vault: Object.freeze({
      ...retainedVault,
      async remove() { return false; },
    }),
    createUid: () => uid(16022),
  });
  await assert.rejects(
    retainedService.create(request()),
    (error) => isRemoteConnectionError(error)
      && error.code === 'REMOTE_CREDENTIAL_CLEANUP_REQUIRED'
      && /^credential:v1:/u.test(error.credentialRef),
  );
});

test('localhost connection routes never return or log submitted credentials', async (t) => {
  const remoteConnectionRoutes = require('../src/routes/v2/remoteConnections');
  const database = createMigratedV2Database(t);
  const vault = createFakeVault();
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(remoteConnectionRoutes({
    error(event, details) {
      logs.push({ event, details });
    },
  }, {
    credentialVault: vault,
    createUid: () => uid(16030),
    async probeHostIdentity() {
      return { algorithm: 'ssh-ed25519', fingerprint: `SHA256:${'A'.repeat(43)}` };
    },
  }, database));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const createdResponse = await fetch(`${origin}/remote-connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request()),
  });
  assert.equal(createdResponse.status, 201);
  const createdBody = await createdResponse.json();
  assert.equal(createdBody.data.uid, uid(16030));
  assert.equal(Object.hasOwn(createdBody.data, 'credentialRef'), false);
  assert.equal(JSON.stringify(createdBody).includes('synthetic-password-value'), false);

  const listedResponse = await fetch(`${origin}/remote-connections`);
  assert.equal(listedResponse.status, 200);
  const listedBody = await listedResponse.json();
  assert.deepEqual(listedBody.data, [createdBody.data]);

  const replacedResponse = await fetch(`${origin}/remote-connections/${uid(16030)}/credential`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedStateVersion: 0,
      secret: 'replacement-route-password',
    }),
  });
  assert.equal(replacedResponse.status, 200);
  const replacedBody = await replacedResponse.json();
  assert.equal(replacedBody.data.stateVersion, 1);
  assert.equal(JSON.stringify(replacedBody).includes('replacement-route-password'), false);

  const probeResponse = await fetch(
    `${origin}/remote-connections/${uid(16030)}/host-identity/probe`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  assert.equal(probeResponse.status, 200);
  const probeBody = await probeResponse.json();
  assert.equal(probeBody.data.requiresConfirmation, true);
  const confirmResponse = await fetch(
    `${origin}/remote-connections/${uid(16030)}/host-identity/confirm`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedStateVersion: probeBody.data.stateVersion,
        fingerprint: probeBody.data.fingerprint,
      }),
    },
  );
  assert.equal(confirmResponse.status, 200);
  const confirmBody = await confirmResponse.json();
  assert.equal(confirmBody.data.status, 'confirmed');
  assert.equal(confirmBody.data.stateVersion, 2);

  const invalidPath = await fetch(`${origin}/remote-connections/not-a-uuid`);
  assert.equal(invalidPath.status, 400);
  assert.equal((await invalidPath.json()).error.code, 'REMOTE_CONNECTION_INPUT_INVALID');

  const invalidBody = await fetch(`${origin}/remote-connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...request(), credentialRef: `credential:v1:${uid(16031)}` }),
  });
  assert.equal(invalidBody.status, 400);
  assert.equal(vault.records.size, 1);
  assert.equal(JSON.stringify(logs).includes('synthetic-password-value'), false);
});

test('remote connection public record matches strict v6 schema and excludes credential references', async (t) => {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-connection.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const database = createMigratedV2Database(t);
  const service = createRemoteConnectionService({
    repository: createV2Repositories(database).remote,
    vault: createFakeVault(),
    createUid: () => uid(16040),
  });
  const record = await service.create(request());
  assert.equal(validate(record), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...record,
    environmentReport: { password: 'synthetic-secret-must-not-persist' },
  }), false);
  assert.equal(validate({ ...record, environmentCheckedAtEpochMs: 0 }), false);
  assert.equal(validate({ ...record, connectionEvidenceSha256: 'A'.repeat(64) }), false);
  assert.equal(validate({ ...record, credentialRef: `credential:v1:${uid(16041)}` }), false);
  assert.equal(validate({ ...record, credentialConfigured: 'yes' }), false);
});
