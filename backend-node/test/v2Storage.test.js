const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAssetLocator } = require('../../packages/storage/dist');
const { LocalStorageError, LocalStorageProvider } = require('../src/adapters/v2/storage');

function createTempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

test('LocalStorageProvider resolves canonical locators under its private project root', (t) => {
  const projectRoot = createTempDirectory(t, 'local-mini-drama-storage-');
  const provider = new LocalStorageProvider({ projectRoot });
  const locator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'poster', 'v1'],
    relativeSegments: ['projects', 'demo', 'assets', 'poster', 'v1.png'],
  });

  const resolved = provider.resolve(locator);
  assert.equal(resolved, path.join(projectRoot, 'projects', 'demo', 'assets', 'poster', 'v1.png'));
  assert.deepEqual(JSON.parse(JSON.stringify(provider)), { id: 'local' });
  assert.equal(JSON.stringify(locator).includes(projectRoot), false);
});

test('LocalStorageProvider rejects invalid roots, other providers, and symlink or junction escapes', (t) => {
  const taskRoot = createTempDirectory(t, 'local-mini-drama-storage-boundary-');
  const projectRoot = path.join(taskRoot, 'project');
  const outsideRoot = path.join(taskRoot, 'outside');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outsideRoot);

  assert.throws(() => new LocalStorageProvider({ projectRoot: 'relative/project' }), /absolute/i);
  assert.throws(() => new LocalStorageProvider({ projectRoot: path.join(taskRoot, 'missing') }), /existing directory/i);
  const regularFile = path.join(taskRoot, 'file-root');
  fs.writeFileSync(regularFile, 'fixture');
  assert.throws(() => new LocalStorageProvider({ projectRoot: regularFile }), /existing directory/i);

  const provider = new LocalStorageProvider({ projectRoot });
  assert.throws(() => provider.resolve({
    storageProvider: 's3',
    logicalUri: 'asset://dramas/demo/poster/v1',
    relativePath: 'projects/demo/assets/poster/v1.png',
  }), /storage provider/i);

  const linkPath = path.join(projectRoot, 'escape-link');
  fs.symlinkSync(outsideRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => provider.resolve({
    storageProvider: 'local',
    logicalUri: 'asset://dramas/demo/poster/v2',
    relativePath: 'escape-link/asset.png',
  }), /symbolic link|project root/i);
});

test('LocalStorageProvider reads, writes, overwrites, and removes through locator-only methods', async (t) => {
  const projectRoot = createTempDirectory(t, 'local-mini-drama-storage-io-');
  const provider = new LocalStorageProvider({ projectRoot });
  const locator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'audio', 'v1'],
    relativeSegments: ['projects', 'demo', 'assets', 'audio', 'v1.bin'],
  });

  assert.equal(await provider.exists(locator), false);
  assert.deepEqual(await provider.write(locator, Buffer.from('first')), locator);
  assert.equal(await provider.exists(locator), true);
  assert.equal((await provider.read(locator)).toString('utf8'), 'first');
  let duplicateError;
  try {
    await provider.write(locator, Buffer.from('blocked'));
  } catch (error) {
    duplicateError = error;
  }
  assert.ok(duplicateError instanceof LocalStorageError);
  assert.equal(duplicateError.code, 'LOCAL_STORAGE_ENTRY_EXISTS');
  assert.equal(duplicateError.message.includes(projectRoot), false);
  assert.equal(JSON.stringify(duplicateError).includes(projectRoot), false);
  await provider.write(locator, Buffer.from('second'), { overwrite: true });
  assert.equal((await provider.read(locator)).toString('utf8'), 'second');
  assert.equal(await provider.remove(locator), true);
  assert.equal(await provider.remove(locator), false);

  const rootFile = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'root-file'],
    relativeSegments: ['root-file.bin'],
  });
  await provider.write(rootFile, Buffer.from('root'));
  assert.equal((await provider.read(rootFile)).toString('utf8'), 'root');
  await assert.rejects(() => provider.write(locator, 'plain text'), /Uint8Array/);

  let missingError;
  try {
    await provider.read(locator);
  } catch (error) {
    missingError = error;
  }
  assert.ok(missingError instanceof LocalStorageError);
  assert.equal(missingError.code, 'LOCAL_STORAGE_ENTRY_NOT_FOUND');
  assert.equal(missingError.message.includes(projectRoot), false);
  assert.equal(JSON.stringify(missingError).includes(projectRoot), false);
});

