const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');
const { utils } = require('ssh2');

const {
  createRemoteConnectionRequest,
  createRemoteCredentialReplacementRequest,
} = require('../src/remote/connectionProfile');
const { createRemoteConnectionService } = require('../src/remote/connectionService');
const { createSshPublicKeyView, generateSshKeyPair } = require('../src/remote/sshKeyPair');
const { createV2Repositories } = require('../src/repositories/v2');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');

function uid(value) {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function publicKeyRequest() {
  return {
    name: 'Featurize 3090',
    host: 'workspace.example.invalid',
    port: 33044,
    username: 'featurize',
    authMethod: 'publickey',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
  };
}

function createFakeVault() {
  const records = new Map();
  let sequence = 19100;
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
    async read(ref) {
      const record = records.get(ref);
      if (!record) throw new Error('not found');
      return record.secret;
    },
    async remove(ref) { return records.delete(ref); },
  });
}

test('generated Ed25519 key pair is OpenSSH-compatible and bounded for Windows Credential Manager', () => {
  const pair = generateSshKeyPair();
  assert.ok(Object.isFrozen(pair));
  assert.match(pair.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]{68} local-mini-drama$/u);
  assert.match(pair.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/u);
  assert.ok(Buffer.byteLength(pair.privateKey, 'utf8') <= 2560);
  const privateKey = utils.parseKey(pair.privateKey);
  const publicKey = utils.parseKey(pair.publicKey);
  assert.equal(privateKey instanceof Error, false);
  assert.equal(publicKey instanceof Error, false);
  assert.equal(privateKey.type, 'ssh-ed25519');
  assert.equal(privateKey.getPublicSSH().equals(publicKey.getPublicSSH()), true);
  assert.throws(() => createSshPublicKeyView(
    uid(19101),
    `ssh-ed25519 ${'A'.repeat(68)} local-mini-drama`,
  ));

  let attempts = 0;
  const retried = generateSshKeyPair(() => {
    attempts += 1;
    return attempts === 1
      ? { private: pair.privateKey, public: `ssh-ed25519 ${'A'.repeat(68)} local-mini-drama` }
      : { private: pair.privateKey, public: pair.publicKey };
  });
  assert.equal(attempts, 2);
  assert.deepEqual(retried, pair);

  let exhaustedAttempts = 0;
  assert.throws(() => generateSshKeyPair(() => {
    exhaustedAttempts += 1;
    return { private: pair.privateKey, public: `ssh-ed25519 ${'A'.repeat(68)} local-mini-drama` };
  }), /SSH key pair value is invalid/u);
  assert.equal(exhaustedAttempts, 16);
});

test('public-key requests are exact and never accept caller-supplied private key material', () => {
  assert.deepEqual(createRemoteConnectionRequest(publicKeyRequest()), publicKeyRequest());
  assert.throws(() => createRemoteConnectionRequest({
    ...publicKeyRequest(),
    secret: '-----BEGIN OPENSSH PRIVATE KEY-----caller-controlled',
  }));
  assert.deepEqual(createRemoteCredentialReplacementRequest({
    expectedStateVersion: 3,
    authMethod: 'publickey',
  }), {
    expectedStateVersion: 3,
    authMethod: 'publickey',
  });
  assert.throws(() => createRemoteCredentialReplacementRequest({
    expectedStateVersion: 3,
    authMethod: 'publickey',
    secret: 'must-not-be-accepted',
  }));
});

