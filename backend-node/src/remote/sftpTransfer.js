const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/u;
const MESSAGES = Object.freeze({
  SFTP_TRANSFER_INPUT_INVALID: 'SFTP transfer input is invalid',
  SFTP_TRANSFER_PATH_UNSAFE: 'SFTP transfer path is unsafe',
  SFTP_TRANSFER_HASH_MISMATCH: 'SFTP transfer hash verification failed',
  SFTP_TRANSFER_CONFLICT: 'SFTP transfer target already exists',
  SFTP_TRANSFER_IO_FAILED: 'SFTP transfer failed',
});
const trustedErrors = new WeakSet();

class SftpTransferError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.SFTP_TRANSFER_IO_FAILED);
    this.name = 'SftpTransferError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'SFTP_TRANSFER_IO_FAILED';
    trustedErrors.add(this);
    Object.freeze(this);
  }
}

function createError(code) {
  return new SftpTransferError(code);
}

function exactObject(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  const output = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw createError('SFTP_TRANSFER_INPUT_INVALID');
    }
    output[key] = descriptor.value;
  }
  return output;
}

function relativeSegments(value, maximumLength = 1024) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1
    || value.length > maximumLength || value.includes('\0') || value.includes('\\')
    || value.includes(':') || value.startsWith('/') || value.endsWith('/')) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..' || !SEGMENT.test(segment))) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  return segments;
}

function taskUid(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  return value;
}

function expectedHash(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  return value;
}

function isMissing(error) {
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    return code === 'ENOENT' || code === 2;
  } catch {
    return false;
  }
}

