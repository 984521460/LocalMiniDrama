const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const {
  CredentialBridgeError,
  PowerShellCredentialBridge,
  WindowsCredentialError,
  WindowsCredentialVault,
} = require('../src/adapters/v2/credentials');
const {
  runPowerShell,
} = require('../src/adapters/v2/credentials/powershellCredentialBridge');

const FIXED_UUID = '22222222-2222-4222-8222-222222222222';
const FIXED_REF = `credential:v1:${FIXED_UUID}`;
const FIXED_TARGET = `LocalMiniDrama/v1/${FIXED_UUID}`;
const SYNTHETIC_SECRET = 'fixture-only-credential-value';

class FakeCredentialBridge {
  constructor() {
    this.records = new Map();
    this.lastWrite = null;
  }

  async write(target, username, secret) {
    this.lastWrite = { target, username, secret: Buffer.from(secret) };
    this.records.set(target, { username, secret: Buffer.from(secret) });
  }

  async read(target) {
    const record = this.records.get(target);
    if (!record) return null;
    return { username: record.username, secret: Buffer.from(record.secret) };
  }

  async inspect(target) {
    const record = this.records.get(target);
    return record ? { username: record.username } : null;
  }

  async remove(target) {
    return this.records.delete(target);
  }
}

test('WindowsCredentialVault stores only opaque references in public results', async () => {
  const bridge = new FakeCredentialBridge();
  const vault = new WindowsCredentialVault({ bridge, createUuid: () => FIXED_UUID });

  const descriptor = await vault.store({ kind: 'ssh_password', secret: SYNTHETIC_SECRET });
  assert.deepEqual(descriptor, { ref: FIXED_REF, kind: 'ssh_password', configured: true });
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(JSON.stringify(descriptor).includes(SYNTHETIC_SECRET), false);
  assert.equal(bridge.lastWrite.target, `LocalMiniDrama/v1/${FIXED_UUID}`);
  assert.equal(bridge.lastWrite.target.includes(SYNTHETIC_SECRET), false);
  assert.equal(bridge.lastWrite.username, 'ssh_password');
  assert.equal(bridge.lastWrite.secret.toString('utf8'), SYNTHETIC_SECRET);

  assert.equal(await vault.read(descriptor.ref), SYNTHETIC_SECRET);
  assert.deepEqual(await vault.inspect(descriptor.ref), descriptor);
  assert.equal(await vault.remove(descriptor.ref), true);
  assert.equal(await vault.remove(descriptor.ref), false);
  await assert.rejects(() => vault.read(descriptor.ref), (error) => (
    error instanceof WindowsCredentialError && error.code === 'CREDENTIAL_NOT_FOUND'
  ));
});

test('WindowsCredentialVault rejects hostile inputs and sanitizes bridge failures', async () => {
  const bridge = new FakeCredentialBridge();
  const vault = new WindowsCredentialVault({ bridge, createUuid: () => FIXED_UUID });
  await assert.rejects(() => vault.store({ kind: 'ssh_password', secret: '' }), WindowsCredentialError);
  await assert.rejects(() => vault.store({ kind: 'ssh_password', secret: 'x'.repeat(5121) }), WindowsCredentialError);
  await assert.rejects(() => vault.store({ kind: 'ssh_password', secret: 'nul\0value' }), WindowsCredentialError);
  await assert.rejects(() => vault.store({ kind: 'ssh_password', secret: '\ud800' }), WindowsCredentialError);
  await assert.rejects(
    () => vault.store({ kind: 'ssh_password', secret: SYNTHETIC_SECRET, extra: true }),
    (error) => error instanceof WindowsCredentialError && error.code === 'CREDENTIAL_VALUE_INVALID',
  );

  let secretReads = 0;
  const hostile = { kind: 'ssh_password' };
  Object.defineProperty(hostile, 'secret', {
    enumerable: true,
    get() {
      secretReads += 1;
      return SYNTHETIC_SECRET;
    },
  });
  await assert.rejects(
    () => vault.store(hostile),
    (error) => error instanceof WindowsCredentialError && error.code === 'CREDENTIAL_VALUE_INVALID',
  );
  assert.equal(secretReads, 0);

  bridge.write = async () => { throw new Error(`provider failed: ${SYNTHETIC_SECRET}`); };
  let captured;
  await vault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET }).catch((error) => { captured = error; });
  assert.ok(captured instanceof WindowsCredentialError);
  assert.equal(captured.code, 'CREDENTIAL_STORE_INDETERMINATE');
  assert.equal(captured.credentialRef, FIXED_REF);
  assert.equal(captured.message.includes(SYNTHETIC_SECRET), false);
  assert.equal(JSON.stringify(captured).includes(SYNTHETIC_SECRET), false);
});

