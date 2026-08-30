'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const identity = require('../product-identity');

const desktopRoot = path.join(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(desktopRoot, relativePath), 'utf8'));
}

test('desktop package metadata uses the approved product identity', () => {
  const packageJson = readJson('package.json');

  assert.equal(identity.PRODUCT_NAME, 'AI漫剧工作台');
  assert.equal(identity.APP_ID, 'com.localminidrama.desktop');
  assert.equal(identity.USER_DATA_DIRECTORY, 'localminidrama-desktop');
  assert.equal(packageJson.build.productName, identity.PRODUCT_NAME);
  assert.equal(packageJson.build.appId, identity.APP_ID);
  assert.match(packageJson.build.artifactName, /^AI漫剧工作台/);
  assert.match(packageJson.build.nsis.artifactName, /^AI漫剧工作台 Setup/);
  assert.notEqual(packageJson.build.nsis.artifactName, packageJson.build.artifactName);
  assert.deepEqual(packageJson.build.win.target, ['nsis', 'portable']);
  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.equal(packageJson.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(packageJson.build.nsis.allowElevation, false);
  assert.equal(packageJson.build.nsis.runAfterFinish, false);
  assert.equal(packageJson.build.publish, undefined);
  assert.ok(packageJson.build.files.includes('product-identity.js'));
  assert.ok(packageJson.build.files.includes('startup-error.js'));
  assert.ok(packageJson.build.files.includes('user-data-path.js'));
  assert.ok(packageJson.build.files.includes('windows-release-contract.js'));
  assert.equal(packageJson.scripts['verify:windows-release'], 'node scripts/verify-windows-release.js');
});

test('alternate builder configs keep the same product name and app id', () => {
  for (const fileName of [
    'electron-builder-lite.json',
    'electron-builder-mac.json',
    'electron-builder-mac-lite.json',
  ]) {
    const config = readJson(fileName);
    assert.equal(config.productName, identity.PRODUCT_NAME, fileName);
    assert.equal(config.appId, identity.APP_ID, fileName);
    assert.ok(config.files.includes('product-identity.js'), fileName);
    assert.ok(config.files.includes('startup-error.js'), fileName);
    assert.ok(config.files.includes('user-data-path.js'), fileName);
    assert.ok(config.files.includes('windows-release-contract.js'), fileName);
  }
});

test('runtime and cleanup scripts consume the shared product identity module', () => {
  const mainSource = fs.readFileSync(path.join(desktopRoot, 'main.js'), 'utf8');
  const cleanupSource = fs.readFileSync(
    path.join(desktopRoot, 'scripts', 'clean-win-unpacked.js'),
    'utf8',
  );

  assert.match(mainSource, /require\('\.\/product-identity'\)/);
  assert.match(mainSource, /require\('\.\/user-data-path'\)/);
  assert.match(mainSource, /resolveUserDataPath/);
  assert.match(cleanupSource, /require\('\.\.\/product-identity'\)/);
  assert.match(cleanupSource, /PRODUCT_NAME/);
});

test('packaging instructions use the approved product name', () => {
  const windowsSource = fs.readFileSync(
    path.join(desktopRoot, 'scripts', 'dist-cn.js'),
    'utf8',
  );
  const macSource = fs.readFileSync(path.join(desktopRoot, 'dist-mac.sh'), 'utf8');

  assert.match(windowsSource, /require\('\.\.\/product-identity'\)/);
  assert.match(windowsSource, /PRODUCT_NAME/);
  assert.doesNotMatch(macSource, /LocalMiniDrama-[^\n]*\.dmg/);
  assert.match(macSource, /AI漫剧工作台-[^\n]*\.dmg/);
});
