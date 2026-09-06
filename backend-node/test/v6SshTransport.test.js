const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const { createSshTransport } = require('../src/remote/sshTransport');
const { createSshTunnelManager } = require('../src/remote/sshTunnel');
const { createRemoteSessionService } = require('../src/remote/remoteSessionService');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const { generateSshKeyPair } = require('../src/remote/sshKeyPair');

const HOST_KEY = Buffer.from('synthetic-host-key-material');
const FINGERPRINT = 'SHA256:zAiiwVB6Uxu2FL8c0K6V6Z/zOD0OWrdz1sKXb539o+w';

class FakeClient extends EventEmitter {
  constructor({ acceptedKey = HOST_KEY } = {}) {
    super();
    this.acceptedKey = acceptedKey;
    this.connectedWith = null;
    this.ended = false;
  }

  connect(config) {
    this.connectedWith = config;
    const accepted = config.hostVerifier(this.acceptedKey);
    queueMicrotask(() => {
      if (accepted) this.emit('ready');
      else this.emit('error', new Error('synthetic host rejection'));
    });
  }

  end() {
    this.ended = true;
    queueMicrotask(() => this.emit('close'));
  }
}

test('SSH host probing hashes the raw key and stops before authentication', async () => {
  const client = new FakeClient();
  const transport = createSshTransport({
    createClient: () => client,
    parseHostKey: () => ({ type: 'ssh-ed25519' }),
    timeoutMs: 500,
  });
  const result = await transport.probeHostIdentity({
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
  });
  assert.deepEqual(result, { algorithm: 'ssh-ed25519', fingerprint: FINGERPRINT });
  assert.equal(client.ended, true);
  assert.equal(Object.hasOwn(client.connectedWith, 'password'), false);
  assert.equal(Object.hasOwn(client.connectedWith, 'authHandler'), false);
});

test('authenticated SSH sessions require the confirmed host key and zero the password buffer', async () => {
  const acceptedClient = new FakeClient();
  const accepted = createSshTransport({
    createClient: () => acceptedClient,
    parseHostKey: () => ({ type: 'ssh-ed25519' }),
    timeoutMs: 500,
  });
  const secret = Buffer.from('synthetic-password-value');
  const session = await accepted.connect({
    endpoint: { host: 'workspace.example.invalid', port: 57339, username: 'worker' },
    expectedFingerprint: FINGERPRINT,
    authMethod: 'password',
    secret,
  });
  assert.equal(secret.every((value) => value === 0), true);
  assert.equal(typeof acceptedClient.connectedWith.authHandler, 'function');
  assert.equal(Object.hasOwn(acceptedClient.connectedWith, 'password'), false);
  await session.close();

  const rejectedClient = new FakeClient();
  const rejected = createSshTransport({
    createClient: () => rejectedClient,
    parseHostKey: () => ({ type: 'ssh-ed25519' }),
    timeoutMs: 500,
  });
  const rejectedSecret = Buffer.from('must-be-zeroed');
  await assert.rejects(rejected.connect({
    endpoint: { host: 'workspace.example.invalid', port: 57339, username: 'worker' },
    expectedFingerprint: `SHA256:${'A'.repeat(43)}`,
    authMethod: 'password',
    secret: rejectedSecret,
  }), { code: 'SSH_HOST_FINGERPRINT_MISMATCH' });
  assert.equal(rejectedSecret.every((value) => value === 0), true);
});

test('local tunnel binds only loopback, forwards bytes, and closes deterministically', async (t) => {
  const echoServer = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => echoServer.close(resolve)));
  const echoPort = echoServer.address().port;
  let sessionClosed = false;
  const session = {
    forwardOut(_sourceHost, _sourcePort, destinationHost, destinationPort) {
      assert.equal(destinationHost, '127.0.0.1');
      assert.equal(destinationPort, 8188);
      return new Promise((resolve, reject) => {
        const socket = net.connect(echoPort, '127.0.0.1', () => resolve(socket));
        socket.once('error', reject);
      });
    },
    async close() { sessionClosed = true; },
  };
  const manager = createSshTunnelManager();
  const tunnel = await manager.open({ session, remotePort: 8188 });
  assert.equal(tunnel.host, '127.0.0.1');
  assert.equal(tunnel.origin, `http://127.0.0.1:${tunnel.port}`);

  const echoed = await new Promise((resolve, reject) => {
    const socket = net.connect(tunnel.port, tunnel.host, () => socket.write('ping'));
    socket.once('data', (chunk) => {
      resolve(chunk.toString('utf8'));
      socket.end();
    });
    socket.once('error', reject);
  });
  assert.equal(echoed, 'ping');
  await tunnel.close();
  assert.equal(sessionClosed, true);
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(tunnel.port, tunnel.host, resolve);
    socket.once('error', reject);
  }));
});

