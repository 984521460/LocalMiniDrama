const fs = require('fs');
const path = require('path');
const { copyTreeSync } = require('./lib/copy-tree');

const repoRoot = path.join(__dirname, '..', '..');
const src = path.join(repoRoot, 'frontweb', 'dist');
const dest = path.join(__dirname, '..', 'frontweb-dist');

if (!fs.existsSync(src)) {
  console.error('frontweb/dist not found. Run: cd frontweb && npm run build');
  process.exit(1);
}
if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true });
copyTreeSync(src, dest);
console.log('Copied frontweb/dist -> desktop/frontweb-dist');
