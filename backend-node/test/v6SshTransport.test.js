const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');

const { createSshTransport } = require('../src/remote/sshTransport');
const { createSshTunnelManager } = require('../src/remote/sshTunnel');
const { createRemoteSessionService } = require('../src/remote/remoteSessionService');
const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');

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
  let openedTunnel;
  const session = { async close() {} };
  const service = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: {
      async read(ref) {
        assert.equal(ref, credentialRef);
        return Buffer.from('vault-password-value');
      },
    },
    sshTransport: {
      async connect(input) {
        consumedSecret = input.secret;
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
  assert.equal(consumedSecret.every((value) => value === 0), true);
  assert.deepEqual(openedTunnel, { session, remotePort: 8188 });
  assert.equal(tunnel.origin, 'http://127.0.0.1:49152');
  assert.equal(JSON.stringify(tunnel).includes('vault-password-value'), false);

  let guardedVaultReads = 0;
  let guardedConnects = 0;
  const guarded = createRemoteSessionService({
    repository: { getConnection() { return record; } },
    vault: { async read() { guardedVaultReads += 1; return Buffer.from('unused'); } },
    sshTransport: { async connect() { guardedConnects += 1; return session; } },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await assert.rejects(guarded.openSession(record.uid, 'f'.repeat(64)), {
    code: 'REMOTE_SESSION_NOT_READY',
  });
  assert.equal(guardedVaultReads, 0);
  assert.equal(guardedConnects, 0);
  const guardedSession = await guarded.openSession(
    record.uid,
    remoteConnectionEvidenceSha256(record),
  );
  assert.equal(guardedVaultReads, 1);
  assert.equal(guardedConnects, 1);
  await guardedSession.session.close();

  const blocked = createRemoteSessionService({
    repository: { getConnection() { return { ...record, status: 'changed' }; } },
    vault: { async read() { throw new Error('must not read'); } },
    sshTransport: { async connect() { throw new Error('must not connect'); } },
    tunnelManager: { async open() { throw new Error('must not open'); } },
  });
  await assert.rejects(blocked.openComfyTunnel(record.uid), {
    code: 'REMOTE_SESSION_NOT_READY',
  });
});
