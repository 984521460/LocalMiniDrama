'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');
const express = require('express');

const {
  createProviderCredentialCleanupView,
  createProviderCredentialRemovedView,
  createProviderCredentialStoreRequest,
  createProviderCredentialView,
} = require('../src/credentials/providerCredential');
const { WindowsCredentialVault } = require('../src/adapters/v2/credentials');
const {
  installApplicationCors,
  installProviderCredentialBodyBoundary,
} = require('../src/app');
const { createProductionAudioTtsRuntime } = require('../src/audio/productionRuntime');
const providerCredentialRoutes = require('../src/routes/v2/providerCredentials');
const { createAudioModeIntentFixture } = require('./helpers/v9AudioModeIntentFixture');
const schema = require('../../schemas/v9/provider-credential.schema.json');

const UUID = '00000000-0000-4000-8000-000000000901';
const REF = `credential:v1:${UUID}`;
const SECRET = 'synthetic-provider-secret-value';

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function descriptor(kind = 'api_key') {
  return Object.freeze({ ref: REF, kind, configured: true });
}

test('provider credential contract accepts only exact secret-bearing requests and secret-free views', () => {
  assert.deepEqual(createProviderCredentialStoreRequest({ kind: 'api_key', secret: SECRET }), {
    kind: 'api_key', secret: SECRET,
  });
  assert.deepEqual(createProviderCredentialStoreRequest({ kind: 'provider_token', secret: SECRET }), {
    kind: 'provider_token', secret: SECRET,
  });
  assert.throws(() => createProviderCredentialStoreRequest({
    kind: 'ssh_password', secret: SECRET,
  }), /Provider credential request is invalid/u);
  assert.throws(() => createProviderCredentialStoreRequest({
    kind: 'api_key', secret: SECRET, extra: true,
  }), /Provider credential request is invalid/u);
  assert.throws(() => createProviderCredentialStoreRequest({ kind: 'api_key', secret: '' }));
  assert.equal(createProviderCredentialStoreRequest({
    kind: 'api_key', secret: '😀'.repeat(640),
  }).secret.length, 1280);
  assert.throws(() => createProviderCredentialStoreRequest({
    kind: 'api_key', secret: '😀'.repeat(641),
  }));

  const view = createProviderCredentialView(descriptor());
  assert.deepEqual(view, {
    schemaVersion: 'provider-credential.v1',
    ref: REF,
    kind: 'api_key',
    configured: true,
  });
  assert.doesNotMatch(JSON.stringify(view), /synthetic-provider-secret/u);
  assert.deepEqual(createProviderCredentialRemovedView({ ref: REF, removed: true }), {
    schemaVersion: 'provider-credential-removal.v1', ref: REF, removed: true,
  });
  assert.deepEqual(createProviderCredentialCleanupView({ ref: REF, cleanupRequired: true }), {
    schemaVersion: 'provider-credential-cleanup.v1', ref: REF, cleanupRequired: true,
  });

  let reads = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'kind', {
    enumerable: true,
    get() { reads += 1; return 'api_key'; },
  });
  Object.defineProperty(hostile, 'secret', {
    enumerable: true,
    get() { reads += 1; return SECRET; },
  });
  assert.throws(() => createProviderCredentialStoreRequest(hostile));
  assert.equal(reads, 0);
  const proxied = new Proxy({ kind: 'api_key', secret: SECRET }, {
    ownKeys() { reads += 1; return []; },
  });
  assert.throws(() => createProviderCredentialStoreRequest(proxied));
  assert.equal(reads, 0);
});

test('public provider credential schema matches runtime views', () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(createProviderCredentialView(descriptor())), true, JSON.stringify(validate.errors));
  assert.equal(validate(createProviderCredentialRemovedView({ ref: REF, removed: true })), true,
    JSON.stringify(validate.errors));
  assert.equal(validate(createProviderCredentialCleanupView({ ref: REF, cleanupRequired: true })), true,
    JSON.stringify(validate.errors));
  assert.equal(validate({ ...createProviderCredentialView(descriptor()), secret: SECRET }), false);
});

test('indeterminate provider writes return only the cleanup reference', async (t) => {
  let persisted = null;
  let removeCalls = 0;
  const bridge = Object.freeze({
    async inspect() {
      return persisted === null ? null : Object.freeze({ username: persisted.kind });
    },
    async write(target, kind, secret) {
      void target;
      persisted = Object.freeze({ kind, secret: Buffer.from(secret) });
      throw new Error(`synthetic bridge failure ${SECRET}`);
    },
    async remove() {
      removeCalls += 1;
      if (removeCalls === 1) return false;
      persisted?.secret.fill(0);
      persisted = null;
      return true;
    },
    async read() { return null; },
  });
  const vault = new WindowsCredentialVault({ bridge, createUuid: () => UUID });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use(providerCredentialRoutes(null, Object.freeze({ credentialVault: vault, timeoutMs: 1_000 })));
  const { server, base } = await listen(app);
  t.after(() => {
    persisted?.secret.fill(0);
    server.close();
  });

  const response = await fetch(`${base}/provider-credentials`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'api_key', secret: SECRET }),
  });
  assert.equal(response.status, 409);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(SECRET, 'u'));
  const body = JSON.parse(text);
  assert.equal(body.error.code, 'PROVIDER_CREDENTIAL_CLEANUP_REQUIRED');
  assert.deepEqual(body.error.details, createProviderCredentialCleanupView({
    ref: REF, cleanupRequired: true,
  }));
});

