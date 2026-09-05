'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { types: { isProxy } } = require('node:util');

const Database = require('better-sqlite3');

const { runMigrationsAndEnsure } = require('../db/migrate');
const { registerV2SqlFunctions } = require('../db/v2/sqlFunctions');
const { createSourceDocumentService } = require('../narrative/sourceDocuments');
const { createV2Repositories } = require('../repositories/v2');
const dramaService = require('../services/dramaService');

const WORKSPACE_NAME = 'mvp-benchmark-rain-before-clear-v1';
const RECEIPT_FILE = 'mvp-benchmark-workspace.json';
const CONFIG_RELATIVE_PATH = 'configs/config.yaml';
const DATABASE_RELATIVE_PATH = 'data/drama_generator.db';
const STORAGE_RELATIVE_PATH = 'data/storage';
const SCHEMA_VERSION = 'mvp-benchmark-workspace-receipt.v1';
const STATUS = 'source-selected';
const ERROR_CODE = 'MVP_BENCHMARK_WORKSPACE_INVALID';
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class MvpBenchmarkWorkspaceError extends Error {
  constructor() {
    super('MVP benchmark workspace is invalid');
    this.name = 'MvpBenchmarkWorkspaceError';
    this.code = ERROR_CODE;
    Object.freeze(this);
  }
}

function fail() {
  throw new MvpBenchmarkWorkspaceError();
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactOptions(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    fail();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) fail();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!Object.hasOwn(descriptors, key)) fail();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  return output;
}

function sourcePack(value) {
  if (!value || typeof value !== 'object' || isProxy(value)
    || !value.manifest || typeof value.manifest !== 'object'
    || !Buffer.isBuffer(value.sourceBytes) || isProxy(value.sourceBytes)
    || !Buffer.isBuffer(value.licenseBytes) || isProxy(value.licenseBytes)
    || typeof value.selectedText !== 'string') fail();
  const manifest = value.manifest;
  if (manifest.schemaVersion !== 'mvp-benchmark-source.v1'
    || manifest.sourceId !== 'rain-before-clear-v1'
    || manifest.title !== '雨停之前'
    || manifest.sourceFile !== 'source.md'
    || manifest.sourceType !== 'markdown'
    || manifest.encoding !== 'utf-8'
    || !SHA256.test(manifest.contentSha256)
    || !SHA256.test(manifest.licenseSha256)
    || hash(value.sourceBytes) !== manifest.contentSha256
    || hash(value.licenseBytes) !== manifest.licenseSha256
    || !manifest.selection
    || !SHA256.test(manifest.selection.selectedTextSha256)
    || hash(Buffer.from(value.selectedText, 'utf8')) !== manifest.selection.selectedTextSha256
    || manifest.selection.targetNarrativeDurationSeconds !== 60) fail();
  return value;
}

function selectionCoordinates(blocks, selection) {
  let start = null;
  let end = null;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.charStart <= selection.startCodePoint
      && selection.startCodePoint < block.charEnd) start = block;
    if (block.charStart < selection.endCodePoint
      && selection.endCodePoint <= block.charEnd) end = block;
  }
  if (!start || !end) fail();
  return Object.freeze({
    startBlockUid: start.uid,
    endBlockUid: end.uid,
    startOffset: selection.startCodePoint - start.charStart,
    endOffset: selection.endCodePoint - end.charStart,
  });
}

function safeEpoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail();
  return value;
}

function metadataFor(pack, preparedAtEpochMs) {
  return Object.freeze({
    mvp_benchmark_workspace_schema_version: SCHEMA_VERSION,
    mvp_benchmark_source_id: pack.manifest.sourceId,
    mvp_benchmark_content_sha256: pack.manifest.contentSha256,
    mvp_benchmark_license_sha256: pack.manifest.licenseSha256,
    mvp_benchmark_selected_text_sha256: pack.manifest.selection.selectedTextSha256,
    mvp_benchmark_prepared_at_epoch_ms: preparedAtEpochMs,
    mvp_benchmark_preparation_status: STATUS,
  });
}

function parseMetadata(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || isProxy(parsed)) fail();
  return parsed;
}

function migrationVersion(database) {
  const row = database.prepare(`
    SELECT count(*) AS count,min(version) AS minimum,max(version) AS maximum
    FROM schema_migrations
  `).get();
  if (!row || !Number.isSafeInteger(row.count) || row.count < 1
    || row.minimum !== 1 || row.maximum !== row.count) fail();
  return row.maximum;
}

