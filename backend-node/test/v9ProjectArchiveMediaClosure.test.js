'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MEDIA_LIMITS,
  createProjectArchiveV21MediaCollector,
  validateProjectArchiveV21Media,
} = require('../src/adapters/v2/zip/projectArchiveV21MediaClosure');
const { uid } = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function version(index, overrides = {}) {
  return {
    uid: uid(9900 + index),
    asset_uid: uid(9950 + index),
    storage_provider: 'local',
    logical_uri: `asset://dramas/${uid(9990)}/video/${uid(9950 + index)}/${uid(9900 + index)}`,
    relative_path: `projects/archive/media-${index}.bin`,
    sha256: 'a'.repeat(64),
    mime_type: 'application/octet-stream',
    width: null,
    height: null,
    duration_ms: null,
    parent_uid: null,
    status: 'ready',
    created_at: '2026-08-30T00:00:00.000Z',
    ...overrides,
  };
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-archive-media-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return root;
}

function writeRelative(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function filesFrom(result) {
  return new Map(result.archiveEntries().map((entry) => [entry.archivePath, entry.buffer]));
}

test('collects local ready bytes by hash and projects remote or inactive bindings deterministically', (t) => {
  const root = temporaryRoot(t);
  const bytes = Buffer.from('portable project media bytes');
  const hash = sha256(bytes);
  writeRelative(root, 'projects/archive/media-0.bin', bytes);
  writeRelative(root, 'projects/archive/media-1.bin', bytes);
  const rows = [
    version(3, { status: 'failed', sha256: null }),
    version(2, { storage_provider: 'nas', relative_path: 'remote/media.bin', sha256: null }),
    version(1, { sha256: hash }),
    version(0, { sha256: hash }),
  ];

  const result = createProjectArchiveV21MediaCollector(root).collect(rows);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.bindings), true);
  assert.deepEqual(result.bindings.map((binding) => binding.asset_version_uid),
    [...rows].map((row) => row.uid).sort());
  assert.deepEqual(result.bindings.map((binding) => binding.binding_state), [
    'content_addressed', 'content_addressed', 'needs_rebind', 'not_required',
  ]);
  assert.equal(result.totalBytes, bytes.length);
  const entries = result.archiveEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].archivePath, `v2/media/sha256/${hash.slice(0, 2)}/${hash}`);
  assert.deepEqual(entries[0].buffer, bytes);
  entries[0].buffer[0] ^= 0xff;
  assert.deepEqual(result.archiveEntries()[0].buffer, bytes);
  assert.equal(validateProjectArchiveV21Media({
    assetVersions: rows,
    bindings: result.bindings,
    files: filesFrom(result),
  }), result.bindings);
});

test('fails closed on unsafe, missing, empty, oversized, or hash-drifted local media', (t) => {
  const root = temporaryRoot(t);
  const bytes = Buffer.from('expected bytes');
  const hash = sha256(bytes);
  writeRelative(root, 'projects/archive/media-0.bin', bytes);
  const invalidRows = [
    version(0, { sha256: 'b'.repeat(64) }),
    version(0, { relative_path: 'projects/archive/missing.bin', sha256: hash }),
    version(0, { relative_path: '../escape.bin', sha256: hash }),
    version(0, { sha256: null }),
  ];
  for (const row of invalidRows) {
    assert.throws(
      () => createProjectArchiveV21MediaCollector(root).collect([row]),
      (error) => error?.code === 'PROJECT_ARCHIVE_INVALID'
        && !String(error).includes(root),
    );
  }

  writeRelative(root, 'projects/archive/media-4.bin', Buffer.alloc(0));
  assert.throws(
    () => createProjectArchiveV21MediaCollector(root).collect([
      version(4, { sha256: sha256(Buffer.alloc(0)) }),
    ]),
    (error) => error?.code === 'PROJECT_ARCHIVE_INVALID',
  );

  const oversized = writeRelative(root, 'projects/archive/media-5.bin', Buffer.from([0]));
  fs.truncateSync(oversized, MEDIA_LIMITS.fileBytes + 1);
  assert.throws(
    () => createProjectArchiveV21MediaCollector(root).collect([
      version(5, { sha256: 'c'.repeat(64) }),
    ]),
    (error) => error?.code === 'PROJECT_ARCHIVE_LIMIT_EXCEEDED',
  );
});

