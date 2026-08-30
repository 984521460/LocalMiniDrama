'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { resolvePhysicalMigrationsDir } = require('../src/db/migrate');

test('packaged migration path resolves to the physical asar-unpacked directory', () => {
  const moduleDirectory = path.join(
    'C:\\fixture',
    'resources',
    'app.asar',
    'backend-app',
    'src',
    'db',
  );
  assert.equal(
    resolvePhysicalMigrationsDir(moduleDirectory),
    path.join(
      'C:\\fixture',
      'resources',
      'app.asar.unpacked',
      'backend-app',
      'migrations',
    ),
  );
});
test('development migration path stays under the backend module root', () => {
  const moduleDirectory = path.join('C:\\fixture', 'backend-node', 'src', 'db');
  assert.equal(
    resolvePhysicalMigrationsDir(moduleDirectory),
    path.join('C:\\fixture', 'backend-node', 'migrations'),
  );
});
