'use strict';

const path = require('node:path');

const addonPath = process.argv[2];
if (typeof addonPath !== 'string' || addonPath.length === 0) process.exit(2);
let addon;
try {
  addon = require(path.resolve(addonPath));
} catch (_) {
  process.exit(31);
}
const valid = typeof addon.acquireDirectoryLease === 'function'
  && typeof addon.appendBoundedLog === 'function'
  && typeof addon.releaseDirectoryLease === 'function';
process.stdout.write(JSON.stringify({
  electron: process.versions.electron,
  napi: process.versions.napi,
  valid,
}));
process.exit(valid ? 23 : 24);