test('rejects replaced roots, linked path segments, and hostile asset-version containers', (t) => {
  const root = temporaryRoot(t);
  const bytes = Buffer.from('stable root bytes');
  const hash = sha256(bytes);
  writeRelative(root, 'projects/archive/media-0.bin', bytes);
  const collector = createProjectArchiveV21MediaCollector(root);
  const moved = `${root}-moved`;
  fs.renameSync(root, moved);
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(moved, { force: true, recursive: true }));
  assert.throws(
    () => collector.collect([version(0, { sha256: hash })]),
    (error) => error?.code === 'PROJECT_ARCHIVE_INVALID',
  );

  let reads = 0;
  const hostile = new Proxy([], {
    getOwnPropertyDescriptor() {
      reads += 1;
      throw new Error('media sentinel');
    },
  });
  assert.throws(
    () => createProjectArchiveV21MediaCollector(root).collect(hostile),
    (error) => error?.code === 'PROJECT_ARCHIVE_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(reads, 0);

  const outside = temporaryRoot(t);
  writeRelative(outside, 'media.bin', bytes);
  const linkedRoot = temporaryRoot(t);
  const linked = path.join(linkedRoot, 'projects');
  try {
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.diagnostic(`linked-path check skipped: ${error.code || error.message}`);
    return;
  }
  assert.throws(
    () => createProjectArchiveV21MediaCollector(linkedRoot).collect([
      version(0, { relative_path: 'projects/media.bin', sha256: hash }),
    ]),
    (error) => error?.code === 'PROJECT_ARCHIVE_INVALID',
  );
});

