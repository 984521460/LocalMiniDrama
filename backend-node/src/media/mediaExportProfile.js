'use strict';

const {
  canonicalHash,
  exactObject,
  fail,
} = require('../audio/audioContract');

const CODE = 'MEDIA_PROFILE_DATA_INVALID';
const MEDIA_EXPORT_PROFILE_SCHEMA_VERSION = 'media-export-profile.v1';
const MEDIA_EXPORT_PROFILE_ID = 'mvp-1080p-16x9';
const MEDIA_EXPORT_PROFILE_REVISION = 1;
const ROOT_KEYS = Object.freeze([
  'schemaVersion', 'profileId', 'revision', 'container', 'video', 'audio',
  'subtitles', 'mux', 'profileSha256',
]);
const VIDEO_KEYS = Object.freeze([
  'width', 'height', 'displayAspectRatio', 'frameRate', 'timeBase', 'codec',
  'pixelFormat', 'scaleMode', 'padColor', 'sampleAspectRatio',
]);
const FRAME_RATE_KEYS = Object.freeze(['numerator', 'denominator', 'mode']);
const RATIONAL_KEYS = Object.freeze(['numerator', 'denominator']);
const AUDIO_KEYS = Object.freeze([
  'codec', 'sampleRateHz', 'channels', 'channelLayout', 'bitrateKbps',
]);
const SUBTITLE_KEYS = Object.freeze(['mode', 'format', 'timeBaseMs']);
const MUX_KEYS = Object.freeze(['fastStart']);
const TRUSTED_PROFILES = new WeakSet();

function invalid() {
  fail(CODE);
}

function rational(value, expectedNumerator, expectedDenominator) {
  const input = exactObject(value, RATIONAL_KEYS, CODE);
  if (input.numerator !== expectedNumerator || input.denominator !== expectedDenominator) invalid();
  return Object.freeze({ numerator: input.numerator, denominator: input.denominator });
}

function frameRate(value) {
  const input = exactObject(value, FRAME_RATE_KEYS, CODE);
  if (input.numerator !== 24 || input.denominator !== 1 || input.mode !== 'cfr') invalid();
  return Object.freeze({ numerator: 24, denominator: 1, mode: 'cfr' });
}

function videoProfile(value) {
  const input = exactObject(value, VIDEO_KEYS, CODE);
  if (input.width !== 1920 || input.height !== 1080
    || input.displayAspectRatio !== '16:9'
    || input.codec !== 'h264' || input.pixelFormat !== 'yuv420p'
    || input.scaleMode !== 'contain' || input.padColor !== '#000000'
    || input.sampleAspectRatio !== '1:1') invalid();
  return Object.freeze({
    width: 1920,
    height: 1080,
    displayAspectRatio: '16:9',
    frameRate: frameRate(input.frameRate),
    timeBase: rational(input.timeBase, 1, 90_000),
    codec: 'h264',
    pixelFormat: 'yuv420p',
    scaleMode: 'contain',
    padColor: '#000000',
    sampleAspectRatio: '1:1',
  });
}

function audioProfile(value) {
  const input = exactObject(value, AUDIO_KEYS, CODE);
  if (input.codec !== 'aac' || input.sampleRateHz !== 48_000 || input.channels !== 2
    || input.channelLayout !== 'stereo' || input.bitrateKbps !== 192) invalid();
  return Object.freeze({
    codec: 'aac',
    sampleRateHz: 48_000,
    channels: 2,
    channelLayout: 'stereo',
    bitrateKbps: 192,
  });
}

function subtitleProfile(value) {
  const input = exactObject(value, SUBTITLE_KEYS, CODE);
  if (input.mode !== 'burn_in' || input.format !== 'ass' || input.timeBaseMs !== 1) invalid();
  return Object.freeze({ mode: 'burn_in', format: 'ass', timeBaseMs: 1 });
}

function muxProfile(value) {
  const input = exactObject(value, MUX_KEYS, CODE);
  if (input.fastStart !== true) invalid();
  return Object.freeze({ fastStart: true });
}

function buildRecord(input) {
  const base = Object.freeze({
    schemaVersion: MEDIA_EXPORT_PROFILE_SCHEMA_VERSION,
    profileId: MEDIA_EXPORT_PROFILE_ID,
    revision: MEDIA_EXPORT_PROFILE_REVISION,
    container: 'mp4',
    video: videoProfile(input.video),
    audio: audioProfile(input.audio),
    subtitles: subtitleProfile(input.subtitles),
    mux: muxProfile(input.mux),
  });
  return Object.freeze({ ...base, profileSha256: canonicalHash(base) });
}

const MVP_PROFILE = buildRecord({
  video: {
    width: 1920,
    height: 1080,
    displayAspectRatio: '16:9',
    frameRate: { numerator: 24, denominator: 1, mode: 'cfr' },
    timeBase: { numerator: 1, denominator: 90_000 },
    codec: 'h264',
    pixelFormat: 'yuv420p',
    scaleMode: 'contain',
    padColor: '#000000',
    sampleAspectRatio: '1:1',
  },
  audio: {
    codec: 'aac', sampleRateHz: 48_000, channels: 2,
    channelLayout: 'stereo', bitrateKbps: 192,
  },
  subtitles: { mode: 'burn_in', format: 'ass', timeBaseMs: 1 },
  mux: { fastStart: true },
});
TRUSTED_PROFILES.add(MVP_PROFILE);

function parseMediaExportProfileRecord(value) {
  try {
    const input = exactObject(value, ROOT_KEYS, CODE);
    if (input.schemaVersion !== MEDIA_EXPORT_PROFILE_SCHEMA_VERSION
      || input.profileId !== MEDIA_EXPORT_PROFILE_ID
      || input.revision !== MEDIA_EXPORT_PROFILE_REVISION
      || input.container !== 'mp4') invalid();
    const canonical = buildRecord(input);
    if (input.profileSha256 !== canonical.profileSha256) invalid();
    return canonical;
  } catch {
    return invalid();
  }
}

function getMvpMediaExportProfile() {
  return MVP_PROFILE;
}

function requireTrustedMediaExportProfile(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && TRUSTED_PROFILES.has(value)) return value;
  return invalid();
}

module.exports = Object.freeze({
  MEDIA_EXPORT_PROFILE_ID,
  MEDIA_EXPORT_PROFILE_REVISION,
  MEDIA_EXPORT_PROFILE_SCHEMA_VERSION,
  getMvpMediaExportProfile,
  parseMediaExportProfileRecord,
  requireTrustedMediaExportProfile,
});
