'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DistributionAssetContractError,
  assertArchiveDistributionEntries,
  assertDistributionBuildConfig,
} = require('./distribution-assets');

const WINDOWS_RELEASE_ERROR = 'WINDOWS_RELEASE_CONTRACT_INVALID';
const REQUIRED_ASAR_ENTRIES = Object.freeze([
  '/main.js',
  '/bounded-log-file.js',
  '/distribution-assets.js',
  '/product-identity.js',
  '/user-data-path.js',
  '/windows-release-contract.js',
  '/backend-app/src/app.js',
  '/backend-app/src/utils/boundedLogFile.js',
  '/backend-app/src/utils/logDirectoryLease.js',
  '/backend-app/native/build/electron-win32-x64/log-directory-lease.node',
  '/backend-app/src/services/projectZipService.js',
  '/node_modules/@local-mini-drama/storage/package.json',
  '/node_modules/@local-mini-drama/storage/dist/index.js',
  '/node_modules/@local-mini-drama/workflow-engine/package.json',
  '/node_modules/@local-mini-drama/workflow-engine/dist/index.js',
  '/node_modules/@local-mini-drama/credential-vault/package.json',
  '/node_modules/@local-mini-drama/credential-vault/dist/index.js',
  '/node_modules/ajv/package.json',
  '/node_modules/ajv/LICENSE',
  '/node_modules/@volcengine/openapi/LICENSE',
  '/node_modules/adm-zip/LICENSE',
  '/node_modules/better-sqlite3/LICENSE',
  '/node_modules/cors/LICENSE',
  '/node_modules/express/LICENSE',
  '/node_modules/js-yaml/LICENSE',
  '/node_modules/jsonrepair/LICENSE.md',
  '/node_modules/jsonwebtoken/LICENSE',
  '/node_modules/multer/LICENSE',
  '/node_modules/sharp/LICENSE',
  '/node_modules/ssh2/LICENSE',
  '/node_modules/uuid/LICENSE.md',
  '/node_modules/ajv/dist/2020.js',
  '/node_modules/fast-uri/index.js',
  '/node_modules/require-from-string/index.js',
  '/schemas/v2/project-archive-manifest-v2.1.schema.json',
  '/schemas/v3/novel-extraction.schema.json',
  '/schemas/v3/shot-planning.schema.json',
]);
const REQUIRED_ARCHIVE_ENTRIES = Object.freeze([
  'resources/app.asar',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'resources/app.asar.unpacked/backend-app/migrations/v2/0001_add_core_uids.sql',
  'resources/app.asar.unpacked/backend-app/native/build/electron-win32-x64/log-directory-lease.node',
  'resources/frontweb/dist/index.html',
  'resources/licenses/LICENSE',
  'resources/licenses/THIRD_PARTY_NOTICES.md',
]);

class WindowsReleaseContractError extends Error {
  constructor() {
    super('Windows release contract invalid');
    this.name = 'WindowsReleaseContractError';
    this.code = WINDOWS_RELEASE_ERROR;
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

function invalid() {
  throw new WindowsReleaseContractError();
}

function nonEmptyString(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) invalid();
  return value;
}

function artifactName(template, packageJson) {
  const value = nonEmptyString(template)
    .replaceAll('${productName}', nonEmptyString(packageJson.build.productName))
    .replaceAll('${version}', nonEmptyString(packageJson.version))
    .replaceAll('${ext}', 'exe');
  if (value.includes('${') || value.includes('/') || value.includes('\\')) invalid();
  return value;
}

function comparablePath(value, pathImpl) {
  const resolved = pathImpl.resolve(value);
  return pathImpl.sep === '\\' ? resolved.toLowerCase() : resolved;
}

function physicalDirectorySnapshot(directory, fsImpl, pathImpl) {
  const resolved = pathImpl.resolve(directory);
  const stat = fsImpl.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
  const real = fsImpl.realpathSync.native
    ? fsImpl.realpathSync.native(resolved)
    : fsImpl.realpathSync(resolved);
  if (comparablePath(real, pathImpl) !== comparablePath(resolved, pathImpl)) invalid();
  return Object.freeze({
    resolved,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
  });
}

function assertDirectorySnapshot(snapshot, fsImpl, pathImpl) {
  const current = physicalDirectorySnapshot(snapshot.resolved, fsImpl, pathImpl);
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.mode !== snapshot.mode) {
    invalid();
  }
}