test('WindowsCredentialVault rebuilds hostile bridge errors across every operation', async () => {
  async function invoke(operation, thrown) {
    const bridge = new FakeCredentialBridge();
    bridge.inspect = async () => null;
    if (operation === 'store') {
      bridge.write = async () => { throw thrown; };
      bridge.remove = async () => true;
    } else {
      bridge[operation] = async () => { throw thrown; };
    }
    const vault = new WindowsCredentialVault({ bridge, createUuid: () => FIXED_UUID });
    let captured;
    const pending = operation === 'store'
      ? vault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET })
      : vault[operation](FIXED_REF);
    await pending.catch((error) => { captured = error; });
    return captured;
  }

  for (const operation of ['store', 'read', 'inspect', 'remove']) {
    const forged = new WindowsCredentialError(
      'CREDENTIAL_NOT_FOUND',
      `forged bridge error: ${SYNTHETIC_SECRET}`,
      SYNTHETIC_SECRET,
    );
    forged.extra = SYNTHETIC_SECRET;
    const captured = await invoke(operation, forged);
    assert.notEqual(captured, forged, `${operation} must not return a bridge-owned error instance`);
    assert.ok(captured instanceof WindowsCredentialError);
    assert.equal(captured.code, 'CREDENTIAL_VAULT_IO_FAILED');
    assert.equal(captured.message.includes(SYNTHETIC_SECRET), false);
    assert.equal(JSON.stringify(captured).includes(SYNTHETIC_SECRET), false);
    assert.equal(Object.hasOwn(captured, 'credentialRef'), false);

    const hostileProxy = new Proxy({}, {
      getPrototypeOf() {
        throw new Error(`prototype trap: ${SYNTHETIC_SECRET}`);
      },
    });
    const trapped = await invoke(operation, hostileProxy);
    assert.ok(trapped instanceof WindowsCredentialError);
    assert.equal(trapped.code, 'CREDENTIAL_VAULT_IO_FAILED');
    assert.equal(trapped.message.includes(SYNTHETIC_SECRET), false);
    assert.equal(JSON.stringify(trapped).includes(SYNTHETIC_SECRET), false);
  }
});

test('trusted vault errors are immutable and safe when a bridge replays them', async () => {
  const sourceVault = new WindowsCredentialVault({
    bridge: new FakeCredentialBridge(),
    createUuid: () => FIXED_UUID,
  });
  let trusted;
  await sourceVault.read(FIXED_REF).catch((error) => { trusted = error; });
  assert.ok(trusted instanceof WindowsCredentialError);
  assert.equal(trusted.code, 'CREDENTIAL_NOT_FOUND');

  const mutationResults = [
    Reflect.set(trusted, 'message', SYNTHETIC_SECRET),
    Reflect.set(trusted, 'code', 'ATTACKER_CODE'),
    Reflect.set(trusted, 'credentialRef', SYNTHETIC_SECRET),
    Reflect.defineProperty(trusted, 'extra', {
      value: SYNTHETIC_SECRET,
      enumerable: true,
      configurable: true,
      writable: true,
    }),
  ];

  for (const operation of ['store', 'read', 'inspect', 'remove']) {
    const bridge = new FakeCredentialBridge();
    bridge.inspect = async () => null;
    if (operation === 'store') {
      bridge.write = async () => { throw trusted; };
      bridge.remove = async () => true;
    } else {
      bridge[operation] = async () => { throw trusted; };
    }
    const vault = new WindowsCredentialVault({ bridge, createUuid: () => FIXED_UUID });
    let replayed;
    const pending = operation === 'store'
      ? vault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET })
      : vault[operation](FIXED_REF);
    await pending.catch((error) => { replayed = error; });
    assert.notEqual(replayed, trusted);
    assert.equal(replayed.code, 'CREDENTIAL_NOT_FOUND');
    assert.equal(replayed.message.includes(SYNTHETIC_SECRET), false);
    assert.equal(JSON.stringify(replayed).includes(SYNTHETIC_SECRET), false);
    assert.equal(Object.isFrozen(replayed), true);
  }

  assert.deepEqual(mutationResults, [false, false, false, false]);
  assert.equal(Object.isFrozen(trusted), true);
  assert.equal(trusted.code, 'CREDENTIAL_NOT_FOUND');
  assert.equal(trusted.message.includes(SYNTHETIC_SECRET), false);
  assert.equal(JSON.stringify(trusted).includes(SYNTHETIC_SECRET), false);
});

