const { createCharacterVersionRecord } = require('../../assets/characterVersions');
const { V2RepositoryDataError } = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');
const { freezeSnapshot } = require('./rowMapping');

const TABLES = Object.freeze({
  identity: 'character_identity_versions',
  appearance: 'character_appearance_versions',
  costume: 'character_costume_versions',
  voice: 'character_voice_versions',
});

function assertKind(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(TABLES, kind)) {
    throw new TypeError('Character version kind is invalid');
  }
  return kind;
}

function createCharacterVersionRepository(database) {
  let statements;

  function getStatements() {
    if (!statements) {
      statements = Object.freeze(Object.fromEntries(
        Object.entries(TABLES).map(([kind, table]) => [kind, Object.freeze({
          insert: database.prepare(kind === 'identity' ? `
            INSERT INTO ${table}
              (uid, character_uid, parent_uid, metadata_json, created_at_epoch_ms)
            VALUES
              (@uid, @characterUid, @parentUid, @metadataJson,
               COALESCE(@createdAtEpochMs,
                 CAST(strftime('%s', 'now') AS INTEGER) * 1000
                 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))
          ` : `
            INSERT INTO ${table}
              (uid, character_uid, identity_version_uid, parent_uid, metadata_json,
               created_at_epoch_ms)
            VALUES
              (@uid, @characterUid, @identityVersionUid, @parentUid, @metadataJson,
               COALESCE(@createdAtEpochMs,
                 CAST(strftime('%s', 'now') AS INTEGER) * 1000
                 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))
          `),
          get: database.prepare(`SELECT * FROM ${table} WHERE uid = ?`),
          list: database.prepare(`
            SELECT * FROM ${table}
            WHERE character_uid = ?
            ORDER BY created_at_epoch_ms, uid
          `),
        })]),
      ));
    }
    return statements;
  }

  function mapPersisted(kind, row) {
    try {
      const metadata = JSON.parse(row.metadata_json);
      if (JSON.stringify(metadata) !== row.metadata_json) {
        throw new TypeError('character version metadata is not canonical');
      }
      return createCharacterVersionRecord({
        schemaVersion: '5.0',
        kind,
        uid: row.uid,
        characterUid: row.character_uid,
        ...(kind === 'identity' ? {} : { identityVersionUid: row.identity_version_uid }),
        parentUid: row.parent_uid,
        metadata,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch {
      throw new V2RepositoryDataError(`character ${kind} version`, 'persisted record');
    }
  }

  function validateLineage(kind, rows, characterUid) {
    const records = [];
    const byUid = Object.create(null);
    for (let index = 0; index < rows.length; index += 1) {
      const record = mapPersisted(kind, rows[index]);
      if (record.characterUid !== characterUid || Object.hasOwn(byUid, record.uid)) {
        throw new V2RepositoryDataError(`character ${kind} version`, 'owner lineage');
      }
      records.push(record);
      byUid[record.uid] = record;
    }
    let identities = null;
    if (kind !== 'identity') {
      identities = Object.create(null);
      const identityRows = getStatements().identity.list.all(characterUid);
      const identityRecords = validateLineage('identity', identityRows, characterUid);
      for (let index = 0; index < identityRecords.length; index += 1) {
        identities[identityRecords[index].uid] = identityRecords[index];
      }
    }
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (identities && !Object.hasOwn(identities, record.identityVersionUid)) {
        throw new V2RepositoryDataError(`character ${kind} version`, 'identity lineage');
      }
      const seen = Object.create(null);
      let current = record;
      while (current.parentUid !== null) {
        if (Object.hasOwn(seen, current.uid)) {
          throw new V2RepositoryDataError(`character ${kind} version`, 'parent lineage');
        }
        seen[current.uid] = true;
        const parent = byUid[current.parentUid];
        if (
          !parent
          || parent.characterUid !== characterUid
          || parent.createdAtEpochMs > current.createdAtEpochMs
          || (kind !== 'identity' && parent.identityVersionUid !== current.identityVersionUid)
        ) {
          throw new V2RepositoryDataError(`character ${kind} version`, 'parent lineage');
        }
        current = parent;
      }
    }
    return freezeSnapshot(records);
  }

  function get(kind, uid) {
    const canonicalKind = assertKind(kind);
    const prepared = getStatements();
    const row = requiredRow(
      prepared[canonicalKind].get.get(uid),
      `character ${canonicalKind} version`,
      uid,
    );
    const initial = mapPersisted(canonicalKind, row);
    const records = list(canonicalKind, initial.characterUid);
    let matched = null;
    for (let index = 0; index < records.length; index += 1) {
      if (records[index].uid === initial.uid) matched = records[index];
    }
    if (!matched) {
      throw new V2RepositoryDataError(`character ${canonicalKind} version`, 'owner lineage');
    }
    return matched;
  }

  function list(kind, characterUid) {
    const canonicalKind = assertKind(kind);
    const prepared = getStatements();
    return validateLineage(
      canonicalKind,
      prepared[canonicalKind].list.all(characterUid),
      characterUid,
    );
  }

  const createTransaction = database.transaction((record) => {
    list(record.kind, record.characterUid);
    const prepared = getStatements();
    prepared[record.kind].insert.run({
      uid: record.uid,
      characterUid: record.characterUid,
      ...(record.kind === 'identity' ? {} : { identityVersionUid: record.identityVersionUid }),
      parentUid: record.parentUid,
      metadataJson: JSON.stringify(record.metadata),
      createdAtEpochMs: record.createdAtEpochMs ?? null,
    });
    const records = list(record.kind, record.characterUid);
    let created = null;
    for (let index = 0; index < records.length; index += 1) {
      if (records[index].uid === record.uid) created = records[index];
    }
    if (!created) {
      throw new V2RepositoryDataError(`character ${record.kind} version`, 'created record');
    }
    return created;
  });

  return Object.freeze({
    create(value) {
      const record = createCharacterVersionRecord(value);
      return executeWrite(
        `character ${record.kind} version`,
        'created',
        () => createTransaction(record),
      );
    },

    get,

    list,
  });
}

module.exports = { createCharacterVersionRepository };
