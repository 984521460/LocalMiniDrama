'use strict';

const {
  canonicalUid,
  epoch,
  exactObject,
  fail,
} = require('./audioContract');

const LICENSE_KEYS = Object.freeze([
  'schemaVersion',
  'uid',
  'basis',
  'attestationKind',
  'commercialUseAllowed',
  'derivativesAllowed',
  'attributionRequired',
  'attributionText',
  'attestedAtEpochMs',
]);
const LICENSE_BASES = new Set(['user-owned', 'licensed', 'public-domain', 'provider-grant']);
const PRIVATE_PATH = /(?:file:\/\/|(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|users|root|private|tmp|var|mnt)\/|~[\\/]|%[A-Za-z_][A-Za-z0-9_]*%[\\/]|\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*(?:\})?[\\/]))/iu;
const SECRET_TEXT = /(?:\b(?:authorization|api[_-]?key|access[_-]?key|secret[_-]?key|token|password)\b\s*[:=]|\bbearer\s+[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{12,})/iu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UNPAIRED_SURROGATE = /(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/u;
const PUBLIC_TEXT_SHAPE = /^(?:[\p{L}\p{N}]|[\p{L}\p{N}](?:[\p{L}\p{N} ._()'&-]{0,254}[\p{L}\p{N}._()'&-]))$/u;

function publicText(value, code = 'BGM_LICENSE_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) fail(code);
  if (value !== value.trim() || value.normalize('NFC') !== value
    || CONTROL.test(value) || UNPAIRED_SURROGATE.test(value) || !PUBLIC_TEXT_SHAPE.test(value)
    || PRIVATE_PATH.test(value) || SECRET_TEXT.test(value)) fail(code);
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > 256) fail(code);
  }
  if (Buffer.byteLength(value, 'utf8') > 1024) fail(code);
  return value;
}

function createBgmLicense(value, code = 'BGM_LICENSE_INVALID') {
  const input = exactObject(value, LICENSE_KEYS, code);
  if (input.schemaVersion !== 'bgm-license.v1'
    || !LICENSE_BASES.has(input.basis)
    || input.attestationKind !== 'user-attestation'
    || typeof input.commercialUseAllowed !== 'boolean'
    || typeof input.derivativesAllowed !== 'boolean'
    || typeof input.attributionRequired !== 'boolean') fail(code);
  const uid = canonicalUid(input.uid, code);
  if (input.attributionRequired || input.attributionText !== null) fail(code);
  const attributionText = null;
  return Object.freeze({
    schemaVersion: input.schemaVersion,
    uid,
    basis: input.basis,
    attestationKind: input.attestationKind,
    commercialUseAllowed: input.commercialUseAllowed,
    derivativesAllowed: input.derivativesAllowed,
    attributionRequired: input.attributionRequired,
    attributionText,
    attestedAtEpochMs: epoch(input.attestedAtEpochMs, code),
  });
}

function assertBgmLicenseExportEligible(value) {
  const license = createBgmLicense(value);
  if (!license.commercialUseAllowed || !license.derivativesAllowed) {
    fail('BGM_LICENSE_NOT_EXPORTABLE');
  }
  return license;
}

module.exports = Object.freeze({
  assertBgmLicenseExportEligible,
  createBgmLicense,
  publicText,
});
