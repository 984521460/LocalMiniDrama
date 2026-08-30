'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { fail } = require('../audio/audioContract');
const {
  assertLocalMediaFileUnchanged,
  hashLocalMediaFile,
  resolveStableLocalMediaFile,
} = require('./localMediaFile');

const INPUT_CODE = 'MEDIA_EXPORT_INPUT_INVALID';
const FAILED_CODE = 'MEDIA_EXPORT_FAILED';

function invalid(code = FAILED_CODE) {
  fail(code);
}

function identity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function directoryRoot(value, code = INPUT_CODE) {
  try {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) invalid(code);
    const resolved = path.resolve(value);
    const stats = await fs.promises.lstat(resolved);
    if (!stats.isDirectory() || stats.isSymbolicLink()) invalid(code);
    const real = await fs.promises.realpath(resolved);
    if (path.resolve(real) !== resolved) invalid(code);
    return Object.freeze({ real, identity: identity(stats) });
  } catch {
    return invalid(code);
  }
}

function relativeSegments(value, extension = null) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value !== value.trim() || value.includes('\0') || value.includes('\\')
    || value.startsWith('/') || value.endsWith('/')) invalid(INPUT_CODE);
  const segments = value.split('/');
  if (segments.length < 2 || segments.length > 64 || segments.some((segment) => (
    segment.length < 1 || segment.length > 128 || segment === '.' || segment === '..'
      || !/^[A-Za-z0-9._-]+$/u.test(segment)
  ))) invalid(INPUT_CODE);
  if (extension !== null && !segments.at(-1).endsWith(extension)) invalid(INPUT_CODE);
  return segments;
}

async function assertRootUnchanged(root, code = FAILED_CODE) {
  try {
    const stats = await fs.promises.lstat(root.real);
    const real = await fs.promises.realpath(root.real);
    if (!stats.isDirectory() || stats.isSymbolicLink() || real !== root.real
      || !sameIdentity(identity(stats), root.identity)) invalid(code);
  } catch {
    return invalid(code);
  }
}

async function createSafeDirectories(root, segments) {
  let cursor = root.real;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      await fs.promises.mkdir(cursor);
    } catch (error) {
      if (error?.code !== 'EEXIST') invalid();
    }
    const stats = await fs.promises.lstat(cursor);
    if (!stats.isDirectory() || stats.isSymbolicLink()) invalid();
    const real = await fs.promises.realpath(cursor);
    if (real !== cursor || !real.startsWith(`${root.real}${path.sep}`)) invalid();
  }
  return cursor;
}