test('LocalStorageProvider rejects accessor-backed constructor and write options without invoking them', async (t) => {
  const projectRoot = createTempDirectory(t, 'local-mini-drama-storage-options-');
  let constructorReads = 0;
  const constructorOptions = {};
  Object.defineProperty(constructorOptions, 'projectRoot', {
    enumerable: true,
    get() {
      constructorReads += 1;
      return projectRoot;
    },
  });
  assert.throws(() => new LocalStorageProvider(constructorOptions), LocalStorageError);
  assert.equal(constructorReads, 0);

  const provider = new LocalStorageProvider({ projectRoot });
  const locator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'options'],
    relativeSegments: ['options.bin'],
  });
  let overwriteReads = 0;
  const writeOptions = {};
  Object.defineProperty(writeOptions, 'overwrite', {
    enumerable: true,
    get() {
      overwriteReads += 1;
      return true;
    },
  });
  await assert.rejects(() => provider.write(locator, Buffer.from('blocked'), writeOptions), TypeError);
  assert.equal(overwriteReads, 0);
  assert.equal(await provider.exists(locator), false);
});

test('LocalStorageProvider rejects a project root replaced after construction', async (t) => {
  const taskRoot = createTempDirectory(t, 'local-mini-drama-storage-root-swap-');
  const projectRoot = path.join(taskRoot, 'project');
  const originalRoot = path.join(taskRoot, 'original-project');
  const outsideRoot = path.join(taskRoot, 'outside');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(outsideRoot);
  const provider = new LocalStorageProvider({ projectRoot });
  const locator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'root-swap'],
    relativeSegments: ['escaped.bin'],
  });

  fs.renameSync(projectRoot, originalRoot);
  fs.symlinkSync(outsideRoot, projectRoot, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(() => provider.write(locator, Buffer.from('blocked')), LocalStorageError);
  assert.equal(fs.existsSync(path.join(outsideRoot, 'escaped.bin')), false);

  const regularRoot = path.join(taskRoot, 'regular-project');
  const movedRegularRoot = path.join(taskRoot, 'moved-regular-project');
  fs.mkdirSync(regularRoot);
  const regularProvider = new LocalStorageProvider({ projectRoot: regularRoot });
  fs.renameSync(regularRoot, movedRegularRoot);
  fs.mkdirSync(regularRoot);
  await assert.rejects(() => regularProvider.write(locator, Buffer.from('blocked')), LocalStorageError);
  assert.deepEqual(fs.readdirSync(regularRoot), []);
});

test('LocalStorageProvider failed writes leave new targets absent and existing targets unchanged', async (t) => {
  const projectRoot = createTempDirectory(t, 'local-mini-drama-storage-atomic-');
  const provider = new LocalStorageProvider({ projectRoot });
  const newLocator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'atomic', 'new'],
    relativeSegments: ['new.bin'],
  });
  const existingLocator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'atomic', 'existing'],
    relativeSegments: ['existing.bin'],
  });
  const existingPath = provider.resolve(existingLocator);
  fs.writeFileSync(existingPath, 'original');

  const originalOpen = fsPromises.open;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    return {
      async writeFile(content) {
        await handle.writeFile(content.subarray(0, 1));
        const error = new Error('synthetic write failure');
        error.code = 'EIO';
        throw error;
      },
      sync: handle.sync.bind(handle),
      close: handle.close.bind(handle),
    };
  };

  let newError;
  let overwriteError;
  try {
    await provider.write(newLocator, Buffer.from('new-content')).catch((error) => { newError = error; });
    await provider.write(existingLocator, Buffer.from('replacement'), { overwrite: true }).catch((error) => { overwriteError = error; });
  } finally {
    fsPromises.open = originalOpen;
  }

  assert.ok(newError instanceof LocalStorageError);
  assert.equal(newError.code, 'LOCAL_STORAGE_IO_FAILED');
  assert.ok(overwriteError instanceof LocalStorageError);
  assert.equal(overwriteError.code, 'LOCAL_STORAGE_IO_FAILED');
  assert.equal(fs.existsSync(provider.resolve(newLocator)), false);
  assert.equal(fs.readFileSync(existingPath, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(projectRoot), ['existing.bin']);
});

