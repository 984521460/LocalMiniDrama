const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('actual backend health endpoint listens on loopback with an isolated database', async () => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-mini-drama-e2e-'));
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'e2e.sqlite').replace(/\\/g, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/g, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.yaml'),
    [
      'app:',
      '  name: LocalMiniDrama-E2E',
      '  version: 0.0.0-test',
      'server:',
      '  port: 0',
      '  insecure_tls: false',
      'database:',
      '  type: sqlite',
      `  path: "${databasePath}"`,
      'storage:',
      `  local_path: "${storagePath}"`,
      '',
    ].join('\n'),
    'utf8',
  );

  let server = null;
  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const { resolveServerHost } = require('../src/config/serverSecurityDefaults');
    const { app, config } = createApp();
    const host = resolveServerHost(config.server);
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, host, () => resolve(instance));
      instance.once('error', reject);
    });

    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    const body = await response.json();

    assert.equal(address.address, '127.0.0.1');
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.app, 'LocalMiniDrama-E2E');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
