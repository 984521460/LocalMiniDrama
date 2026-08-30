const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const CATEGORIES = new Set(['audio', 'characters', 'images', 'props', 'scenes', 'videos']);
const ERROR_MESSAGE = 'Project import media could not be installed safely';
const MAX_EXACT_FILE_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const TYPED_ARRAY_SUBARRAY = Uint8Array.prototype.subarray;
const SET_HAS = Set.prototype.has;

class ProjectImportMediaError extends Error {
  constructor() {
    super(ERROR_MESSAGE);
    this.name = 'ProjectImportMediaError';
    Object.defineProperty(this, 'code', {
      configurable: false,
      enumerable: true,
      value: 'PROJECT_IMPORT_MEDIA_FAILED',
      writable: false,
    });
    Object.freeze(this);
  }
}

function mediaError() {
  return new ProjectImportMediaError();
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.relative(left, right) === '' && path.relative(right, left) === '';
}

function directoryIdentity(directory) {
  const stats = fs.lstatSync(directory, { bigint: true });
  const realPath = fs.realpathSync.native(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw mediaError();
  return Object.freeze({ dev: stats.dev, ino: stats.ino, realPath });
}

function assertDirectoryStable(directory, identity) {
  const current = directoryIdentity(directory);
  if (current.dev !== identity.dev || current.ino !== identity.ino || !samePath(current.realPath, identity.realPath)) {
    throw mediaError();
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

function assertExpectedFileSnapshot(stats, entry) {
  if (!stats.isFile() || stats.isSymbolicLink()
    || stats.dev !== entry.dev || stats.ino !== entry.ino
    || stats.size !== BigInt(entry.expectedBytes)) throw mediaError();
}

function safeRemoveFile(filename) {
  try {
    fs.unlinkSync(filename);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertPortableProjectDirectory(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0 || projectDir.length > 1024
    || projectDir.includes('\0') || projectDir.includes('\\') || path.isAbsolute(projectDir)
    || /^[A-Za-z]:/.test(projectDir)) throw mediaError();
  const segments = projectDir.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].length === 0 || segments[index] === '.' || segments[index] === '..') {
      throw mediaError();
    }
  }
}

function portableRelativeSegments(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.includes('\0') || value.includes('\\') || path.isAbsolute(value)
    || /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.endsWith('/')) throw mediaError();
  const segments = value.split('/');
  if (segments.length > 64) throw mediaError();
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0 || segment === '.' || segment === '..'
      || Buffer.byteLength(segment, 'utf8') > 255
      || /[\u0000-\u001f\u007f:]/u.test(segment)
      || segment.endsWith('.') || segment.endsWith(' ') || WINDOWS_RESERVED.test(segment)) {
      throw mediaError();
    }
  }
  return segments;
}