test('localhost routes store, inspect, and remove without returning or logging the secret', async (t) => {
  const calls = [];
  const logEntries = [];
  const vault = Object.freeze({
    store(input) {
      calls.push(Object.freeze({ operation: 'store', kind: input.kind, secret: input.secret }));
      return Promise.resolve(descriptor(input.kind));
    },
    inspect(ref) {
      calls.push(Object.freeze({ operation: 'inspect', ref }));
      return Promise.resolve(descriptor());
    },
    remove(ref) {
      calls.push(Object.freeze({ operation: 'remove', ref }));
      return Promise.resolve(true);
    },
  });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/v1/v2', providerCredentialRoutes(
    Object.freeze({ error(event, fields) { logEntries.push({ event, fields }); } }),
    Object.freeze({ credentialVault: vault, timeoutMs: 1_000 }),
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const createdResponse = await fetch(`${base}/api/v1/v2/provider-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'api_key', secret: SECRET }),
  });
  assert.equal(createdResponse.status, 201);
  const createdText = await createdResponse.text();
  assert.doesNotMatch(createdText, new RegExp(SECRET, 'u'));
  assert.deepEqual(JSON.parse(createdText).data, createProviderCredentialView(descriptor()));
  assert.deepEqual(calls[0], { operation: 'store', kind: 'api_key', secret: SECRET });

  const inspectedResponse = await fetch(
    `${base}/api/v1/v2/provider-credentials/${encodeURIComponent(REF)}`,
  );
  assert.equal(inspectedResponse.status, 200);
  assert.deepEqual((await inspectedResponse.json()).data, createProviderCredentialView(descriptor()));

  const removedResponse = await fetch(
    `${base}/api/v1/v2/provider-credentials/${encodeURIComponent(REF)}`,
    { method: 'DELETE' },
  );
  assert.equal(removedResponse.status, 200);
  assert.deepEqual((await removedResponse.json()).data,
    createProviderCredentialRemovedView({ ref: REF, removed: true }));

  const invalidResponse = await fetch(`${base}/api/v1/v2/provider-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'ssh_password', secret: SECRET }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal(calls.filter((call) => call.operation === 'store').length, 1);
  assert.doesNotMatch(JSON.stringify(logEntries), new RegExp(SECRET, 'u'));
});

test('route failures are fixed, bounded, and never echo a rejected credential', async (t) => {
  const vault = Object.freeze({
    store() { return Promise.reject(new Error(`do not leak ${SECRET}`)); },
    inspect() { return Promise.resolve(descriptor()); },
    remove() { return Promise.resolve(false); },
  });
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use(providerCredentialRoutes(
    Object.freeze({ error(event, fields) { logs.push({ event, fields }); } }),
    Object.freeze({ credentialVault: vault, timeoutMs: 1_000 }),
  ));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const failed = await fetch(`${base}/provider-credentials`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'provider_token', secret: SECRET }),
  });
  assert.equal(failed.status, 500);
  const failedText = await failed.text();
  assert.doesNotMatch(failedText, new RegExp(SECRET, 'u'));
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET, 'u'));

  const missing = await fetch(
    `${base}/provider-credentials/${encodeURIComponent(REF)}`,
    { method: 'DELETE' },
  );
  assert.equal(missing.status, 404);
});

test('provider routes never inspect as public or remove SSH credentials', async (t) => {
  let removeCalls = 0;
  const vault = Object.freeze({
    store() { return Promise.resolve(descriptor()); },
    inspect() { return Promise.resolve(descriptor('ssh_password')); },
    remove() { removeCalls += 1; return Promise.resolve(true); },
  });
  const app = express();
  app.use(providerCredentialRoutes(null, Object.freeze({ credentialVault: vault, timeoutMs: 1_000 })));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const inspected = await fetch(`${base}/provider-credentials/${encodeURIComponent(REF)}`);
  assert.equal(inspected.status, 404);
  const removed = await fetch(
    `${base}/provider-credentials/${encodeURIComponent(REF)}`,
    { method: 'DELETE' },
  );
  assert.equal(removed.status, 404);
  assert.equal(removeCalls, 0);
});