test('credential-backed sessions open only for confirmed profiles and never expose password bytes', async () => {
  const credentialRef = 'credential:v1:00000000-0000-4000-8000-000000005000';
  const record = {
    uid: '00000000-0000-4000-8000-000000005001',
    name: 'Synthetic worker',
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
    hostFingerprint: FINGERPRINT,
    credentialRef,
    status: 'ready',
    createdAt: '2026-08-28T06:00:00.000Z',
    updatedAt: '2026-08-28T06:00:00.000Z',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
    environmentReport: null,
    environmentCheckedAtEpochMs: null,
    stateVersion: 1,
  };
  let consumedSecret;
  let consumedSecretSnapshot;
  let openedTunnel;
  const session = { async close() {} };
  const service = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: {
      async inspect(ref) {
        return { ref, kind: 'ssh_password', configured: true };
      },
      async read(ref) {
        assert.equal(ref, credentialRef);
        return 'vault-password-value';
      },
    },
    sshTransport: {
      async connect(input) {
        consumedSecret = input.secret;
        consumedSecretSnapshot = Buffer.from(input.secret);
        assert.equal(input.expectedFingerprint, FINGERPRINT);
        assert.deepEqual(input.endpoint, {
          host: record.host,
          port: record.port,
          username: record.username,
        });
        return session;
      },
    },
    tunnelManager: {
      async open(input) {
        openedTunnel = input;
        return Object.freeze({
          host: '127.0.0.1', port: 49152, origin: 'http://127.0.0.1:49152', async close() {},
        });
      },
    },
  });
  const tunnel = await service.openComfyTunnel(record.uid);
  assert.deepEqual(consumedSecretSnapshot, Buffer.from('vault-password-value'));
  assert.equal(consumedSecret.every((value) => value === 0), true);
  assert.deepEqual(openedTunnel, { session, remotePort: 8188 });
  assert.equal(tunnel.origin, 'http://127.0.0.1:49152');
  assert.equal(JSON.stringify(tunnel).includes('vault-password-value'), false);

  let guardedVaultReads = 0;
  let guardedVaultInspects = 0;
  let guardedConnects = 0;
  const guarded = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: {
      async inspect(ref) {
        guardedVaultInspects += 1;
        return { ref, kind: 'ssh_password', configured: true };
      },
      async read() { guardedVaultReads += 1; return Buffer.from('unused'); },
    },
    sshTransport: { async connect() { guardedConnects += 1; return session; } },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await assert.rejects(guarded.openSession(record.uid, 'f'.repeat(64)), {
    code: 'REMOTE_SESSION_NOT_READY',
  });
  assert.equal(guardedVaultReads, 0);
  assert.equal(guardedVaultInspects, 0);
  assert.equal(guardedConnects, 0);
  const guardedSession = await guarded.openSession(
    record.uid,
    remoteConnectionEvidenceSha256(record),
  );
  assert.equal(guardedVaultReads, 1);
  assert.equal(guardedVaultInspects, 1);
  assert.equal(guardedConnects, 1);
  await guardedSession.session.close();

  const blocked = createRemoteSessionService({
    repository: { getConnection() { return { ...record, status: 'changed' }; } },
    vault: {
      async inspect() { throw new Error('must not inspect'); },
      async read() { throw new Error('must not read'); },
    },
    sshTransport: { async connect() { throw new Error('must not connect'); } },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await assert.rejects(blocked.openComfyTunnel(record.uid), {
    code: 'REMOTE_SESSION_NOT_READY',
  });

  const compatibleBuffer = Buffer.from('buffer-password-value');
  let compatibleSnapshot;
  const compatible = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: {
      async inspect(ref) { return { ref, kind: 'ssh_password', configured: true }; },
      async read() { return compatibleBuffer; },
    },
    sshTransport: {
      async connect(input) {
        compatibleSnapshot = Buffer.from(input.secret);
        return session;
      },
    },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await compatible.openSession(record.uid);
  assert.deepEqual(compatibleSnapshot, Buffer.from('buffer-password-value'));
  assert.equal(compatibleBuffer.every((value) => value === 0), true);

  const maxUtf8Secret = `${'a'.repeat(2557)}界`;
  let maxUtf8Consumed;
  let maxUtf8Snapshot;
  const maxUtf8 = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: {
      async inspect(ref) { return { ref, kind: 'ssh_password', configured: true }; },
      async read() { return maxUtf8Secret; },
    },
    sshTransport: {
      async connect(input) {
        maxUtf8Consumed = input.secret;
        maxUtf8Snapshot = Buffer.from(input.secret);
        return session;
      },
    },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await maxUtf8.openSession(record.uid);
  assert.equal(maxUtf8Snapshot.length, 2560);
  assert.deepEqual(maxUtf8Snapshot, Buffer.from(maxUtf8Secret));
  assert.equal(maxUtf8Consumed.every((value) => value === 0), true);

  const oversizedBuffer = Buffer.alloc(2561, 7);
  const nulBuffer = Buffer.from([0x61, 0x00, 0x62]);
  const invalidUtf8Buffer = Buffer.from([0xff]);
  const invalidSecrets = [
    '',
    'nul\0value',
    '\ud800',
    'x'.repeat(2561),
    `${'a'.repeat(2558)}界`,
    oversizedBuffer,
    nulBuffer,
    invalidUtf8Buffer,
    null,
  ];
  for (const invalidSecret of invalidSecrets) {
    let invalidConnects = 0;
    const invalid = createRemoteSessionService({
      repository: { getConnection() { return record; } },
      vault: {
        async inspect(ref) { return { ref, kind: 'ssh_password', configured: true }; },
        async read() { return invalidSecret; },
      },
      sshTransport: { async connect() { invalidConnects += 1; return session; } },
      tunnelManager: { async open() { throw new Error('must not open'); } },
    });
    await assert.rejects(invalid.openSession(record.uid), {
      code: 'REMOTE_SESSION_CREDENTIAL_FAILED',
    });
    assert.equal(invalidConnects, 0);
  }
  for (const invalidBuffer of [oversizedBuffer, nulBuffer, invalidUtf8Buffer]) {
    assert.equal(invalidBuffer.every((value) => value === 0), true);
  }

  const failingVault = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: {
      async inspect(ref) { return { ref, kind: 'ssh_password', configured: true }; },
      async read() { throw new TypeError('synthetic vault failure'); },
    },
    sshTransport: { async connect() { throw new Error('must not connect'); } },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await assert.rejects(failingVault.openSession(record.uid), {
    code: 'REMOTE_SESSION_CREDENTIAL_FAILED',
  });
});