function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      sftp[method](...args, (error, value) => {
        if (error) reject(error);
        else resolve(value);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function lstatMaybe(sftp, remotePath) {
  try {
    return await call(sftp, 'lstat', remotePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function safeDirectoryStat(stats) {
  try {
    return stats && typeof stats.isDirectory === 'function' && stats.isDirectory()
      && (typeof stats.isSymbolicLink !== 'function' || !stats.isSymbolicLink());
  } catch {
    return false;
  }
}

function safeFileStat(stats) {
  try {
    return stats && typeof stats.isFile === 'function' && stats.isFile()
      && (typeof stats.isSymbolicLink !== 'function' || !stats.isSymbolicLink());
  } catch {
    return false;
  }
}

async function ensureRemoteDirectories(sftp, directorySegments, baseSegmentCount) {
  for (let index = 1; index <= directorySegments.length; index += 1) {
    const current = directorySegments.slice(0, index).join('/');
    let stats = await lstatMaybe(sftp, current);
    if (!stats) {
      try {
        await call(sftp, 'mkdir', current);
      } catch {
        // A concurrent creator is accepted only after the directory is revalidated.
      }
      stats = await lstatMaybe(sftp, current);
    }
    if (!safeDirectoryStat(stats)) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  }
  const base = directorySegments.slice(0, baseSegmentCount).join('/');
  const parent = directorySegments.join('/');
  const baseReal = path.posix.normalize(await call(sftp, 'realpath', base));
  const parentReal = path.posix.normalize(await call(sftp, 'realpath', parent));
  if (!baseReal.startsWith('/') || !parentReal.startsWith('/')
    || (parentReal !== baseReal && !parentReal.startsWith(`${baseReal}/`))) {
    throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  }
}

function hashReadable(stream) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

function within(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function localSource(localRoot, segments) {
  const rootStats = await fs.promises.lstat(localRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  }
  const rootReal = await fs.promises.realpath(localRoot);
  const candidate = path.resolve(rootReal, ...segments);
  if (!within(rootReal, candidate)) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  const stats = await fs.promises.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  const real = await fs.promises.realpath(candidate);
  if (!within(rootReal, real)) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  return real;
}

async function localDestination(localRoot, segments) {
  const rootStats = await fs.promises.lstat(localRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  }
  const rootReal = await fs.promises.realpath(localRoot);
  const target = path.resolve(rootReal, ...segments);
  if (!within(rootReal, target)) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  let current = rootReal;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch (error) {
      if (!isMissing(error)) throw error;
      try { await fs.promises.mkdir(current); } catch { /* concurrent creator */ }
      stats = await fs.promises.lstat(current);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw createError('SFTP_TRANSFER_PATH_UNSAFE');
    }
  }
  const parentReal = await fs.promises.realpath(path.dirname(target));
  if (!within(rootReal, parentReal)) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
  try {
    await fs.promises.lstat(target);
    throw createError('SFTP_TRANSFER_CONFLICT');
  } catch (error) {
    if (trustedErrors.has(error)) throw error;
    if (!isMissing(error)) throw error;
  }
  return target;
}

function transferInput(value) {
  const input = exactObject(value, [
    'session',
    'localRelativePath',
    'remoteWorkDir',
    'taskUid',
    'relativePath',
    'expectedSha256',
  ]);
  if (!input.session || typeof input.session !== 'object' || typeof input.session.sftp !== 'function') {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  const workSegments = relativeSegments(input.remoteWorkDir, 256);
  const remoteFileSegments = relativeSegments(input.relativePath);
  const localFileSegments = relativeSegments(input.localRelativePath);
  const uid = taskUid(input.taskUid);
  const remoteSegments = [...workSegments, 'jobs', uid, ...remoteFileSegments];
  if (remoteSegments.join('/').length > 2048) throw createError('SFTP_TRANSFER_INPUT_INVALID');
  return Object.freeze({
    session: input.session,
    localFileSegments,
    remoteSegments,
    baseSegmentCount: workSegments.length,
    expectedSha256: expectedHash(input.expectedSha256),
  });
}

function remoteFileInput(value) {
  const input = exactObject(value, [
    'session', 'remoteWorkDir', 'taskUid', 'relativePath',
  ]);
  if (!input.session || typeof input.session !== 'object' || typeof input.session.sftp !== 'function') {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }
  const workSegments = relativeSegments(input.remoteWorkDir, 256);
  const fileSegments = relativeSegments(input.relativePath);
  const remoteSegments = [...workSegments, 'jobs', taskUid(input.taskUid), ...fileSegments];
  if (remoteSegments.join('/').length > 2048) throw createError('SFTP_TRANSFER_INPUT_INVALID');
  return Object.freeze({
    session: input.session,
    remoteSegments,
    baseSegmentCount: workSegments.length,
  });
}

function translate(error) {
  return trustedErrors.has(error) ? error : createError('SFTP_TRANSFER_IO_FAILED');
}

function createSftpTransfer({ localRoot } = {}) {
  if (typeof localRoot !== 'string' || !path.isAbsolute(localRoot)) {
    throw createError('SFTP_TRANSFER_INPUT_INVALID');
  }

  async function uploadFile(value) {
    let sftp;
    let temporaryRemotePath;
    try {
      const input = transferInput(value);
      const source = await localSource(localRoot, input.localFileSegments);
      const sourceHash = await hashReadable(fs.createReadStream(source));
      if (sourceHash.sha256 !== input.expectedSha256) {
        throw createError('SFTP_TRANSFER_HASH_MISMATCH');
      }
      sftp = await input.session.sftp();
      const finalRemotePath = input.remoteSegments.join('/');
      const parentSegments = input.remoteSegments.slice(0, -1);
      await ensureRemoteDirectories(sftp, parentSegments, input.baseSegmentCount);
      if (await lstatMaybe(sftp, finalRemotePath)) throw createError('SFTP_TRANSFER_CONFLICT');
      temporaryRemotePath = `${parentSegments.join('/')}/.${input.remoteSegments.at(-1)}.${randomUUID()}.part`;
      await call(sftp, 'fastPut', source, temporaryRemotePath);
      const remoteHash = await hashReadable(sftp.createReadStream(temporaryRemotePath));
      if (remoteHash.sha256 !== input.expectedSha256 || remoteHash.bytes !== sourceHash.bytes) {
        throw createError('SFTP_TRANSFER_HASH_MISMATCH');
      }
      if (await lstatMaybe(sftp, finalRemotePath)) throw createError('SFTP_TRANSFER_CONFLICT');
      await call(sftp, 'rename', temporaryRemotePath, finalRemotePath);
      temporaryRemotePath = null;
      if (!safeFileStat(await lstatMaybe(sftp, finalRemotePath))) {
        throw createError('SFTP_TRANSFER_PATH_UNSAFE');
      }
      return Object.freeze({
        remoteRelativePath: finalRemotePath,
        sha256: remoteHash.sha256,
        bytes: remoteHash.bytes,
      });
    } catch (error) {
      throw translate(error);
    } finally {
      if (sftp && temporaryRemotePath) {
        try { await call(sftp, 'unlink', temporaryRemotePath); } catch { /* best-effort temp cleanup */ }
      }
      try { sftp?.end?.(); } catch { /* bounded session cleanup */ }
    }
  }

  async function downloadFile(value) {
    let sftp;
    let temporaryLocalPath;
    try {
      const input = transferInput(value);
      const target = await localDestination(localRoot, input.localFileSegments);
      sftp = await input.session.sftp();
      const remotePath = input.remoteSegments.join('/');
      const parentSegments = input.remoteSegments.slice(0, -1);
      await ensureRemoteDirectories(sftp, parentSegments, input.baseSegmentCount);
      const remoteStats = await lstatMaybe(sftp, remotePath);
      if (!safeFileStat(remoteStats)) throw createError('SFTP_TRANSFER_PATH_UNSAFE');
      const baseReal = path.posix.normalize(await call(
        sftp,
        'realpath',
        input.remoteSegments.slice(0, input.baseSegmentCount).join('/'),
      ));
      const remoteReal = path.posix.normalize(await call(sftp, 'realpath', remotePath));
      if (remoteReal !== baseReal && !remoteReal.startsWith(`${baseReal}/`)) {
        throw createError('SFTP_TRANSFER_PATH_UNSAFE');
      }
      const remoteHash = await hashReadable(sftp.createReadStream(remotePath));
      if (remoteHash.sha256 !== input.expectedSha256) {
        throw createError('SFTP_TRANSFER_HASH_MISMATCH');
      }
      temporaryLocalPath = path.join(
        path.dirname(target),
        `.${path.basename(target)}.${randomUUID()}.part`,
      );
      await call(sftp, 'fastGet', remotePath, temporaryLocalPath);
      const localHash = await hashReadable(fs.createReadStream(temporaryLocalPath));
      if (localHash.sha256 !== input.expectedSha256 || localHash.bytes !== remoteHash.bytes) {
        throw createError('SFTP_TRANSFER_HASH_MISMATCH');
      }
      await fs.promises.link(temporaryLocalPath, target);
      await fs.promises.unlink(temporaryLocalPath);
      temporaryLocalPath = null;
      return Object.freeze({
        localRelativePath: input.localFileSegments.join('/'),
        sha256: localHash.sha256,
        bytes: localHash.bytes,
      });
    } catch (error) {
      throw translate(error);
    } finally {
      if (temporaryLocalPath) {
        try { await fs.promises.unlink(temporaryLocalPath); } catch { /* best-effort temp cleanup */ }
      }
      try { sftp?.end?.(); } catch { /* bounded session cleanup */ }
    }
  }

  async function inspectRemoteFile(value) {
    let sftp;
    try {
      const input = remoteFileInput(value);
      sftp = await input.session.sftp();
      const remotePath = input.remoteSegments.join('/');
      const parentSegments = input.remoteSegments.slice(0, -1);
      await ensureRemoteDirectories(sftp, parentSegments, input.baseSegmentCount);
      if (!safeFileStat(await lstatMaybe(sftp, remotePath))) {
        throw createError('SFTP_TRANSFER_PATH_UNSAFE');
      }
      const baseReal = path.posix.normalize(await call(
        sftp,
        'realpath',
        input.remoteSegments.slice(0, input.baseSegmentCount).join('/'),
      ));
      const remoteReal = path.posix.normalize(await call(sftp, 'realpath', remotePath));
      if (remoteReal !== baseReal && !remoteReal.startsWith(`${baseReal}/`)) {
        throw createError('SFTP_TRANSFER_PATH_UNSAFE');
      }
      const measured = await hashReadable(sftp.createReadStream(remotePath));
      return Object.freeze({
        remoteRelativePath: remotePath,
        sha256: measured.sha256,
        bytes: measured.bytes,
      });
    } catch (error) {
      throw translate(error);
    } finally {
      try { sftp?.end?.(); } catch { /* bounded session cleanup */ }
    }
  }

  return Object.freeze({ downloadFile, inspectRemoteFile, uploadFile });
}

module.exports = { SftpTransferError, createSftpTransfer };
