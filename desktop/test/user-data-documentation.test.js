'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  LEGACY_USER_DATA_DIRECTORIES,
  USER_DATA_DIRECTORY,
} = require('../product-identity');
const {
  GENERIC_CODE,
  MIGRATION_BACKUP_CODE,
  MIGRATION_BACKUP_MESSAGE,
  formatStartupError,
} = require('../startup-error');

const repositoryRoot = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

test('user-data guide is bound to the production identity and persistent paths', () => {
  const guide = read('docs/user-data-backup-and-migration.md');
  const stableRoot = `%APPDATA%\\${USER_DATA_DIRECTORY}`;

  assert.match(guide, new RegExp(stableRoot.replaceAll('\\', '\\\\')));
  for (const legacyDirectory of LEGACY_USER_DATA_DIRECTORIES) {
    assert.match(guide, new RegExp(`%APPDATA%\\\\${legacyDirectory}`));
  }

  for (const requiredPath of [
    'backend\\data\\drama_generator.db',
    'backend\\data\\storage',
    'backend\\configs\\config.yaml',
    'backend\\data\\drama_generator.db.pre-v2.sqlite',
    'backend\\data\\drama_generator.db.pre-v2.manifest.json',
  ]) {
    assert.ok(guide.includes(requiredPath), `missing documented path: ${requiredPath}`);
  }

  assert.match(guide, /完全退出/);
  assert.match(guide, /SQLite 使用 WAL/);
  assert.match(guide, /不要把两棵目录直接合并/);
  assert.match(guide, /Windows Credential Manager/);
  assert.match(guide, /credential:v1:<UUID>/);
  assert.match(guide, /旧版 AI 服务 API Key.*SQLite 数据库/);
  assert.match(guide, /不能替代.*完整外部备份/);
});

test('public entry documents use the stable path and link the authoritative guide', () => {
  const stableConfig = `%APPDATA%\\${USER_DATA_DIRECTORY}\\backend\\configs\\config.yaml`;
  const guideLink = 'docs/user-data-backup-and-migration.md';
  const documents = {
    'README.md': read('README.md'),
    'docs/en.md': read('docs/en.md'),
    'docs/quickstart.md': read('docs/quickstart.md'),
    'desktop/README.md': read('desktop/README.md'),
  };

  assert.ok(documents['README.md'].includes(stableConfig));
  assert.ok(documents['README.md'].includes(guideLink));
  assert.ok(documents['docs/en.md'].includes(stableConfig));
  assert.ok(documents['docs/quickstart.md'].includes(`%APPDATA%\\${USER_DATA_DIRECTORY}\\`));
  assert.ok(documents['docs/quickstart.md'].includes('user-data-backup-and-migration.md'));
  assert.ok(documents['desktop/README.md'].includes('../docs/user-data-backup-and-migration.md'));

  assert.doesNotMatch(documents['README.md'], /%APPDATA%\\LocalMiniDrama\\backend\\configs\\config\.yaml/);
  assert.doesNotMatch(documents['docs/en.md'], /%APPDATA%\\LocalMiniDrama\\backend\\configs\\config\.yaml/);
  assert.doesNotMatch(documents['docs/quickstart.md'], /%APPDATA%\\LocalMiniDrama\\backend\\(?:configs|data)\\/);
});

test('documented database and storage paths match the bundled backend config and migration backup implementation', () => {
  const config = read('backend-node/configs/config.yaml');
  const backupImplementation = read('backend-node/src/db/v2/migrationBackup.js');

  assert.match(config, /^\s*path: \.\/data\/drama_generator\.db\s*$/m);
  assert.match(config, /^\s*local_path: \.\/data\/storage\s*$/m);
  assert.match(backupImplementation, /`\$\{resolved\}\.pre-v2\.sqlite`/);
  assert.match(backupImplementation, /`\$\{resolved\}\.pre-v2\.manifest\.json`/);
});

test('migration backup guidance is reachable through the fixed production startup error surface', () => {
  const guide = read('docs/user-data-backup-and-migration.md');
  const mainSource = read('desktop/main.js');
  const sentinel = 'C:\\private\\synthetic-secret-stack';
  const migrationFailure = Object.assign(new Error(sentinel), {
    code: MIGRATION_BACKUP_CODE,
    stack: `Error: ${sentinel}`,
  });
  const formatted = formatStartupError(migrationFailure);

  assert.equal(formatted.code, MIGRATION_BACKUP_CODE);
  assert.equal(formatted.message, MIGRATION_BACKUP_MESSAGE);
  assert.ok(guide.includes(formatted.code));
  assert.doesNotMatch(formatted.text, /synthetic-secret-stack|C:\\private/);
  assert.match(mainSource, /formatStartupError\(err\)/);
  assert.match(mainSource, /safeError\.text/);
  assert.doesNotMatch(mainSource, /`后端服务未能启动，请查看日志：\\n\$\{MAIN_STARTUP_LOG\}/);

  let getterReads = 0;
  const accessorError = {};
  Object.defineProperty(accessorError, 'code', {
    get() {
      getterReads += 1;
      return MIGRATION_BACKUP_CODE;
    },
  });
  assert.equal(formatStartupError(accessorError).code, GENERIC_CODE);
  assert.equal(getterReads, 0);

  let proxyReads = 0;
  const proxyError = new Proxy({}, {
    getOwnPropertyDescriptor() {
      proxyReads += 1;
      return { configurable: true, enumerable: true, value: MIGRATION_BACKUP_CODE };
    },
  });
  assert.equal(formatStartupError(proxyError).code, GENERIC_CODE);
  assert.equal(proxyReads, 0);
});