test('key generation fails before any Vault or database write', async (t) => {
  const database = createMigratedV2Database(t);
  const vault = createFakeVault();
  const service = createRemoteConnectionService({
    repository: createV2Repositories(database).remote,
    vault,
    createUid: () => uid(19105),
    generateKeyPair() { throw new Error('synthetic generation failure'); },
  });
  await assert.rejects(
    () => service.create(publicKeyRequest()),
    (error) => error.code === 'REMOTE_SSH_KEY_GENERATION_FAILED',
  );
  assert.equal(vault.records.size, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM remote_connections').get().count, 0);
});

test('connection service stores only the private key in Vault and exposes a repeatable public key', async (t) => {
  const database = createMigratedV2Database(t);
  const repository = createV2Repositories(database).remote;
  const vault = createFakeVault();
  const connectionUid = uid(19110);
  const service = createRemoteConnectionService({
    repository,
    vault,
    createUid: () => connectionUid,
  });

  const created = await service.create(publicKeyRequest());
  assert.equal(created.authMethod, 'publickey');
  assert.equal(created.credentialKind, 'ssh_private_key');
  assert.equal(created.credentialConfigured, true);
  const row = database.prepare(`
    SELECT auth_method, auth_method_v2, ssh_public_key, credential_ref
    FROM remote_connections WHERE uid = ?
  `).get(connectionUid);
  assert.equal(row.auth_method, 'password');
  assert.equal(row.auth_method_v2, 'publickey');
  assert.match(row.ssh_public_key, /^ssh-ed25519 /u);
  assert.equal(JSON.stringify(row).includes('OPENSSH PRIVATE KEY'), false);
  assert.match(vault.records.get(row.credential_ref).secret, /^-----BEGIN OPENSSH PRIVATE KEY-----/u);
  assert.equal(vault.records.get(row.credential_ref).kind, 'ssh_private_key');

  const publicView = await service.getSshPublicKey(connectionUid);
  assert.deepEqual(publicView, {
    contractVersion: 'ssh-public-key.v1',
    connectionUid,
    algorithm: 'ssh-ed25519',
    publicKey: row.ssh_public_key,
    fingerprint: publicView.fingerprint,
  });
  assert.match(publicView.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
  assert.equal(JSON.stringify(publicView).includes('PRIVATE'), false);

  const keyCredentialRef = row.credential_ref;
  const password = await service.replaceCredential(connectionUid, {
    expectedStateVersion: created.stateVersion,
    authMethod: 'password',
    secret: 'replacement-password',
  });
  assert.equal(password.authMethod, 'password');
  assert.equal(password.credentialKind, 'ssh_password');
  assert.equal(vault.records.has(keyCredentialRef), false);
  assert.equal(database.prepare(
    'SELECT ssh_public_key FROM remote_connections WHERE uid = ?',
  ).get(connectionUid).ssh_public_key, null);
  await assert.rejects(
    () => service.getSshPublicKey(connectionUid),
    (error) => error.code === 'REMOTE_SSH_PUBLIC_KEY_UNAVAILABLE',
  );
});

test('migration binds effective auth evidence and rejects inconsistent public-key rows', (t) => {
  const database = createMigratedV2Database(t);
  for (const name of [
    'mvp_benchmark_execution_ready_sessions',
    'v2_h3_generation_intents_validate_insert',
    'v2_mvp_benchmark_external_authorizations_validate_insert',
    'v2_mvp_benchmark_live_environment_attestations_validate_insert',
    'v2_mvp_benchmark_execution_reservations_validate_insert',
  ]) {
    const row = database.prepare(`
      SELECT sql FROM sqlite_schema WHERE name = ? AND type IN ('view', 'trigger')
    `).get(name);
    assert.match(row.sql, /connection\.auth_method_v2/u);
    assert.doesNotMatch(row.sql, /connection\.auth_method(?:[^_]|$)/u);
  }
  const base = {
    uid: uid(19120),
    name: 'Invalid direct row',
    host: 'workspace.example.invalid',
    port: 22,
    username: 'worker',
    credentialRef: `credential:v1:${uid(19121)}`,
  };
  assert.throws(() => database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, auth_method_v2)
    VALUES (@uid, @name, @host, @port, @username, @credentialRef, 'publickey')
  `).run(base));
  assert.throws(() => database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, auth_method_v2, ssh_public_key)
    VALUES (@uid, @name, @host, @port, @username, @credentialRef, 'password',
      'ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA local-mini-drama')
  `).run(base));
  assert.throws(() => database.prepare(`
    INSERT INTO remote_connections
      (uid, name, host, port, username, credential_ref, auth_method_v2, ssh_public_key)
    VALUES (@uid, @name, @host, @port, @username, @credentialRef, 'publickey',
      'ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA local-mini-drama')
  `).run(base));
});

test('localhost API creates a key profile and returns only its schema-valid public key', async (t) => {
  const remoteConnectionRoutes = require('../src/routes/v2/remoteConnections');
  const database = createMigratedV2Database(t);
  const vault = createFakeVault();
  const connectionUid = uid(19130);
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use(remoteConnectionRoutes({
    error(event, details) { logs.push({ event, details }); },
  }, {
    credentialVault: vault,
    createUid: () => connectionUid,
  }, database));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const createResponse = await fetch(`${origin}/remote-connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(publicKeyRequest()),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()).data;
  assert.equal(created.authMethod, 'publickey');
  assert.equal(created.credentialKind, 'ssh_private_key');
  const connectionSchema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/remote-connection.schema.json'),
    'utf8',
  ));
  const validateConnection = new Ajv2020({ allErrors: true, strict: true })
    .compile(connectionSchema);
  assert.equal(validateConnection(created), true, JSON.stringify(validateConnection.errors));

  const keyResponse = await fetch(
    `${origin}/remote-connections/${connectionUid}/ssh-public-key`,
  );
  assert.equal(keyResponse.status, 200);
  const keyEnvelope = await keyResponse.json();
  const keyView = keyEnvelope.data;
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/ssh-public-key.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(keyView), true, JSON.stringify(validate.errors));
  assert.equal(JSON.stringify({ created, keyView }).includes('OPENSSH PRIVATE KEY'), false);
  assert.deepEqual(logs, []);
});
