const LEGACY_ASSET_TABLE = 'legacy_assets';
const PRE_V2_ASSET_TABLE = 'assets';

function tableExists(database, table) {
  return database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table) !== undefined;
}

function resolveLegacyAssetTable(database) {
  if (tableExists(database, LEGACY_ASSET_TABLE)) return LEGACY_ASSET_TABLE;
  return PRE_V2_ASSET_TABLE;
}

module.exports = {
  LEGACY_ASSET_TABLE,
  PRE_V2_ASSET_TABLE,
  resolveLegacyAssetTable,
};
