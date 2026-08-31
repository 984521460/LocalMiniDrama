'use strict';

const { types: { isProxy } } = require('node:util');

const { createAssetVersionEvidence } = require('../assets/assetVersionEvidence');
const {
  boundedInteger,
  canonicalHash,
  canonicalJson,
  canonicalUid,
  denseArray,
  epoch,
  exactObject,
  fail,
  frozenArray,
  sha256,
  textHash,
} = require('../audio/audioContract');

const INPUT_CODE = 'MEDIA_PROBE_INPUT_INVALID';
const DATA_CODE = 'MEDIA_PROBE_DATA_INVALID';
const MEDIA_PROBE_SCHEMA_VERSION = 'media-probe-evidence.v1';
const MEDIA_PROBE_ALGORITHM_VERSION = 'ffprobe-full-decode.v1';
const MAX_LOCAL_MEDIA_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_DURATION_MS = 3_600_000;
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'assetVersion', 'bytes', 'durationMs', 'formatNames',
  'video', 'audio', 'decoded', 'probedAtEpochMs',
]);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'uid', 'assetVersionUid', 'assetUid',
  'assetVersionSha256', 'relativePathSha256', 'mimeType', 'mediaKind', 'bytes',
  'durationMs', 'formatNames', 'video', 'audio', 'decoded', 'probedAtEpochMs',
  'evidenceSha256',
]);
const VIDEO_KEYS = Object.freeze([
  'codecName', 'width', 'height', 'pixelFormat', 'averageFrameRate', 'timeBase',
  'sampleAspectRatio', 'displayAspectRatio', 'frameCount',
]);
const AUDIO_KEYS = Object.freeze([
  'codecName', 'sampleRateHz', 'channels', 'channelLayout', 'sampleFormat',
]);
const RATIONAL_KEYS = Object.freeze(['numerator', 'denominator']);
const TRUSTED_EVIDENCE = new WeakSet();
const DEFINE_PROPERTY = Object.defineProperty;
const REGEXP_TEST = RegExp.prototype.test;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const STRING_INCLUDES = String.prototype.includes;
const STRING_TRIM = String.prototype.trim;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

function append(target, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function invalid(code = DATA_CODE) {
  fail(code);
}

function boundedToken(value, maximumBytes, code) {
  if (typeof value !== 'string' || value.length < 1
    || value !== Reflect.apply(STRING_TRIM, value, [])
    || Reflect.apply(STRING_INCLUDES, value, ['\0'])
    || Buffer.byteLength(value, 'utf8') > maximumBytes
    || !Reflect.apply(REGEXP_TEST, /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u, [value])) invalid(code);
  return value;
}

function audioLayout(value, code) {
  if (typeof value !== 'string' || value.length < 1
    || value !== Reflect.apply(STRING_TRIM, value, [])
    || Reflect.apply(STRING_INCLUDES, value, ['\0'])
    || Buffer.byteLength(value, 'utf8') > 128
    || !Reflect.apply(REGEXP_TEST, /^[A-Za-z0-9][A-Za-z0-9._:+()-]*$/u, [value])) {
    invalid(code);
  }
  return value;
}

function rational(value, code, { numeratorMaximum = 1_000_000, denominatorMaximum = 1_000_000 } = {}) {
  const input = exactObject(value, RATIONAL_KEYS, code);
  const numerator = boundedInteger(input.numerator, 1, numeratorMaximum, code);
  const denominator = boundedInteger(input.denominator, 1, denominatorMaximum, code);
  return Object.freeze({ numerator, denominator });
}

function aspectRatio(value, code) {
  if (typeof value !== 'string'
    || !Reflect.apply(REGEXP_TEST, /^[1-9][0-9]{0,5}:[1-9][0-9]{0,5}$/u, [value])) {
    invalid(code);
  }
  return value;
}

function videoRecord(value, code) {
  if (value === null) return null;
  const input = exactObject(value, VIDEO_KEYS, code);
  return Object.freeze({
    codecName: boundedToken(input.codecName, 64, code),
    width: boundedInteger(input.width, 1, 16_384, code),
    height: boundedInteger(input.height, 1, 16_384, code),
    pixelFormat: boundedToken(input.pixelFormat, 64, code),
    averageFrameRate: rational(input.averageFrameRate, code, {
      denominatorMaximum: 1_000_000_000,
    }),
    timeBase: rational(input.timeBase, code, {
      numeratorMaximum: 1_000_000,
      denominatorMaximum: 1_000_000_000,
    }),
    sampleAspectRatio: aspectRatio(input.sampleAspectRatio, code),
    displayAspectRatio: aspectRatio(input.displayAspectRatio, code),
    frameCount: boundedInteger(input.frameCount, 1, 10_000_000, code),
  });
}

function audioRecord(value, code) {
  if (value === null) return null;
  const input = exactObject(value, AUDIO_KEYS, code);
  return Object.freeze({
    codecName: boundedToken(input.codecName, 64, code),
    sampleRateHz: boundedInteger(input.sampleRateHz, 8_000, 384_000, code),
    channels: boundedInteger(input.channels, 1, 32, code),
    channelLayout: audioLayout(input.channelLayout, code),
    sampleFormat: boundedToken(input.sampleFormat, 64, code),
  });
}

function formatNames(value, code) {
  const values = denseArray(value, 16, code);
  if (values.length < 1) invalid(code);
  const normalized = [];
  const unique = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    if (typeof entry !== 'string'
      || !Reflect.apply(REGEXP_TEST, /^[a-z0-9][a-z0-9_-]{0,31}$/u, [entry])
      || Reflect.apply(SET_HAS, unique, [entry])) invalid(code);
    Reflect.apply(SET_ADD, unique, [entry]);
    let target = normalized.length;
    while (target > 0 && normalized[target - 1] > entry) target -= 1;
    append(normalized, undefined);
    for (let move = normalized.length - 1; move > target; move -= 1) {
      Reflect.apply(DEFINE_PROPERTY, Object, [normalized, String(move), {
        configurable: true,
        enumerable: true,
        writable: true,
        value: normalized[move - 1],
      }]);
    }
    Reflect.apply(DEFINE_PROPERTY, Object, [normalized, String(target), {
      configurable: true,
      enumerable: true,
      writable: true,
      value: entry,
    }]);
  }
  return frozenArray(normalized);
}