async function createMediaExportWorkspace(config, plan) {
  try {
    const localRoot = await directoryRoot(config.localRoot);
    const workspaceRoot = await directoryRoot(config.workspaceRoot);
    if (!workspaceRoot.real.startsWith(`${localRoot.real}${path.sep}`)) invalid(INPUT_CODE);
    const outputSegments = relativeSegments(plan.outputRelativePath, '.mp4');
    const outputPath = path.join(localRoot.real, ...outputSegments);
    try {
      await fs.promises.lstat(outputPath);
      invalid();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const workspacePath = path.join(workspaceRoot.real, plan.uid);
    await fs.promises.mkdir(workspacePath);
    const workspaceStats = await fs.promises.lstat(workspacePath);
    if (!workspaceStats.isDirectory() || workspaceStats.isSymbolicLink()) invalid();
    return Object.freeze({
      localRoot,
      workspaceRoot,
      workspacePath,
      workspaceIdentity: identity(workspaceStats),
      outputSegments: Object.freeze(outputSegments),
      outputPath,
    });
  } catch {
    return invalid();
  }
}

async function assertMediaExportWorkspaceUnchanged(workspace) {
  try {
    await assertRootUnchanged(workspace.localRoot);
    await assertRootUnchanged(workspace.workspaceRoot);
    const stats = await fs.promises.lstat(workspace.workspacePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()
      || !sameIdentity(identity(stats), workspace.workspaceIdentity)) invalid();
  } catch {
    return invalid();
  }
}

async function installMediaExportCandidate(workspace, candidatePath) {
  let linkedTarget = null;
  try {
    await assertMediaExportWorkspaceUnchanged(workspace);
    const candidate = await fs.promises.lstat(candidatePath);
    if (!candidate.isFile() || candidate.isSymbolicLink()
      || candidate.nlink !== 1
      || path.dirname(candidatePath) !== workspace.workspacePath) invalid();
    const parent = await createSafeDirectories(
      workspace.localRoot, workspace.outputSegments.slice(0, -1),
    );
    await assertRootUnchanged(workspace.localRoot);
    const target = path.join(parent, workspace.outputSegments.at(-1));
    if (target !== workspace.outputPath) invalid();
    await fs.promises.link(candidatePath, target);
    linkedTarget = target;
    const installed = await fs.promises.lstat(target);
    if (!installed.isFile() || installed.isSymbolicLink()
      || installed.dev !== candidate.dev || installed.ino !== candidate.ino
      || installed.size !== candidate.size || installed.nlink !== 2) invalid();
    await fs.promises.unlink(candidatePath);
    try {
      await fs.promises.lstat(candidatePath);
      invalid();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const final = await fs.promises.lstat(target);
    if (!final.isFile() || final.isSymbolicLink()
      || final.dev !== candidate.dev || final.ino !== candidate.ino
      || final.size !== candidate.size || final.nlink !== 1) invalid();
    return Object.freeze({
      targetPath: target,
      candidatePath,
      identity: identity(final),
      bytes: final.size,
    });
  } catch {
    if (linkedTarget !== null) {
      try {
        let candidateExists = true;
        try {
          await fs.promises.lstat(candidatePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          candidateExists = false;
        }
        if (!candidateExists) await fs.promises.link(linkedTarget, candidatePath);
        await fs.promises.unlink(linkedTarget);
      } catch { /* fixed export failure below */ }
    }
    return invalid();
  }
}

async function rollbackMediaExportInstallation(installation) {
  try {
    const target = await fs.promises.lstat(installation.targetPath);
    if (!target.isFile() || target.isSymbolicLink()
      || !sameIdentity(identity(target), installation.identity)
      || target.size !== installation.bytes || target.nlink !== 1) invalid();
    try {
      await fs.promises.lstat(installation.candidatePath);
      invalid();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await fs.promises.link(installation.targetPath, installation.candidatePath);
    await fs.promises.unlink(installation.targetPath);
    const candidate = await fs.promises.lstat(installation.candidatePath);
    if (!candidate.isFile() || candidate.isSymbolicLink()
      || !sameIdentity(identity(candidate), installation.identity)
      || candidate.size !== installation.bytes || candidate.nlink !== 1) invalid();
    try {
      await fs.promises.lstat(installation.targetPath);
      invalid();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch {
    return invalid();
  }
}

async function removeVerifiedMediaExportOutput(localRoot, relativePath, expectedSha256) {
  try {
    if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedSha256)) invalid();
    const config = Object.freeze({ localRoot, maxFileBytes: 64 * 1024 * 1024 * 1024 });
    const resolved = await resolveStableLocalMediaFile(config, relativePath);
    const hashed = await hashLocalMediaFile(resolved.real, config.maxFileBytes);
    if (hashed.sha256 !== expectedSha256) invalid();
    await assertLocalMediaFileUnchanged(config, resolved, hashed);
    await fs.promises.unlink(resolved.real);
    await assertRootUnchanged(resolved.root);
    try {
      await fs.promises.lstat(resolved.real);
      invalid();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } catch {
    return invalid();
  }
}

module.exports = Object.freeze({
  assertMediaExportWorkspaceUnchanged,
  createMediaExportWorkspace,
  installMediaExportCandidate,
  removeVerifiedMediaExportOutput,
  rollbackMediaExportInstallation,
});
