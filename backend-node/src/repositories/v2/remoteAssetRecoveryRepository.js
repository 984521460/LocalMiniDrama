'use strict';

const { createHash } = require('node:crypto');

const {
  canonicalCharacterCandidateSource,
  characterCandidateSourceSha256,
  parseCharacterCandidateSourceJson,
} = require('../../characterCandidates/execution/source');
const {
  canonicalRemoteAssetRecoveryManifest,
  parseStoredRemoteAssetRecoveryManifestJson,
} = require('../../remoteAssets/recoveryManifest');
const {
  canonicalRemoteAssetRecoveryRequest,
  parseRemoteAssetRecoveryRequestJson,
  remoteAssetRecoveryRequestSha256,
} = require('../../remoteAssets/recoveryRequest');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { assertDatabase, executeWrite } = require('./repositorySupport');

const ENTITY = 'remote asset recovery';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STATES = new Set(['reserved', 'succeeded', 'failed', 'submission_unknown']);
const FAILURE_CODES = new Set([
  'REMOTE_ASSET_RECOVERY_SOURCE_STALE',
  'REMOTE_ASSET_RECOVERY_MANIFEST_INVALID',
  'REMOTE_ASSET_RECOVERY_OUTPUT_INVALID',
  'REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE',
]);

function dataError(reason) {
  throw new V2RepositoryDataError(ENTITY, reason);
}

function epoch(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) dataError('epoch');
  return value;
}