test('WindowsCredentialVault removes uncertain writes or returns a cleanup reference', async () => {
  const cleanedBridge = new FakeCredentialBridge();
  cleanedBridge.write = async (target, username, secret) => {
    cleanedBridge.records.set(target, { username, secret: Buffer.from(secret) });
    throw new Error(`uncertain write: ${SYNTHETIC_SECRET}`);
  };
  const cleanedVault = new WindowsCredentialVault({ bridge: cleanedBridge, createUuid: () => FIXED_UUID });
  let cleanedError;
  await cleanedVault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET }).catch((error) => { cleanedError = error; });
  assert.ok(cleanedError instanceof WindowsCredentialError);
  assert.equal(cleanedError.code, 'CREDENTIAL_VAULT_IO_FAILED');
  assert.equal(cleanedBridge.records.size, 0);
  assert.equal(JSON.stringify(cleanedError).includes(SYNTHETIC_SECRET), false);

  const uncertainBridge = new FakeCredentialBridge();
  uncertainBridge.write = async (target, username, secret) => {
    uncertainBridge.records.set(target, { username, secret: Buffer.from(secret) });
    throw new Error('synthetic response loss');
  };
  uncertainBridge.remove = async () => { throw new Error('synthetic cleanup failure'); };
  const uncertainVault = new WindowsCredentialVault({ bridge: uncertainBridge, createUuid: () => FIXED_UUID });
  let uncertainError;
  await uncertainVault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET }).catch((error) => { uncertainError = error; });
  assert.ok(uncertainError instanceof WindowsCredentialError);
  assert.equal(uncertainError.code, 'CREDENTIAL_STORE_INDETERMINATE');
  assert.equal(uncertainError.credentialRef, FIXED_REF);
  assert.equal(JSON.stringify(uncertainError).includes(SYNTHETIC_SECRET), false);
});

test('WindowsCredentialVault treats unproven cleanup as indeterminate', async () => {
  for (const removeResult of [false, true]) {
    const bridge = new FakeCredentialBridge();
    bridge.write = async (target, username, secret) => {
      bridge.records.set(target, { username, secret: Buffer.from(secret) });
      throw new Error('synthetic uncertain write');
    };
    bridge.remove = async () => removeResult;
    const vault = new WindowsCredentialVault({ bridge, createUuid: () => FIXED_UUID });

    let captured;
    await vault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET }).catch((error) => { captured = error; });
    assert.ok(captured instanceof WindowsCredentialError);
    assert.equal(captured.code, 'CREDENTIAL_STORE_INDETERMINATE');
    assert.equal(captured.credentialRef, FIXED_REF);
    assert.equal(bridge.records.has(FIXED_TARGET), true);
    assert.equal(JSON.stringify(captured).includes(SYNTHETIC_SECRET), false);
  }

  const terminationBridge = new FakeCredentialBridge();
  terminationBridge.write = async (target, username, secret) => {
    terminationBridge.records.set(target, { username, secret: Buffer.from(secret) });
    throw new CredentialBridgeError('CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED');
  };
  const terminationVault = new WindowsCredentialVault({
    bridge: terminationBridge,
    createUuid: () => FIXED_UUID,
  });
  let terminationError;
  await terminationVault.store({ kind: 'api_key', secret: SYNTHETIC_SECRET })
    .catch((error) => { terminationError = error; });
  assert.equal(terminationBridge.records.size, 0, 'best-effort cleanup should still run');
  assert.equal(terminationError.code, 'CREDENTIAL_STORE_INDETERMINATE');
  assert.equal(terminationError.credentialRef, FIXED_REF);
});