function createProjectImportMediaStaging(storagePath) {
  const root = path.resolve(storagePath);
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    throw mediaError();
  }
  let rootIdentity;
  try {
    rootIdentity = directoryIdentity(root);
    if (!samePath(root, rootIdentity.realPath)) throw mediaError();
  } catch {
    throw mediaError();
  }

  const stagingParent = path.join(root, '.project-import-staging');
  const stagingRoot = path.join(stagingParent, randomUUID());
  if (!isInside(root, stagingRoot)) throw mediaError();
  const entries = [];
  const createdFinalDirectories = [];
  let stagingIdentity = null;
  let promoted = false;
  let disposed = false;

  function assertRootStable() {
    assertDirectoryStable(root, rootIdentity);
    if (!samePath(root, rootIdentity.realPath)) throw mediaError();
  }

  function assertSegmentsSafe(segments) {
    assertRootStable();
    let cursor = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      cursor = path.join(cursor, segment);
      let stats;
      try {
        stats = fs.lstatSync(cursor);
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw mediaError();
      }
      if (stats.isSymbolicLink()) throw mediaError();
      const realPath = fs.realpathSync.native(cursor);
      if (!samePath(cursor, realPath) || !isInside(root, realPath)) throw mediaError();
    }
  }

  function ensureDirectory(segments, { track = false } = {}) {
    assertSegmentsSafe(segments);
    let directory = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      directory = path.join(directory, segment);
      if (!isInside(root, directory)) throw mediaError();
      let created = false;
      try {
        const existing = fs.lstatSync(directory);
        if (!existing.isDirectory() || existing.isSymbolicLink()) throw mediaError();
      } catch (error) {
        if (error instanceof ProjectImportMediaError) throw error;
        if (error?.code !== 'ENOENT') throw mediaError();
        fs.mkdirSync(directory);
        created = true;
      }
      const identity = directoryIdentity(directory);
      if (created && track) {
        createdFinalDirectories[createdFinalDirectories.length] = { directory, identity };
      }
    }
    assertSegmentsSafe(segments);
    return directoryIdentity(directory);
  }

  function ensureStagingRoot() {
    if (stagingIdentity === null) {
      stagingIdentity = ensureDirectory(['.project-import-staging', path.basename(stagingRoot)]);
    }
    assertDirectoryStable(stagingRoot, stagingIdentity);
  }

  function assertActive() {
    if (disposed || promoted) throw mediaError();
    assertRootStable();
  }

  function removeInstalledEntry(entry) {
    assertRootStable();
    assertDirectoryStable(path.dirname(entry.final), entry.finalParentIdentity);
    let target;
    try {
      target = fs.lstatSync(entry.final, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw mediaError();
    }
    if (!target.isFile() || target.isSymbolicLink() || target.dev !== entry.dev || target.ino !== entry.ino) throw mediaError();
    safeRemoveFile(entry.final);
    entry.installed = false;
  }

  function cleanupStaging() {
    assertRootStable();
    if (stagingIdentity !== null) {
      assertDirectoryStable(stagingRoot, stagingIdentity);
      fs.rmSync(stagingRoot, { force: true, recursive: true });
      stagingIdentity = null;
    }
    try {
      if (fs.existsSync(stagingParent)) {
        assertSegmentsSafe(['.project-import-staging']);
        if (fs.readdirSync(stagingParent).length === 0) fs.rmdirSync(stagingParent);
      }
    } catch {}
  }

  function cleanupCreatedFinalDirectories() {
    for (let index = createdFinalDirectories.length - 1; index >= 0; index -= 1) {
      const entry = createdFinalDirectories[index];
      assertRootStable();
      assertDirectoryStable(entry.directory, entry.identity);
      if (fs.readdirSync(entry.directory).length !== 0) throw mediaError();
      fs.rmdirSync(entry.directory);
    }
    createdFinalDirectories.length = 0;
  }

  function verifyFile(filename, entry, parentIdentity) {
    assertRootStable();
    assertDirectoryStable(path.dirname(filename), parentIdentity);
    let descriptor;
    try {
      const beforePath = fs.lstatSync(filename, { bigint: true });
      assertExpectedFileSnapshot(beforePath, entry);
      descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertExpectedFileSnapshot(opened, entry);
      if (!sameFileSnapshot(beforePath, opened)) throw mediaError();
      const hash = createHash('sha256');
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, entry.expectedBytes));
      let total = 0;
      while (total < entry.expectedBytes) {
        const read = fs.readSync(
          descriptor,
          chunk,
          0,
          Math.min(chunk.length, entry.expectedBytes - total),
          null,
        );
        if (read === 0) throw mediaError();
        total += read;
        hash.update(Reflect.apply(TYPED_ARRAY_SUBARRAY, chunk, [0, read]));
      }
      if (fs.readSync(descriptor, chunk, 0, 1, null) !== 0
        || hash.digest('hex') !== entry.expectedSha256) throw mediaError();
      const afterRead = fs.fstatSync(descriptor, { bigint: true });
      assertExpectedFileSnapshot(afterRead, entry);
      if (!sameFileSnapshot(opened, afterRead)) throw mediaError();
      fs.closeSync(descriptor);
      descriptor = undefined;
      const afterPath = fs.lstatSync(filename, { bigint: true });
      assertExpectedFileSnapshot(afterPath, entry);
      if (!sameFileSnapshot(afterRead, afterPath)) throw mediaError();
      assertDirectoryStable(path.dirname(filename), parentIdentity);
      assertRootStable();
    } catch {
      try { if (descriptor !== undefined) fs.closeSync(descriptor); } catch {}
      throw mediaError();
    }
  }

  function stageFile(final, filename, buffer, expectedSha256, expectedBytes) {
    ensureStagingRoot();
    const stagedParent = path.join(stagingRoot, String(entries.length));
    const staged = path.join(stagedParent, filename);
    if (!isInside(root, final) || !isInside(stagingRoot, staged)) throw mediaError();
    fs.mkdirSync(stagedParent, { recursive: false });
    const stagedParentIdentity = directoryIdentity(stagedParent);
    assertDirectoryStable(stagingRoot, stagingIdentity);
    let handle;
    try {
      handle = fs.openSync(staged, 'wx');
      fs.writeFileSync(handle, buffer);
      fs.fsyncSync(handle);
    } catch {
      try { if (handle !== undefined) fs.closeSync(handle); } catch {}
      try { safeRemoveFile(staged); } catch {}
      throw mediaError();
    }
    fs.closeSync(handle);
    const stagedStats = fs.lstatSync(staged, { bigint: true });
    if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) throw mediaError();
    const entry = {
      staged,
      stagedParentIdentity,
      final,
      installed: false,
      finalParentIdentity: null,
      dev: stagedStats.dev,
      ino: stagedStats.ino,
      expectedSha256,
      expectedBytes,
    };
    verifyFile(staged, entry, stagedParentIdentity);
    entries[entries.length] = entry;
  }

  return Object.freeze({
    write({ projectDir, category, zipPath, prefix, buffer }) {
      assertActive();
      assertPortableProjectDirectory(projectDir);
      if (!Reflect.apply(SET_HAS, CATEGORIES, [category])
        || !Buffer.isBuffer(buffer) || typeof zipPath !== 'string'
        || typeof prefix !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(prefix)) throw mediaError();
      const extension = path.extname(zipPath) || '.jpg';
      if (!/^\.[A-Za-z0-9]{1,12}$/.test(extension)) throw mediaError();
      ensureStagingRoot();
      const filename = `${prefix}_${randomUUID().slice(0, 8)}${extension}`;
      const relativePath = `${projectDir}/${category}/${filename}`.replace(/\\/g, '/');
      const final = path.resolve(root, ...relativePath.split('/'));
      stageFile(
        final,
        filename,
        buffer,
        createHash('sha256').update(buffer).digest('hex'),
        buffer.length,
      );
      return relativePath;
    },

    writeExact({ relativePath, archivePath, buffer, expectedSha256, expectedBytes }) {
      assertActive();
      if (!Buffer.isBuffer(buffer) || typeof archivePath !== 'string'
        || archivePath.length === 0 || archivePath.length > 1024
        || typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256)
        || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1
        || expectedBytes > MAX_EXACT_FILE_BYTES || buffer.length !== expectedBytes
        || createHash('sha256').update(buffer).digest('hex') !== expectedSha256) throw mediaError();
      const segments = portableRelativeSegments(relativePath);
      if (segments[0] === '.project-import-staging') throw mediaError();
      const filename = segments[segments.length - 1];
      stageFile(
        path.resolve(root, ...segments),
        filename,
        buffer,
        expectedSha256,
        expectedBytes,
      );
      return relativePath;
    },

    promote() {
      assertActive();
      try {
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index];
          ensureStagingRoot();
          assertDirectoryStable(path.dirname(entry.staged), entry.stagedParentIdentity);
          verifyFile(entry.staged, entry, entry.stagedParentIdentity);
          const relativeParent = path.relative(root, path.dirname(entry.final));
          const rawParentSegments = relativeParent.split(path.sep);
          const parentSegments = [];
          for (let segmentIndex = 0; segmentIndex < rawParentSegments.length; segmentIndex += 1) {
            if (rawParentSegments[segmentIndex]) {
              parentSegments[parentSegments.length] = rawParentSegments[segmentIndex];
            }
          }
          entry.finalParentIdentity = ensureDirectory(parentSegments, { track: true });
          assertDirectoryStable(path.dirname(entry.final), entry.finalParentIdentity);
          fs.linkSync(entry.staged, entry.final);
          entry.installed = true;
          assertDirectoryStable(path.dirname(entry.final), entry.finalParentIdentity);
          const targetStats = fs.lstatSync(entry.final, { bigint: true });
          if (!targetStats.isFile() || targetStats.isSymbolicLink()
            || targetStats.dev !== entry.dev || targetStats.ino !== entry.ino) throw mediaError();
          verifyFile(entry.final, entry, entry.finalParentIdentity);
          safeRemoveFile(entry.staged);
        }
        cleanupStaging();
        promoted = true;
      } catch {
        try {
          for (let index = 0; index < entries.length; index += 1) {
            if (entries[index].installed) removeInstalledEntry(entries[index]);
          }
          cleanupStaging();
          cleanupCreatedFinalDirectories();
        } catch {}
        throw mediaError();
      }
    },

    assertCommitReady() {
      if (!promoted || disposed) throw mediaError();
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        verifyFile(entry.final, entry, entry.finalParentIdentity);
      }
    },

    rollback() {
      if (disposed) return;
      try {
        for (let index = 0; index < entries.length; index += 1) {
          if (entries[index].installed) removeInstalledEntry(entries[index]);
        }
        cleanupStaging();
        cleanupCreatedFinalDirectories();
        disposed = true;
      } catch {
        throw mediaError();
      }
    },

    complete() {
      if (!promoted) throw mediaError();
      disposed = true;
    },
  });
}

module.exports = {
  ProjectImportMediaError,
  createProjectImportMediaStaging,
};