function mediaKindFromMime(value, code) {
  if (value === 'video/mp4') return 'video';
  if (value === 'audio/aac' || value === 'audio/flac' || value === 'audio/mpeg'
    || value === 'audio/wav' || value === 'audio/x-wav') {
    return 'audio';
  }
  return invalid(code);
}

function assertMediaRelations({ version, mediaKind, video, audio, durationMs, names, code }) {
  if (version.sha256 === null || version.durationMs === null || version.durationMs < 1) invalid(code);
  const toleranceMs = mediaKind === 'video' ? 300 : 100;
  if (Math.abs(durationMs - version.durationMs) > toleranceMs) invalid(code);
  if (mediaKind === 'video') {
    if (video === null || video.width !== version.width || video.height !== version.height
      || (!includes(names, 'mp4') && !includes(names, 'mov'))) invalid(code);
  } else if (video !== null || audio === null) {
    invalid(code);
  }
}

function canonicalInput(value, code) {
  const input = exactObject(value, INPUT_KEYS, code);
  if (input.schemaVersion !== '8.0' || input.decoded !== true) invalid(code);
  let version;
  try {
    version = createAssetVersionEvidence(input.assetVersion);
  } catch {
    return invalid(code);
  }
  if (version.storageProvider !== 'local') invalid(code);
  const mediaKind = mediaKindFromMime(version.mimeType, code);
  const video = videoRecord(input.video, code);
  const audio = audioRecord(input.audio, code);
  const durationMs = boundedInteger(input.durationMs, 1, MAX_DURATION_MS, code);
  const names = formatNames(input.formatNames, code);
  assertMediaRelations({ version, mediaKind, video, audio, durationMs, names, code });
  const probedAtEpochMs = epoch(input.probedAtEpochMs, code);
  if (probedAtEpochMs < Date.parse(version.createdAt)) invalid(code);
  return Object.freeze({
    uid: canonicalUid(input.uid, code),
    version,
    mediaKind,
    bytes: boundedInteger(input.bytes, 1, MAX_LOCAL_MEDIA_BYTES, code),
    durationMs,
    formatNames: names,
    video,
    audio,
    probedAtEpochMs,
  });
}

function buildRecord(value) {
  const base = Object.freeze({
    schemaVersion: MEDIA_PROBE_SCHEMA_VERSION,
    algorithmVersion: MEDIA_PROBE_ALGORITHM_VERSION,
    uid: value.uid,
    assetVersionUid: value.version.uid,
    assetUid: value.version.assetUid,
    assetVersionSha256: value.version.sha256,
    relativePathSha256: textHash(value.version.relativePath),
    mimeType: value.version.mimeType,
    mediaKind: value.mediaKind,
    bytes: value.bytes,
    durationMs: value.durationMs,
    formatNames: value.formatNames,
    video: value.video,
    audio: value.audio,
    decoded: true,
    probedAtEpochMs: value.probedAtEpochMs,
  });
  return Object.freeze({ ...base, evidenceSha256: canonicalHash(base) });
}

