const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  parseAssetLocator,
  parseStorageRelativePath,
} = require('@local-mini-drama/storage');

class LocalStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalStorageError';
    this.code = code;
  }
}

function rootError() {
  return new LocalStorageError('LOCAL_STORAGE_ROOT_INVALID', 'Local storage root must be an existing directory with an absolute path');
}

function boundaryError(code = 'LOCAL_STORAGE_PATH_OUTSIDE_ROOT') {
  const message = code === 'LOCAL_STORAGE_SYMBOLIC_LINK_REJECTED'
    ? 'Local storage path contains a symbolic link'
    : 'Local storage path must remain inside the project root';
  return new LocalStorageError(code, message);
}

function cleanupError() {
  return new LocalStorageError('LOCAL_STORAGE_CLEANUP_FAILED', 'Local storage temporary file cleanup failed');
}

async function removeTemporaryFile(filename) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsPromises.unlink(filename);
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (attempt === 2) throw cleanupError();
    }
  }
}

function translateIoError(error, operation) {
  if (error instanceof LocalStorageError || error?.name === 'StorageContractError' || error instanceof TypeError) {
    return error;
  }
  if (error?.code === 'EEXIST') {
    return new LocalStorageError('LOCAL_STORAGE_ENTRY_EXISTS', 'Local storage entry already exists');
  }
  if (error?.code === 'ENOENT') {
    return new LocalStorageError('LOCAL_STORAGE_ENTRY_NOT_FOUND', 'Local storage entry was not found');
  }
  return new LocalStorageError('LOCAL_STORAGE_IO_FAILED', `Local storage ${operation} failed`);
}

function readDataOptions(value, allowedKeys, invalid) {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object') throw invalid();

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw invalid();
  }
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) throw invalid();

  const snapshot = {};
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw invalid();
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function readConstructorOptions(value) {
  const options = readDataOptions(value, ['projectRoot'], rootError);
  if (!Object.hasOwn(options, 'projectRoot')) throw rootError();
  return options;
}

