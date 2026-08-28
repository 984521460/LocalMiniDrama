const {
  createCharacterReferencePackage,
  createCharacterReferencePackageInput,
} = require('../../assets/characterReferencePackage');
const { createCharacterVersionRecord } = require('../../assets/characterVersions');
const { V2RepositoryDataError } = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');
const { createVersionValidation } = require('../../assets/versionValidation');

const validation = createVersionValidation('Character reference package input is invalid');

function createCharacterReferencePackageRepository(database) {
  let statements;

  function getStatements() {
    if (statements) return statements;
    statements = Object.freeze({
      getCharacter: database.prepare('SELECT uid FROM characters WHERE uid = ?'),
      latestLock: database.prepare(`
        SELECT * FROM character_identity_lock_events
        WHERE character_uid = ? ORDER BY state_version DESC LIMIT 1
      `),
      getLock: database.prepare('SELECT * FROM character_identity_lock_events WHERE uid = ?'),
      getAppearance: database.prepare('SELECT * FROM character_appearance_versions WHERE uid = ?'),
      getCostume: database.prepare('SELECT * FROM character_costume_versions WHERE uid = ?'),
      assetEvidence: database.prepare(`
        SELECT version.asset_uid AS assetUid,
               version.storage_provider AS storageProvider,
               version.relative_path AS relativePath,
               version.duration_ms AS durationMs,
               version.parent_uid AS assetVersionParentUid,
               version.created_at AS assetVersionCreatedAt,
               asset.created_at AS assetCreatedAt,
               asset.updated_at AS assetUpdatedAt,
               version.logical_uri AS logicalUri,
               version.mime_type AS mediaType,
               version.width AS width,
               version.height AS height,
               version.sha256 AS contentSha256
        FROM asset_versions AS version
        JOIN assets AS asset ON asset.uid = version.asset_uid
        WHERE version.uid = @assetVersionUid
          AND version.logical_uri = @logicalUri
          AND version.status = 'ready'
          AND typeof(version.created_at) = 'text'
          AND length(CAST(version.created_at AS BLOB)) = 24
          AND version.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(version.created_at)) IS version.created_at
          AND version.sha256 IS NOT NULL
          AND version.mime_type IN ('image/png', 'image/jpeg', 'image/webp')
          AND version.width BETWEEN 64 AND 8192
          AND version.height BETWEEN 64 AND 8192
          AND asset.owner_type = 'character'
          AND asset.owner_uid = @characterUid
          AND asset.asset_type = 'character_reference'
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
      insertItem: database.prepare(`
        INSERT INTO character_reference_package_items
          (uid, package_uid, character_uid, ordinal, item_kind, asset_version_uid,
           asset_uid, storage_provider, relative_path, duration_ms,
           asset_version_parent_uid, asset_version_created_at, asset_created_at,
           asset_updated_at, logical_uri, media_type, width, height, content_sha256)
        VALUES
          (@uid, @packageUid, @characterUid, @ordinal, @kind, @assetVersionUid,
           @assetUid, @storageProvider, @relativePath, @durationMs,
           @assetVersionParentUid, @assetVersionCreatedAt, @assetCreatedAt,
           @assetUpdatedAt, @logicalUri, @mediaType, @width, @height, @contentSha256)
      `),
      insertPackage: database.prepare(`
        INSERT INTO character_reference_packages
          (uid, character_uid, identity_version_uid, candidate_uid, lock_event_uid,
           lock_state_version, appearance_version_uid, costume_version_uid,
           appearance_metadata_json, costume_metadata_json, created_at_epoch_ms)
        VALUES
          (@packageUid, @characterUid, @identityVersionUid, @candidateUid, @lockEventUid,
           @lockStateVersion, @appearanceVersionUid, @costumeVersionUid,
           @appearanceMetadataJson, @costumeMetadataJson, @createdAtEpochMs)
      `),
      getPackage: database.prepare('SELECT * FROM character_reference_packages WHERE uid = ?'),
      listPackages: database.prepare(`
        SELECT * FROM character_reference_packages
        WHERE character_uid = ? ORDER BY created_at_epoch_ms, uid
      `),
      listItems: database.prepare(`
        SELECT * FROM character_reference_package_items
        WHERE package_uid = ? ORDER BY ordinal
      `),
      validItemCount: database.prepare(`
        SELECT count(*)
        FROM character_reference_package_items AS item
        JOIN asset_versions AS version ON version.uid = item.asset_version_uid
        JOIN assets AS asset ON asset.uid = version.asset_uid
        WHERE item.package_uid = @packageUid
          AND item.character_uid = @characterUid
          AND item.logical_uri = 'asset://characters/' || @characterUid
            || '/reference-packages/' || @packageUid || '/' || item.item_kind
          AND version.asset_uid = item.asset_uid
          AND version.storage_provider = item.storage_provider
          AND version.relative_path = item.relative_path
          AND version.duration_ms IS item.duration_ms
          AND version.parent_uid IS item.asset_version_parent_uid
          AND version.created_at = item.asset_version_created_at
          AND typeof(version.created_at) = 'text'
          AND length(CAST(version.created_at AS BLOB)) = 24
          AND version.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(version.created_at)) IS version.created_at
          AND version.logical_uri = item.logical_uri
          AND version.sha256 = item.content_sha256
          AND version.mime_type = item.media_type
          AND version.width = item.width AND version.height = item.height
          AND version.status = 'ready'
          AND asset.owner_type = 'character'
          AND asset.owner_uid = @characterUid
          AND asset.asset_type = 'character_reference'
          AND asset.current_version_uid = version.uid
          AND asset.status = 'ready'
          AND asset.created_at = item.asset_created_at
          AND asset.updated_at = item.asset_updated_at
          AND typeof(asset.created_at) = 'text' AND typeof(asset.updated_at) = 'text'
          AND length(CAST(asset.created_at AS BLOB)) = 24
          AND length(CAST(asset.updated_at AS BLOB)) = 24
          AND asset.created_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND asset.updated_at BETWEEN '1970-01-01T00:00:00.000Z' AND '9999-12-31T23:59:59.999Z'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.created_at)) IS asset.created_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(asset.updated_at)) IS asset.updated_at
          AND typeof(item.asset_version_created_at) = 'text'
          AND typeof(item.asset_created_at) = 'text'
          AND typeof(item.asset_updated_at) = 'text'
          AND length(CAST(item.asset_version_created_at AS BLOB)) = 24
          AND length(CAST(item.asset_created_at AS BLOB)) = 24
          AND length(CAST(item.asset_updated_at AS BLOB)) = 24
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(item.asset_version_created_at))
            IS item.asset_version_created_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(item.asset_created_at)) IS item.asset_created_at
          AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(item.asset_updated_at)) IS item.asset_updated_at
      `).pluck(),
    });
    return statements;
  }

  function visualVersion(kind, row) {
    try {
      return createCharacterVersionRecord({
        schemaVersion: '5.0',
        kind,
        uid: row.uid,
        characterUid: row.character_uid,
        identityVersionUid: row.identity_version_uid,
        parentUid: row.parent_uid,
        metadata: JSON.parse(row.metadata_json),
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch {
      throw new V2RepositoryDataError(`character ${kind} version`, 'persisted record');
    }
  }

  const insertTransaction = database.transaction((input) => {
    const prepared = getStatements();
    const lock = requiredRow(
      prepared.latestLock.get(input.characterUid),
      'character identity lock',
      input.characterUid,
    );
    const appearanceRow = requiredRow(
      prepared.getAppearance.get(input.appearanceVersionUid),
      'character appearance version',
      input.appearanceVersionUid,
    );
    const costumeRow = requiredRow(
      prepared.getCostume.get(input.costumeVersionUid),
      'character costume version',
      input.costumeVersionUid,
    );
    if (
      lock.operation !== 'lock'
      || lock.state_version !== input.expectedLockStateVersion
      || appearanceRow.character_uid !== input.characterUid
      || costumeRow.character_uid !== input.characterUid
      || appearanceRow.identity_version_uid !== lock.identity_version_uid
      || costumeRow.identity_version_uid !== lock.identity_version_uid
    ) throw new TypeError('Character reference package input is invalid');

    visualVersion('appearance', appearanceRow);
    visualVersion('costume', costumeRow);
    for (const item of input.items) {
      const logicalUri = `asset://characters/${input.characterUid}/reference-packages/${input.packageUid}/${item.kind}`;
      const evidence = requiredRow(
        prepared.assetEvidence.get({
          assetVersionUid: item.assetVersionUid,
          characterUid: input.characterUid,
          logicalUri,
        }),
        'character reference asset version',
        item.assetVersionUid,
      );
      prepared.insertItem.run({
        ...item,
        ...evidence,
        packageUid: input.packageUid,
        characterUid: input.characterUid,
      });
    }
    prepared.insertPackage.run({
      packageUid: input.packageUid,
      characterUid: input.characterUid,
      identityVersionUid: lock.identity_version_uid,
      candidateUid: lock.candidate_uid,
      lockEventUid: lock.uid,
      lockStateVersion: lock.state_version,
      appearanceVersionUid: appearanceRow.uid,
      costumeVersionUid: costumeRow.uid,
      appearanceMetadataJson: appearanceRow.metadata_json,
      costumeMetadataJson: costumeRow.metadata_json,
      createdAtEpochMs: input.createdAtEpochMs,
    });
  });

  function mapPackage(row) {
    try {
      const prepared = getStatements();
      if (prepared.validItemCount.get({
        packageUid: row.uid,
        characterUid: row.character_uid,
      }) !== 10) throw new TypeError();
      const lock = prepared.getLock.get(row.lock_event_uid);
      const appearanceRow = prepared.getAppearance.get(row.appearance_version_uid);
      const costumeRow = prepared.getCostume.get(row.costume_version_uid);
      if (
        !lock
        || !appearanceRow
        || !costumeRow
        || lock.character_uid !== row.character_uid
        || lock.identity_version_uid !== row.identity_version_uid
        || lock.candidate_uid !== row.candidate_uid
        || lock.operation !== 'lock'
        || lock.state_version !== row.lock_state_version
        || appearanceRow.character_uid !== row.character_uid
        || costumeRow.character_uid !== row.character_uid
        || appearanceRow.identity_version_uid !== row.identity_version_uid
        || costumeRow.identity_version_uid !== row.identity_version_uid
        || appearanceRow.metadata_json !== row.appearance_metadata_json
        || costumeRow.metadata_json !== row.costume_metadata_json
      ) throw new TypeError();
      const appearance = visualVersion('appearance', appearanceRow);
      const costume = visualVersion('costume', costumeRow);
      return createCharacterReferencePackage({
        schemaVersion: '5.0',
        packageUid: row.uid,
        characterUid: row.character_uid,
        identityVersionUid: row.identity_version_uid,
        candidateUid: row.candidate_uid,
        lockEventUid: row.lock_event_uid,
        lockStateVersion: row.lock_state_version,
        appearanceVersion: {
          uid: appearance.uid,
          name: appearance.metadata.name,
          description: appearance.metadata.description,
          colorAnchors: appearance.metadata.colorAnchors,
        },
        defaultCostumeVersion: {
          uid: costume.uid,
          name: costume.metadata.name,
          description: costume.metadata.description,
          colorAnchors: costume.metadata.colorAnchors,
        },
        items: prepared.listItems.all(row.uid).map((item) => ({
          uid: item.uid,
          ordinal: item.ordinal,
          kind: item.item_kind,
          assetVersionUid: item.asset_version_uid,
          logicalUri: item.logical_uri,
          mediaType: item.media_type,
          width: item.width,
          height: item.height,
          contentSha256: item.content_sha256,
        })),
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      throw new V2RepositoryDataError('character reference package', 'persisted record');
    }
  }

  function get(packageUid) {
    const canonicalPackageUid = validation.canonicalUid(packageUid);
    const row = requiredRow(
      getStatements().getPackage.get(canonicalPackageUid),
      'character reference package',
      canonicalPackageUid,
    );
    return mapPackage(row);
  }

  return Object.freeze({
    create(value) {
      const input = createCharacterReferencePackageInput(value);
      executeWrite('character reference package', 'created', () => insertTransaction(input));
      return get(input.packageUid);
    },

    get,

    list(characterUid) {
      const canonicalCharacterUid = validation.canonicalUid(characterUid);
      requiredRow(
        getStatements().getCharacter.get(canonicalCharacterUid),
        'character',
        canonicalCharacterUid,
      );
      return Object.freeze(
        getStatements().listPackages.all(canonicalCharacterUid).map((row) => mapPackage(row)),
      );
    },
  });
}

module.exports = { createCharacterReferencePackageRepository };
