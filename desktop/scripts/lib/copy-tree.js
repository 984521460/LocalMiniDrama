'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function copyEntrySync(source, destination) {
  const stat = fs.lstatSync(source);

  if (stat.isSymbolicLink()) {
    throw new Error(`symbolic links are not supported: ${source}`);
  }

  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyEntrySync(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }

  if (!stat.isFile()) {
    throw new Error(`unsupported filesystem entry: ${source}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyTreeSync(source, destination) {
  const sourceRoot = path.resolve(source);
  const destinationRoot = path.resolve(destination);

  if (isPathInside(sourceRoot, destinationRoot)) {
    throw new Error('copyTreeSync destination must be outside source');
  }
  if (isPathInside(destinationRoot, sourceRoot)) {
    throw new Error('copyTreeSync source must be outside destination');
  }

  copyEntrySync(sourceRoot, destinationRoot);
}

module.exports = { copyTreeSync };