function createMediaProbeEvidence(value) {
  try {
    return buildRecord(canonicalInput(value, INPUT_CODE));
  } catch {
    return invalid(INPUT_CODE);
  }
}

function parseMediaProbeEvidenceRecord(value) {
  try {
    const input = exactObject(value, RECORD_KEYS, DATA_CODE);
    if (input.schemaVersion !== MEDIA_PROBE_SCHEMA_VERSION
      || input.algorithmVersion !== MEDIA_PROBE_ALGORITHM_VERSION
      || input.decoded !== true) invalid();
    const canonical = Object.freeze({
      schemaVersion: MEDIA_PROBE_SCHEMA_VERSION,
      algorithmVersion: MEDIA_PROBE_ALGORITHM_VERSION,
      uid: canonicalUid(input.uid, DATA_CODE),
      assetVersionUid: canonicalUid(input.assetVersionUid, DATA_CODE),
      assetUid: canonicalUid(input.assetUid, DATA_CODE),
      assetVersionSha256: sha256(input.assetVersionSha256, DATA_CODE),
      relativePathSha256: sha256(input.relativePathSha256, DATA_CODE),
      mimeType: input.mimeType,
      mediaKind: input.mediaKind,
      bytes: boundedInteger(input.bytes, 1, MAX_LOCAL_MEDIA_BYTES, DATA_CODE),
      durationMs: boundedInteger(input.durationMs, 1, MAX_DURATION_MS, DATA_CODE),
      formatNames: formatNames(input.formatNames, DATA_CODE),
      video: videoRecord(input.video, DATA_CODE),
      audio: audioRecord(input.audio, DATA_CODE),
      decoded: true,
      probedAtEpochMs: epoch(input.probedAtEpochMs, DATA_CODE),
    });
    if (canonical.mediaKind !== 'video' && canonical.mediaKind !== 'audio') invalid();
    if (mediaKindFromMime(canonical.mimeType, DATA_CODE) !== canonical.mediaKind
      || (canonical.mediaKind === 'video' && canonical.video === null)
      || (canonical.mediaKind === 'audio' && (canonical.video !== null || canonical.audio === null))) {
      invalid();
    }
    const expectedHash = canonicalHash(canonical);
    if (sha256(input.evidenceSha256, DATA_CODE) !== expectedHash) invalid();
    return Object.freeze({ ...canonical, evidenceSha256: expectedHash });
  } catch {
    return invalid();
  }
}

function createMediaProbeEvidenceVerifier(value) {
  const dependencies = exactObject(value, ['loadTrustedEnvelope'], INPUT_CODE);
  if (typeof dependencies.loadTrustedEnvelope !== 'function'
    || isProxy(dependencies.loadTrustedEnvelope)) invalid(INPUT_CODE);
  const loadTrustedEnvelope = dependencies.loadTrustedEnvelope;
  return Object.freeze({
    verify(recordValue, expectedUid) {
      try {
        const uid = canonicalUid(expectedUid, DATA_CODE);
        const stored = parseMediaProbeEvidenceRecord(recordValue);
        const envelope = exactObject(loadTrustedEnvelope(uid), INPUT_KEYS, DATA_CODE);
        if (envelope.uid !== uid) invalid();
        const expected = createMediaProbeEvidence(envelope);
        if (canonicalJson(stored) !== canonicalJson(expected)) invalid();
        Reflect.apply(WEAK_SET_ADD, TRUSTED_EVIDENCE, [expected]);
        return expected;
      } catch {
        return invalid();
      }
    },
  });
}

function requireTrustedMediaProbeEvidence(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && Reflect.apply(WEAK_SET_HAS, TRUSTED_EVIDENCE, [value])) return value;
  return invalid();
}

module.exports = Object.freeze({
  MAX_LOCAL_MEDIA_BYTES,
  MEDIA_PROBE_ALGORITHM_VERSION,
  MEDIA_PROBE_SCHEMA_VERSION,
  createMediaProbeEvidence,
  createMediaProbeEvidenceVerifier,
  parseMediaProbeEvidenceRecord,
  requireTrustedMediaProbeEvidence,
});
