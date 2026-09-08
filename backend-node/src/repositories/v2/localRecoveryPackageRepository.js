'use strict';

const {
  canonicalCharacterCandidateSource,
  characterCandidateSourceSha256,
  parseCharacterCandidateSourceJson,
} = require('../../characterCandidates/execution/source');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { assertDatabase, executeWrite } = require('./repositorySupport');

const ENTITY = 'local recovery package';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const STATES = new Set(['reserved', 'succeeded', 'failed', 'submission_unknown']);
const FAILURE_CODES = new Set(['LOCAL_PACKAGE_IMPORT_INTERRUPTED', 'LOCAL_PACKAGE_IMPORT_FAILED']);

function dataError(field) {
  throw new V2RepositoryDataError(ENTITY, field);
}

function parseSource(row) {
  let source;
  try { source = parseCharacterCandidateSourceJson(row.source_json); } catch { return dataError('source'); }
  if (characterCandidateSourceSha256(source) !== row.source_sha256
    || source.dramaUid !== row.drama_uid || source.characterUid !== row.character_uid) {
    dataError('source binding');
  }
  return source;
}

function parseItems(row) {
  let items;
  try { items = JSON.parse(row.items_json); } catch { return dataError('items'); }
  if (!Array.isArray(items) || items.length < 1 || items.length > 16) dataError('items');
  return Object.freeze(items.map((item) => Object.freeze(item)));
}