test('public-key sessions bind the Vault kind, confirmed host key, and SSH auth method', async () => {
  const pair = generateSshKeyPair();
  const client = new FakeClient();
  let authentication;
  const originalConnect = client.connect.bind(client);
  client.connect = (config) => {
    config.authHandler([], false, (candidate) => {
      authentication = candidate === false ? false : {
        type: candidate.type,
        username: candidate.username,
        key: Buffer.from(candidate.key),
      };
    });
    originalConnect(config);
  };
  const transport = createSshTransport({
    createClient: () => client,
    parseHostKey: () => ({ type: 'ssh-ed25519' }),
    timeoutMs: 500,
  });
  const keyBytes = Buffer.from(pair.privateKey, 'utf8');
  const session = await transport.connect({
    endpoint: { host: 'workspace.example.invalid', port: 57339, username: 'worker' },
    expectedFingerprint: FINGERPRINT,
    authMethod: 'publickey',
    secret: keyBytes,
  });
  assert.equal(authentication.type, 'publickey');
  assert.equal(authentication.username, 'worker');
  assert.deepEqual(authentication.key, Buffer.from(pair.privateKey, 'utf8'));
  assert.equal(keyBytes.every((value) => value === 0), true);
  await session.close();

  const keyRecord = {
    uid: '00000000-0000-4000-8000-000000005011',
    name: 'Synthetic key worker',
    host: 'workspace.example.invalid',
    port: 57339,
    username: 'worker',
    hostFingerprint: FINGERPRINT,
    credentialRef: 'credential:v1:00000000-0000-4000-8000-000000005010',
    status: 'ready',
    createdAt: '2026-08-28T06:00:00.000Z',
    updatedAt: '2026-08-28T06:00:00.000Z',
    authMethod: 'publickey',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
    environmentReport: null,
    environmentCheckedAtEpochMs: null,
    stateVersion: 1,
  };
  let reads = 0;
  const mismatched = createRemoteSessionService({
    repository: { getConnection() { return keyRecord; } },
    vault: {
      async inspect(ref) { return { ref, kind: 'ssh_password', configured: true }; },
      async read() { reads += 1; return pair.privateKey; },
    },
    sshTransport: { async connect() { throw new Error('must not connect'); } },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await assert.rejects(mismatched.openSession(keyRecord.uid), {
    code: 'REMOTE_SESSION_CREDENTIAL_FAILED',
  });
  assert.equal(reads, 0);

  let connectedWith;
  const accepted = createRemoteSessionService({
    repository: { getConnection() { return keyRecord; } },
    vault: {
      async inspect(ref) { return { ref, kind: 'ssh_private_key', configured: true }; },
      async read() { return pair.privateKey; },
    },
    sshTransport: {
      async connect(input) {
        connectedWith = { ...input, secret: Buffer.from(input.secret) };
        return { async close() {} };
      },
    },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await accepted.openSession(keyRecord.uid);
  assert.equal(connectedWith.authMethod, 'publickey');
  assert.deepEqual(connectedWith.secret, Buffer.from(pair.privateKey, 'utf8'));
});
