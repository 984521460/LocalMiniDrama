const { createScenePropVersionRecord } = require('../../assets/scenePropVersions');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');
const { freezeSnapshot } = require('./rowMapping');

const TABLES = Object.freeze({
  scene: Object.freeze({ table: 'scene_versions', ownerColumn: 'scene_uid', ownerField: 'sceneUid' }),
  prop: Object.freeze({ table: 'prop_versions', ownerColumn: 'prop_uid', ownerField: 'propUid' }),
});

function assertKind(kind) {
  if (typeof kind !== 'string' || !Object.hasOwn(TABLES, kind)) {
    throw new TypeError('Scene or prop version kind is invalid');
  }
  return kind;
}

function createScenePropVersionRepository(database) {
  let statements;

  function getStatements() {
    if (!statements) {
      statements = Object.freeze(Object.fromEntries(
        Object.entries(TABLES).map(([kind, definition]) => [kind, Object.freeze({
          insert: database.prepare(`
            INSERT INTO ${definition.table}
              (uid, ${definition.ownerColumn}, parent_uid, state, metadata_json, created_at_epoch_ms)
            VALUES
              (@uid, @ownerUid, @parentUid, @state, @metadataJson,
               COALESCE(@createdAtEpochMs,
                 CAST(strftime('%s', 'now') AS INTEGER) * 1000
                 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))
          `),
          get: database.prepare(`SELECT * FROM ${definition.table} WHERE uid = ?`),
          list: database.prepare(`
            SELECT * FROM ${definition.table}
            WHERE ${definition.ownerColumn} = ?
            ORDER BY created_at_epoch_ms, uid
          `),
        })]),
      ));
    }
    return statements;
  }

  function mapPersisted(kind, row) {
    const definition = TABLES[kind];
    try {
      return createScenePropVersionRecord({
        schemaVersion: '5.0',
        kind,
        uid: row.uid,
        [definition.ownerField]: row[definition.ownerColumn],
        parentUid: row.parent_uid,
        state: row.state,
        metadata: JSON.parse(row.metadata_json),
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch {
      throw new V2RepositoryDataError(`${kind} version`, 'persisted record');
    }
  }

  function get(kind, uid) {
    const canonicalKind = assertKind(kind);
    const row = requiredRow(
      getStatements()[canonicalKind].get.get(uid),
      `${canonicalKind} version`,
      uid,
    );
    return mapPersisted(canonicalKind, row);
  }

  function list(kind, ownerUid) {
    const canonicalKind = assertKind(kind);
    return freezeSnapshot(
      getStatements()[canonicalKind].list.all(ownerUid)
        .map((row) => mapPersisted(canonicalKind, row)),
    );
  }

  return Object.freeze({
    create(value) {
      const record = createScenePropVersionRecord(value);
      const definition = TABLES[record.kind];
      executeWrite(`${record.kind} version`, 'created', () => {
        getStatements()[record.kind].insert.run({
          uid: record.uid,
          ownerUid: record[definition.ownerField],
          parentUid: record.parentUid,
          state: record.state,
          metadataJson: JSON.stringify(record.metadata),
          createdAtEpochMs: record.createdAtEpochMs ?? null,
        });
      });
      return get(record.kind, record.uid);
    },

    get,

    list,

    requireReferenceable(kind, uid, ownerUid) {
      const record = get(kind, uid);
      const definition = TABLES[record.kind];
      if (record[definition.ownerField] !== ownerUid || record.state !== 'ready') {
        throw new V2RepositoryConflictError(`${record.kind} version`, 'referenced');
      }
      return record;
    },
  });
}

module.exports = { createScenePropVersionRepository };
