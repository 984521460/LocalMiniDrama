const { types } = require('node:util');

const { archiveError } = require('./errors');

const ARCHIVE_V20 = '2.0.0';
const ARCHIVE_V21 = '2.1.0';

function invalidManifest() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function schemaVersionDescriptor(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) {
    invalidManifest();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidManifest();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
    invalidManifest();
  }
  return descriptor.value;
}

function createArchiveVersionRouter(parsers) {
  if (parsers === null || typeof parsers !== 'object' || types.isProxy(parsers) || Array.isArray(parsers)) {
    throw new TypeError('Project archive parsers are invalid');
  }
  const registered = new Map();
  for (const version of [ARCHIVE_V20, ARCHIVE_V21]) {
    const descriptor = Object.getOwnPropertyDescriptor(parsers, version);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw new TypeError('Project archive parser is invalid');
    }
    registered.set(version, descriptor.value);
  }
  const unexpected = Reflect.ownKeys(parsers).filter((key) => ![ARCHIVE_V20, ARCHIVE_V21].includes(key));
  if (unexpected.length > 0) throw new TypeError('Project archive parser version is unsupported');

  return Object.freeze({
    parse(manifestData) {
      if (manifestData === null) {
        return Object.freeze({ kind: 'legacy-v1', manifest: null, schemaVersion: null });
      }
      const schemaVersion = schemaVersionDescriptor(manifestData);
      const parser = registered.get(schemaVersion);
      if (!parser) invalidManifest();
      return Object.freeze({
        kind: 'manifest',
        manifest: parser(manifestData),
        schemaVersion,
      });
    },
    supports(schemaVersion) {
      return typeof schemaVersion === 'string' && registered.has(schemaVersion);
    },
  });
}

module.exports = {
  ARCHIVE_V20,
  ARCHIVE_V21,
  createArchiveVersionRouter,
};
