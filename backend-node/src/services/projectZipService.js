const AdmZip = require('adm-zip');

const legacyExportService = require('./dramaExportService');
const legacyImportService = require('./dramaImportService');
const { readProjectArchive } = require('../adapters/v2/zip/archiveReader');
const {
  assertNoCredentialData,
  assertNoLocalPathData,
  createProjectManifest,
  parseProjectManifest,
} = require('../adapters/v2/zip/manifest');
const {
  archiveError,
  isProjectArchiveError,
} = require('../adapters/v2/zip/errors');
const { createV2Repositories } = require('../repositories/v2');
const {
  assertProjectArchiveSourceEvidence,
  projectArchiveRecordsForManifest,
} = require('./projectArchiveSourceEvidence');
const { createProjectImportMediaStaging } = require('./projectImportMediaStaging');
const path = require('node:path');

const quietLog = Object.freeze({ info() {}, error() {} });

function getStoragePath(config) {
  const raw = config?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function exportDrama(database, config, log, dramaId) {
  try {
    const legacy = legacyExportService.exportDrama(database, config, quietLog, dramaId);
    const parsed = readProjectArchive(legacy.buffer);
    assertNoCredentialData(parsed.legacyProject);
    assertNoLocalPathData(parsed.legacyProject, [getStoragePath(config)]);
    const repositories = createV2Repositories(database);
    const snapshot = repositories.projectArchives.exportSnapshot(Number(dramaId));
    if (!snapshot) throw archiveError('PROJECT_ARCHIVE_INVALID');
    assertProjectArchiveSourceEvidence(snapshot.records);
    const manifest = createProjectManifest({
      exportedAt: new Date().toISOString(),
      legacyProjectVersion: parsed.legacyProject.version,
      project: snapshot.project,
      records: projectArchiveRecordsForManifest(snapshot.records),
    });

    const zip = new AdmZip(legacy.buffer);
    zip.addFile('v2/manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
    const buffer = zip.toBuffer();
    log?.info?.('Drama exported', { drama_id: Number(dramaId), title: legacy.title, archive_version: '2.0.0' });
    return { buffer, title: legacy.title };
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
}

function importDrama(database, config, log, zipBuffer) {
  try {
    const parsedArchive = readProjectArchive(zipBuffer);
    assertNoCredentialData(parsedArchive.legacyProject);
    const storagePath = getStoragePath(config);
    assertNoLocalPathData(parsedArchive.legacyProject, [storagePath]);
    if (parsedArchive.manifestData === null) {
      const mediaWriter = createProjectImportMediaStaging(storagePath);
      return legacyImportService.importDrama(database, config, log, zipBuffer, {
        parsedArchive,
        mediaWriter,
        immediate: true,
      });
    }

    const manifest = parseProjectManifest(parsedArchive.manifestData);
    assertProjectArchiveSourceEvidence(manifest.records);
    const mediaWriter = createProjectImportMediaStaging(storagePath);
    const repositories = createV2Repositories(database);
    return legacyImportService.importDrama(database, config, log, zipBuffer, {
      parsedArchive,
      beforeImport() {
        if (repositories.projectArchives.hasUidConflict(manifest)) {
          throw archiveError('PROJECT_ARCHIVE_UID_CONFLICT');
        }
      },
      afterImport({ result }) {
        repositories.projectArchives.importSnapshot(result.drama_id, manifest);
      },
      archiveVersion: '2.0.0',
      mediaWriter,
      immediate: true,
    });
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
  }
}

module.exports = { exportDrama, importDrama };
