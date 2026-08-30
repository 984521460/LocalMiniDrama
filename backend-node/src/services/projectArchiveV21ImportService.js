'use strict';

const { types } = require('node:util');

const {
  validateProjectArchiveV21Bundle,
} = require('../adapters/v2/zip/manifestV21');
const { archiveError, isProjectArchiveError } = require('../adapters/v2/zip/errors');
const {
  createProjectArchiveV21ImportRepository,
} = require('../repositories/v2/projectArchiveV21ImportRepository');
const { createProjectImportMediaStaging } = require('./projectImportMediaStaging');

const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;

function invalid() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function createProjectArchiveV21ImportService({
  repositoryFactory = createProjectArchiveV21ImportRepository,
  mediaStagingFactory = createProjectImportMediaStaging,
} = {}) {
  if (typeof repositoryFactory !== 'function' || typeof mediaStagingFactory !== 'function') {
    throw new TypeError('Project archive import dependencies are invalid');
  }

  return Object.freeze({
    importBundle({ database, storageRoot, manifest, files } = {}) {
      let parsed;
      try {
        parsed = validateProjectArchiveV21Bundle({ manifest, files });
      } catch (error) {
        if (isProjectArchiveError(error)) throw error;
        return invalid();
      }
      if (!database || typeof database.transaction !== 'function'
        || typeof database.prepare !== 'function' || typeof storageRoot !== 'string'
        || storageRoot.length === 0 || types.isProxy(files)) invalid();

      let media;
      try {
        const repository = repositoryFactory(database);
        if (!repository || typeof repository.assertImportable !== 'function'
          || typeof repository.importManifest !== 'function'
          || typeof repository.assertCommitReady !== 'function') invalid();
        repository.assertImportable(parsed);
        media = mediaStagingFactory(storageRoot);
        if (!media || typeof media.writeExact !== 'function'
          || typeof media.promote !== 'function' || typeof media.assertCommitReady !== 'function'
          || typeof media.rollback !== 'function' || typeof media.complete !== 'function') invalid();
        const versions = new Map();
        for (let index = 0; index < parsed.records.assetVersions.length; index += 1) {
          const version = parsed.records.assetVersions[index];
          Reflect.apply(MAP_SET, versions, [version.uid, version]);
        }
        for (let index = 0; index < parsed.mediaBindings.length; index += 1) {
          const binding = parsed.mediaBindings[index];
          if (binding.binding_state !== 'content_addressed') continue;
          const version = Reflect.apply(MAP_GET, versions, [binding.asset_version_uid]);
          const buffer = Reflect.apply(MAP_GET, files, [binding.archive_path]);
          if (!version || !Buffer.isBuffer(buffer)) invalid();
          media.writeExact({
            relativePath: version.relative_path,
            archivePath: binding.archive_path,
            buffer,
            expectedSha256: binding.sha256,
            expectedBytes: binding.byte_length,
          });
        }

        const run = database.transaction(() => {
          repository.importManifest(parsed);
          media.promote();
          repository.assertCommitReady(parsed);
          media.assertCommitReady();
        });
        run.immediate();
        media.complete();
        return Object.freeze({ dramaUid: parsed.project.dramaUid });
      } catch (error) {
        try { media?.rollback(); } catch {}
        if (isProjectArchiveError(error)) throw error;
        return invalid();
      }
    },
  });
}

module.exports = { createProjectArchiveV21ImportService };
