const fs = require('fs');
const path = require('path');
const { copyTreeSync } = require('./lib/copy-tree');

const repoRoot = path.join(__dirname, '..', '..');
const src = path.join(repoRoot, 'backend-node');
const dest = path.join(__dirname, '..', 'backend-app');
const schemaSource = path.join(repoRoot, 'schemas');
const schemaDestination = path.join(__dirname, '..', 'schemas');

const dirsToCopy = ['src', 'configs', 'scripts', 'migrations'];

if (!fs.existsSync(src)) {
  console.error('backend-node not found at', src);
  process.exit(1);
}

if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
fs.mkdirSync(dest, { recursive: true });

for (const dir of dirsToCopy) {
  const from = path.join(src, dir);
  const to = path.join(dest, dir);
  if (fs.existsSync(from)) {
    copyTreeSync(from, to);
  }
}

if (!fs.existsSync(schemaSource)) {
  console.error('schemas not found at', schemaSource);
  process.exit(1);
}
if (fs.existsSync(schemaDestination)) fs.rmSync(schemaDestination, { recursive: true });
copyTreeSync(schemaSource, schemaDestination);

// 合并 desktop 自带的初始迁移（保证 01_init、02_add_default_model 等存在）
const migrationsDest = path.join(dest, 'migrations');
const initialMigrations = path.join(__dirname, 'initial-migrations');
if (!fs.existsSync(migrationsDest)) fs.mkdirSync(migrationsDest, { recursive: true });
if (fs.existsSync(initialMigrations)) {
  for (const f of fs.readdirSync(initialMigrations)) {
    if (f.endsWith('.sql')) {
      fs.copyFileSync(path.join(initialMigrations, f), path.join(migrationsDest, f));
    }
  }
  console.log('Merged initial-migrations -> desktop/backend-app/migrations');
}

console.log('Copied backend-node and schemas -> desktop packaging workspace');