function readWriteOptions(value) {
  const invalid = () => new TypeError('Local storage write options must be an exact data object');
  const options = readDataOptions(value, ['overwrite'], invalid);
  if (Object.hasOwn(options, 'overwrite') && typeof options.overwrite !== 'boolean') throw invalid();
  return options;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

class LocalStorageProvider {
  id = 'local';

  #root;

  #rootIdentity;

  #assertRootIsStable() {
    let stats;
    let realRoot;
    try {
      stats = fs.lstatSync(this.#root, { bigint: true });
      realRoot = fs.realpathSync.native(this.#root);
    } catch {
      throw rootError();
    }
    if (
      !stats.isDirectory()
      || stats.isSymbolicLink()
      || stats.dev !== this.#rootIdentity.dev
      || stats.ino !== this.#rootIdentity.ino
      || !samePath(this.#root, realRoot)
    ) {
      throw rootError();
    }
  }

  #assertSegmentsAreSafe(segments) {
    this.#assertRootIsStable();
    let cursor = this.#root;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      let stats;
      try {
        stats = fs.lstatSync(cursor);
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw new LocalStorageError('LOCAL_STORAGE_PATH_UNAVAILABLE', 'Local storage path could not be inspected');
      }
      if (stats.isSymbolicLink()) throw boundaryError('LOCAL_STORAGE_SYMBOLIC_LINK_REJECTED');
      let realCursor;
      try {
        realCursor = fs.realpathSync.native(cursor);
      } catch {
        throw new LocalStorageError('LOCAL_STORAGE_PATH_UNAVAILABLE', 'Local storage path could not be inspected');
      }
      if (!isInside(this.#root, realCursor)) throw boundaryError();
    }
  }

  constructor(options) {
    const { projectRoot } = readConstructorOptions(options);
    if (typeof projectRoot !== 'string' || projectRoot.includes('\0') || !path.isAbsolute(projectRoot)) {
      throw rootError();
    }
    let rootStats;
    try {
      rootStats = fs.lstatSync(projectRoot, { bigint: true });
    } catch {
      throw rootError();
    }
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw rootError();
    try {
      this.#root = fs.realpathSync.native(projectRoot);
    } catch {
      throw rootError();
    }
    this.#rootIdentity = Object.freeze({ dev: rootStats.dev, ino: rootStats.ino });
    this.#assertRootIsStable();
  }

  resolve(locator) {
    this.#assertRootIsStable();
    const parsed = parseAssetLocator(locator);
    if (parsed.storageProvider !== this.id) {
      throw new LocalStorageError('LOCAL_STORAGE_PROVIDER_UNSUPPORTED', 'Local storage provider cannot resolve a different storage provider');
    }
    const segments = parseStorageRelativePath(parsed.relativePath);
    const candidate = path.resolve(this.#root, ...segments);
    if (!isInside(this.#root, candidate)) throw boundaryError();
    this.#assertSegmentsAreSafe(segments);
    return candidate;
  }

  async exists(locator) {
    const filename = this.resolve(locator);
    try {
      this.#assertRootIsStable();
      const stats = await fsPromises.stat(filename);
      return stats.isFile();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw translateIoError(error, 'inspection');
    }
  }

  async read(locator) {
    const filename = this.resolve(locator);
    try {
      this.#assertRootIsStable();
      const stats = await fsPromises.stat(filename);
      if (!stats.isFile()) {
        throw new LocalStorageError('LOCAL_STORAGE_ENTRY_INVALID', 'Local storage entry must be a regular file');
      }
      return await fsPromises.readFile(filename);
    } catch (error) {
      throw translateIoError(error, 'read');
    }
  }

  async write(locator, content, options) {
    if (!(content instanceof Uint8Array)) {
      throw new TypeError('Local storage content must be a Uint8Array');
    }
    const { overwrite = false } = readWriteOptions(options);
    const parsed = parseAssetLocator(locator);
    let filename;
    let temporaryFilename;
    let linked = false;
    try {
      filename = this.resolve(parsed);
      const parent = path.dirname(filename);
      this.#assertRootIsStable();
      await fsPromises.mkdir(parent, { recursive: true });
      const segments = parseStorageRelativePath(parsed.relativePath);
      this.#assertRootIsStable();
      this.#assertSegmentsAreSafe(segments.slice(0, -1));

      temporaryFilename = path.join(parent, `.${path.basename(filename)}.${randomUUID()}.tmp`);
      this.#assertRootIsStable();
      const handle = await fsPromises.open(temporaryFilename, 'wx');
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#assertRootIsStable();
      this.#assertSegmentsAreSafe(segments);
      if (overwrite) {
        await fsPromises.rename(temporaryFilename, filename);
      } else {
        await fsPromises.link(temporaryFilename, filename);
        linked = true;
      }
    } catch (error) {
      throw translateIoError(error, 'write');
    } finally {
      if (temporaryFilename) {
        try {
          await removeTemporaryFile(temporaryFilename);
        } catch {
          if (!linked || !filename) throw cleanupError();
          try {
            this.#assertRootIsStable();
            const [temporaryStats, targetStats] = await Promise.all([
              fsPromises.lstat(temporaryFilename, { bigint: true }),
              fsPromises.lstat(filename, { bigint: true }),
            ]);
            if (
              !temporaryStats.isFile()
              || temporaryStats.isSymbolicLink()
              || !targetStats.isFile()
              || targetStats.isSymbolicLink()
              || temporaryStats.dev !== targetStats.dev
              || temporaryStats.ino !== targetStats.ino
            ) {
              throw cleanupError();
            }
            await fsPromises.unlink(filename);
            await fsPromises.rename(temporaryFilename, filename);
          } catch {
            throw cleanupError();
          }
        }
      }
    }
    return parsed;
  }

  async remove(locator) {
    const filename = this.resolve(locator);
    try {
      this.#assertRootIsStable();
      const stats = await fsPromises.lstat(filename);
      if (!stats.isFile()) {
        throw new LocalStorageError('LOCAL_STORAGE_ENTRY_INVALID', 'Local storage entry must be a regular file');
      }
      await fsPromises.unlink(filename);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw translateIoError(error, 'remove');
    }
  }
}

module.exports = {
  LocalStorageError,
  LocalStorageProvider,
};
