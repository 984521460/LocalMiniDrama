const { createCoreReferenceAdapter } = require('./coreReferenceAdapter');
const {
  V2CompatibilityError,
} = require('./errors');
const { createLegacyPathAdapter } = require('./legacyPathAdapter');
const { readExactDataObject } = require('./safeInput');

function createV2CompatibilityAdapter(value) {
  const input = readExactDataObject(value, ['database', 'projectRoot']);
  const coreReferences = createCoreReferenceAdapter(input.database);
  const legacyPaths = createLegacyPathAdapter(input.projectRoot);
  return Object.freeze({
    resolveCoreReference: coreReferences.resolveCoreReference,
    mapLegacyAbsolutePath: legacyPaths.mapLegacyAbsolutePath,
  });
}

module.exports = {
  V2CompatibilityError,
  createV2CompatibilityAdapter,
};