test('provider route rejects proxy vaults and custom thenables without executing traps', async (t) => {
  let reads = 0;
  const proxiedVault = new Proxy({}, {
    get() { reads += 1; throw new Error('vault trap'); },
    getPrototypeOf() { reads += 1; throw new Error('vault trap'); },
  });
  const unavailableApp = express();
  unavailableApp.use(providerCredentialRoutes(null, Object.freeze({
    credentialVault: proxiedVault, timeoutMs: 1_000,
  })));
  const unavailableServer = await listen(unavailableApp);
  t.after(() => unavailableServer.server.close());
  const unavailable = await fetch(`${unavailableServer.base}/provider-credentials`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'api_key', secret: SECRET }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(reads, 0);

  const thenableApp = express();
  thenableApp.use(express.json());
  thenableApp.use(providerCredentialRoutes(null, Object.freeze({
    credentialVault: Object.freeze({
      store() {
        const value = {};
        Object.defineProperty(value, 'then', {
          get() { reads += 1; throw new Error('then trap'); },
        });
        return value;
      },
      inspect() { return Promise.resolve(descriptor()); },
      remove() { return Promise.resolve(true); },
    }),
    timeoutMs: 1_000,
  })));
  const thenableServer = await listen(thenableApp);
  t.after(() => thenableServer.server.close());
  const rejected = await fetch(`${thenableServer.base}/provider-credentials`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'api_key', secret: SECRET }),
  });
  assert.equal(rejected.status, 503);
  assert.equal(reads, 0);
});

test('production audio runtime exposes the exact vault instance used by TTS', (t) => {
  const current = createAudioModeIntentFixture(t);
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-credential-runtime-'));
  t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
  const credentialVault = Object.freeze({
    read() { return Promise.resolve('synthetic-runtime-secret'); },
    store() { return Promise.resolve(descriptor()); },
    inspect() { return Promise.resolve(descriptor()); },
    remove() { return Promise.resolve(true); },
  });
  const runtime = createProductionAudioTtsRuntime({
    database: current.fixture.database,
    localRoot,
    dependencies: { credentialVault },
  });
  assert.equal(runtime.audioTts.credentialVault, credentialVault);
  assert.equal(runtime.voiceProfiles.credentialVault, credentialVault);
});

test('production app applies the provider credential body cap before the global JSON parser', async (t) => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');
  const bounded = source.indexOf('installProviderCredentialBodyBoundary(app)');
  const global = source.indexOf("app.use(express.json({ limit: '10mb' }))");
  assert.ok(bounded >= 0);
  assert.ok(global > bounded);
  assert.match(source, /REQUEST_BODY_TOO_LARGE/u);

  let storeCalls = 0;
  const app = express();
  installProviderCredentialBodyBoundary(app);
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  installApplicationCors(app, []);
  app.use('/api/v1/v2', providerCredentialRoutes(null, Object.freeze({
    credentialVault: Object.freeze({
      store() { storeCalls += 1; return Promise.resolve(descriptor()); },
      inspect() { return Promise.resolve(descriptor()); },
      remove() { return Promise.resolve(true); },
    }),
    timeoutMs: 1_000,
  })));
  app.use((error, req, res, next) => {
    void req;
    void next;
    const tooLarge = error?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 500).json({
      success: false,
      error: { code: tooLarge ? 'REQUEST_BODY_TOO_LARGE' : 'INTERNAL_ERROR' },
    });
  });
  const current = await listen(app);
  t.after(() => current.server.close());

  const formBody = new URLSearchParams({
    kind: 'api_key', secret: SECRET, padding: 'x'.repeat(9_000),
  }).toString();
  assert.ok(Buffer.byteLength(formBody) > 8 * 1024);
  const form = await fetch(`${current.base}/api/v1/v2/provider-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });
  assert.equal(form.status, 415);
  assert.equal((await form.json()).error.code, 'PROVIDER_CREDENTIAL_CONTENT_TYPE_UNSUPPORTED');
  assert.equal(storeCalls, 0);

  const oversizedJson = await fetch(`${current.base}/api/v1/v2/provider-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'api_key', secret: 'x'.repeat(9_000) }),
  });
  assert.equal(oversizedJson.status, 413);
  assert.equal((await oversizedJson.json()).error.code, 'REQUEST_BODY_TOO_LARGE');
  assert.equal(storeCalls, 0);

  const evilOrigin = 'https://untrusted.example';
  const preflight = await fetch(`${current.base}/api/v1/v2/provider-credentials`, {
    method: 'OPTIONS',
    headers: {
      origin: evilOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  const evilPost = await fetch(`${current.base}/api/v1/v2/provider-credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: evilOrigin },
    body: JSON.stringify({ kind: 'api_key', secret: SECRET }),
  });
  assert.equal(evilPost.status, 403);
  const evilDelete = await fetch(
    `${current.base}/api/v1/v2/provider-credentials/${encodeURIComponent(REF)}`,
    { method: 'DELETE', headers: { origin: evilOrigin } },
  );
  assert.equal(evilDelete.status, 403);
  assert.equal(storeCalls, 0);

  const trustedOrigin = 'http://127.0.0.1:3013';
  const trustedPreflight = await fetch(`${current.base}/api/v1/v2/provider-credentials`, {
    method: 'OPTIONS',
    headers: {
      origin: trustedOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(trustedPreflight.status, 204);
  assert.equal(trustedPreflight.headers.get('access-control-allow-origin'), trustedOrigin);
  assert.match(trustedPreflight.headers.get('access-control-allow-methods'), /POST/u);
});
