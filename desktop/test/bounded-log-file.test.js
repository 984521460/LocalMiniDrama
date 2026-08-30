'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createBoundedLogWriter } = require('../bounded-log-file');

test('desktop startup log writer rotates within a fixed disk budget', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-p9-08-desktop-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'startup.log');
  const writer = createBoundedLogWriter({
    filePath,
    maxLineBytes: 96,
    maxFileBytes: 256,
    maxBackups: 2,
  });

  for (let index = 0; index < 30; index += 1) {
    assert.equal(writer.write(`desktop=${index} ${'x'.repeat(120)}`), true);
  }
  const files = fs.readdirSync(root);
  assert.ok(files.length <= 3);
  assert.ok(files.every((name) => fs.statSync(path.join(root, name)).size <= 256));
  assert.match(fs.readFileSync(filePath, 'utf8'), /desktop=29/);
});

test('desktop startup logging never persists raw stacks, runtime paths, or failed-load URLs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /createBoundedLogWriter/);
  assert.match(source, /formatStartupError/);
  assert.doesNotMatch(source, /appendFileSync\(MAIN_STARTUP_LOG/u);
  assert.doesNotMatch(source, /err\.stack|reason\.stack|process\.execPath/u);
  assert.match(source, /did-fail-load code=/u);
  assert.doesNotMatch(source, /did-fail-load.*desc|did-fail-load.*url/u);
});

test('Electron loads the reviewed native log lease through the Windows delay-load hook', () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  const desktopRoot = path.join(__dirname, '..');
  const electron = require('electron');
  const fixture = path.join(__dirname, 'fixtures', 'electron-native-log-smoke.cjs');
  const addon = path.join(
    desktopRoot,
    '..',
    'backend-node',
    'native',
    'build',
    'electron-win32-x64',
    'log-directory-lease.node',
  );
  const result = spawnSync(electron, [fixture, addon], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 23);
});
