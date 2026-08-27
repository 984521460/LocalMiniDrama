const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  StorageContractError,
  createAssetLocator,
  createAssetUri,
  createStorageRelativePath,
  parseAssetLocator,
  parseAssetUri,
  parseStorageRelativePath,
} = require('../dist');

test('asset URI and relative path factories are deterministic and canonical', () => {
  const logicalSegments = ['characters', '11111111-1111-4111-8111-111111111111', 'identity', 'front'];
  const relativeSegments = ['projects', '22222222-2222-4222-8222-222222222222', 'assets', ...logicalSegments, 'front.png'];

  const logicalUri = createAssetUri(logicalSegments);
  const relativePath = createStorageRelativePath(relativeSegments);
  assert.equal(logicalUri, 'asset://characters/11111111-1111-4111-8111-111111111111/identity/front');
  assert.equal(relativePath, 'projects/22222222-2222-4222-8222-222222222222/assets/characters/11111111-1111-4111-8111-111111111111/identity/front/front.png');
  assert.deepEqual(parseAssetUri(logicalUri), logicalSegments);
  assert.deepEqual(parseStorageRelativePath(relativePath), relativeSegments);
  assert.equal(Object.isFrozen(parseAssetUri(logicalUri)), true);

  const locator = createAssetLocator({ logicalSegments, relativeSegments });
  assert.deepEqual(locator, { storageProvider: 'local', logicalUri, relativePath });
  assert.equal(Object.isFrozen(locator), true);
});

test('asset URI factories and parsers share the same total-length boundary', () => {
  const exactSegments = [
    ...Array.from({ length: 15 }, (_, index) => `${String(index).padStart(2, '0')}${'a'.repeat(126)}`),
    `15${'b'.repeat(103)}`,
  ];
  const exactUri = createAssetUri(exactSegments);
  assert.equal(exactUri.length, 2048);
  assert.deepEqual(parseAssetUri(exactUri), exactSegments);

  const tooLongSegments = [...exactSegments.slice(0, -1), `15${'b'.repeat(104)}`];
  assert.throws(() => createAssetUri(tooLongSegments), StorageContractError);
  assert.throws(
    () => createAssetLocator({ logicalSegments: tooLongSegments, relativeSegments: ['asset.bin'] }),
    StorageContractError,
  );
});

test('asset URI and storage paths reject ambiguous, encoded, absolute, and platform-specific forms', () => {
  const invalidUris = [
    '', 'http://characters/id', 'ASSET://characters/id', 'asset://', 'asset:///id',
    'asset://characters//id', 'asset://characters/../id', 'asset://characters/%2e%2e/id',
    'asset://characters\\id', 'asset://characters/id?query=1', 'asset://characters/id#fragment',
  ];
  for (const value of invalidUris) {
    assert.throws(() => parseAssetUri(value), StorageContractError, value);
  }

  const invalidPaths = [
    '', '.', '..', '../escape.png', 'projects/../escape.png', 'projects//asset.png',
    '/absolute/asset.png', 'C:\\absolute\\asset.png', '\\\\server\\share\\asset.png',
    'projects\\asset.png', 'projects/%2e%2e/asset.png', 'projects/NUL.txt',
    'projects/asset.png:stream', 'projects/trailing.', 'projects/trailing ', 'projects/\0asset.png',
  ];
  for (const value of invalidPaths) {
    assert.throws(() => parseStorageRelativePath(value), StorageContractError, value);
  }
});

test('public locators are exact frozen snapshots and never accept local root fields or accessors', () => {
  const safe = {
    storageProvider: 'local',
    logicalUri: 'asset://dramas/demo/poster/v1',
    relativePath: 'projects/demo/assets/poster/v1.png',
  };
  assert.deepEqual(parseAssetLocator(safe), safe);

  assert.throws(
    () => parseAssetLocator({ ...safe, absolutePath: 'C:\\private\\asset.png' }),
    /unsupported field/i,
  );
  assert.throws(
    () => parseAssetLocator({ ...safe, projectRoot: 'C:\\private' }),
    /unsupported field/i,
  );

  let getterReads = 0;
  const hostile = { storageProvider: 'local', relativePath: safe.relativePath };
  Object.defineProperty(hostile, 'logicalUri', {
    enumerable: true,
    get() {
      getterReads += 1;
      return safe.logicalUri;
    },
  });
  assert.throws(() => parseAssetLocator(hostile), StorageContractError);
  assert.equal(getterReads, 0);
});

test('package consumers load compiled CommonJS, declarations, and ESM exports', async () => {
  const entryPath = require.resolve('@local-mini-drama/storage');
  const packageRoot = path.resolve(__dirname, '..');
  assert.equal(entryPath, path.join(packageRoot, 'dist', 'index.js'));
  assert.equal(fs.existsSync(path.join(packageRoot, 'dist', 'index.d.ts')), true);
  assert.equal(fs.existsSync(path.join(packageRoot, 'dist', 'asset-location.d.ts')), true);

  const storage = await import('@local-mini-drama/storage');
  assert.equal(typeof storage.createAssetLocator, 'function');
  assert.equal(typeof storage.parseAssetLocator, 'function');
  assert.equal(typeof storage.StorageContractError, 'function');
});
