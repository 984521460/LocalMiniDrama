'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { copyTreeSync } = require('../scripts/lib/copy-tree');

test('copyTreeSync copies nested directories and files', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-copy-tree-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, 'source');
  const destination = path.join(tempRoot, 'destination');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'root.txt'), 'root', 'utf8');
  fs.writeFileSync(path.join(source, 'nested', 'child.txt'), 'child', 'utf8');

  copyTreeSync(source, destination);

  assert.equal(fs.readFileSync(path.join(destination, 'root.txt'), 'utf8'), 'root');
  assert.equal(fs.readFileSync(path.join(destination, 'nested', 'child.txt'), 'utf8'), 'child');
});

test('copyTreeSync overwrites existing destination files', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-copy-tree-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, 'source');
  const destination = path.join(tempRoot, 'destination');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(source, 'same.txt'), 'new', 'utf8');
  fs.writeFileSync(path.join(destination, 'same.txt'), 'old', 'utf8');

  copyTreeSync(source, destination);

  assert.equal(fs.readFileSync(path.join(destination, 'same.txt'), 'utf8'), 'new');
});

test('copyTreeSync rejects symbolic links instead of following them', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-copy-tree-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, 'source');
  const linkedTarget = path.join(tempRoot, 'linked-target');
  const destination = path.join(tempRoot, 'destination');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(linkedTarget, { recursive: true });
  fs.symlinkSync(
    linkedTarget,
    path.join(source, 'linked-directory'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  assert.throws(() => copyTreeSync(source, destination), /symbolic links are not supported/);
});

test('copyTreeSync rejects a destination nested inside its source', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-copy-tree-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, 'source');
  fs.mkdirSync(source, { recursive: true });

  assert.throws(
    () => copyTreeSync(source, path.join(source, 'nested-destination')),
    /destination must be outside source/,
  );
});

test('copyTreeSync rejects a source nested inside its destination', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localminidrama-copy-tree-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const destination = path.join(tempRoot, 'destination');
  const source = path.join(destination, 'nested-source');
  fs.mkdirSync(source, { recursive: true });

  assert.throws(
    () => copyTreeSync(source, destination),
    /source must be outside destination/,
  );
});

test('desktop recursive copy scripts use the shared copyTreeSync boundary', () => {
  for (const scriptName of ['copy-backend.js', 'copy-front.js']) {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', scriptName), 'utf8');
    assert.match(script, /require\('\.\/lib\/copy-tree'\)/);
    assert.match(script, /copyTreeSync\(/);
    assert.doesNotMatch(script, /fs\.cp(?:Sync)?\(/);
  }
});
