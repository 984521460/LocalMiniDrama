'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const asar = require('@electron/asar');
const {
  WINDOWS_RELEASE_ERROR,
  WindowsReleaseContractError,
  assertArchiveEntries,
  assertAsarEntries,
  assertPackagingSmokeTaskRoot,
  assertPeFile,
  assertUnpackedPayload,
  assertWindowsReleaseConfig,
  releaseArtifactNames,
} = require('../windows-release-contract');
const {
  APP_ID,
  LEGACY_PRODUCT_NAMES,
  PRODUCT_NAME,
  USER_DATA_DIRECTORY,
} = require('../product-identity');
const {
  MAX_PROVENANCE_BYTES,
  currentWindowsBuildProvenance,
  parseWindowsBuildProvenanceBytes,
  provenanceSha256,
  serializeWindowsBuildProvenance,
} = require('../windows-build-provenance');

const desktopRoot = path.join(__dirname, '..');
const releaseRoot = path.join(desktopRoot, 'release');
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_EMBEDDED_ASAR_BYTES = 512 * 1024 * 1024;
const MAX_LICENSE_BYTES = 4 * 1024 * 1024;
const SYNTHETIC_SENTINEL = Buffer.from('p9-05-synthetic-upgrade-sentinel\n', 'utf8');

function fail() {
  throw new WindowsReleaseContractError();
}

function packageJson() {
  try {
    return JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
  } catch (_) {
    fail();
  }
}

function parseArchiveEntries(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 64 * 1024 * 1024) fail();
  const entries = [];
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith('Path = ')) entries.push(line.slice(7));
  }
  return entries;
}

