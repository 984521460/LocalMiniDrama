'use strict';

const AdmZip = require('adm-zip');

const { createProjectArchiveV21LegacyData } = require(
  '../adapters/v2/compat/projectArchiveV21LegacyData',
);
const {
  createProjectArchiveV21MediaCollector,
} = require('../adapters/v2/zip/projectArchiveV21MediaClosure');
const {
  createProjectArchiveV21PortableSnapshot,
} = require('../adapters/v2/zip/projectArchiveV21PortableSnapshot');
const {
  createProjectManifestV21,
  validateProjectArchiveV21Bundle,
} = require('../adapters/v2/zip/manifestV21');
const { archiveError, isProjectArchiveError } = require('../adapters/v2/zip/errors');
const { createV2Repositories } = require('../repositories/v2');
const { projectArchiveRecordsForManifest } = require('./projectArchiveSourceEvidence');
const { EXPORT_VERSION: LEGACY_PROJECT_VERSION } = require('./dramaExportService');

const DRAMA_ID = /^[1-9][0-9]*$/u;

function invalid() {
  throw archiveError('PROJECT_ARCHIVE_INVALID');
}

function filesFromEntries(entries) {
  const files = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    files.set(entries[index].archivePath, entries[index].buffer);
  }
  return files;
}

function projectDramaId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : invalid();
  }
  if (typeof value !== 'string' || !DRAMA_ID.test(value)) return invalid();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : invalid();
}

function createProjectArchiveV21ExportService({ now = () => new Date() } = {}) {
  if (typeof now !== 'function') throw new TypeError('Project archive export clock is invalid');

  return Object.freeze({
    exportDrama({ database, storageRoot, dramaId } = {}) {
      try {
        if (!database || typeof database.prepare !== 'function'
          || typeof storageRoot !== 'string' || storageRoot.length === 0) invalid();
        const id = projectDramaId(dramaId);
        const drama = database.prepare(`
          SELECT id,uid,title FROM dramas WHERE id=? AND deleted_at IS NULL
        `).get(id);
        if (!drama || typeof drama.uid !== 'string' || typeof drama.title !== 'string'
          || drama.title.trim().length === 0) invalid();
        const exportedAt = now().toISOString();
        const repositories = createV2Repositories(database);
        const snapshot = repositories.projectArchives.exportSnapshot(id);
        if (!snapshot || snapshot.project.dramaUid !== drama.uid) invalid();
        const structuredRecords = repositories.projectArchives.exportStructuredV21(drama.uid);
        const legacyRecords = createProjectArchiveV21LegacyData(database).exportForDrama(drama.uid);
        const portable = createProjectArchiveV21PortableSnapshot(database).project({
          dramaUid: drama.uid,
          records: projectArchiveRecordsForManifest(snapshot.records),
          structuredRecords,
        });
        const media = createProjectArchiveV21MediaCollector(storageRoot)
          .collect(portable.records.assetVersions);
        const manifest = createProjectManifestV21({
          legacyProjectVersion: LEGACY_PROJECT_VERSION,
          exportedAt,
          project: snapshot.project,
          records: portable.records,
          structuredRecords,
          legacyRecords,
          mediaBindings: media.bindings,
          portableBindings: portable.portableBindings,
        });
        const mediaEntries = media.archiveEntries();
        validateProjectArchiveV21Bundle({ manifest, files: filesFromEntries(mediaEntries) });

        const compatibilityProject = Object.freeze({
          version: LEGACY_PROJECT_VERSION,
          exported_at: exportedAt,
          drama: Object.freeze({ title: drama.title }),
        });
        const zip = new AdmZip();
        zip.addFile('project.json', Buffer.from(JSON.stringify(compatibilityProject, null, 2), 'utf8'));
        zip.addFile('v2/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
        for (let index = 0; index < mediaEntries.length; index += 1) {
          zip.addFile(mediaEntries[index].archivePath, mediaEntries[index].buffer);
        }
        return Object.freeze({ buffer: zip.toBuffer(), manifest, title: drama.title });
      } catch (error) {
        if (isProjectArchiveError(error)) throw error;
        return invalid();
      }
    },
  });
}

module.exports = Object.freeze({ createProjectArchiveV21ExportService });