function createRemoteAssetRecoveryRepository(database) {
  assertDatabase(database);
  const select = database.prepare('SELECT * FROM remote_asset_recoveries WHERE operation_uid=?');
  const selectItems = database.prepare(`
    SELECT item.*,
      asset.owner_type AS live_owner_type, asset.owner_uid AS live_owner_uid,
      asset.asset_type AS live_asset_type, asset.status AS live_asset_status,
      asset.current_version_uid AS live_current_version_uid,
      version.asset_uid AS live_version_asset_uid,
      version.storage_provider AS live_storage_provider,
      version.logical_uri AS live_logical_uri, version.relative_path AS live_relative_path,
      version.sha256 AS live_sha256, version.mime_type AS live_mime_type,
      version.width AS live_width, version.height AS live_height,
      version.status AS live_version_status
    FROM remote_asset_recovery_items AS item
    LEFT JOIN assets AS asset ON asset.uid=item.asset_uid
    LEFT JOIN asset_versions AS version ON version.uid=item.asset_version_uid
    WHERE item.operation_uid=? ORDER BY item.ordinal
  `);
  const listRows = database.prepare(`
    SELECT operation_uid FROM remote_asset_recoveries
    WHERE drama_uid=? AND character_uid=?
    ORDER BY created_at_epoch_ms DESC, operation_uid DESC LIMIT 50
  `);
  const listReservedRows = database.prepare(`
    SELECT operation_uid FROM remote_asset_recoveries
    WHERE state='reserved' ORDER BY created_at_epoch_ms,operation_uid
  `);
  const insert = database.prepare(`
    INSERT INTO remote_asset_recoveries
      (operation_uid,drama_uid,character_uid,source_selection_uid,
       extraction_result_uid,extraction_result_hash,extraction_envelope_hash,
       extraction_review_uid,connection_uid,connection_evidence_sha256,remote_task_uid,
       request_json,request_sha256,source_json,source_sha256,state)
    VALUES
      (@operationUid,@dramaUid,@characterUid,@sourceSelectionUid,
       @extractionResultUid,@extractionResultHash,@extractionEnvelopeHash,
       @extractionReviewUid,@connectionUid,@connectionEvidenceSha256,@remoteTaskUid,
       @requestJson,@requestSha256,@sourceJson,@sourceSha256,'reserved')
  `);
  const insertItem = database.prepare(`
    INSERT INTO remote_asset_recovery_items
      (operation_uid,ordinal,remote_relative_path,remote_sha256,remote_byte_length,
       asset_uid,asset_version_uid,logical_uri,relative_path,content_sha256,
       byte_length,width,height)
    VALUES
      (@operationUid,@ordinal,@remoteRelativePath,@remoteSha256,@remoteByteLength,
       @assetUid,@assetVersionUid,@logicalUri,@relativePath,@contentSha256,
       @byteLength,@width,@height)
  `);
  const completeRow = database.prepare(`
    UPDATE remote_asset_recoveries
    SET state='succeeded', manifest_json=@manifestJson, manifest_sha256=@manifestSha256,
        item_count=@itemCount, updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=@operationUid AND state='reserved'
  `);
  const failRow = database.prepare(`
    UPDATE remote_asset_recoveries
    SET state='failed', error_code=@errorCode,
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=@operationUid AND state='reserved'
  `);
  const unknownRow = database.prepare(`
    UPDATE remote_asset_recoveries
    SET state='submission_unknown', error_code='REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN',
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=@operationUid AND state='reserved'
  `);
  const recoverRows = database.prepare(`
    UPDATE remote_asset_recoveries
    SET state='submission_unknown', error_code='REMOTE_ASSET_RECOVERY_SUBMISSION_UNKNOWN',
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE state='reserved'
  `);
  const retryTransferRow = database.prepare(`
    UPDATE remote_asset_recoveries
    SET state='reserved',error_code=NULL,updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='failed'
      AND error_code='REMOTE_ASSET_RECOVERY_REMOTE_UNAVAILABLE'
  `);

  function mapItems(recovery, manifest, rows) {
    if (recovery.state !== 'succeeded') {
      if (rows.length !== 0) dataError('terminal items');
      return Object.freeze([]);
    }
    if (!manifest || rows.length !== manifest.items.length || rows.length !== recovery.itemCount) {
      dataError('item count');
    }
    const items = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const expected = manifest.items[index];
      const expectedLogical = `asset://characters/${recovery.request.characterUid}/remote-recoveries/${recovery.operationUid}/${index}`;
      const expectedRelative = `characters/${recovery.request.characterUid}/remote-recoveries/${recovery.operationUid}/${index}.png`;
      if (row.operation_uid !== recovery.operationUid || row.ordinal !== index
        || row.remote_relative_path !== expected.remoteRelativePath
        || row.remote_sha256 !== expected.remoteSha256
        || !Number.isSafeInteger(row.remote_byte_length) || row.remote_byte_length < 1
        || row.remote_byte_length > 16 * 1024 * 1024
        || !UUID_V4.test(row.asset_uid) || !UUID_V4.test(row.asset_version_uid)
        || row.logical_uri !== expectedLogical || row.relative_path !== expectedRelative
        || typeof row.content_sha256 !== 'string' || !SHA256.test(row.content_sha256)
        || !Number.isSafeInteger(row.byte_length) || row.byte_length < 1
        || row.byte_length > 16 * 1024 * 1024
        || row.width !== expected.width || row.height !== expected.height
        || row.live_owner_type !== 'character' || row.live_owner_uid !== recovery.request.characterUid
        || row.live_asset_type !== 'remote_recovery' || row.live_asset_status !== 'draft'
        || row.live_current_version_uid !== null
        || row.live_version_asset_uid !== row.asset_uid || row.live_storage_provider !== 'local'
        || row.live_logical_uri !== expectedLogical || row.live_relative_path !== expectedRelative
        || row.live_sha256 !== row.content_sha256 || row.live_mime_type !== 'image/png'
        || row.live_width !== row.width || row.live_height !== row.height
        || row.live_version_status !== 'ready') {
        dataError('item binding');
      }
      items[index] = Object.freeze({
        ordinal: index,
        remoteRelativePath: row.remote_relative_path,
        remoteSha256: row.remote_sha256,
        remoteByteLength: row.remote_byte_length,
        assetUid: row.asset_uid,
        assetVersionUid: row.asset_version_uid,
        logicalUri: row.logical_uri,
        relativePath: row.relative_path,
        contentSha256: row.content_sha256,
        byteLength: row.byte_length,
        width: row.width,
        height: row.height,
        createdAtEpochMs: epoch(row.created_at_epoch_ms),
      });
    }
    return Object.freeze(items);
  }

  function map(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    let request;
    let source;
    let manifest = null;
    try {
      request = parseRemoteAssetRecoveryRequestJson(row.request_json);
      source = parseCharacterCandidateSourceJson(row.source_json);
      if (row.manifest_json !== null) manifest = parseStoredRemoteAssetRecoveryManifestJson(row.manifest_json);
    } catch {
      return dataError('contract');
    }
    if (request.operationUid !== row.operation_uid || request.dramaUid !== row.drama_uid
      || request.characterUid !== row.character_uid
      || request.extractionResultUid !== row.extraction_result_uid
      || request.connectionUid !== row.connection_uid
      || request.connectionEvidenceSha256 !== row.connection_evidence_sha256
      || request.remoteTaskUid !== row.remote_task_uid
      || source.dramaUid !== row.drama_uid || source.characterUid !== row.character_uid
      || source.sourceSelectionUid !== row.source_selection_uid
      || source.extractionResultUid !== row.extraction_result_uid
      || source.extractionResultHash !== row.extraction_result_hash
      || source.extractionEnvelopeHash !== row.extraction_envelope_hash
      || source.extractionApprovalRef !== `review:v1:${row.extraction_review_uid}`
      || source.characterFactId !== request.characterFactId
      || remoteAssetRecoveryRequestSha256(request) !== row.request_sha256
      || characterCandidateSourceSha256(source) !== row.source_sha256
      || !STATES.has(row.state)) dataError('binding');
    const manifestSha256 = row.manifest_json === null ? null
      : createHash('sha256').update(row.manifest_json, 'utf8').digest('hex');
    if ((row.state === 'succeeded'
      && (!manifest || manifest.remoteTaskUid !== request.remoteTaskUid
        || manifest.characterName !== source.characterName
        || manifestSha256 !== row.manifest_sha256
        || manifest.sourceManifestSha256 === null))
      || (row.state !== 'succeeded'
        && (manifest !== null || row.manifest_sha256 !== null || row.item_count !== null))) {
      dataError('manifest');
    }
    const recovery = {
      schemaVersion: 'remote-asset-recovery.v1',
      operationUid: row.operation_uid,
      requestSha256: row.request_sha256,
      request,
      sourceSha256: row.source_sha256,
      source,
      state: row.state,
      quarantineStatus: 'unapproved',
      manifestSha256: row.manifest_sha256,
      manifest,
      itemCount: row.item_count,
      errorCode: row.error_code,
      createdAtEpochMs: epoch(row.created_at_epoch_ms),
      updatedAtEpochMs: epoch(row.updated_at_epoch_ms),
    };
    recovery.items = mapItems(recovery, manifest, selectItems.all(row.operation_uid));
    return Object.freeze(recovery);
  }

  function get(operationUid) {
    if (typeof operationUid !== 'string' || !UUID_V4.test(operationUid)) {
      throw new TypeError('Remote asset recovery UID is invalid');
    }
    return map(select.get(operationUid));
  }

  return Object.freeze({
    complete(operationUid, manifest, items) {
      if (!Array.isArray(items) || items.length !== manifest?.items?.length) {
        throw new TypeError('Remote asset recovery completion is invalid');
      }
      const manifestJson = canonicalRemoteAssetRecoveryManifest(manifest);
      const manifestSha256 = createHash('sha256').update(manifestJson, 'utf8').digest('hex');
      executeWrite(ENTITY, 'completed', () => {
        for (let index = 0; index < items.length; index += 1) {
          insertItem.run({ operationUid, ...items[index] });
        }
        const result = completeRow.run({
          operationUid, manifestJson, manifestSha256, itemCount: items.length,
        });
        if (result.changes !== 1) throw new V2RepositoryConflictError(ENTITY, 'completed');
      });
      return get(operationUid);
    },

    fail(operationUid, errorCode) {
      if (!FAILURE_CODES.has(errorCode)) throw new TypeError('Remote asset recovery failure is invalid');
      executeWrite(ENTITY, 'failed', () => {
        if (failRow.run({ operationUid, errorCode }).changes !== 1) {
          throw new V2RepositoryConflictError(ENTITY, 'failed');
        }
      });
      return get(operationUid);
    },

    get,

    listByCharacter(dramaUid, characterUid) {
      if (!UUID_V4.test(dramaUid) || !UUID_V4.test(characterUid)) {
        throw new TypeError('Remote asset recovery history input is invalid');
      }
      return Object.freeze(listRows.all(dramaUid, characterUid).map((row) => get(row.operation_uid)));
    },

    listReserved() {
      return Object.freeze(listReservedRows.all().map((row) => get(row.operation_uid)));
    },

    markUnknown(operationUid) {
      executeWrite(ENTITY, 'marked unknown', () => {
        if (unknownRow.run({ operationUid }).changes !== 1) {
          throw new V2RepositoryConflictError(ENTITY, 'marked unknown');
        }
      });
      return get(operationUid);
    },

    recoverInterrupted() {
      return Object.freeze({ recoveredCount: recoverRows.run().changes });
    },

    retryTransfer(operationUid) {
      executeWrite(ENTITY, 'retried', () => {
        if (retryTransferRow.run(operationUid).changes !== 1) {
          throw new V2RepositoryConflictError(ENTITY, 'retried');
        }
      });
      return get(operationUid);
    },

    reserve({ request, requestSha256, source, sourceSha256 }) {
      const requestJson = canonicalRemoteAssetRecoveryRequest(request);
      const sourceJson = canonicalCharacterCandidateSource(source);
      if (remoteAssetRecoveryRequestSha256(request) !== requestSha256
        || characterCandidateSourceSha256(source) !== sourceSha256) {
        throw new TypeError('Remote asset recovery reservation is invalid');
      }
      const existing = select.get(request.operationUid);
      if (existing) {
        if (existing.request_sha256 !== requestSha256) {
          throw new V2RepositoryConflictError(ENTITY, 'reserved');
        }
        return Object.freeze({ created: false, recovery: map(existing) });
      }
      executeWrite(ENTITY, 'reserved', () => insert.run({
        operationUid: request.operationUid,
        dramaUid: request.dramaUid,
        characterUid: request.characterUid,
        sourceSelectionUid: source.sourceSelectionUid,
        extractionResultUid: source.extractionResultUid,
        extractionResultHash: source.extractionResultHash,
        extractionEnvelopeHash: source.extractionEnvelopeHash,
        extractionReviewUid: source.extractionApprovalRef.slice('review:v1:'.length),
        connectionUid: request.connectionUid,
        connectionEvidenceSha256: request.connectionEvidenceSha256,
        remoteTaskUid: request.remoteTaskUid,
        requestJson,
        requestSha256,
        sourceJson,
        sourceSha256,
      }));
      return Object.freeze({ created: true, recovery: get(request.operationUid) });
    },
  });
}

module.exports = Object.freeze({ createRemoteAssetRecoveryRepository });