function createLocalRecoveryPackageRepository(database) {
  assertDatabase(database);
  const selectAttempt = database.prepare(
    'SELECT * FROM local_recovery_import_attempts WHERE operation_uid=?',
  );
  const selectAttemptByIdentity = database.prepare(`
    SELECT * FROM local_recovery_import_attempts WHERE character_uid=? AND package_sha256=?
  `);
  const selectReserved = database.prepare(`
    SELECT * FROM local_recovery_import_attempts
    WHERE state='reserved' ORDER BY created_at_epoch_ms,operation_uid
  `);
  const selectPackage = database.prepare('SELECT * FROM local_recovery_packages WHERE uid=?');
  const selectPackageByIdentity = database.prepare(`
    SELECT * FROM local_recovery_packages WHERE character_uid=? AND package_sha256=?
  `);
  const listPackages = database.prepare(`
    SELECT * FROM local_recovery_packages
    WHERE drama_uid=? AND character_uid=? ORDER BY created_at DESC,uid LIMIT 50
  `);
  const insertAttempt = database.prepare(`
    INSERT INTO local_recovery_import_attempts
      (operation_uid,drama_uid,character_uid,package_sha256,manifest_sha256,
       remote_task_uid,source_json,source_sha256,state)
    VALUES
      (@operationUid,@dramaUid,@characterUid,@packageSha256,@manifestSha256,
       @remoteTaskUid,@sourceJson,@sourceSha256,'reserved')
  `);
  const restartAttempt = database.prepare(`
    UPDATE local_recovery_import_attempts
    SET state='reserved',error_code=NULL,attempt_count=attempt_count+1,
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='failed'
  `);
  const insertPackage = database.prepare(`
    INSERT INTO local_recovery_packages
      (uid,drama_uid,character_uid,package_sha256,manifest_sha256,remote_task_uid,
       source_json,source_sha256,items_json)
    VALUES
      (@uid,@dramaUid,@characterUid,@packageSha256,@manifestSha256,@remoteTaskUid,
       @sourceJson,@sourceSha256,@itemsJson)
  `);
  const succeedAttempt = database.prepare(`
    UPDATE local_recovery_import_attempts
    SET state='succeeded',updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='reserved'
  `);
  const failAttempt = database.prepare(`
    UPDATE local_recovery_import_attempts
    SET state='failed',error_code=?,updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='reserved'
  `);
  const unknownAttempt = database.prepare(`
    UPDATE local_recovery_import_attempts
    SET state='submission_unknown',error_code='LOCAL_PACKAGE_IMPORT_SUBMISSION_UNKNOWN',
        updated_at_epoch_ms=unixepoch('now') * 1000
    WHERE operation_uid=? AND state='reserved'
  `);

  function mapAttempt(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    const source = parseSource(row);
    if (!UUID.test(row.operation_uid) || !UUID.test(row.drama_uid) || !UUID.test(row.character_uid)
      || !UUID.test(row.remote_task_uid) || !SHA.test(row.package_sha256)
      || !SHA.test(row.manifest_sha256) || !STATES.has(row.state)
      || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 1
      || !Number.isSafeInteger(row.created_at_epoch_ms)
      || !Number.isSafeInteger(row.updated_at_epoch_ms)) dataError('attempt');
    return Object.freeze({
      operationUid: row.operation_uid,
      dramaUid: row.drama_uid,
      characterUid: row.character_uid,
      packageSha256: row.package_sha256,
      manifestSha256: row.manifest_sha256,
      remoteTaskUid: row.remote_task_uid,
      source,
      sourceSha256: row.source_sha256,
      state: row.state,
      errorCode: row.error_code,
      attemptCount: row.attempt_count,
      createdAtEpochMs: row.created_at_epoch_ms,
      updatedAtEpochMs: row.updated_at_epoch_ms,
    });
  }

  function mapPackage(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    const source = parseSource(row);
    if (!UUID.test(row.uid) || !UUID.test(row.drama_uid) || !UUID.test(row.character_uid)
      || !UUID.test(row.remote_task_uid) || !SHA.test(row.package_sha256)
      || !SHA.test(row.manifest_sha256) || typeof row.created_at !== 'string') dataError('package');
    return Object.freeze({
      uid: row.uid,
      dramaUid: row.drama_uid,
      characterUid: row.character_uid,
      packageSha256: row.package_sha256,
      manifestSha256: row.manifest_sha256,
      remoteTaskUid: row.remote_task_uid,
      source,
      sourceSha256: row.source_sha256,
      items: parseItems(row),
      createdAt: row.created_at,
    });
  }

  function sameIdentity(attempt, input, sourceJson) {
    return attempt.dramaUid === input.dramaUid
      && attempt.characterUid === input.characterUid
      && attempt.packageSha256 === input.packageSha256
      && attempt.manifestSha256 === input.manifestSha256
      && attempt.remoteTaskUid === input.remoteTaskUid
      && attempt.sourceSha256 === input.sourceSha256
      && canonicalCharacterCandidateSource(attempt.source) === sourceJson;
  }

  return Object.freeze({
    complete(operationUid, items) {
      const attempt = mapAttempt(selectAttempt.get(operationUid));
      if (attempt.state !== 'reserved' || !Array.isArray(items)
        || items.length < 1 || items.length > 16) {
        throw new V2RepositoryConflictError(ENTITY, 'completed');
      }
      const values = {
        uid: attempt.operationUid,
        dramaUid: attempt.dramaUid,
        characterUid: attempt.characterUid,
        packageSha256: attempt.packageSha256,
        manifestSha256: attempt.manifestSha256,
        remoteTaskUid: attempt.remoteTaskUid,
        sourceJson: canonicalCharacterCandidateSource(attempt.source),
        sourceSha256: attempt.sourceSha256,
        itemsJson: JSON.stringify(items),
      };
      executeWrite(ENTITY, 'completed', () => {
        insertPackage.run(values);
        if (succeedAttempt.run(operationUid).changes !== 1) {
          throw new V2RepositoryConflictError(ENTITY, 'completed');
        }
      });
      return mapPackage(selectPackage.get(operationUid));
    },

    fail(operationUid, errorCode = 'LOCAL_PACKAGE_IMPORT_FAILED') {
      if (!FAILURE_CODES.has(errorCode)) throw new TypeError('Local recovery failure is invalid');
      executeWrite(ENTITY, 'failed', () => {
        if (failAttempt.run(errorCode, operationUid).changes !== 1) {
          throw new V2RepositoryConflictError(ENTITY, 'failed');
        }
      });
      return mapAttempt(selectAttempt.get(operationUid));
    },

    get(operationUid) {
      return mapPackage(selectPackage.get(operationUid));
    },

    getAttempt(operationUid) {
      return mapAttempt(selectAttempt.get(operationUid));
    },

    getByIdentity(characterUid, packageSha256) {
      return mapPackage(selectPackageByIdentity.get(characterUid, packageSha256));
    },

    listByCharacter(dramaUid, characterUid) {
      if (!UUID.test(dramaUid) || !UUID.test(characterUid)) {
        throw new TypeError('Local recovery history input is invalid');
      }
      return Object.freeze(listPackages.all(dramaUid, characterUid).map(mapPackage));
    },

    listReserved() {
      return Object.freeze(selectReserved.all().map(mapAttempt));
    },

    markUnknown(operationUid) {
      executeWrite(ENTITY, 'marked unknown', () => {
        if (unknownAttempt.run(operationUid).changes !== 1) {
          throw new V2RepositoryConflictError(ENTITY, 'marked unknown');
        }
      });
      return mapAttempt(selectAttempt.get(operationUid));
    },

    reserve(input) {
      if (!input || typeof input !== 'object' || !UUID.test(input.operationUid)
        || !UUID.test(input.dramaUid) || !UUID.test(input.characterUid)
        || !UUID.test(input.remoteTaskUid) || !SHA.test(input.packageSha256)
        || !SHA.test(input.manifestSha256)
        || characterCandidateSourceSha256(input.source) !== input.sourceSha256) {
        throw new TypeError('Local recovery reservation is invalid');
      }
      const sourceJson = canonicalCharacterCandidateSource(input.source);
      let created = false;
      try {
        insertAttempt.run({ ...input, sourceJson });
        created = true;
      } catch (error) {
        const existingRow = selectAttemptByIdentity.get(input.characterUid, input.packageSha256);
        if (!existingRow) {
          if (typeof error?.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) {
            throw new V2RepositoryConflictError(ENTITY, 'reserved');
          }
          throw error;
        }
      }
      let attempt = mapAttempt(selectAttemptByIdentity.get(input.characterUid, input.packageSha256));
      if (!sameIdentity(attempt, input, sourceJson)) {
        throw new V2RepositoryConflictError(ENTITY, 'reserved');
      }
      if (!created && attempt.state === 'failed') {
        executeWrite(ENTITY, 'restarted', () => {
          if (restartAttempt.run(attempt.operationUid).changes !== 1) {
            throw new V2RepositoryConflictError(ENTITY, 'restarted');
          }
        });
        attempt = mapAttempt(selectAttempt.get(attempt.operationUid));
        created = true;
      }
      return Object.freeze({ created, attempt });
    },
  });
}

module.exports = Object.freeze({ createLocalRecoveryPackageRepository });