test('Windows credential layers enforce the 2560-byte native blob limit', async () => {
  const acceptedVault = new WindowsCredentialVault({
    bridge: new FakeCredentialBridge(),
    createUuid: () => FIXED_UUID,
  });
  const descriptor = await acceptedVault.store({ kind: 'provider_token', secret: 'a'.repeat(2560) });
  assert.equal(descriptor.ref, FIXED_REF);

  const rejectedVault = new WindowsCredentialVault({
    bridge: new FakeCredentialBridge(),
    createUuid: () => FIXED_UUID,
  });
  await assert.rejects(
    () => rejectedVault.store({ kind: 'provider_token', secret: 'a'.repeat(2561) }),
    (error) => error instanceof WindowsCredentialError && error.code === 'CREDENTIAL_VALUE_INVALID',
  );
  await acceptedVault.remove(descriptor.ref);
  await acceptedVault.store({ kind: 'provider_token', secret: `${'密'.repeat(853)}a` });
  await assert.rejects(
    () => rejectedVault.store({ kind: 'provider_token', secret: `${'密'.repeat(853)}aa` }),
    (error) => error instanceof WindowsCredentialError && error.code === 'CREDENTIAL_VALUE_INVALID',
  );

  const bridge = new PowerShellCredentialBridge({
    platform: 'win32',
    scriptPath: 'C:\\trusted\\credential-bridge.ps1',
    runProcess: async () => ({ code: 0, stdout: '{"ok":true}', stderr: '' }),
  });
  await bridge.write(FIXED_TARGET, 'provider_token', Buffer.alloc(2560, 1));
  await assert.rejects(() => bridge.write(FIXED_TARGET, 'provider_token', Buffer.alloc(2561, 1)));
});

test('PowerShell native read clears the credential blob before CredFree', () => {
  const script = fs.readFileSync(path.join(
    __dirname,
    '../src/adapters/v2/credentials/credential-bridge.ps1',
  ), 'utf8');
  const readFunction = script.slice(
    script.indexOf('function Read-NativeCredential'),
    script.indexOf("try {\n    $rawRequest"),
  );
  const clearIndex = readFunction.indexOf('WriteByte($credential.CredentialBlob');
  const freeIndex = readFunction.indexOf('CredFree($credentialPointer)');
  assert.ok(clearIndex >= 0, 'native credential blob must be explicitly overwritten');
  assert.ok(clearIndex < freeIndex, 'native credential blob must be cleared before CredFree');
});

