const { executeWrite, optimisticResult, requiredRow } = require('./repositorySupport');
const { freezeSnapshot, mapRow, mapRows } = require('./rowMapping');

const ASSET_MAP = Object.freeze({ entity: 'asset' });
const VERSION_MAP = Object.freeze({ entity: 'asset version' });

function createAssetRepository(database) {
  const insertAsset = database.prepare(`
    INSERT INTO assets
      (uid, owner_type, owner_uid, asset_type, status)
    VALUES
      (@uid, @ownerType, @ownerUid, @assetType, @status)
  `);
  const insertVersion = database.prepare(`
    INSERT INTO asset_versions
      (uid, asset_uid, storage_provider, logical_uri, relative_path, sha256, mime_type,
       width, height, duration_ms, parent_uid, status)
    VALUES
      (@uid, @assetUid, @storageProvider, @logicalUri, @relativePath, @sha256, @mimeType,
       @width, @height, @durationMs, @parentUid, @status)
  `);
  const getAssetRow = database.prepare('SELECT * FROM assets WHERE uid = ?');
  const getVersionRow = database.prepare('SELECT * FROM asset_versions WHERE uid = ?');
  const listVersionRows = database.prepare(`
    SELECT * FROM asset_versions WHERE asset_uid = ? ORDER BY created_at, uid
  `);
  const listActiveOwnerRows = database.prepare(`
    SELECT * FROM assets
    WHERE owner_type = ? AND owner_uid = ? AND status <> 'deleted'
    ORDER BY asset_type, created_at, uid
  `);
  const listAllOwnerRows = database.prepare(`
    SELECT * FROM assets
    WHERE owner_type = ? AND owner_uid = ?
    ORDER BY asset_type, created_at, uid
  `);
  const setCurrent = database.prepare(`
    UPDATE assets
    SET current_version_uid = ?, status = CASE WHEN status = 'draft' THEN 'ready' ELSE status END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = ?
  `);
  const softDelete = database.prepare(`
    UPDATE assets
    SET status = 'deleted', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE uid = @uid AND status = @expectedStatus
  `);

  const insertVersionTransaction = database.transaction((version, makeCurrent) => {
    requiredRow(getAssetRow.get(version.assetUid), 'asset', version.assetUid);
    insertVersion.run(version);
    if (makeCurrent) setCurrent.run(version.uid, version.assetUid);
  });

  function get(uid) {
    return mapRow(requiredRow(getAssetRow.get(uid), 'asset', uid), ASSET_MAP);
  }

  function getVersion(uid) {
    return mapRow(requiredRow(getVersionRow.get(uid), 'asset version', uid), VERSION_MAP);
  }

  function listVersions(assetUid) {
    return mapRows(listVersionRows.all(assetUid), VERSION_MAP);
  }

  return Object.freeze({
    addVersion(version, { makeCurrent = false } = {}) {
      executeWrite('asset version', 'created', () => insertVersionTransaction(version, makeCurrent));
      return getVersion(version.uid);
    },

    create(asset) {
      executeWrite('asset', 'created', () => insertAsset.run(asset));
      return get(asset.uid);
    },

    get,

    getVersion,

    getWithVersions(uid) {
      return freezeSnapshot({ asset: get(uid), versions: listVersions(uid) });
    },

    listByOwner(ownerType, ownerUid, { includeDeleted = false } = {}) {
      const statement = includeDeleted ? listAllOwnerRows : listActiveOwnerRows;
      return mapRows(statement.all(ownerType, ownerUid), ASSET_MAP);
    },

    listVersions,

    setCurrentVersion(assetUid, versionUid) {
      requiredRow(getAssetRow.get(assetUid), 'asset', assetUid);
      executeWrite('asset', 'updated', () => setCurrent.run(versionUid, assetUid));
      return get(assetUid);
    },

    softDelete(uid, { expectedStatus }) {
      const result = softDelete.run({ uid, expectedStatus });
      optimisticResult({
        changes: result.changes,
        exists: () => Boolean(getAssetRow.get(uid)),
        entity: 'asset',
        uid,
        operation: 'soft-deleted',
      });
      return get(uid);
    },
  });
}

module.exports = { createAssetRepository };