function packagingTaskRootSnapshot(taskRoot, {
  fsImpl = fs,
  pathImpl = path,
  tempRoot = os.tmpdir(),
} = {}) {
  const temp = physicalDirectorySnapshot(tempRoot, fsImpl, pathImpl);
  const task = physicalDirectorySnapshot(taskRoot, fsImpl, pathImpl);
  if (comparablePath(pathImpl.dirname(task.resolved), pathImpl)
    !== comparablePath(temp.resolved, pathImpl)) invalid();
  if (!/^ai-drama-p9-05-(?:portable|installer)-[a-zA-Z0-9_-]+$/u.test(
    pathImpl.basename(task.resolved),
  )) invalid();
  assertDirectorySnapshot(temp, fsImpl, pathImpl);
  assertDirectorySnapshot(task, fsImpl, pathImpl);
  return Object.freeze({ temp, task });
}

function assertPackagingSmokeTaskRoot({
  taskRoot,
  fsImpl = fs,
  pathImpl = path,
  tempRoot = os.tmpdir(),
}) {
  try {
    return packagingTaskRootSnapshot(taskRoot, { fsImpl, pathImpl, tempRoot }).task.resolved;
  } catch (error) {
    if (error instanceof WindowsReleaseContractError) throw error;
    invalid();
  }
}

function releaseArtifactNames(packageJson) {
  assertWindowsReleaseConfig(packageJson);
  const portable = artifactName(packageJson.build.artifactName, packageJson);
  const installer = artifactName(packageJson.build.nsis.artifactName, packageJson);
  if (portable === installer) invalid();
  return Object.freeze({
    installer,
    portable,
    unpackedExecutable: `${packageJson.build.productName}.exe`,
  });
}

function resolvePackagingSmokeAppData({
  env,
  defaultPath,
  fsImpl = fs,
  pathImpl = path,
  tempRoot = os.tmpdir(),
}) {
  nonEmptyString(defaultPath);
  if (!env || env.LOCALMINIDRAMA_PACKAGING_SMOKE !== '1') return defaultPath;
  const value = env.LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA;
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) invalid();
  if (!pathImpl.isAbsolute(value) || pathImpl.basename(value) !== 'appdata') invalid();
  try {
    const resolved = pathImpl.resolve(value);
    const roots = packagingTaskRootSnapshot(pathImpl.dirname(resolved), {
      fsImpl,
      pathImpl,
      tempRoot,
    });
    const appData = physicalDirectorySnapshot(resolved, fsImpl, pathImpl);
    if (comparablePath(pathImpl.dirname(appData.resolved), pathImpl)
      !== comparablePath(roots.task.resolved, pathImpl)) invalid();
    assertDirectorySnapshot(roots.temp, fsImpl, pathImpl);
    assertDirectorySnapshot(roots.task, fsImpl, pathImpl);
    assertDirectorySnapshot(appData, fsImpl, pathImpl);
    return resolved;
  } catch (error) {
    if (error instanceof WindowsReleaseContractError) throw error;
    invalid();
  }
}

function assertWindowsReleaseConfig(packageJson) {
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) invalid();
  const build = packageJson.build;
  const win = build && build.win;
  const nsis = build && build.nsis;
  if (!build || !win || !nsis) invalid();
  try {
    assertDistributionBuildConfig(packageJson);
  } catch (error) {
    if (!(error instanceof DistributionAssetContractError)) throw error;
    invalid();
  }
  if (build.appId !== 'com.localminidrama.desktop') invalid();
  if (build.productName !== 'AI漫剧工作台') invalid();
  if (!Array.isArray(win.target) || win.target.length !== 2) invalid();
  if (win.target[0] !== 'nsis' || win.target[1] !== 'portable') invalid();
  if (win.signAndEditExecutable !== false) invalid();
  if (nsis.oneClick !== false || nsis.allowToChangeInstallationDirectory !== true) invalid();
  if (nsis.perMachine !== false || nsis.deleteAppDataOnUninstall !== false) invalid();
  if (nsis.allowElevation !== false || nsis.runAfterFinish !== false) invalid();
  if (packageJson.publish !== undefined || build.publish !== undefined) invalid();
  if (!Array.isArray(build.files)) invalid();
  if (!Array.isArray(build.asarUnpack)
    || !build.asarUnpack.includes('backend-app/migrations/**')
    || !build.asarUnpack.includes('backend-app/native/build/**')) invalid();
  for (const required of [
    'main.js',
    'bounded-log-file.js',
    'distribution-assets.js',
    'product-identity.js',
    'user-data-path.js',
    'windows-release-contract.js',
    'backend-app/**/*',
    'node_modules/**/*',
  ]) {
    if (!build.files.includes(required)) invalid();
  }
  if (packageJson.dependencies.ajv !== '8.20.0') invalid();
  if (packageJson.dependencies['@local-mini-drama/storage'] !== 'file:../packages/storage') invalid();
  if (packageJson.dependencies['@local-mini-drama/workflow-engine'] !== 'file:../packages/workflow-engine') invalid();
  if (packageJson.dependencies['@local-mini-drama/credential-vault'] !== 'file:../packages/credential-vault') invalid();
  if (!build.files.includes('schemas/**/*')) invalid();
  const portable = artifactName(build.artifactName, packageJson);
  const installer = artifactName(nsis.artifactName, packageJson);
  if (portable === installer) invalid();
  return Object.freeze({
    targets: Object.freeze(['nsis', 'portable']),
    perMachine: false,
    deleteAppDataOnUninstall: false,
    publishConfigured: false,
  });
}