test('PowerShell bridge keeps secrets out of process arguments and validates responses', async () => {
  const calls = [];
  const bridge = new PowerShellCredentialBridge({
    platform: 'win32',
    scriptPath: 'C:\\trusted\\credential-bridge.ps1',
    runProcess: async (request) => {
      calls.push(request);
      const input = JSON.parse(request.input);
      if (input.action === 'write') return { code: 0, stdout: '{"ok":true}', stderr: '' };
      if (input.action === 'read') {
        return {
          code: 0,
          stdout: JSON.stringify({ found: true, username: 'api_key', secretBase64: Buffer.from(SYNTHETIC_SECRET).toString('base64') }),
          stderr: '',
        };
      }
      return { code: 0, stdout: '{"found":false}', stderr: '' };
    },
  });

  await bridge.write(FIXED_TARGET, 'api_key', Buffer.from(SYNTHETIC_SECRET));
  const record = await bridge.read(FIXED_TARGET);
  assert.equal(record.secret.toString('utf8'), SYNTHETIC_SECRET);
  assert.equal(calls.every((call) => !call.args.join(' ').includes(SYNTHETIC_SECRET)), true);
  assert.equal(calls.every((call) => !JSON.stringify(call.env || {}).includes(SYNTHETIC_SECRET)), true);
  assert.equal(JSON.parse(calls[0].input).secretBase64, Buffer.from(SYNTHETIC_SECRET).toString('base64'));

  const broken = new PowerShellCredentialBridge({
    platform: 'win32',
    scriptPath: 'C:\\trusted\\credential-bridge.ps1',
    runProcess: async () => ({ code: 1, stdout: '', stderr: SYNTHETIC_SECRET }),
  });
  let captured;
  await broken.inspect(FIXED_TARGET).catch((error) => { captured = error; });
  assert.ok(captured instanceof CredentialBridgeError);
  assert.equal(captured.message.includes(SYNTHETIC_SECRET), false);
  assert.equal(JSON.stringify(captured).includes(SYNTHETIC_SECRET), false);

  const oversizedStderr = new PowerShellCredentialBridge({
    platform: 'win32',
    scriptPath: 'C:\\trusted\\credential-bridge.ps1',
    runProcess: async () => ({ code: 0, stdout: '{"found":false}', stderr: 'x'.repeat(65537) }),
  });
  await assert.rejects(() => oversizedStderr.inspect(FIXED_TARGET), CredentialBridgeError);
});

function fakePowerShellChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

test('runPowerShell rejects output overflow even when the child later exits zero', async () => {
  const child = fakePowerShellChild();
  let spawnCalls = 0;
  const pending = runPowerShell({
    executable: 'synthetic-powershell.exe',
    args: [],
    input: '{}',
    timeoutMs: 1000,
    spawnProcess: () => {
      spawnCalls += 1;
      return child;
    },
  });
  child.stdout.write('{"found":false}');
  child.stderr.write(Buffer.alloc(65537, 1));
  child.emit('close', 0);
  await assert.rejects(pending, CredentialBridgeError);
  assert.equal(spawnCalls, 1);
  assert.equal(child.killCalls, 1);
});

test('runPowerShell waits for close after a timeout before it rejects', async () => {
  const child = fakePowerShellChild();
  let completed = false;
  const pending = runPowerShell({
    executable: 'synthetic-powershell.exe',
    args: [],
    input: '{}',
    timeoutMs: 10,
    spawnProcess: () => child,
  }).finally(() => { completed = true; });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(child.killCalls, 1);
  assert.equal(completed, false);
  child.emit('close', 1);
  await assert.rejects(pending, CredentialBridgeError);
});

test('runPowerShell reports unconfirmed termination when kill is refused', async () => {
  const child = fakePowerShellChild();
  child.kill = () => {
    child.killCalls += 1;
    return false;
  };
  await assert.rejects(
    runPowerShell({
      executable: 'synthetic-powershell.exe',
      args: [],
      input: '{}',
      timeoutMs: 10,
      spawnProcess: () => child,
    }),
    (error) => (
      error instanceof CredentialBridgeError
      && error.code === 'CREDENTIAL_BRIDGE_TERMINATION_UNCONFIRMED'
    ),
  );
  assert.equal(child.killCalls, 1);
});

test('Windows Credential Manager round trip uses only a task-created synthetic entry', {
  skip: process.env.LOCAL_MINI_DRAMA_WINDOWS_CREDENTIAL_SMOKE !== '1',
}, async () => {
  const vault = new WindowsCredentialVault();
  const syntheticValue = `local-mini-drama-smoke-${randomUUID()}`;
  let ref;
  try {
    const descriptor = await vault.store({ kind: 'provider_token', secret: syntheticValue });
    ref = descriptor.ref;
    assert.equal(await vault.read(ref), syntheticValue);
    assert.deepEqual(await vault.inspect(ref), descriptor);
  } finally {
    if (ref) await vault.remove(ref).catch(() => {});
  }
  assert.equal(await vault.remove(ref), false);
});
