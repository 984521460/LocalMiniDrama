'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const {
  CONFIG_RELATIVE_PATH,
  DATABASE_RELATIVE_PATH,
  ERROR_CODE,
  MvpBenchmarkWorkspaceError,
  RECEIPT_FILE,
  STORAGE_RELATIVE_PATH,
  WORKSPACE_NAME,
  inspectMvpBenchmarkDatabase,
  prepareMvpBenchmarkDatabase,
} = require('../backend-node/src/benchmark/mvpBenchmarkWorkspace');
const {
  validateMvpBenchmarkSourcePack,
} = require('./validate-mvp-benchmark-source');

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 16 * 1024;

function invalid() {
  throw new MvpBenchmarkWorkspaceError();
}

function comparable(value) {
  const resolved = path.resolve(value);
  return path.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function exactOptions(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) invalid();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    invalid();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    output[key] = descriptor.value;
  }
  return output;
}

function directorySnapshot(directory) {
  const resolved = path.resolve(directory);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(resolved, { bigint: true });
    real = fs.realpathSync.native(resolved);
  } catch {
    invalid();
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || comparable(real) !== comparable(resolved)) invalid();
  return Object.freeze({
    resolved,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
  });
}

function sameDirectory(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function assertDirectoryUnchanged(expected) {
  const current = directorySnapshot(expected.resolved);
  if (!sameDirectory(current, expected)) invalid();
}

function fileSnapshot(filename, minimum, maximum) {
  let stat;
  let real;
  try {
    stat = fs.lstatSync(filename, { bigint: true });
    real = fs.realpathSync.native(filename);
  } catch {
    invalid();
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || stat.size < BigInt(minimum) || stat.size > BigInt(maximum)
    || comparable(real) !== comparable(filename)) invalid();
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    ctimeNs: stat.ctimeNs,
    mtimeNs: stat.mtimeNs,
  });
}

function sameFile(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

function readStableFile(filename, minimum, maximum) {
  const before = fileSnapshot(filename, minimum, maximum);
  const buffer = Buffer.alloc(Number(before.size));
  let handle;
  try {
    handle = fs.openSync(filename, 'r');
    const opened = fs.fstatSync(handle, { bigint: true });
    if (!sameFile(before, opened)) invalid();
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1) invalid();
      offset += count;
    }
    const eof = Buffer.alloc(1);
    if (fs.readSync(handle, eof, 0, 1, buffer.length) !== 0) invalid();
    const afterRead = fs.fstatSync(handle, { bigint: true });
    const afterPath = fileSnapshot(filename, minimum, maximum);
    if (!sameFile(opened, afterRead) || !sameFile(afterRead, afterPath)) invalid();
    return buffer;
  } catch (error) {
    if (error instanceof MvpBenchmarkWorkspaceError) throw error;
    return invalid();
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
  }
}

function assertMissing(filename) {
  try {
    fs.lstatSync(filename);
    invalid();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function createDirectory(parent, name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/u.test(name)) invalid();
  assertDirectoryUnchanged(parent);
  const target = path.join(parent.resolved, name);
  if (comparable(path.dirname(target)) !== comparable(parent.resolved)) invalid();
  assertMissing(target);
  try {
    fs.mkdirSync(target, { recursive: false });
  } catch {
    invalid();
  }
  const created = directorySnapshot(target);
  assertDirectoryUnchanged(parent);
  return created;
}

function writeExclusive(filename, bytes) {
  if (!Buffer.isBuffer(bytes) || isProxy(bytes) || bytes.length < 1) invalid();
  let handle;
  try {
    handle = fs.openSync(filename, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count < 1) invalid();
      offset += count;
    }
    fs.fsyncSync(handle);
    const opened = fs.fstatSync(handle, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n
      || opened.size !== BigInt(bytes.length)) invalid();
  } catch (error) {
    if (error instanceof MvpBenchmarkWorkspaceError) throw error;
    return invalid();
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
  }
  const installed = readStableFile(filename, bytes.length, bytes.length);
  if (!installed.equals(bytes)) invalid();
}

function writeEmptyExclusive(filename) {
  let handle;
  try {
    handle = fs.openSync(filename, 'wx', 0o600);
    fs.fsyncSync(handle);
    const opened = fs.fstatSync(handle, { bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n
      || opened.size !== 0n) invalid();
  } catch (error) {
    if (error instanceof MvpBenchmarkWorkspaceError) throw error;
    return invalid();
  } finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); } catch {}
    }
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validatedSourcePack(sourceRoot) {
  try {
    return validateMvpBenchmarkSourcePack(sourceRoot);
  } catch {
    return invalid();
  }
}

