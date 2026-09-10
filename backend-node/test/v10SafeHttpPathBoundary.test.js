'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { installSafeHttpBoundary } = require('../src/startup/startupPolicy');

function request(port, path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { Origin: 'http://127.0.0.1:5831', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('safe boundary follows actual Express API namespace semantics without dispatching denied handlers', async (t) => {
  const app = express();
  installSafeHttpBoundary(app);
  const router = express.Router();
  let deniedDispatches = 0;
  router.get('/dramas/1', (_req, res) => res.json({ fixture: 'allowed-local-read' }));
  router.all('*', (_req, res) => { deniedDispatches += 1; res.json({ fixture: 'FORBIDDEN_API_HANDLER' }); });
  app.use('/api/v1', router);
  app.get('/static/synthetic.png', (_req, res) => res.type('png').send(Buffer.from('89504e470d0a1a0a', 'hex')));
  app.get('*', (_req, res) => res.type('html').send('<!doctype html><title>synthetic SPA fallback</title>'));
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  for (const method of ['GET', 'HEAD']) {
    for (const route of ['/api/v1/ai-configs', '/API/v1/ai-configs', '/aPi/V1/AI-Configs',
      '/API/v1/storyboards/episode/1/generate', '/aPi/v1/dramas/1/export', '/API/v1/dramas/1',
      '/api/v1/unknown', '/api/v1//ai-configs', '/api/v1/%61i-configs', '/api/v1/ai-configs/',
      '/api/v1/ai-configs?mode=normal', '/api', '/API']) {
      const response = await request(port, route, method);
      assert.equal(response.status, 403, `${method} ${route}`);
      if (method === 'GET') assert.equal(JSON.parse(response.body).error.code, 'OFFLINE_SAFE_MODE');
      else assert.equal(response.body, '');
    }
  }
  // Raw-path transport does not normalize encodings or repeated separators.
  // Express does not mount these as /api/v1: prove the response is our SPA,
  // not an API JSON body or an arbitrary 404 accepted as success.
  for (const route of ['/%61pi/v1/ai-configs', '/%41PI/v1/ai-configs', '/%2561pi/v1/ai-configs',
    '//api/v1/ai-configs', '/api%2fv1/ai-configs', '/api%5cv1/ai-configs', '/api%252fv1/ai-configs',
    '/outside/../api/v1/ai-configs']) {
    const response = await request(port, route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.equal(response.body, '<!doctype html><title>synthetic SPA fallback</title>');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const route of ['/api/v1/ai-configs', '/API/v1/ai-configs', '/not-api']) {
      assert.equal((await request(port, route, method)).status, 403, `${method} ${route}`);
    }
  }
  const local = await request(port, '/api/v1/dramas/1');
  assert.equal(local.status, 200);
  assert.deepEqual(JSON.parse(local.body), { fixture: 'allowed-local-read' });
  assert.equal((await request(port, '/api/v1/dramas/1', 'HEAD')).status, 200);
  assert.match((await request(port, '/static/synthetic.png')).headers['content-type'], /^image\/png/);
  for (const route of ['/api/v1/dramas/1', '/API/v1/ai-configs', '/static/synthetic.png']) {
    for (const headers of [{ Origin: 'https://evil.invalid' }, { Host: 'evil.invalid' }]) {
      const response = await request(port, route, 'GET', headers);
      assert.equal(response.status, 403);
      assert.equal(JSON.parse(response.body).error.code, 'OFFLINE_SAFE_ORIGIN_FORBIDDEN');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal(deniedDispatches, 0);
});