function assertPeFile(filePath, fsImpl = fs) {
  let stat;
  let handle;
  try {
    stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 68) invalid();
    handle = fsImpl.openSync(filePath, 'r');
    const dosHeader = Buffer.allocUnsafe(64);
    if (fsImpl.readSync(handle, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) invalid();
    if (dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) invalid();
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < dosHeader.length || peOffset > stat.size - 4) invalid();
    const peSignature = Buffer.allocUnsafe(4);
    if (fsImpl.readSync(handle, peSignature, 0, peSignature.length, peOffset)
      !== peSignature.length) invalid();
    if (!peSignature.equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))) invalid();
  } catch (error) {
    if (error instanceof WindowsReleaseContractError) throw error;
    invalid();
  } finally {
    if (handle !== undefined) {
      try { fsImpl.closeSync(handle); } catch (_) {}
    }
  }
  return Object.freeze({ bytes: stat.size });
}

function normalizedEntry(value) {
  if (typeof value !== 'string') invalid();
  return `/${value.replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

function assertEntries(entries, requiredEntries) {
  if (!Array.isArray(entries)) invalid();
  const normalized = new Set(entries.map(normalizedEntry));
  for (const required of requiredEntries) {
    if (!normalized.has(required)) invalid();
  }
  return Object.freeze(requiredEntries.slice());
}

function assertAsarEntries(entries) {
  try {
    assertArchiveDistributionEntries(entries);
  } catch (error) {
    if (!(error instanceof DistributionAssetContractError)) throw error;
    invalid();
  }
  return assertEntries(entries, REQUIRED_ASAR_ENTRIES);
}

function assertArchiveEntries(entries) {
  try {
    assertArchiveDistributionEntries(entries);
  } catch (error) {
    if (!(error instanceof DistributionAssetContractError)) throw error;
    invalid();
  }
  const required = assertEntries(entries, REQUIRED_ARCHIVE_ENTRIES.map((entry) => `/${entry}`));
  return required;
}

function assertUnpackedPayload({ desktopRoot, packageJson, asarEntries, fsImpl = fs }) {
  const names = releaseArtifactNames(packageJson);
  const unpackedRoot = path.join(desktopRoot, 'release', 'win-unpacked');
  assertPeFile(path.join(unpackedRoot, names.unpackedExecutable), fsImpl);
  for (const relativePath of [
    ['resources', 'app.asar'],
    ['resources', 'frontweb', 'dist', 'index.html'],
    ['resources', 'licenses', 'LICENSE'],
    ['resources', 'licenses', 'THIRD_PARTY_NOTICES.md'],
    ['resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'],
    ['resources', 'app.asar.unpacked', 'backend-app', 'migrations', 'v2', '0001_add_core_uids.sql'],
    ['resources', 'app.asar.unpacked', 'backend-app', 'native', 'build', 'electron-win32-x64', 'log-directory-lease.node'],
    ['resources', 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node'],
  ]) {
    try {
      const stat = fsImpl.statSync(path.join(unpackedRoot, ...relativePath));
      if (!stat.isFile() || stat.size < 1) invalid();
    } catch (error) {
      if (error instanceof WindowsReleaseContractError) throw error;
      invalid();
    }
  }
  for (const forbiddenDirectory of ['example_drama', 'ffmpeg']) {
    if (fsImpl.existsSync(path.join(unpackedRoot, 'resources', forbiddenDirectory))) invalid();
  }
  assertAsarEntries(asarEntries);
  return Object.freeze({ unpackedExecutable: names.unpackedExecutable });
}

module.exports = Object.freeze({
  WINDOWS_RELEASE_ERROR,
  WindowsReleaseContractError,
  assertPackagingSmokeTaskRoot,
  assertArchiveEntries,
  assertAsarEntries,
  assertPeFile,
  assertUnpackedPayload,
  assertWindowsReleaseConfig,
  releaseArtifactNames,
  resolvePackagingSmokeAppData,
});
