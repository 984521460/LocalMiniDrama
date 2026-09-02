'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const express = require('express');

const {
  installApplicationCors,
  installLocalV2OriginBoundary,
} = require('../src/app');

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      server,
    }));
  });
}

function fixture() {
  const counters = { downstream: 0, handler: 0 };
  const app = express();
  installLocalV2OriginBoundary(app);
  app.use('/api/v1/v2', (_req, _res, next) => {
    counters.downstream += 1;
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  installApplicationCors(app, []);
  app.all('/api/v1/v2/synthetic-state', (req, res) => {
    counters.handler += 1;
    res.json({ method: req.method, value: req.body?.value ?? null });
  });
  return { app, counters };
}

test('production app installs every v2 origin gate before the matching body parser', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/app.js'), 'utf8');
  const providerBoundary = source.indexOf('installProviderCredentialBodyBoundary(app)');
  const v2Boundary = source.indexOf('installLocalV2OriginBoundary(app)');
  const globalJson = source.indexOf("app.use(express.json({ limit: '10mb' }))");
  const globalUrlencoded = source.indexOf('app.use(express.urlencoded({ extended: true }))');
  assert.ok(providerBoundary >= 0);
  assert.ok(v2Boundary > providerBoundary);
  assert.ok(globalJson > v2Boundary);
  assert.ok(globalUrlencoded > globalJson);
});

test('CORS response policy alone does not stop a cross-site form mutation', async (t) => {
  let handlerCalls = 0;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  installApplicationCors(app, []);
  app.post('/api/v1/v2/synthetic-state', (_req, res) => {
    handlerCalls += 1;
    res.status(204).end();
  });
  const listening = await listen(app);
  t.after(() => listening.server.close());
  const response = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://untrusted.example',
    },
    body: 'value=synthetic',
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(handlerCalls, 1);
});

test('v2 origin boundary rejects untrusted browser requests before parsers and handlers', async (t) => {
  const current = fixture();
  const listening = await listen(current.app);
  t.after(() => listening.server.close());
  const evilOrigin = 'https://untrusted.example';

  const preflight = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
    method: 'OPTIONS',
    headers: {
      origin: evilOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  const requests = [
    ['GET', undefined],
    ['POST', 'value=synthetic'],
    ['PUT', 'value=synthetic'],
    ['PATCH', 'value=synthetic'],
    ['DELETE', undefined],
  ];
  for (let index = 0; index < requests.length; index += 1) {
    const [method, body] = requests[index];
    const response = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
      method,
      headers: {
        origin: evilOrigin,
        ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
      },
      ...(body === undefined ? {} : { body }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal((await response.json()).error.code, 'LOCAL_V2_ORIGIN_FORBIDDEN');
  }
  assert.deepEqual(current.counters, { downstream: 0, handler: 0 });
});

test('v2 origin boundary accepts exact loopback origins and origin-less local clients', async (t) => {
  const current = fixture();
  const listening = await listen(current.app);
  t.after(() => listening.server.close());
  const trustedOrigins = [
    'http://localhost:3013',
    'http://127.0.0.1:3013',
    'https://[::1]:3013',
  ];

  for (let index = 0; index < trustedOrigins.length; index += 1) {
    const origin = trustedOrigins[index];
    const preflight = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(preflight.headers.get('vary'), 'Origin');

    const response = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ value: 'synthetic' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal((await response.json()).value, 'synthetic');
  }

  const local = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'native' }),
  });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('access-control-allow-origin'), null);
  assert.equal((await local.json()).value, 'native');
  assert.deepEqual(current.counters, { downstream: 4, handler: 4 });
});

test('v2 origin boundary rejects ambiguous origins and preflight metadata', async (t) => {
  const current = fixture();
  const listening = await listen(current.app);
  t.after(() => listening.server.close());
  const rejectedOrigins = [
    'null',
    'https://example.invalid',
    'http://127.example.com:3013',
    'http://127.0.0.1.example:3013',
    'http://user@localhost:3013',
    'http://localhost:3013/path',
    'http://localhost:3013/?query=1',
    'http://localhost:3013/#fragment',
  ];
  for (let index = 0; index < rejectedOrigins.length; index += 1) {
    const response = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
      headers: { origin: rejectedOrigins[index] },
    });
    assert.equal(response.status, 403);
  }

  const badMethod = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3013',
      'access-control-request-method': 'TRACE',
    },
  });
  assert.equal(badMethod.status, 403);
  const badHeader = await fetch(`${listening.base}/api/v1/v2/synthetic-state`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://localhost:3013',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'x-secret-header',
    },
  });
  assert.equal(badHeader.status, 403);
  assert.deepEqual(current.counters, { downstream: 0, handler: 0 });
});
