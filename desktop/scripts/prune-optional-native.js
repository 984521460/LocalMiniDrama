'use strict';

const fs = require('node:fs');
const path = require('node:path');

function pruneUnsupportedOptionalNative({ desktopRoot = path.join(__dirname, '..'), fsImpl = fs } = {}) {
  const root = path.resolve(desktopRoot);
  const target = path.resolve(root, 'node_modules', 'cpu-features');
  const expectedParent = path.resolve(root, 'node_modules');
  if (path.dirname(target) !== expectedParent || path.basename(target) !== 'cpu-features') {
    throw new TypeError('optional native dependency path invalid');
  }
  if (!fsImpl.existsSync(target)) return Object.freeze({ removed: false });
  fsImpl.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  if (fsImpl.existsSync(target)) throw new Error('optional native dependency cleanup failed');
  return Object.freeze({ removed: true });
}

if (require.main === module) {
  const result = pruneUnsupportedOptionalNative();
  process.stdout.write(`[packaging] optional cpu-features removed=${result.removed}\n`);
}

module.exports = Object.freeze({ pruneUnsupportedOptionalNative });
