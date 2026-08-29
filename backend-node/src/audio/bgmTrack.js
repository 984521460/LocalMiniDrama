'use strict';

const {
  createAssetVersionEvidence,
} = require('../assets/assetVersionEvidence');
const {
  canonicalUid,
  epoch,
  exactObject,
  fail,
} = require('./audioContract');
const {
  assertBgmLicenseExportEligible,
  createBgmLicense,
  publicText,
} = require('./bgmLicense');

const TRACK_KEYS = Object.freeze([
  'schemaVersion',
  'uid',
  'dramaUid',
  'title',
  'sourceKind',
  'providerId',
  'assetVersion',
  'license',
  'createdAtEpochMs',
]);
const AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
]);
const EXTENSION_BY_MIME = Object.freeze({
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
});

function createBgmTrack(value, code = 'BGM_TRACK_INVALID') {
  const input = exactObject(value, TRACK_KEYS, code);
  if (input.schemaVersion !== 'bgm-track.v1'
    || input.sourceKind !== 'local-import'
    || input.providerId !== 'local-library') fail(code);
  const uid = canonicalUid(input.uid, code);
  const dramaUid = canonicalUid(input.dramaUid, code);
  let assetVersion;
  try {
    assetVersion = createAssetVersionEvidence(input.assetVersion);
  } catch {
    return fail(code);
  }
  if (assetVersion.storageProvider !== 'local'
    || !AUDIO_MIME_TYPES.has(assetVersion.mimeType)
    || typeof assetVersion.sha256 !== 'string'
    || assetVersion.width !== null
    || assetVersion.height !== null
    || !Number.isSafeInteger(assetVersion.durationMs)
    || assetVersion.durationMs < 1
    || assetVersion.durationMs > 86_400_000) fail(code);
  const extension = EXTENSION_BY_MIME[assetVersion.mimeType];
  const expectedLogicalUri = `asset://dramas/${dramaUid}/bgm/${assetVersion.assetUid}/${assetVersion.uid}`;
  const expectedRelativePath = `projects/${dramaUid}/assets/bgm/${assetVersion.assetUid}/${assetVersion.uid}.${extension}`;
  if (assetVersion.logicalUri !== expectedLogicalUri
    || assetVersion.relativePath !== expectedRelativePath) fail(code);
  let license;
  try {
    license = createBgmLicense(input.license, code);
  } catch {
    return fail(code);
  }
  const createdAtEpochMs = epoch(input.createdAtEpochMs, code);
  if (license.attestedAtEpochMs > createdAtEpochMs) fail(code);
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    uid,
    dramaUid,
    title: publicText(input.title, code),
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    assetVersion,
    license,
    createdAtEpochMs,
  });
}

function parseBgmTrack(value) {
  return createBgmTrack(value, 'BGM_TRACK_INVALID');
}

function assertBgmTrackExportReady(value) {
  const track = createBgmTrack(value);
  assertBgmLicenseExportEligible(track.license);
  return track;
}

module.exports = Object.freeze({
  AUDIO_MIME_TYPES,
  EXTENSION_BY_MIME,
  assertBgmTrackExportReady,
  createBgmTrack,
  parseBgmTrack,
});
