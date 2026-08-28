const {
  createCharacterCandidateBatch,
  isCharacterCandidateBatch,
} = require('../../assets/characterCandidateBatch');
const { createVersionValidation } = require('../../assets/versionValidation');
const { V2RepositoryDataError } = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');

const validation = createVersionValidation('Character candidate state input is invalid');

function createCharacterCandidateRepository(database) {
  let statements;

  function getStatements() {
    if (statements) return statements;
    statements = Object.freeze({
      insertResult: database.prepare(`
        INSERT INTO character_candidate_results
          (uid, batch_uid, character_uid, ordinal, asset_version_uid, asset_uid,
           storage_provider, relative_path, duration_ms, asset_version_parent_uid,
           asset_version_created_at, asset_created_at, asset_updated_at, logical_uri,
           media_type, width, height, content_sha256, presentation)
        VALUES
          (@uid, @batchUid, @characterUid, @ordinal, @assetVersionUid, @assetUid,
           @storageProvider, @relativePath, @durationMs, @assetVersionParentUid,
           @assetVersionCreatedAt, @assetCreatedAt, @assetUpdatedAt, @logicalUri,
           @mediaType, @width, @height, @contentSha256, @presentation)
      `),
      candidateAssetEvidence: database.prepare(`
        SELECT version.asset_uid AS assetUid,
               version.storage_provider AS storageProvider,
               version.relative_path AS relativePath,
               version.duration_ms AS durationMs,
               version.parent_uid AS assetVersionParentUid,
               version.created_at AS assetVersionCreatedAt,
               asset.created_at AS assetCreatedAt,
               asset.updated_at AS assetUpdatedAt
        FROM asset_versions AS version
        JOIN assets AS asset ON asset.uid = version.asset_uid
        WHERE version.uid = @assetVersionUid
          AND version.logical_uri = @logicalUri
          AND version.sha256 = @contentSha256
          AND version.mime_type = @mediaType
          AND version.width = @width AND version.height = @height
          AND version.status = 'ready'
          AND typeof(version.created_at) = 'text'
          AND length(CAST(version.created_at AS BLOB)) = 24
          AND version.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(version.created_at)) IS version.created_at
          AND asset.owner_type = 'character'
          AND asset.owner_uid = @characterUid
          AND asset.asset_type = 'character_candidate'
          AND asset.current_version_uid = version.uid
          AND asset.status = 'ready'
          AND typeof(asset.created_at) = 'text' AND typeof(asset.updated_at) = 'text'
          AND length(CAST(asset.created_at AS BLOB)) = 24
          AND length(CAST(asset.updated_at AS BLOB)) = 24
          AND asset.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND asset.updated_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.created_at)) IS asset.created_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.updated_at)) IS asset.updated_at
      `),
      insertBatch: database.prepare(`
        INSERT INTO character_candidate_batches
          (uid, character_uid, prompt_semantic_uid, profile_uid, manifest_uid,
           width, height, seed, candidate_count, request_sha256)
        VALUES
          (@uid, @characterUid, @promptSemanticUid, @profileUid, @manifestUid,
           @width, @height, @seed, @candidateCount, @requestSha256)
      `),
      getBatch: database.prepare('SELECT * FROM character_candidate_batches WHERE uid = ?'),
      listBatches: database.prepare(`
        SELECT * FROM character_candidate_batches
        WHERE character_uid = ? ORDER BY created_at_epoch_ms, uid
      `),
      listResults: database.prepare(`
        SELECT * FROM character_candidate_results
        WHERE batch_uid = ? ORDER BY ordinal
      `),
      validResultCount: database.prepare(`
        SELECT count(*)
        FROM character_candidate_results AS result
        JOIN asset_versions AS version ON version.uid = result.asset_version_uid
        JOIN assets AS asset ON asset.uid = version.asset_uid
        WHERE result.batch_uid = @batchUid
          AND result.character_uid = @characterUid
          AND result.logical_uri = 'asset://characters/' || @characterUid
            || '/candidate-batches/' || @batchUid || '/' || result.ordinal
          AND result.width = @width AND result.height = @height
          AND version.asset_uid = result.asset_uid
          AND version.storage_provider = result.storage_provider
          AND version.relative_path = result.relative_path
          AND version.duration_ms IS result.duration_ms
          AND version.parent_uid IS result.asset_version_parent_uid
          AND version.created_at = result.asset_version_created_at
          AND typeof(version.created_at) = 'text'
          AND length(CAST(version.created_at AS BLOB)) = 24
          AND version.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(version.created_at)) IS version.created_at
          AND typeof(result.asset_version_created_at) = 'text'
          AND length(CAST(result.asset_version_created_at AS BLOB)) = 24
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(result.asset_version_created_at))
            IS result.asset_version_created_at
          AND version.logical_uri = result.logical_uri
          AND version.sha256 = result.content_sha256
          AND version.mime_type = result.media_type
          AND version.width = result.width AND version.height = result.height
          AND version.status = 'ready'
          AND asset.owner_type = 'character'
          AND asset.owner_uid = @characterUid
          AND asset.asset_type = 'character_candidate'
          AND asset.current_version_uid = version.uid
          AND asset.status = 'ready'
          AND asset.created_at = result.asset_created_at
          AND asset.updated_at = result.asset_updated_at
          AND typeof(asset.created_at) = 'text' AND typeof(asset.updated_at) = 'text'
          AND length(CAST(asset.created_at AS BLOB)) = 24
          AND length(CAST(asset.updated_at AS BLOB)) = 24
          AND asset.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND asset.updated_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.created_at)) IS asset.created_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.updated_at)) IS asset.updated_at
          AND typeof(result.asset_created_at) = 'text' AND typeof(result.asset_updated_at) = 'text'
          AND length(CAST(result.asset_created_at AS BLOB)) = 24
          AND length(CAST(result.asset_updated_at AS BLOB)) = 24
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(result.asset_created_at))
            IS result.asset_created_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(result.asset_updated_at))
            IS result.asset_updated_at
      `).pluck(),
      getCharacter: database.prepare('SELECT uid FROM characters WHERE uid = ?'),
      insertLockEvent: database.prepare(`
        INSERT INTO character_identity_lock_events
          (uid, character_uid, candidate_uid, identity_version_uid, operation,
           state_version, changed_at_epoch_ms)
        VALUES
          (@eventUid, @characterUid, @candidateUid, @identityVersionUid, @operation,
           @stateVersion, @changedAtEpochMs)
      `),
      latestLockEvent: database.prepare(`
        SELECT * FROM character_identity_lock_events
        WHERE character_uid = ? ORDER BY state_version DESC LIMIT 1
      `),
      listLockEvents: database.prepare(`
        SELECT * FROM character_identity_lock_events
        WHERE character_uid = ? ORDER BY state_version
      `),
    });
    return statements;
  }

  const insertBatchTransaction = database.transaction((batch) => {
    const prepared = getStatements();
    for (const candidate of batch.candidates) {
      const evidence = requiredRow(
        prepared.candidateAssetEvidence.get({
          ...candidate,
          characterUid: batch.characterUid,
        }),
        'character candidate asset evidence',
        candidate.assetVersionUid,
      );
      prepared.insertResult.run({
        ...candidate,
        ...evidence,
        batchUid: batch.batchUid,
        characterUid: batch.characterUid,
      });
    }
    prepared.insertBatch.run({
      uid: batch.batchUid,
      characterUid: batch.characterUid,
      promptSemanticUid: batch.request.promptSemanticUid,
      profileUid: batch.request.profileUid,
      manifestUid: batch.request.manifestUid,
      width: batch.request.width,
      height: batch.request.height,
      seed: batch.request.seed,
      candidateCount: batch.request.candidateCount,
      requestSha256: batch.requestSha256,
    });
  });

  function mapBatch(row) {
    try {
      const prepared = getStatements();
      if (prepared.validResultCount.get({
        batchUid: row.uid,
        characterUid: row.character_uid,
        width: row.width,
        height: row.height,
      }) !== 4) throw new TypeError();
      const request = {
        schemaVersion: '5.0',
        batchUid: row.uid,
        characterUid: row.character_uid,
        promptSemanticUid: row.prompt_semantic_uid,
        profileUid: row.profile_uid,
        manifestUid: row.manifest_uid,
        width: row.width,
        height: row.height,
        seed: row.seed,
        candidateCount: row.candidate_count,
      };
      const output = {
        candidates: prepared.listResults.all(row.uid).map((candidate) => ({
          uid: candidate.uid,
          ordinal: candidate.ordinal,
          assetVersionUid: candidate.asset_version_uid,
          logicalUri: candidate.logical_uri,
          mediaType: candidate.media_type,
          width: candidate.width,
          height: candidate.height,
          contentSha256: candidate.content_sha256,
          presentation: candidate.presentation,
        })),
      };
      const batch = createCharacterCandidateBatch(request, output);
      if (batch.requestSha256 !== row.request_sha256) throw new TypeError();
      return batch;
    } catch {
      throw new V2RepositoryDataError('character candidate batch', 'persisted record');
    }
  }

  function getBatch(batchUid) {
    const canonicalBatchUid = validation.canonicalUid(batchUid);
    const row = requiredRow(
      getStatements().getBatch.get(canonicalBatchUid),
      'character candidate batch',
      canonicalBatchUid,
    );
    return mapBatch(row);
  }

  function listBatches(characterUid) {
    const canonicalCharacterUid = validation.canonicalUid(characterUid);
    requiredRow(
      getStatements().getCharacter.get(canonicalCharacterUid),
      'character',
      canonicalCharacterUid,
    );
    return Object.freeze(
      getStatements().listBatches.all(canonicalCharacterUid).map((row) => mapBatch(row)),
    );
  }

  function lockInput(value, operation) {
    const input = validation.exactObject(value, [
      'eventUid',
      'characterUid',
      'candidateUid',
      'identityVersionUid',
      'expectedStateVersion',
      'changedAtEpochMs',
    ]);
    if (
      !Number.isSafeInteger(input.expectedStateVersion)
      || input.expectedStateVersion < 0
      || input.expectedStateVersion >= Number.MAX_SAFE_INTEGER
    ) {
      validation.fail();
    }
    if (
      !Number.isSafeInteger(input.changedAtEpochMs)
      || input.changedAtEpochMs < 0
      || input.changedAtEpochMs > 253402300799999
    ) validation.fail();
    return Object.freeze({
      eventUid: validation.canonicalUid(input.eventUid),
      characterUid: validation.canonicalUid(input.characterUid),
      candidateUid: validation.canonicalUid(input.candidateUid),
      identityVersionUid: validation.canonicalUid(input.identityVersionUid),
      operation,
      stateVersion: input.expectedStateVersion + 1,
      changedAtEpochMs: input.changedAtEpochMs,
    });
  }

  function mapLockEvent(row) {
    try {
      return Object.freeze({
        schemaVersion: '5.0',
        eventUid: validation.canonicalUid(row.uid),
        characterUid: validation.canonicalUid(row.character_uid),
        candidateUid: validation.canonicalUid(row.candidate_uid),
        identityVersionUid: validation.canonicalUid(row.identity_version_uid),
        operation: row.operation === 'lock' || row.operation === 'unlock'
          ? row.operation
          : validation.fail(),
        stateVersion: Number.isSafeInteger(row.state_version) && row.state_version >= 1
          ? row.state_version
          : validation.fail(),
        changedAtEpochMs: Number.isSafeInteger(row.changed_at_epoch_ms)
          && row.changed_at_epoch_ms >= 0
          && row.changed_at_epoch_ms <= 253402300799999
          ? row.changed_at_epoch_ms
          : validation.fail(),
      });
    } catch {
      throw new V2RepositoryDataError('character identity lock event', 'persisted record');
    }
  }

  function getLockState(characterUid) {
    const prepared = getStatements();
    const canonicalCharacterUid = validation.canonicalUid(characterUid);
    requiredRow(
      prepared.getCharacter.get(canonicalCharacterUid),
      'character',
      canonicalCharacterUid,
    );
    const row = prepared.latestLockEvent.get(canonicalCharacterUid);
    if (!row) {
      return Object.freeze({
        schemaVersion: '5.0',
        characterUid: canonicalCharacterUid,
        status: 'unlocked',
        stateVersion: 0,
        candidateUid: null,
        identityVersionUid: null,
        eventUid: null,
        changedAtEpochMs: null,
      });
    }
    const event = mapLockEvent(row);
    return Object.freeze({
      schemaVersion: '5.0',
      characterUid: event.characterUid,
      status: event.operation === 'lock' ? 'locked' : 'unlocked',
      stateVersion: event.stateVersion,
      candidateUid: event.candidateUid,
      identityVersionUid: event.identityVersionUid,
      eventUid: event.eventUid,
      changedAtEpochMs: event.changedAtEpochMs,
    });
  }

  function appendLockEvent(value, operation) {
    const event = lockInput(value, operation);
    executeWrite('character identity lock', operation, () => {
      getStatements().insertLockEvent.run(event);
    });
    return getLockState(event.characterUid);
  }

  return Object.freeze({
    appendBatch(batch) {
      if (!isCharacterCandidateBatch(batch)) {
        throw new TypeError('Character candidate batch is invalid');
      }
      executeWrite('character candidate batch', 'created', () => insertBatchTransaction(batch));
      return getBatch(batch.batchUid);
    },

    getBatch,
    getLockState,
    listBatches,

    listLockEvents(characterUid) {
      const canonicalCharacterUid = validation.canonicalUid(characterUid);
      requiredRow(
        getStatements().getCharacter.get(canonicalCharacterUid),
        'character',
        canonicalCharacterUid,
      );
      return Object.freeze(
        getStatements().listLockEvents.all(canonicalCharacterUid).map((row) => mapLockEvent(row)),
      );
    },

    lock(value) {
      return appendLockEvent(value, 'lock');
    },

    unlock(value) {
      return appendLockEvent(value, 'unlock');
    },
  });
}

module.exports = { createCharacterCandidateRepository };
