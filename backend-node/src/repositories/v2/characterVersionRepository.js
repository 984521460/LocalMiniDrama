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

  function get(kind, uid) {
    const canonicalKind = assertKind(kind);
    const prepared = getStatements();
    const row = requiredRow(
      prepared[canonicalKind].get.get(uid),
      `character ${canonicalKind} version`,
      uid,
    );
    return mapPersisted(canonicalKind, row);
  }

  function list(kind, characterUid) {
    const canonicalKind = assertKind(kind);
    const prepared = getStatements();
    return freezeSnapshot(
      prepared[canonicalKind].list.all(characterUid)
        .map((row) => mapPersisted(canonicalKind, row)),
    );
  }

  return Object.freeze({
    create(value) {
      const record = createCharacterVersionRecord(value);
      const prepared = getStatements();
      executeWrite(`character ${record.kind} version`, 'created', () => {
        prepared[record.kind].insert.run({
          uid: record.uid,
          characterUid: record.characterUid,
          ...(record.kind === 'identity' ? {} : { identityVersionUid: record.identityVersionUid }),
          parentUid: record.parentUid,
          metadataJson: JSON.stringify(record.metadata),
          createdAtEpochMs: record.createdAtEpochMs ?? null,
        });
      });
      return get(record.kind, record.uid);
    },

    get,

    list,
  });
}

module.exports = { createCharacterVersionRepository };