test('LocalStorageProvider sync and install failures preserve target state and clean temporary files', async (t) => {
  const runFailureCase = async (label, installFailure) => {
    const projectRoot = path.join(createTempDirectory(t, `local-mini-drama-storage-${label}-`), 'project');
    fs.mkdirSync(projectRoot);
    const provider = new LocalStorageProvider({ projectRoot });
    const newLocator = createAssetLocator({
      logicalSegments: ['dramas', 'demo', label, 'new'],
      relativeSegments: ['new.bin'],
    });
    const existingLocator = createAssetLocator({
      logicalSegments: ['dramas', 'demo', label, 'existing'],
      relativeSegments: ['existing.bin'],
    });
    const existingPath = provider.resolve(existingLocator);
    fs.writeFileSync(existingPath, 'original');

    const originalOpen = fsPromises.open;
    const originalLink = fsPromises.link;
    const originalRename = fsPromises.rename;
    if (installFailure) {
      const failInstall = async () => {
        const error = new Error('synthetic install failure');
        error.code = 'EIO';
        throw error;
      };
      fsPromises.link = failInstall;
      fsPromises.rename = failInstall;
    } else {
      fsPromises.open = async (...args) => {
        const handle = await originalOpen(...args);
        return {
          writeFile: handle.writeFile.bind(handle),
          async sync() {
            const error = new Error('synthetic sync failure');
            error.code = 'EIO';
            throw error;
          },
          close: handle.close.bind(handle),
        };
      };
    }

    const errors = [];
    try {
      await provider.write(newLocator, Buffer.from('new-content')).catch((error) => errors.push(error));
      await provider.write(existingLocator, Buffer.from('replacement'), { overwrite: true }).catch((error) => errors.push(error));
    } finally {
      fsPromises.open = originalOpen;
      fsPromises.link = originalLink;
      fsPromises.rename = originalRename;
    }

    assert.equal(errors.length, 2);
    assert.equal(errors.every((error) => error instanceof LocalStorageError && error.code === 'LOCAL_STORAGE_IO_FAILED'), true);
    assert.equal(fs.existsSync(provider.resolve(newLocator)), false);
    assert.equal(fs.readFileSync(existingPath, 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(projectRoot), ['existing.bin']);
  };

  await runFailureCase('sync-failure', false);
  await runFailureCase('install-failure', true);
});

test('LocalStorageProvider recovers when temporary hard-link cleanup repeatedly fails', async (t) => {
  const projectRoot = createTempDirectory(t, 'local-mini-drama-storage-cleanup-recovery-');
  const provider = new LocalStorageProvider({ projectRoot });
  const locator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'cleanup', 'recovery'],
    relativeSegments: ['cleanup.bin'],
  });
  const originalUnlink = fsPromises.unlink;
  let injectedFailures = 0;
  fsPromises.unlink = async (filename) => {
    if (path.basename(filename).startsWith('.cleanup.bin.')) {
      injectedFailures += 1;
      const error = new Error('synthetic cleanup denial');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink(filename);
  };
  try {
    await provider.write(locator, Buffer.from('retained-only-once'));
  } finally {
    fsPromises.unlink = originalUnlink;
  }

  assert.equal(injectedFailures, 3);
  assert.equal((await provider.read(locator)).toString('utf8'), 'retained-only-once');
  assert.deepEqual(fs.readdirSync(projectRoot), ['cleanup.bin']);
  assert.equal(await provider.remove(locator), true);
  assert.deepEqual(fs.readdirSync(projectRoot), []);
});

test('LocalStorageProvider exposes a stable cleanup error when recovery cannot complete', async (t) => {
  const projectRoot = createTempDirectory(t, 'local-mini-drama-storage-cleanup-error-');
  const provider = new LocalStorageProvider({ projectRoot });
  const locator = createAssetLocator({
    logicalSegments: ['dramas', 'demo', 'cleanup', 'error'],
    relativeSegments: ['cleanup-error.bin'],
  });
  const originalUnlink = fsPromises.unlink;
  const originalRename = fsPromises.rename;
  fsPromises.unlink = async (filename) => {
    if (path.basename(filename).startsWith('.cleanup-error.bin.')) {
      const error = new Error('synthetic cleanup denial');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlink(filename);
  };
  fsPromises.rename = async () => {
    const error = new Error('synthetic recovery failure');
    error.code = 'EIO';
    throw error;
  };
  let cleanupError;
  try {
    await provider.write(locator, Buffer.from('signalled-content')).catch((error) => { cleanupError = error; });
  } finally {
    fsPromises.unlink = originalUnlink;
    fsPromises.rename = originalRename;
  }

  assert.ok(cleanupError instanceof LocalStorageError);
  assert.equal(cleanupError.code, 'LOCAL_STORAGE_CLEANUP_FAILED');
  assert.equal(cleanupError.message.includes(projectRoot), false);
  assert.equal(JSON.stringify(cleanupError).includes(projectRoot), false);
});
