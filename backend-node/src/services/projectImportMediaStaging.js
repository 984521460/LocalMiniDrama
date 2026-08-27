const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CATEGORIES = new Set(['audio', 'characters', 'images', 'props', 'scenes', 'videos']);
const ERROR_MESSAGE = 'Project import media could not be installed safely';

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
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) throw mediaError();
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
    for (const segment of segments) {
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

  function ensureDirectory(segments) {
    assertSegmentsSafe(segments);
    const directory = path.resolve(root, ...segments);
    if (!isInside(root, directory)) throw mediaError();
    fs.mkdirSync(directory, { recursive: true });
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

  return Object.freeze({
    write({ projectDir, category, zipPath, prefix, buffer }) {
      assertActive();
      assertPortableProjectDirectory(projectDir);
      if (!CATEGORIES.has(category) || !Buffer.isBuffer(buffer) || typeof zipPath !== 'string'
        || typeof prefix !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(prefix)) throw mediaError();
      const extension = path.extname(zipPath) || '.jpg';
      if (!/^\.[A-Za-z0-9]{1,12}$/.test(extension)) throw mediaError();
      ensureStagingRoot();
      const filename = `${prefix}_${randomUUID().slice(0, 8)}${extension}`;
      const relativePath = `${projectDir}/${category}/${filename}`.replace(/\\/g, '/');
      const stagedParent = path.join(stagingRoot, String(entries.length));
      const staged = path.join(stagedParent, filename);
      const final = path.resolve(root, ...relativePath.split('/'));
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
      entries.push({
        staged,
        stagedParentIdentity,
        final,
        installed: false,
        finalParentIdentity: null,
        dev: stagedStats.dev,
        ino: stagedStats.ino,
      });
      return relativePath;
    },

    promote() {
      assertActive();
      try {
        for (const entry of entries) {
          ensureStagingRoot();
          assertDirectoryStable(path.dirname(entry.staged), entry.stagedParentIdentity);
          const relativeParent = path.relative(root, path.dirname(entry.final));
          const parentSegments = relativeParent.split(path.sep).filter(Boolean);
          entry.finalParentIdentity = ensureDirectory(parentSegments);
          assertDirectoryStable(path.dirname(entry.final), entry.finalParentIdentity);
          fs.linkSync(entry.staged, entry.final);
          entry.installed = true;
          assertDirectoryStable(path.dirname(entry.final), entry.finalParentIdentity);
          const targetStats = fs.lstatSync(entry.final, { bigint: true });
          if (!targetStats.isFile() || targetStats.isSymbolicLink()
            || targetStats.dev !== entry.dev || targetStats.ino !== entry.ino) throw mediaError();
          safeRemoveFile(entry.staged);
        }
        cleanupStaging();
        promoted = true;
      } catch {
        try {
          for (const entry of entries) if (entry.installed) removeInstalledEntry(entry);
          cleanupStaging();
        } catch {}
        throw mediaError();
      }
    },

    rollback() {
      if (disposed) return;
      try {
        for (const entry of entries) if (entry.installed) removeInstalledEntry(entry);
        cleanupStaging();
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
