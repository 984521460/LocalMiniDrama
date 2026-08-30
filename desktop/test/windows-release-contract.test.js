'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const asar = require('@electron/asar');

const {
  WINDOWS_RELEASE_ERROR,
  assertAsarEntries,
  assertPeFile,
  assertWindowsReleaseConfig,
  releaseArtifactNames,
  resolvePackagingSmokeAppData,
} = require('../windows-release-contract');
const {
  assertExtractedExecutablePayload,
  hasHostInstallerFlag,
  parseArchiveEntries,
  removeTaskRoot,
} = require('../scripts/verify-windows-release');
const { pruneUnsupportedOptionalNative } = require('../scripts/prune-optional-native');

const desktopRoot = path.join(__dirname, '..');

function packageFixture() {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'));
}

function withTempDirectory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-release-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function withPackagingSmokeTaskRoot(t, suffix = 'fixture') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ai-drama-p9-05-portable-${suffix}-`));
  const appDataRoot = path.join(root, 'appdata');
  fs.mkdirSync(appDataRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, appDataRoot };
}

test('Windows release config has distinct installer and portable artifacts with safe user-data behavior', () => {
  const packageJson = packageFixture();
  const result = assertWindowsReleaseConfig(packageJson);

  assert.deepEqual(result.targets, ['nsis', 'portable']);
  assert.equal(result.perMachine, false);
  assert.equal(result.deleteAppDataOnUninstall, false);
  assert.equal(result.publishConfigured, false);
  assert.deepEqual(releaseArtifactNames(packageJson), {
    installer: 'AI漫剧工作台 Setup 1.2.8.exe',
    portable: 'AI漫剧工作台 1.2.8.exe',
    unpackedExecutable: 'AI漫剧工作台.exe',
  });
});

test('release config rejects unsafe or ambiguous Windows packaging changes', () => {
  for (const mutate of [
    (value) => { value.build.win.target = ['nsis']; },
    (value) => { value.build.nsis.perMachine = true; },
    (value) => { value.build.nsis.deleteAppDataOnUninstall = true; },
    (value) => { value.build.artifactName = value.build.nsis.artifactName; },
    (value) => { value.build.publish = [{ provider: 'github' }]; },
    (value) => { value.build.extraResources.push({ from: '../example_drama', to: 'example_drama', filter: ['**/*'] }); },
    (value) => { value.build.extraResources.push({ from: '../backend-node/tools/ffmpeg', to: 'ffmpeg', filter: ['**/*'] }); },
  ]) {
    const packageJson = packageFixture();
    mutate(packageJson);
    assert.throws(
      () => assertWindowsReleaseConfig(packageJson),
      (error) => error && error.code === WINDOWS_RELEASE_ERROR,
    );
  }
});

test('PE and packaged asar contracts fail closed on missing production payload', (t) => {
  const root = withTempDirectory(t);
  const executable = path.join(root, 'artifact.exe');
  const peFixture = Buffer.alloc(128);
  peFixture[0] = 0x4d;
  peFixture[1] = 0x5a;
  peFixture.writeUInt32LE(64, 0x3c);
  peFixture.set([0x50, 0x45, 0x00, 0x00], 64);
  fs.writeFileSync(executable, peFixture);
  assert.equal(assertPeFile(executable).bytes, 128);

  fs.writeFileSync(executable, Buffer.from([0x4d, 0x5a, 0x00, 0x00]));
  assert.throws(
    () => assertPeFile(executable),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );

  const required = [
    '/main.js',
    '/distribution-assets.js',
    '/product-identity.js',
    '/user-data-path.js',
    '/windows-release-contract.js',
    '/backend-app/src/app.js',
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
  ];
  assert.deepEqual(assertAsarEntries(required), required);
  assert.throws(
    () => assertAsarEntries(required.filter((entry) => entry !== '/backend-app/src/app.js')),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
  assert.throws(
    () => assertAsarEntries([...required, '/backend-app/models/weights.onnx']),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
  for (const forbiddenAsarEntry of [
    '/ffmpeg/ffmpeg.exe',
    '/example_drama/demo.zip',
    '/backend-app/tools/ffmpeg/ffmpeg.exe',
  ]) {
    assert.throws(
      () => assertAsarEntries([...required, forbiddenAsarEntry]),
      (error) => error && error.code === WINDOWS_RELEASE_ERROR,
    );
  }

  const archiveEntries = [
    'resources\\app.asar',
    'resources\\app.asar.unpacked\\node_modules\\@img\\sharp-win32-x64\\lib\\sharp-win32-x64.node',
    'resources\\app.asar.unpacked\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node',
    'resources\\app.asar.unpacked\\backend-app\\migrations\\v2\\0001_add_core_uids.sql',
    'resources\\frontweb\\dist\\index.html',
    'resources\\licenses\\LICENSE',
    'resources\\licenses\\THIRD_PARTY_NOTICES.md',
  ];
  const { assertArchiveEntries } = require('../windows-release-contract');
  assert.equal(assertArchiveEntries(archiveEntries).length, 7);
  for (const forbidden of [
    'resources\\example_drama\\synthetic.zip',
    'resources\\ffmpeg\\ffmpeg.exe',
    'resources\\frontweb\\dist\\weights.safetensors',
  ]) {
    assert.throws(
      () => assertArchiveEntries([...archiveEntries, forbidden]),
      (error) => error && error.code === WINDOWS_RELEASE_ERROR,
    );
  }
});

test('packaged runtime exposes an exact local smoke gate without opening the UI', () => {
  const source = fs.readFileSync(path.join(desktopRoot, 'main.js'), 'utf8');
  assert.match(source, /LOCALMINIDRAMA_PACKAGING_SMOKE/);
  assert.match(source, /packaging-smoke-ready/);
  assert.match(source, /if \(isPackagingSmoke\(process\.env\)\)/);
  assert.match(source, /exitPackagingSmoke\(\)/);
  assert.match(source, /closeAllConnections/);
  assert.match(source, /app\.exit\(0\)/);
});

test('backend packaging copies the built local runtime modules used by production', () => {
  const packageJson = packageFixture();
  assert.equal(packageJson.dependencies['@local-mini-drama/storage'], 'file:../packages/storage');
  assert.equal(packageJson.dependencies['@local-mini-drama/workflow-engine'], 'file:../packages/workflow-engine');
  assert.equal(packageJson.dependencies['@local-mini-drama/credential-vault'],
    'file:../packages/credential-vault');
  assert.equal(packageJson.dependencies.ajv, '8.20.0');
  const backendPackageJson = JSON.parse(fs.readFileSync(
    path.join(desktopRoot, '..', 'backend-node', 'package.json'),
    'utf8',
  ));
  assert.equal(backendPackageJson.dependencies.ajv, '8.20.0');
  assert.equal(packageJson.scripts['prepare-backend'],
    'npm --prefix .. run build:packages && node scripts/copy-backend.js');
  assert.ok(packageJson.build.files.includes('schemas/**/*'));
  const copySource = fs.readFileSync(path.join(desktopRoot, 'scripts', 'copy-backend.js'), 'utf8');
  assert.match(copySource, /copyTreeSync\(schemaSource, schemaDestination\)/);
});

test('packaging smoke app-data override only accepts a real task-owned directory', (t) => {
  const { appDataRoot } = withPackagingSmokeTaskRoot(t);
  assert.equal(resolvePackagingSmokeAppData({
    env: {
      LOCALMINIDRAMA_PACKAGING_SMOKE: '1',
      LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA: appDataRoot,
    },
    defaultPath: 'C:\\Users\\fixture\\AppData\\Roaming',
  }), appDataRoot);
  assert.equal(resolvePackagingSmokeAppData({
    env: {},
    defaultPath: 'C:\\Users\\fixture\\AppData\\Roaming',
  }), 'C:\\Users\\fixture\\AppData\\Roaming');
  assert.throws(
    () => resolvePackagingSmokeAppData({
      env: {
        LOCALMINIDRAMA_PACKAGING_SMOKE: '1',
        LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA: path.dirname(appDataRoot),
      },
      defaultPath: 'C:\\Users\\fixture\\AppData\\Roaming',
    }),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
});

test('packaging smoke rejects matching roots outside the direct OS-temp boundary', (t) => {
  const outer = withTempDirectory(t);
  const appDataRoot = path.join(
    outer,
    'ai-drama-p9-05-portable-forged',
    'appdata',
  );
  fs.mkdirSync(appDataRoot, { recursive: true });

  assert.throws(
    () => resolvePackagingSmokeAppData({
      env: {
        LOCALMINIDRAMA_PACKAGING_SMOKE: '1',
        LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA: appDataRoot,
      },
      defaultPath: 'C:\\Users\\fixture\\AppData\\Roaming',
    }),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
});

test('packaging smoke rejects a junction task root and a root replaced during validation', (t) => {
  const realContainer = withTempDirectory(t);
  const realTaskRoot = path.join(realContainer, 'real-task');
  fs.mkdirSync(path.join(realTaskRoot, 'appdata'), { recursive: true });
  const junctionRoot = path.join(
    os.tmpdir(),
    `ai-drama-p9-05-portable-junction-${process.pid}-${Date.now()}`,
  );
  fs.symlinkSync(realTaskRoot, junctionRoot, 'junction');
  t.after(() => fs.rmSync(junctionRoot, { recursive: true, force: true }));
  assert.throws(
    () => resolvePackagingSmokeAppData({
      env: {
        LOCALMINIDRAMA_PACKAGING_SMOKE: '1',
        LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA: path.join(junctionRoot, 'appdata'),
      },
      defaultPath: 'C:\\Users\\fixture\\AppData\\Roaming',
    }),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );

  const { root, appDataRoot } = withPackagingSmokeTaskRoot(t, 'replace');
  const movedRoot = `${root}-moved`;
  t.after(() => fs.rmSync(movedRoot, { recursive: true, force: true }));
  let taskRootReads = 0;
  const fsWithReplacement = {
    ...fs,
    lstatSync(value, options) {
      if (path.resolve(value) === path.resolve(root) && taskRootReads++ === 1) {
        fs.renameSync(root, movedRoot);
        fs.mkdirSync(path.join(root, 'appdata'), { recursive: true });
      }
      return fs.lstatSync(value, options);
    },
  };
  assert.throws(
    () => resolvePackagingSmokeAppData({
      env: {
        LOCALMINIDRAMA_PACKAGING_SMOKE: '1',
        LOCALMINIDRAMA_PACKAGING_SMOKE_APPDATA: appDataRoot,
      },
      defaultPath: 'C:\\Users\\fixture\\AppData\\Roaming',
      fsImpl: fsWithReplacement,
    }),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
});

test('release verifier parses bounded 7-Zip listings and requires an explicit host-install flag', () => {
  assert.deepEqual(
    parseArchiveEntries('Path = artifact.exe\r\nPath = resources\\app.asar\r\n'),
    ['artifact.exe', 'resources\\app.asar'],
  );
  assert.equal(hasHostInstallerFlag([]), false);
  assert.equal(hasHostInstallerFlag(['--allow-host-installer']), true);
  assert.throws(
    () => hasHostInstallerFlag(['--unknown']),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
});

test('release verifier binds each final executable payload to the reviewed sidecar asar', async (t) => {
  const root = withTempDirectory(t);
  const cleanSource = path.join(root, 'clean-source');
  const poisonedSource = path.join(root, 'poisoned-source');
  const extractionRoot = path.join(root, 'extracted');
  const sidecarAsarPath = path.join(root, 'sidecar.asar');
  const extractedAsarPath = path.join(extractionRoot, 'resources', 'app.asar');
  const projectLicensePath = path.join(root, 'LICENSE');
  const thirdPartyNoticesPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
  const extractedLicensePath = path.join(extractionRoot, 'resources', 'licenses', 'LICENSE');
  const extractedNoticesPath = path.join(
    extractionRoot,
    'resources',
    'licenses',
    'THIRD_PARTY_NOTICES.md',
  );
  fs.mkdirSync(cleanSource, { recursive: true });
  fs.mkdirSync(poisonedSource, { recursive: true });
  fs.mkdirSync(path.dirname(extractedAsarPath), { recursive: true });
  fs.mkdirSync(path.dirname(extractedLicensePath), { recursive: true });
  fs.writeFileSync(path.join(cleanSource, 'main.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(poisonedSource, 'main.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(poisonedSource, 'model.onnx'), 'synthetic-model');
  fs.writeFileSync(projectLicensePath, 'synthetic-license\n');
  fs.writeFileSync(thirdPartyNoticesPath, 'synthetic-notices\n');
  fs.copyFileSync(projectLicensePath, extractedLicensePath);
  fs.copyFileSync(thirdPartyNoticesPath, extractedNoticesPath);
  await asar.createPackage(cleanSource, sidecarAsarPath);
  await asar.createPackage(poisonedSource, extractedAsarPath);

  assert.throws(
    () => assertExtractedExecutablePayload({
      extractionRoot,
      sidecarAsarPath,
      projectLicensePath,
      thirdPartyNoticesPath,
      assertAsarEntriesImpl() {},
    }),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );

  fs.copyFileSync(sidecarAsarPath, extractedAsarPath);
  assert.deepEqual(
    assertExtractedExecutablePayload({
      extractionRoot,
      sidecarAsarPath,
      projectLicensePath,
      thirdPartyNoticesPath,
      assertAsarEntriesImpl() {},
    }),
    {
      asarEntries: 1,
      asarSha256: require('node:crypto')
        .createHash('sha256')
        .update(fs.readFileSync(sidecarAsarPath))
        .digest('hex'),
    },
  );

  fs.writeFileSync(extractedNoticesPath, 'drifted-notices\n');
  assert.throws(
    () => assertExtractedExecutablePayload({
      extractionRoot,
      sidecarAsarPath,
      projectLicensePath,
      thirdPartyNoticesPath,
      assertAsarEntriesImpl() {},
    }),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
});

test('packaging removes only the optional ssh2 cpu-features native accelerator', (t) => {
  const root = withTempDirectory(t);
  const target = path.join(root, 'node_modules', 'cpu-features');
  const sibling = path.join(root, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(target, 'fixture.node'), 'synthetic');
  fs.writeFileSync(path.join(sibling, 'fixture.node'), 'keep');

  assert.deepEqual(pruneUnsupportedOptionalNative({ desktopRoot: root }), { removed: true });
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(sibling, 'fixture.node'), 'utf8'), 'keep');
  assert.deepEqual(pruneUnsupportedOptionalNative({ desktopRoot: root }), { removed: false });
});

test('release cleanup only removes a task-owned OS-temp root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-drama-p9-05-installer-'));
  fs.writeFileSync(path.join(root, 'synthetic.txt'), 'fixture');
  removeTaskRoot(root);
  assert.equal(fs.existsSync(root), false);
  assert.throws(
    () => removeTaskRoot(path.join(os.tmpdir(), 'unrelated-fixture')),
    (error) => error && error.code === WINDOWS_RELEASE_ERROR,
  );
});
