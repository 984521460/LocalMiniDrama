'use strict';

const { createHash } = require('node:crypto');

const PROFILE = Object.freeze({
  schemaVersion: 'character-candidate-generator-profile.v1',
  uid: 'c22f9231-0d79-43b9-93a6-d5e28d1d4401',
  manifestUid: '66512afd-a10f-447d-8f1f-1428b6dc1021',
  adapter: 'configured-image',
  promptVersion: 'character-candidate-portrait.v1',
  outputMediaType: 'image/png',
  candidateCount: 4,
});

const MANIFEST = Object.freeze({
  schemaVersion: 'character-candidate-adapter-manifest.v1',
  uid: PROFILE.manifestUid,
  adapter: 'configured-image',
  version: '1.0.0',
  inputKind: 'text-to-image',
  outputKind: 'single-portrait',
});

function profileJson() {
  return '{"schemaVersion":"character-candidate-generator-profile.v1"'
    + ',"uid":"c22f9231-0d79-43b9-93a6-d5e28d1d4401"'
    + ',"manifestUid":"66512afd-a10f-447d-8f1f-1428b6dc1021"'
    + ',"adapter":"configured-image"'
    + ',"promptVersion":"character-candidate-portrait.v1"'
    + ',"outputMediaType":"image/png","candidateCount":4}';
}

function manifestJson() {
  return '{"schemaVersion":"character-candidate-adapter-manifest.v1"'
    + ',"uid":"66512afd-a10f-447d-8f1f-1428b6dc1021"'
    + ',"adapter":"configured-image","version":"1.0.0"'
    + ',"inputKind":"text-to-image","outputKind":"single-portrait"}';
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const PROFILE_JSON = profileJson();
const MANIFEST_JSON = manifestJson();
const PROFILE_SHA256 = sha256(PROFILE_JSON);
const MANIFEST_SHA256 = sha256(MANIFEST_JSON);

function parseConfiguredCharacterCandidateProfile(value) {
  if (value !== PROFILE_JSON) throw new TypeError('Character candidate profile is invalid');
  return PROFILE;
}

function parseConfiguredCharacterCandidateManifest(value) {
  if (value !== MANIFEST_JSON) throw new TypeError('Character candidate manifest is invalid');
  return MANIFEST;
}

module.exports = Object.freeze({
  MANIFEST,
  MANIFEST_JSON,
  MANIFEST_SHA256,
  PROFILE,
  PROFILE_JSON,
  PROFILE_SHA256,
  parseConfiguredCharacterCandidateManifest,
  parseConfiguredCharacterCandidateProfile,
});