function inspectDatabase(database, pack, configSha256) {
  const rows = database.prepare(`
    SELECT id,uid,title,metadata FROM dramas
    WHERE deleted_at IS NULL
    ORDER BY id
  `).all();
  if (rows.length !== 1) fail();
  const drama = rows[0];
  const metadata = parseMetadata(drama.metadata);
  const expectedMetadata = metadataFor(pack, metadata.mvp_benchmark_prepared_at_epoch_ms);
  for (const [key, value] of Object.entries(expectedMetadata)) {
    if (metadata[key] !== value) fail();
  }
  if (!Number.isSafeInteger(drama.id) || drama.id < 1
    || typeof drama.uid !== 'string' || !UUID_V4.test(drama.uid)
    || drama.title !== `${pack.manifest.title} · MVP 基准项目`) fail();

  const repositories = createV2Repositories(database);
  const sourceService = createSourceDocumentService({ repositories });
  const documents = sourceService.listDocuments(drama.id);
  if (!Array.isArray(documents) || documents.length !== 1) fail();
  const reopened = sourceService.getDocument(documents[0].uid);
  if (reopened.document.dramaUid !== drama.uid
    || reopened.document.contentSha256 !== pack.manifest.contentSha256
    || reopened.document.originalName !== pack.manifest.sourceFile
    || reopened.document.sourceType !== pack.manifest.sourceType
    || reopened.document.encoding !== pack.manifest.encoding
    || reopened.selections.length !== 1
    || reopened.selections[0].selectedTextSha256
      !== pack.manifest.selection.selectedTextSha256) fail();
  const readiness = repositories.mvpBenchmarkReadiness.inspect();
  if (readiness.contractsReady !== true || readiness.readyConnection !== false) fail();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    workspaceName: WORKSPACE_NAME,
    status: STATUS,
    sourceId: pack.manifest.sourceId,
    contentSha256: pack.manifest.contentSha256,
    licenseSha256: pack.manifest.licenseSha256,
    selectedTextSha256: pack.manifest.selection.selectedTextSha256,
    targetNarrativeDurationSeconds: 60,
    dramaId: drama.id,
    dramaUid: drama.uid,
    sourceDocumentUid: reopened.document.uid,
    sourceSelectionUid: reopened.selections[0].uid,
    databaseMigrationVersion: migrationVersion(database),
    contractsReady: true,
    readyConnectionAtPreparation: false,
    configSha256,
    preparedAtEpochMs: safeEpoch(metadata.mvp_benchmark_prepared_at_epoch_ms),
  });
}

function prepareMvpBenchmarkDatabase(value) {
  const input = exactOptions(value, [
    'databasePath', 'sourcePack', 'configSha256', 'nowEpochMs', 'createUid',
  ]);
  if (typeof input.databasePath !== 'string' || !path.isAbsolute(input.databasePath)
    || typeof input.configSha256 !== 'string' || !SHA256.test(input.configSha256)
    || typeof input.nowEpochMs !== 'function' || typeof input.createUid !== 'function') fail();
  const pack = sourcePack(input.sourcePack);
  const preparedAtEpochMs = safeEpoch(input.nowEpochMs());
  let database;
  try {
    database = new Database(input.databasePath, { fileMustExist: true });
    database.pragma('journal_mode = WAL');
    runMigrationsAndEnsure(database);
    const prepare = database.transaction(() => {
      if (database.prepare('SELECT count(*) FROM dramas').pluck().get() !== 0) fail();
      const drama = dramaService.createDrama(database, Object.freeze({ info() {} }), {
        title: `${pack.manifest.title} · MVP 基准项目`,
        description: '仓库自有固定来源的隔离 MVP 基准项目；尚未生成或批准外部媒体。',
        genre: '悬疑漫剧',
        style: 'realistic',
        metadata: metadataFor(pack, preparedAtEpochMs),
      });
      if (!drama || !Number.isSafeInteger(drama.id)) fail();
      const service = createSourceDocumentService({
        repositories: createV2Repositories(database),
        createUid: input.createUid,
      });
      const imported = service.importDocument({
        dramaId: drama.id,
        fileName: pack.manifest.sourceFile,
        bytes: pack.sourceBytes,
        encoding: pack.manifest.encoding,
      });
      if (imported.status !== 'ready'
        || imported.document.contentSha256 !== pack.manifest.contentSha256) fail();
      const selected = service.createSelection({
        documentUid: imported.document.uid,
        ...selectionCoordinates(imported.blocks, pack.manifest.selection),
      });
      if (selected.selectedText !== pack.selectedText
        || selected.selection.selectedTextSha256
          !== pack.manifest.selection.selectedTextSha256) fail();
    });
    prepare.immediate();
    database.pragma('wal_checkpoint(TRUNCATE)');
    return inspectDatabase(database, pack, input.configSha256);
  } catch (error) {
    if (error instanceof MvpBenchmarkWorkspaceError) throw error;
    return fail();
  } finally {
    try { database?.close(); } catch {}
  }
}

function inspectMvpBenchmarkDatabase(value) {
  const input = exactOptions(value, ['databasePath', 'sourcePack', 'configSha256']);
  if (typeof input.databasePath !== 'string' || !path.isAbsolute(input.databasePath)
    || typeof input.configSha256 !== 'string' || !SHA256.test(input.configSha256)) fail();
  const pack = sourcePack(input.sourcePack);
  let database;
  try {
    database = new Database(input.databasePath, { readonly: true, fileMustExist: true });
    database.pragma('query_only = ON');
    registerV2SqlFunctions(database);
    if (database.pragma('integrity_check', { simple: true }) !== 'ok'
      || database.pragma('foreign_key_check').length !== 0) fail();
    return inspectDatabase(database, pack, input.configSha256);
  } catch (error) {
    if (error instanceof MvpBenchmarkWorkspaceError) throw error;
    return fail();
  } finally {
    try { database?.close(); } catch {}
  }
}

module.exports = Object.freeze({
  CONFIG_RELATIVE_PATH,
  DATABASE_RELATIVE_PATH,
  ERROR_CODE,
  MvpBenchmarkWorkspaceError,
  RECEIPT_FILE,
  SCHEMA_VERSION,
  STATUS,
  STORAGE_RELATIVE_PATH,
  WORKSPACE_NAME,
  inspectMvpBenchmarkDatabase,
  prepareMvpBenchmarkDatabase,
});
