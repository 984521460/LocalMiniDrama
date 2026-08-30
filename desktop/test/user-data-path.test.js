'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveUserDataPath } = require('../user-data-path');

function withTempDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-user-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('migrates legacy data before the current user-data directory is created', (t) => {
  const appDataPath = withTempDirectory(t);
  const legacyPath = path.join(appDataPath, 'LocalMiniDrama');
  fs.mkdirSync(legacyPath);
  fs.writeFileSync(path.join(legacyPath, 'project.db'), 'legacy-data');

  const result = resolveUserDataPath({ appDataPath });
  const currentPath = path.join(appDataPath, 'localminidrama-desktop');

  assert.equal(result.path, currentPath);
  assert.equal(result.migratedFrom, legacyPath);
  assert.equal(fs.readFileSync(path.join(currentPath, 'project.db'), 'utf8'), 'legacy-data');
  assert.equal(fs.existsSync(legacyPath), false);

  const secondLaunch = resolveUserDataPath({ appDataPath });
  assert.equal(secondLaunch.path, currentPath);
  assert.equal(secondLaunch.migratedFrom, null);
  assert.equal(fs.readFileSync(path.join(currentPath, 'project.db'), 'utf8'), 'legacy-data');
});

test('replaces an empty current directory so interrupted upgrades can recover', (t) => {
  const appDataPath = withTempDirectory(t);
  const legacyPath = path.join(appDataPath, 'LocalMiniDrama');
  const currentPath = path.join(appDataPath, 'localminidrama-desktop');
  fs.mkdirSync(legacyPath);
  fs.mkdirSync(currentPath);
  fs.writeFileSync(path.join(legacyPath, 'config.yaml'), 'legacy-config');

  const result = resolveUserDataPath({ appDataPath });

  assert.equal(result.path, currentPath);
  assert.equal(result.migratedFrom, legacyPath);
  assert.equal(fs.readFileSync(path.join(currentPath, 'config.yaml'), 'utf8'), 'legacy-config');
});

test('never overwrites a current directory that already contains data', (t) => {
  const appDataPath = withTempDirectory(t);
  const legacyPath = path.join(appDataPath, 'LocalMiniDrama');
  const currentPath = path.join(appDataPath, 'localminidrama-desktop');
  fs.mkdirSync(legacyPath);
  fs.mkdirSync(currentPath);
  fs.writeFileSync(path.join(legacyPath, 'project.db'), 'legacy-data');
  fs.writeFileSync(path.join(currentPath, 'project.db'), 'current-data');

  const result = resolveUserDataPath({ appDataPath });

  assert.equal(result.path, currentPath);
  assert.equal(result.migratedFrom, null);
  assert.equal(fs.readFileSync(path.join(currentPath, 'project.db'), 'utf8'), 'current-data');
  assert.equal(fs.readFileSync(path.join(legacyPath, 'project.db'), 'utf8'), 'legacy-data');
});

test('uses the legacy path for this launch when a safe rename fails', (t) => {
  const appDataPath = withTempDirectory(t);
  const legacyPath = path.join(appDataPath, 'LocalMiniDrama');
  fs.mkdirSync(legacyPath);
  fs.writeFileSync(path.join(legacyPath, 'project.db'), 'legacy-data');
  const fsWithFailedRename = { ...fs, renameSync() { throw new Error('locked'); } };

  const result = resolveUserDataPath({ appDataPath, fsImpl: fsWithFailedRename });

  assert.equal(result.path, legacyPath);
  assert.equal(result.migratedFrom, null);
  assert.match(result.migrationError.message, /locked/);
  assert.equal(fs.readFileSync(path.join(legacyPath, 'project.db'), 'utf8'), 'legacy-data');
});

test('uses the legacy path when an empty current directory cannot be removed', (t) => {
  const appDataPath = withTempDirectory(t);
  const legacyPath = path.join(appDataPath, 'LocalMiniDrama');
  const currentPath = path.join(appDataPath, 'localminidrama-desktop');
  fs.mkdirSync(legacyPath);
  fs.mkdirSync(currentPath);
  fs.writeFileSync(path.join(legacyPath, 'project.db'), 'legacy-data');
  const fsWithFailedRemove = { ...fs, rmdirSync() { throw new Error('current-dir-locked'); } };

  const result = resolveUserDataPath({ appDataPath, fsImpl: fsWithFailedRemove });

  assert.equal(result.path, legacyPath);
  assert.equal(result.migratedFrom, null);
  assert.match(result.migrationError.message, /current-dir-locked/);
  assert.equal(fs.readFileSync(path.join(legacyPath, 'project.db'), 'utf8'), 'legacy-data');
});