function serializeReceipt(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function sameReceipt(left, right) {
  return serializeReceipt(left).equals(serializeReceipt(right));
}

function workspacePaths(dataRoot) {
  const root = path.join(dataRoot.resolved, WORKSPACE_NAME);
  if (comparable(path.dirname(root)) !== comparable(dataRoot.resolved)) invalid();
  return Object.freeze({
    root,
    config: path.join(root, CONFIG_RELATIVE_PATH),
    database: path.join(root, DATABASE_RELATIVE_PATH),
    receipt: path.join(root, RECEIPT_FILE),
    storage: path.join(root, STORAGE_RELATIVE_PATH),
  });
}

function assertWorkspaceLayout(dataRoot, paths) {
  assertDirectoryUnchanged(dataRoot);
  const root = directorySnapshot(paths.root);
  if (comparable(path.dirname(root.resolved)) !== comparable(dataRoot.resolved)
    || path.basename(root.resolved) !== WORKSPACE_NAME) invalid();
  const configs = directorySnapshot(path.dirname(paths.config));
  const data = directorySnapshot(path.dirname(paths.database));
  const storage = directorySnapshot(paths.storage);
  if (comparable(path.dirname(configs.resolved)) !== comparable(root.resolved)
    || comparable(path.dirname(data.resolved)) !== comparable(root.resolved)
    || comparable(path.dirname(storage.resolved)) !== comparable(data.resolved)) invalid();
  return Object.freeze({ root, configs, data, storage });
}

function withMigrationOutputSuppressed(operation) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  try {
    console.log = () => {};
    console.warn = () => {};
    return operation();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

function prepareOptions(value) {
  const input = exactOptions(value, [
    'dataRoot', 'configPath', 'sourceRoot', 'nowEpochMs', 'createUid',
  ]);
  if (typeof input.dataRoot !== 'string' || !path.isAbsolute(input.dataRoot)
    || typeof input.configPath !== 'string' || !path.isAbsolute(input.configPath)
    || typeof input.sourceRoot !== 'string' || !path.isAbsolute(input.sourceRoot)
    || typeof input.nowEpochMs !== 'function' || typeof input.createUid !== 'function') invalid();
  return input;
}

function inspectOptions(value) {
  const input = exactOptions(value, ['dataRoot', 'configPath', 'sourceRoot']);
  if (typeof input.dataRoot !== 'string' || !path.isAbsolute(input.dataRoot)
    || typeof input.configPath !== 'string' || !path.isAbsolute(input.configPath)
    || typeof input.sourceRoot !== 'string' || !path.isAbsolute(input.sourceRoot)) invalid();
  return input;
}

function removeOwnedFile(filename) {
  try {
    const stat = fs.lstatSync(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) invalid();
    fs.unlinkSync(filename);
    assertMissing(filename);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    invalid();
  }
}

function removeOwnedDirectory(expected) {
  if (!expected) return;
  const current = directorySnapshot(expected.resolved);
  if (!sameDirectory(current, expected)) invalid();
  try {
    fs.rmdirSync(current.resolved);
    assertMissing(current.resolved);
  } catch {
    invalid();
  }
}

function cleanupCreatedWorkspace(dataRoot, layout, paths) {
  try {
    assertDirectoryUnchanged(dataRoot);
    const current = directorySnapshot(layout.root.resolved);
    if (!sameDirectory(current, layout.root)
      || comparable(path.dirname(current.resolved)) !== comparable(dataRoot.resolved)
      || path.basename(current.resolved) !== WORKSPACE_NAME) invalid();
    const allowed = new Set([
      path.basename(paths.receipt),
      path.basename(path.dirname(paths.config)),
      path.basename(path.dirname(paths.database)),
    ]);
    const rootEntries = fs.readdirSync(current.resolved);
    if (rootEntries.some((entry) => !allowed.has(entry))) invalid();
    if (layout.configs) {
      assertDirectoryUnchanged(layout.configs);
      const entries = fs.readdirSync(layout.configs.resolved);
      if (entries.some((entry) => entry !== path.basename(paths.config))) invalid();
      removeOwnedFile(paths.config);
    }
    if (layout.data) {
      assertDirectoryUnchanged(layout.data);
      if (layout.storage) assertDirectoryUnchanged(layout.storage);
      const databaseName = path.basename(paths.database);
      const storageName = path.basename(paths.storage);
      const allowedData = new Set([
        databaseName,
        `${databaseName}-shm`,
        `${databaseName}-wal`,
        storageName,
      ]);
      const entries = fs.readdirSync(layout.data.resolved);
      if (entries.some((entry) => !allowedData.has(entry))) invalid();
      removeOwnedFile(`${paths.database}-shm`);
      removeOwnedFile(`${paths.database}-wal`);
      removeOwnedFile(paths.database);
    }
    removeOwnedFile(paths.receipt);
    removeOwnedDirectory(layout.storage);
    removeOwnedDirectory(layout.configs);
    removeOwnedDirectory(layout.data);
    removeOwnedDirectory(layout.root);
    assertDirectoryUnchanged(dataRoot);
  } catch {
    invalid();
  }
}

function checkMvpBenchmarkWorkspace(value) {
  const input = inspectOptions(value);
  const dataRoot = directorySnapshot(input.dataRoot);
  const paths = workspacePaths(dataRoot);
  assertWorkspaceLayout(dataRoot, paths);
  const pack = validatedSourcePack(input.sourceRoot);
  const sourceConfig = readStableFile(input.configPath, 1, MAX_CONFIG_BYTES);
  const installedConfig = readStableFile(paths.config, 1, MAX_CONFIG_BYTES);
  if (!sourceConfig.equals(installedConfig)) invalid();
  const configSha256 = sha256(installedConfig);
  fileSnapshot(paths.database, 1, MAX_DATABASE_BYTES);
  const receiptBytes = readStableFile(paths.receipt, 2, MAX_RECEIPT_BYTES);
  const inspected = inspectMvpBenchmarkDatabase({
    databasePath: paths.database,
    sourcePack: pack,
    configSha256,
  });
  const canonical = serializeReceipt(inspected);
  if (!receiptBytes.equals(canonical)) invalid();
  return inspected;
}

function prepareMvpBenchmarkWorkspace(value) {
  const input = prepareOptions(value);
  const dataRoot = directorySnapshot(input.dataRoot);
  const paths = workspacePaths(dataRoot);
  const pack = validatedSourcePack(input.sourceRoot);
  const configBytes = readStableFile(input.configPath, 1, MAX_CONFIG_BYTES);
  const configSha256 = sha256(configBytes);
  assertMissing(paths.root);
  const created = {
    root: null,
    configs: null,
    data: null,
    storage: null,
  };
  try {
    created.root = createDirectory(dataRoot, WORKSPACE_NAME);
    created.configs = createDirectory(created.root, 'configs');
    created.data = createDirectory(created.root, 'data');
    created.storage = createDirectory(created.data, 'storage');
    assertDirectoryUnchanged(created.configs);
    writeExclusive(paths.config, configBytes);
    assertDirectoryUnchanged(created.data);
    writeEmptyExclusive(paths.database);
    const prepared = withMigrationOutputSuppressed(() => prepareMvpBenchmarkDatabase({
      databasePath: paths.database,
      sourcePack: pack,
      configSha256,
      nowEpochMs: input.nowEpochMs,
      createUid: input.createUid,
    }));
    fileSnapshot(paths.database, 1, MAX_DATABASE_BYTES);
    const checked = inspectMvpBenchmarkDatabase({
      databasePath: paths.database,
      sourcePack: pack,
      configSha256,
    });
    if (!sameReceipt(prepared, checked)) invalid();
    writeExclusive(paths.receipt, serializeReceipt(prepared));
    const final = checkMvpBenchmarkWorkspace({
      dataRoot: input.dataRoot,
      configPath: input.configPath,
      sourceRoot: input.sourceRoot,
    });
    if (!sameReceipt(prepared, final)) invalid();
    return final;
  } catch (error) {
    if (created.root) cleanupCreatedWorkspace(dataRoot, created, paths);
    if (error instanceof MvpBenchmarkWorkspaceError) throw error;
    return invalid();
  }
}

function commandPaths() {
  const repoRoot = path.resolve(__dirname, '..');
  return Object.freeze({
    dataRoot: path.join(repoRoot, 'backend-node', 'data'),
    configPath: path.join(repoRoot, 'backend-node', 'configs', 'config.yaml'),
    sourceRoot: path.join(repoRoot, 'benchmarks', 'mvp-source'),
  });
}

function main(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 1
    || (argv[0] !== 'prepare' && argv[0] !== 'check')) invalid();
  const paths = commandPaths();
  if (argv[0] === 'prepare') {
    return prepareMvpBenchmarkWorkspace({
      ...paths,
      nowEpochMs: Date.now,
      createUid: crypto.randomUUID,
    });
  }
  return checkMvpBenchmarkWorkspace(paths);
}

if (require.main === module) {
  try {
    const receipt = main();
    process.stdout.write(`${JSON.stringify({
      status: 'MVP_BENCHMARK_WORKSPACE_VERIFIED',
      workspace: receipt,
    })}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({
      code: ERROR_CODE,
      message: 'MVP benchmark workspace is invalid',
    })}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  checkMvpBenchmarkWorkspace,
  main,
  prepareMvpBenchmarkWorkspace,
});