function runProcess(executable, args, options = {}) {
  const timeout = options.timeout || PROCESS_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer || 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_) {
      reject(new WindowsReleaseContractError());
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let failed = false;
    let settled = false;

    function terminateTree() {
      if (!child.pid) return;
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 15_000,
      });
    }

    function collect(target, chunk) {
      if (failed) return;
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) {
        failed = true;
        terminateTree();
        return;
      }
      target.push(chunk);
    }

    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', () => {
      failed = true;
    });

    const timer = setTimeout(() => {
      failed = true;
      terminateTree();
    }, timeout);

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failed || signal || code !== 0) {
        reject(new WindowsReleaseContractError());
        return;
      }
      resolve({
        status: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function sevenZipPath() {
  return path.join(desktopRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
}

async function listExecutableArchive(executable) {
  const sevenZip = sevenZipPath();
  assertPeFile(sevenZip);
  const result = await runProcess(sevenZip, ['l', '-slt', executable]);
  const entries = parseArchiveEntries(result.stdout);
  assertArchiveEntries(entries);
  return entries.length;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(handle, chunk, 0, chunk.length, null);
      if (bytes === 0) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function assertBoundedRegularFile(filePath, maxBytes) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (_) {
    fail();
  }
  if (!stat.isFile() || stat.isSymbolicLink()
    || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) fail();
  return stat.size;
}

function extractBuildProvenance(asarImpl, archivePath) {
  let stat;
  let bytes;
  try {
    stat = asarImpl.statFile(archivePath, 'build-provenance.json', false);
    if (!stat || 'link' in stat || 'files' in stat || stat.unpacked === true
      || !Number.isSafeInteger(stat.size) || stat.size < 2
      || stat.size > MAX_PROVENANCE_BYTES) fail();
    bytes = asarImpl.extractFile(archivePath, 'build-provenance.json', false);
  } catch (_) {
    fail();
  }
  const provenance = parseWindowsBuildProvenanceBytes(bytes);
  if (Buffer.byteLength(serializeWindowsBuildProvenance(provenance), 'utf8') !== stat.size) fail();
  return provenance;
}

function assertExtractedExecutablePayload({
  extractionRoot,
  sidecarAsarPath,
  expectedProvenance,
  projectLicensePath = path.join(desktopRoot, '..', 'LICENSE'),
  thirdPartyNoticesPath = path.join(desktopRoot, '..', 'THIRD_PARTY_NOTICES.md'),
  asarImpl = asar,
  assertAsarEntriesImpl = assertAsarEntries,
}) {
  const extractedAsar = path.join(extractionRoot, 'resources', 'app.asar');
  const extractedLicense = path.join(extractionRoot, 'resources', 'licenses', 'LICENSE');
  const extractedNotices = path.join(
    extractionRoot,
    'resources',
    'licenses',
    'THIRD_PARTY_NOTICES.md',
  );
  assertBoundedRegularFile(sidecarAsarPath, MAX_EMBEDDED_ASAR_BYTES);
  assertBoundedRegularFile(extractedAsar, MAX_EMBEDDED_ASAR_BYTES);
  assertBoundedRegularFile(projectLicensePath, MAX_LICENSE_BYTES);
  assertBoundedRegularFile(thirdPartyNoticesPath, MAX_LICENSE_BYTES);
  assertBoundedRegularFile(extractedLicense, MAX_LICENSE_BYTES);
  assertBoundedRegularFile(extractedNotices, MAX_LICENSE_BYTES);

  const sidecarAsarSha256 = sha256(sidecarAsarPath);
  const embeddedAsarSha256 = sha256(extractedAsar);
  if (embeddedAsarSha256 !== sidecarAsarSha256
    || sha256(extractedLicense) !== sha256(projectLicensePath)
    || sha256(extractedNotices) !== sha256(thirdPartyNoticesPath)) fail();

  let entries;
  let sidecarProvenance;
  let embeddedProvenance;
  try {
    entries = asarImpl.listPackage(extractedAsar);
    sidecarProvenance = extractBuildProvenance(asarImpl, sidecarAsarPath);
    embeddedProvenance = extractBuildProvenance(asarImpl, extractedAsar);
  } catch (_) {
    fail();
  }
  assertAsarEntriesImpl(entries);
  let expectedSerialized;
  try {
    expectedSerialized = serializeWindowsBuildProvenance(expectedProvenance);
  } catch (_) {
    fail();
  }
  if (serializeWindowsBuildProvenance(sidecarProvenance) !== expectedSerialized
    || serializeWindowsBuildProvenance(embeddedProvenance) !== expectedSerialized) fail();
  return Object.freeze({
    asarEntries: entries.length,
    asarSha256: embeddedAsarSha256,
    provenanceSha256: provenanceSha256(embeddedProvenance),
    sourceCommitSha: embeddedProvenance.sourceCommitSha,
    sourceTreeSha: embeddedProvenance.sourceTreeSha,
  });
}

async function inspectExecutablePayload(executable, kind, sidecarAsarPath, expectedProvenance) {
  if (kind !== 'installer' && kind !== 'portable') fail();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ai-drama-p9-05-${kind}-payload-`));
  try {
    const sevenZip = sevenZipPath();
    assertPeFile(sevenZip);
    await runProcess(sevenZip, [
      'x',
      '-y',
      '-bd',
      '-bb0',
      `-o${root}`,
      executable,
      'resources\\app.asar',
      'resources\\licenses\\LICENSE',
      'resources\\licenses\\THIRD_PARTY_NOTICES.md',
    ]);
    return assertExtractedExecutablePayload({
      extractionRoot: root,
      sidecarAsarPath,
      expectedProvenance,
    });
  } finally {
    removeTaskRoot(root);
  }
}

function removeTaskRoot(root) {
  const resolvedRoot = assertPackagingSmokeTaskRoot({ taskRoot: root });
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (!fs.existsSync(resolvedRoot)) return;
    } catch (_) {}
    Atomics.wait(delay, 0, 0, 500);
  }
  fail();
}

function waitFor(predicate, attempts = 60) {
  const delay = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return true;
    Atomics.wait(delay, 0, 0, 500);
  }
  return false;
}

async function verifyArtifacts() {
  const manifest = packageJson();
  assertWindowsReleaseConfig(manifest);
  let expectedProvenance;
  try {
    expectedProvenance = currentWindowsBuildProvenance({
      repoRoot: path.resolve(desktopRoot, '..'),
      packageJsonPath: path.join(desktopRoot, 'package.json'),
    });
  } catch (_) {
    fail();
  }
  const names = releaseArtifactNames(manifest);
  const installer = path.join(releaseRoot, names.installer);
  const portable = path.join(releaseRoot, names.portable);
  const asarPath = path.join(releaseRoot, 'win-unpacked', 'resources', 'app.asar');

  const installerStat = assertPeFile(installer);
  const portableStat = assertPeFile(portable);
  const entries = asar.listPackage(asarPath);
  assertUnpackedPayload({ desktopRoot, packageJson: manifest, asarEntries: entries });
  const [installerEntries, portableEntries] = await Promise.all([
    listExecutableArchive(installer),
    listExecutableArchive(portable),
  ]);
  const [installerPayload, portablePayload] = await Promise.all([
    inspectExecutablePayload(installer, 'installer', asarPath, expectedProvenance),
    inspectExecutablePayload(portable, 'portable', asarPath, expectedProvenance),
  ]);
  if (installerPayload.provenanceSha256 !== portablePayload.provenanceSha256
    || installerPayload.sourceCommitSha !== portablePayload.sourceCommitSha
    || installerPayload.sourceTreeSha !== portablePayload.sourceTreeSha) fail();

  return Object.freeze({
    manifest,
    names,
    installer,
    portable,
    receipt: Object.freeze({
      installerBytes: installerStat.bytes,
      installerSha256: sha256(installer),
      installerEntries,
      installerAsarEntries: installerPayload.asarEntries,
      installerAsarSha256: installerPayload.asarSha256,
      portableBytes: portableStat.bytes,
      portableSha256: sha256(portable),
      portableEntries,
      portableAsarEntries: portablePayload.asarEntries,
      portableAsarSha256: portablePayload.asarSha256,
      sourceCommitSha: installerPayload.sourceCommitSha,
      sourceTreeSha: installerPayload.sourceTreeSha,
      provenanceSha256: installerPayload.provenanceSha256,
      asarEntries: entries.length,
    }),
  });
}

function registryContains(term) {
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    const result = spawnSync('reg.exe', ['query', root, '/s', '/f', term], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: 'pipe',
    });
    if (result.error) fail();
    if (result.status === 0) return true;
    if (result.status !== 1) fail();
  }
  return false;
}

function hasKnownRegistration() {
  return [PRODUCT_NAME, APP_ID, ...LEGACY_PRODUCT_NAMES].some(registryContains);
}

function assertNoPreexistingInstall() {
  if (hasKnownRegistration()) fail();
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', PRODUCT_NAME, `${PRODUCT_NAME}.exe`),
    path.join(process.env.USERPROFILE || '', 'Desktop', `${PRODUCT_NAME}.lnk`),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
  ];
  if (candidates.some((candidate) => candidate && fs.existsSync(candidate))) fail();
}

function sentinelPath(appDataRoot, legacy) {
  const directory = legacy ? 'LocalMiniDrama' : USER_DATA_DIRECTORY;
  return path.join(appDataRoot, directory, 'backend', 'data', 'p9-05-upgrade-sentinel.bin');
}

function seedLegacyUserData(appDataRoot) {
  const target = sentinelPath(appDataRoot, true);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, SYNTHETIC_SENTINEL, { flag: 'wx' });
  return crypto.createHash('sha256').update(SYNTHETIC_SENTINEL).digest('hex');
}

function assertMigratedSentinel(appDataRoot, expectedSha256) {
  const current = sentinelPath(appDataRoot, false);
  if (!fs.existsSync(current) || fs.existsSync(sentinelPath(appDataRoot, true))) fail();
  if (sha256(current) !== expectedSha256) fail();
}

function smokeLogPath(appDataRoot) {
  return path.join(appDataRoot, USER_DATA_DIRECTORY, 'main-startup.log');
}

async function runPackagedSmoke(executable, appDataRoot, localAppDataRoot) {
  const logPath = smokeLogPath(appDataRoot);
  const previousBytes = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  await runProcess(executable, [], {
    env: {
      ...process.env,
      APPDATA: appDataRoot,
      LOCALAPPDATA: localAppDataRoot,
      LOCALMINIDRAMA_PACKAGING_SMOKE: '1',
      LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA: appDataRoot,
      LOCALMINIDRAMA_DEVTOOLS: '0',
    },
  });
  let appended;
  try {
    const currentBytes = fs.statSync(logPath).size;
    if (currentBytes <= previousBytes || currentBytes > previousBytes + 1024 * 1024) fail();
    const handle = fs.openSync(logPath, 'r');
    const buffer = Buffer.allocUnsafe(currentBytes - previousBytes);
    try {
      if (fs.readSync(handle, buffer, 0, buffer.length, previousBytes) !== buffer.length) fail();
    } finally {
      fs.closeSync(handle);
    }
    appended = buffer.toString('utf8');
  } catch (error) {
    if (error instanceof WindowsReleaseContractError) throw error;
    fail();
  }
  if (!appended.includes('packaging-smoke-ready')) fail();
}

async function runPortableSmoke(portable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-p9-05-portable-'));
  try {
    const appDataRoot = path.join(root, 'appdata');
    const localAppDataRoot = path.join(root, 'localappdata');
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(localAppDataRoot, { recursive: true });
    const sentinelSha256 = seedLegacyUserData(appDataRoot);
    await runPackagedSmoke(portable, appDataRoot, localAppDataRoot);
    assertMigratedSentinel(appDataRoot, sentinelSha256);
    return Object.freeze({ smoke: 'passed', migration: 'preserved' });
  } finally {
    removeTaskRoot(root);
  }
}

function findUninstaller(installRoot) {
  const names = fs.readdirSync(installRoot);
  const matches = names.filter((name) => /^Uninstall .+\.exe$/u.test(name));
  if (matches.length !== 1) fail();
  return path.join(installRoot, matches[0]);
}

async function runInstallerLifecycle(installer, unpackedExecutable) {
  assertNoPreexistingInstall();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-p9-05-installer-'));
  const installRoot = path.join(root, 'installed');
  const appDataRoot = path.join(root, 'appdata');
  const localAppDataRoot = path.join(root, 'localappdata');
  let installed = false;
  let uninstaller = null;
  let installedExecutable = null;
  try {
    fs.mkdirSync(appDataRoot, { recursive: true });
    fs.mkdirSync(localAppDataRoot, { recursive: true });
    const sentinelSha256 = seedLegacyUserData(appDataRoot);
    const installArgs = ['/S', '/currentuser', '/noDesktopShortcut', `/D=${installRoot}`];

    await runProcess(installer, installArgs);
    installed = true;
    installedExecutable = path.join(installRoot, unpackedExecutable);
    assertPeFile(installedExecutable);
    uninstaller = findUninstaller(installRoot);
    if (!hasKnownRegistration()) fail();
    await runPackagedSmoke(installedExecutable, appDataRoot, localAppDataRoot);
    assertMigratedSentinel(appDataRoot, sentinelSha256);

    await runProcess(installer, installArgs);
    assertPeFile(installedExecutable);
    await runPackagedSmoke(installedExecutable, appDataRoot, localAppDataRoot);
    assertMigratedSentinel(appDataRoot, sentinelSha256);

    await runProcess(uninstaller, ['/S', '/currentuser']);
    installed = false;
    if (!waitFor(() => !fs.existsSync(installedExecutable) && !hasKnownRegistration())) fail();
    assertMigratedSentinel(appDataRoot, sentinelSha256);
    return Object.freeze({ install: 'passed', upgrade: 'preserved', uninstall: 'preserved' });
  } finally {
    if (installed && uninstaller && fs.existsSync(uninstaller)) {
      try {
        await runProcess(uninstaller, ['/S', '/currentuser']);
        installed = false;
      } catch (_) {}
    }
    if (!waitFor(() => !installed && !hasKnownRegistration()
      && (!installedExecutable || !fs.existsSync(installedExecutable)))) fail();
    removeTaskRoot(root);
  }
}

function hasHostInstallerFlag(argv) {
  const allowed = new Set(['--allow-host-installer']);
  for (const value of argv) if (!allowed.has(value)) fail();
  return argv.includes('--allow-host-installer');
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'win32') fail();
  const allowHostInstaller = hasHostInstallerFlag(argv);
  const artifacts = await verifyArtifacts();
  const portable = await runPortableSmoke(artifacts.portable);
  const installer = allowHostInstaller
    ? await runInstallerLifecycle(artifacts.installer, artifacts.names.unpackedExecutable)
    : Object.freeze({ install: 'not-run', upgrade: 'not-run', uninstall: 'not-run' });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    code: 'WINDOWS_RELEASE_VERIFIED',
    artifacts: artifacts.receipt,
    portable,
    installer,
  })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const code = error && error.code === WINDOWS_RELEASE_ERROR
      ? WINDOWS_RELEASE_ERROR
      : 'WINDOWS_RELEASE_VERIFICATION_FAILED';
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  assertExtractedExecutablePayload,
  hasHostInstallerFlag,
  main,
  parseArchiveEntries,
  removeTaskRoot,
  runPackagedSmoke,
  verifyArtifacts,
});
