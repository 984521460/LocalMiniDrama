'use strict';

const {
  assetVersionEvidenceFromRow,
  assetVersionEvidenceMatches,
} = require('../../assets/assetVersionEvidence');
const {
  canonicalUid,
  epoch,
  exactObject,
} = require('../../audio/audioContract');
const { createBgmLicense } = require('../../audio/bgmLicense');
const { createBgmTrack } = require('../../audio/bgmTrack');
const {
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');

const CREATE_KEYS = Object.freeze([
  'schemaVersion',
  'uid',
  'dramaUid',
  'title',
  'sourceKind',
  'providerId',
  'assetVersionUid',
  'license',
  'createdAtEpochMs',
]);

function createBgmTrackRepository(database) {
  let statements;

  function getStatements() {
    if (statements) return statements;
    const select = `
      SELECT
        track.*,
        asset.owner_type AS live_asset_owner_type,
        asset.owner_uid AS live_asset_owner_uid,
        asset.asset_type AS live_asset_type,
        asset.status AS live_asset_status,
        version.asset_uid AS live_version_asset_uid,
        version.storage_provider AS live_version_storage_provider,
        version.logical_uri AS live_version_logical_uri,
        version.relative_path AS live_version_relative_path,
        version.sha256 AS live_version_sha256,
        version.mime_type AS live_version_mime_type,
        version.width AS live_version_width,
        version.height AS live_version_height,
        version.duration_ms AS live_version_duration_ms,
        version.parent_uid AS live_version_parent_uid,
        version.status AS live_version_status,
        version.created_at AS live_version_created_at,
        license.track_uid AS live_license_track_uid,
        license.schema_version AS live_license_schema_version,
        license.basis AS live_license_basis,
        license.attestation_kind AS live_license_attestation_kind,
        license.commercial_use_allowed AS live_license_commercial_use_allowed,
        license.derivatives_allowed AS live_license_derivatives_allowed,
        license.attribution_required AS live_license_attribution_required,
        license.attribution_text AS live_license_attribution_text,
        license.attested_at_epoch_ms AS live_license_attested_at_epoch_ms
      FROM bgm_tracks AS track
      LEFT JOIN assets AS asset ON asset.uid=track.asset_uid
      LEFT JOIN asset_versions AS version ON version.uid=track.asset_version_uid
      LEFT JOIN bgm_licenses AS license ON license.uid=track.license_uid
    `;
    statements = Object.freeze({
      get: database.prepare(`${select} WHERE track.uid=?`),
      list: database.prepare(`${select} WHERE track.drama_uid=? ORDER BY track.created_at_epoch_ms,track.uid`),
      getAsset: database.prepare('SELECT * FROM assets WHERE uid=?'),
      getVersion: database.prepare('SELECT * FROM asset_versions WHERE uid=?'),
      getLicense: database.prepare('SELECT * FROM bgm_licenses WHERE uid=?'),
      licenseIdentity: database.prepare(`
        SELECT
          license_uid,license_basis,commercial_use_allowed,derivatives_allowed,
          attribution_required,attribution_text,license_attested_at_epoch_ms
        FROM bgm_tracks
        WHERE license_uid=?
        ORDER BY uid
      `),
      insert: database.prepare(`
        INSERT INTO bgm_tracks (
          uid,drama_uid,title,source_kind,provider_id,asset_uid,asset_version_uid,
          license_uid,license_basis,commercial_use_allowed,
          derivatives_allowed,attribution_required,attribution_text,license_attested_at_epoch_ms,
          version_storage_provider,version_logical_uri,version_relative_path,version_sha256,
          version_mime_type,version_width,version_height,version_duration_ms,version_parent_uid,
          version_status,version_created_at,created_at_epoch_ms
        ) VALUES (
          @uid,@dramaUid,@title,@sourceKind,@providerId,@assetUid,@assetVersionUid,
          @licenseUid,@licenseBasis,@commercialUseAllowed,
          @derivativesAllowed,@attributionRequired,@attributionText,@licenseAttestedAtEpochMs,
          @versionStorageProvider,@versionLogicalUri,@versionRelativePath,@versionSha256,
          @versionMimeType,@versionWidth,@versionHeight,@versionDurationMs,@versionParentUid,
          @versionStatus,@versionCreatedAt,@createdAtEpochMs
        )
      `),
      insertLicense: database.prepare(`
        INSERT INTO bgm_licenses (
          uid,track_uid,schema_version,basis,attestation_kind,commercial_use_allowed,
          derivatives_allowed,attribution_required,attribution_text,attested_at_epoch_ms
        ) VALUES (
          @uid,@trackUid,@schemaVersion,@basis,@attestationKind,@commercialUseAllowed,
          @derivativesAllowed,@attributionRequired,@attributionText,@attestedAtEpochMs
        )
      `),
    });
    return statements;
  }

  function dataError(field) {
    throw new V2RepositoryDataError('bgm track', field);
  }

  function storedTrack(row) {
    try {
      return createBgmTrack({
        schemaVersion: 'bgm-track.v1',
        uid: row.uid,
        dramaUid: row.drama_uid,
        title: row.title,
        sourceKind: row.source_kind,
        providerId: row.provider_id,
        assetVersion: {
          uid: row.asset_version_uid,
          assetUid: row.asset_uid,
          storageProvider: row.version_storage_provider,
          logicalUri: row.version_logical_uri,
          relativePath: row.version_relative_path,
          sha256: row.version_sha256,
          mimeType: row.version_mime_type,
          width: row.version_width,
          height: row.version_height,
          durationMs: row.version_duration_ms,
          parentUid: row.version_parent_uid,
          status: row.version_status,
          createdAt: row.version_created_at,
        },
        license: {
          schemaVersion: 'bgm-license.v1',
          uid: row.license_uid,
          basis: row.license_basis,
          attestationKind: 'user-attestation',
          commercialUseAllowed: row.commercial_use_allowed === 1,
          derivativesAllowed: row.derivatives_allowed === 1,
          attributionRequired: row.attribution_required === 1,
          attributionText: row.attribution_text,
          attestedAtEpochMs: row.license_attested_at_epoch_ms,
        },
        createdAtEpochMs: row.created_at_epoch_ms,
      });
    } catch {
      return dataError('record');
    }
  }

  function licenseMatches(left, right) {
    return left.schemaVersion === right.schemaVersion
      && left.uid === right.uid
      && left.basis === right.basis
      && left.attestationKind === right.attestationKind
      && left.commercialUseAllowed === right.commercialUseAllowed
      && left.derivativesAllowed === right.derivativesAllowed
      && left.attributionRequired === right.attributionRequired
      && left.attributionText === right.attributionText
      && left.attestedAtEpochMs === right.attestedAtEpochMs;
  }

  function independentLicense(row) {
    try {
      return createBgmLicense({
        schemaVersion: row.schema_version,
        uid: row.uid,
        basis: row.basis,
        attestationKind: row.attestation_kind,
        commercialUseAllowed: row.commercial_use_allowed === 1,
        derivativesAllowed: row.derivatives_allowed === 1,
        attributionRequired: row.attribution_required === 1,
        attributionText: row.attribution_text,
        attestedAtEpochMs: row.attested_at_epoch_ms,
      });
    } catch {
      return dataError('license evidence');
    }
  }

  function map(row) {
    if (!row) return null;
    const track = storedTrack(row);
    if (row.live_asset_owner_type !== 'drama'
      || row.live_asset_owner_uid !== track.dramaUid
      || row.live_asset_type !== 'bgm'
      || !['ready', 'archived'].includes(row.live_asset_status)
      || row.live_version_asset_uid !== track.assetVersion.assetUid) dataError('ownership');
    let liveEvidence;
    try {
      liveEvidence = assetVersionEvidenceFromRow({
        uid: track.assetVersion.uid,
        asset_uid: row.live_version_asset_uid,
        storage_provider: row.live_version_storage_provider,
        logical_uri: row.live_version_logical_uri,
        relative_path: row.live_version_relative_path,
        sha256: row.live_version_sha256,
        mime_type: row.live_version_mime_type,
        width: row.live_version_width,
        height: row.live_version_height,
        duration_ms: row.live_version_duration_ms,
        parent_uid: row.live_version_parent_uid,
        status: row.live_version_status,
        created_at: row.live_version_created_at,
      });
    } catch {
      return dataError('asset version');
    }
    if (!assetVersionEvidenceMatches(track.assetVersion, liveEvidence)) dataError('asset version');
    const liveLicense = independentLicense({
      schema_version: row.live_license_schema_version,
      uid: track.license.uid,
      basis: row.live_license_basis,
      attestation_kind: row.live_license_attestation_kind,
      commercial_use_allowed: row.live_license_commercial_use_allowed,
      derivatives_allowed: row.live_license_derivatives_allowed,
      attribution_required: row.live_license_attribution_required,
      attribution_text: row.live_license_attribution_text,
      attested_at_epoch_ms: row.live_license_attested_at_epoch_ms,
    });
    if (row.live_license_track_uid !== track.uid
      || !licenseMatches(track.license, liveLicense)) dataError('license evidence');
    const licenseRows = getStatements().licenseIdentity.all(track.license.uid);
    if (licenseRows.length === 0 || licenseRows.some((licenseRow) => (
      licenseRow.license_uid !== track.license.uid
      || licenseRow.license_basis !== track.license.basis
      || licenseRow.commercial_use_allowed !== Number(track.license.commercialUseAllowed)
      || licenseRow.derivatives_allowed !== Number(track.license.derivativesAllowed)
      || licenseRow.attribution_required !== Number(track.license.attributionRequired)
      || licenseRow.attribution_text !== track.license.attributionText
      || licenseRow.license_attested_at_epoch_ms !== track.license.attestedAtEpochMs
    ))) dataError('license identity');
    return track;
  }

  function get(uid) {
    try {
      canonicalUid(uid, 'BGM_TRACK_INVALID');
    } catch {
      throw new TypeError('BGM track repository input is invalid');
    }
    return map(requiredRow(getStatements().get.get(uid), 'bgm track', uid));
  }

  const insertTransaction = database.transaction((record) => {
    const existingLicenseRow = getStatements().getLicense.get(record.license.uid);
    if (existingLicenseRow) {
      if (existingLicenseRow.track_uid !== record.uid
        || !licenseMatches(record.license, independentLicense(existingLicenseRow))) {
        throw new TypeError('BGM track repository input is invalid');
      }
    } else {
      getStatements().insertLicense.run({
        uid: record.license.uid,
        trackUid: record.uid,
        schemaVersion: record.license.schemaVersion,
        basis: record.license.basis,
        attestationKind: record.license.attestationKind,
        commercialUseAllowed: Number(record.license.commercialUseAllowed),
        derivativesAllowed: Number(record.license.derivativesAllowed),
        attributionRequired: Number(record.license.attributionRequired),
        attributionText: record.license.attributionText,
        attestedAtEpochMs: record.license.attestedAtEpochMs,
      });
    }
    getStatements().insert.run({
      uid: record.uid,
      dramaUid: record.dramaUid,
      title: record.title,
      sourceKind: record.sourceKind,
      providerId: record.providerId,
      assetUid: record.assetVersion.assetUid,
      assetVersionUid: record.assetVersion.uid,
      licenseUid: record.license.uid,
      licenseBasis: record.license.basis,
      commercialUseAllowed: Number(record.license.commercialUseAllowed),
      derivativesAllowed: Number(record.license.derivativesAllowed),
      attributionRequired: Number(record.license.attributionRequired),
      attributionText: record.license.attributionText,
      licenseAttestedAtEpochMs: record.license.attestedAtEpochMs,
      versionStorageProvider: record.assetVersion.storageProvider,
      versionLogicalUri: record.assetVersion.logicalUri,
      versionRelativePath: record.assetVersion.relativePath,
      versionSha256: record.assetVersion.sha256,
      versionMimeType: record.assetVersion.mimeType,
      versionWidth: record.assetVersion.width,
      versionHeight: record.assetVersion.height,
      versionDurationMs: record.assetVersion.durationMs,
      versionParentUid: record.assetVersion.parentUid,
      versionStatus: record.assetVersion.status,
      versionCreatedAt: record.assetVersion.createdAt,
      createdAtEpochMs: record.createdAtEpochMs,
    });
    return get(record.uid);
  });

  return Object.freeze({
    create(value) {
      let input;
      let license;
      try {
        input = exactObject(value, CREATE_KEYS, 'BGM_TRACK_INVALID');
        canonicalUid(input.uid, 'BGM_TRACK_INVALID');
        canonicalUid(input.dramaUid, 'BGM_TRACK_INVALID');
        canonicalUid(input.assetVersionUid, 'BGM_TRACK_INVALID');
        epoch(input.createdAtEpochMs, 'BGM_TRACK_INVALID');
        license = createBgmLicense(input.license, 'BGM_TRACK_INVALID');
      } catch {
        throw new TypeError('BGM track repository input is invalid');
      }
      const versionRow = requiredRow(
        getStatements().getVersion.get(input.assetVersionUid),
        'asset version',
        input.assetVersionUid,
      );
      const assetRow = requiredRow(
        getStatements().getAsset.get(versionRow.asset_uid),
        'asset',
        versionRow.asset_uid,
      );
      if (assetRow.owner_type !== 'drama' || assetRow.owner_uid !== input.dramaUid
        || assetRow.asset_type !== 'bgm' || !['ready', 'archived'].includes(assetRow.status)) {
        throw new TypeError('BGM track repository input is invalid');
      }
      let record;
      try {
        record = createBgmTrack({
          schemaVersion: input.schemaVersion,
          uid: input.uid,
          dramaUid: input.dramaUid,
          title: input.title,
          sourceKind: input.sourceKind,
          providerId: input.providerId,
          assetVersion: assetVersionEvidenceFromRow(versionRow),
          license,
          createdAtEpochMs: input.createdAtEpochMs,
        });
      } catch {
        throw new TypeError('BGM track repository input is invalid');
      }
      return executeWrite('bgm track', 'created', () => insertTransaction(record));
    },

    get,

    listByDrama(dramaUid) {
      try {
        canonicalUid(dramaUid, 'BGM_TRACK_INVALID');
      } catch {
        throw new TypeError('BGM track repository input is invalid');
      }
      return Object.freeze(getStatements().list.all(dramaUid).map(map));
    },
  });
}

module.exports = { createBgmTrackRepository };