test('validates an exact byte closure and rejects missing, extra, drifted, or hostile files', (t) => {
  const root = temporaryRoot(t);
  const bytes = Buffer.from('validated archive entry');
  const hash = sha256(bytes);
  writeRelative(root, 'projects/archive/media-0.bin', bytes);
  const rows = [version(0, { sha256: hash })];
  const result = createProjectArchiveV21MediaCollector(root).collect(rows);
  const files = filesFrom(result);
  const binding = result.bindings[0];

  const cases = [
    { bindings: [], files },
    { bindings: [{ ...binding, byte_length: binding.byte_length + 1 }], files },
    { bindings: result.bindings, files: new Map() },
    { bindings: result.bindings, files: new Map([...files, ['v2/media/sha256/aa/' + 'a'.repeat(64), bytes]]) },
    { bindings: result.bindings, files: new Map([[binding.archive_path, Buffer.from('drift')]]) },
  ];
  for (const value of cases) {
    assert.throws(
      () => validateProjectArchiveV21Media({ assetVersions: rows, ...value }),
      (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID',
    );
  }

  let reads = 0;
  const hostileBuffer = new Proxy(Buffer.from(bytes), {
    get() {
      reads += 1;
      throw new Error('buffer sentinel');
    },
  });
  assert.throws(
    () => validateProjectArchiveV21Media({
      assetVersions: rows,
      bindings: result.bindings,
      files: new Map([[binding.archive_path, hostileBuffer]]),
    }),
    (error) => error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID'
      && !String(error).includes('sentinel'),
  );
  assert.equal(reads, 0);
});

test('does not execute polluted inherited collection accessors', () => {
  const modulePath = path.resolve(
    __dirname,
    '../src/adapters/v2/zip/projectArchiveV21MediaClosure.js',
  );
  const script = String.raw`
    'use strict';
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const {
      createProjectArchiveV21MediaCollector,
      validateProjectArchiveV21Media,
    } = require(process.argv[1]);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lmd-array-poison-'));
    const relativePath = 'projects/archive/media.bin';
    const filename = path.join(root, 'projects', 'archive', 'media.bin');
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const bytes = Buffer.from('array prototype isolation');
    fs.writeFileSync(filename, bytes);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const row = {
      uid: '00000000-0000-4000-8000-000000009900',
      asset_uid: '00000000-0000-4000-8000-000000009950',
      storage_provider: 'local',
      logical_uri: 'asset://dramas/00000000-0000-4000-8000-000000009999/video/a/v',
      relative_path: relativePath,
      sha256: hash,
      mime_type: 'application/octet-stream',
      width: null,
      height: null,
      duration_ms: null,
      parent_uid: null,
      status: 'ready',
      created_at: '2026-08-30T00:00:00.000Z',
    };
    const collector = createProjectArchiveV21MediaCollector(root);
    const baseline = collector.collect([row]);
    const entry = baseline.archiveEntries()[0];
    const files = new Map([[entry.archivePath, entry.buffer]]);
    const reads = {
      iterator: 0,
      map: 0,
      sort: 0,
      mapHas: 0,
      mapGet: 0,
      mapSet: 0,
      mapSize: 0,
      setHas: 0,
      setAdd: 0,
      setSize: 0,
    };
    const iterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
    const map = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
    const sort = Object.getOwnPropertyDescriptor(Array.prototype, 'sort');
    const mapHas = Object.getOwnPropertyDescriptor(Map.prototype, 'has');
    const mapGet = Object.getOwnPropertyDescriptor(Map.prototype, 'get');
    const mapSet = Object.getOwnPropertyDescriptor(Map.prototype, 'set');
    const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size');
    const setHas = Object.getOwnPropertyDescriptor(Set.prototype, 'has');
    const setAdd = Object.getOwnPropertyDescriptor(Set.prototype, 'add');
    const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size');
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      get() { reads.iterator += 1; return iterator.value; },
    });
    Object.defineProperty(Array.prototype, 'map', {
      configurable: true,
      get() { reads.map += 1; return map.value; },
    });
    Object.defineProperty(Array.prototype, 'sort', {
      configurable: true,
      get() { reads.sort += 1; return sort.value; },
    });
    Object.defineProperty(Map.prototype, 'has', {
      configurable: true,
      get() { reads.mapHas += 1; return mapHas.value; },
    });
    Object.defineProperty(Map.prototype, 'get', {
      configurable: true,
      get() { reads.mapGet += 1; return mapGet.value; },
    });
    Object.defineProperty(Map.prototype, 'set', {
      configurable: true,
      get() { reads.mapSet += 1; return mapSet.value; },
    });
    Object.defineProperty(Map.prototype, 'size', {
      configurable: true,
      get() { reads.mapSize += 1; return Reflect.apply(mapSize.get, this, []); },
    });
    Object.defineProperty(Set.prototype, 'has', {
      configurable: true,
      get() { reads.setHas += 1; return setHas.value; },
    });
    Object.defineProperty(Set.prototype, 'add', {
      configurable: true,
      get() { reads.setAdd += 1; return setAdd.value; },
    });
    Object.defineProperty(Set.prototype, 'size', {
      configurable: true,
      get() { reads.setSize += 1; return Reflect.apply(setSize.get, this, []); },
    });
    try {
      validateProjectArchiveV21Media({
        assetVersions: [row],
        bindings: baseline.bindings,
        files,
      });
      validateProjectArchiveV21Media({ assetVersions: [], bindings: [], files: new Map() });
      collector.collect([]);
      collector.collect([row]).archiveEntries();
      baseline.archiveEntries();
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
      Object.defineProperty(Array.prototype, 'map', map);
      Object.defineProperty(Array.prototype, 'sort', sort);
      Object.defineProperty(Map.prototype, 'has', mapHas);
      Object.defineProperty(Map.prototype, 'get', mapGet);
      Object.defineProperty(Map.prototype, 'set', mapSet);
      Object.defineProperty(Map.prototype, 'size', mapSize);
      Object.defineProperty(Set.prototype, 'has', setHas);
      Object.defineProperty(Set.prototype, 'add', setAdd);
      Object.defineProperty(Set.prototype, 'size', setSize);
      fs.rmSync(root, { force: true, recursive: true });
    }
    process.stdout.write(JSON.stringify(reads));
  `;
  const result = childProcess.spawnSync(process.execPath, ['-e', script, modulePath], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    iterator: 0,
    map: 0,
    sort: 0,
    mapHas: 0,
    mapGet: 0,
    mapSet: 0,
    mapSize: 0,
    setHas: 0,
    setAdd: 0,
    setSize: 0,
  });
});
