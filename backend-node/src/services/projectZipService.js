const AdmZip = require('adm-zip');

const legacyExportService = require('./dramaExportService');
const legacyImportService = require('./dramaImportService');
const { readProjectArchive } = require('../adapters/v2/zip/archiveReader');
const {
  ARCHIVE_V20,
  ARCHIVE_V21,
  createArchiveVersionRouter,
} = require('../adapters/v2/zip/archiveVersionRouter');
const {
  assertNoCredentialData,
  assertNoLocalPathData,
  createProjectManifest,
  parseProjectManifest,
  RECORD_SPECS,
} = require('../adapters/v2/zip/manifest');
const {
  PROJECT_ARCHIVE_CATALOG,
  validateProjectArchiveCatalog,
} = require('../adapters/v2/zip/projectArchiveCatalog');
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
const { parseProjectManifestV21 } = require('../adapters/v2/zip/manifestV21');
const {
  createProjectArchiveV21ExportService,
} = require('./projectArchiveV21ExportService');
const {
  createProjectArchiveV21ImportService,
} = require('./projectArchiveV21ImportService');
const path = require('node:path');

const quietLog = Object.freeze({ info() {}, error() {} });
validateProjectArchiveCatalog(PROJECT_ARCHIVE_CATALOG, RECORD_SPECS);
const archiveVersionRouter = createArchiveVersionRouter({
  [ARCHIVE_V20]: parseProjectManifest,
  [ARCHIVE_V21]: parseProjectManifestV21,
});

function getStoragePath(config) {
  const raw = config?.storage?.local_path || './data/storage';
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

function exportDramaV20(database, config, log, dramaId) {
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
    log?.info?.('Drama exported', { drama_id: Number(dramaId), title: legacy.title, archive_version: ARCHIVE_V20 });
    return { buffer, title: legacy.title };
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    throw archiveError('PROJECT_ARCHIVE_INVALID');
  }
}

function exportDrama(database, config, log, dramaId) {
  try {
    const result = createProjectArchiveV21ExportService().exportDrama({
      database,
      storageRoot: getStoragePath(config),
      dramaId,
    });
    log?.info?.('Drama exported', {
      drama_id: Number(dramaId),
      title: result.title,
      archive_version: ARCHIVE_V21,
    });
    return { buffer: result.buffer, title: result.title };
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
    const archiveRoute = archiveVersionRouter.parse(parsedArchive.manifestData);
    if (archiveRoute.kind === 'legacy-v1') {
      const mediaWriter = createProjectImportMediaStaging(storagePath);
      return legacyImportService.importDrama(database, config, log, zipBuffer, {
        parsedArchive,
        mediaWriter,
        immediate: true,
      });
    }

    const manifest = archiveRoute.manifest;
    if (archiveRoute.schemaVersion === ARCHIVE_V21) {
      const drama = manifest.legacyRecords.dramas[0];
      createProjectArchiveV21ImportService().importBundle({
        database,
        storageRoot: storagePath,
        manifest,
        files: parsedArchive.files,
      });
      try {
        log?.info?.('Drama imported', {
          drama_id: drama.id,
          title: drama.title,
          archive_version: ARCHIVE_V21,
        });
      } catch {}
      return { drama_id: drama.id, title: drama.title };
    }
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
      archiveVersion: archiveRoute.schemaVersion,
      mediaWriter,
      immediate: true,
    });
  } catch (error) {
    if (isProjectArchiveError(error)) throw error;
    throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
  }
}

module.exports = { exportDrama, exportDramaV20, importDrama };
