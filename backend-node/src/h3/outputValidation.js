'use strict';

const {
  exactKeys,
  sha256,
  sha256Canonical,
  snapshot,
} = require('./contract');
const { fail } = require('./errors');
const { validateH3GenerationSpec } = require('./generationSpec');
const { H3_PROFILE } = require('./profile');

const CODE = 'H3_OUTPUT_INVALID';
const MEASURED_FIELDS = Object.freeze([
  'sha256', 'bytes', 'mimeType', 'width', 'height', 'durationMs', 'frames', 'fps',
  'videoCodec', 'audioCodec', 'audioStreams', 'blackFrameRatio', 'frozenFrameRatio',
]);

function ratio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateH3VideoOutput(input) {
  const root = snapshot(input, CODE, {
    maxStringBytes: 64 * 1024,
    maxTotalBytes: 512 * 1024,
  });
  exactKeys(root, ['generationSpec', 'measured'], CODE);
  let spec;
  try { spec = validateH3GenerationSpec(root.generationSpec); } catch { return fail(CODE); }
  const measured = root.measured;
  exactKeys(measured, MEASURED_FIELDS, CODE);
  sha256(measured.sha256, CODE);
  const expectedDurationMs = Math.round((spec.frames / spec.fps) * 1000);
  if (!Number.isSafeInteger(measured.bytes) || measured.bytes < 1 || measured.bytes > 20_000_000_000
    || measured.mimeType !== 'video/mp4'
    || measured.width !== spec.width || measured.height !== spec.height
    || !Number.isSafeInteger(measured.durationMs) || measured.durationMs < 1
    || Math.abs(measured.durationMs - expectedDurationMs) > 300
    || measured.frames !== spec.frames || measured.fps !== spec.fps
    || measured.videoCodec !== 'h264'
    || measured.audioCodec !== 'aac' || measured.audioStreams !== 1
    || !ratio(measured.blackFrameRatio) || measured.blackFrameRatio > 0.95
    || !ratio(measured.frozenFrameRatio) || measured.frozenFrameRatio > 0.95) fail(CODE);
  return snapshot({
    schemaVersion: 'h3-video-evidence.v1',
    profileUid: H3_PROFILE.uid,
    generationSpecSha256: sha256Canonical(spec),
    sha256: measured.sha256,
    bytes: measured.bytes,
    mimeType: measured.mimeType,
    width: measured.width,
    height: measured.height,
    durationMs: measured.durationMs,
    frames: measured.frames,
    fps: measured.fps,
    videoCodec: measured.videoCodec,
    audioCodec: measured.audioCodec,
    audioStreams: measured.audioStreams,
    blackFrameRatio: measured.blackFrameRatio,
    frozenFrameRatio: measured.frozenFrameRatio,
  }, CODE);
}

function validateH3VideoEvidence(input) {
  const root = snapshot(input, CODE, {
    maxStringBytes: 64 * 1024,
    maxTotalBytes: 512 * 1024,
  });
  exactKeys(root, ['generationSpec', 'evidence'], CODE);
  const evidence = root.evidence;
  exactKeys(evidence, [
    'schemaVersion', 'profileUid', 'generationSpecSha256', ...MEASURED_FIELDS,
  ], CODE);
  if (evidence.schemaVersion !== 'h3-video-evidence.v1'
    || evidence.profileUid !== H3_PROFILE.uid) fail(CODE);
  const validated = validateH3VideoOutput({
    generationSpec: root.generationSpec,
    measured: Object.fromEntries(MEASURED_FIELDS.map((field) => [field, evidence[field]])),
  });
  if (sha256Canonical(validated) !== sha256Canonical(evidence)) fail(CODE);
  return evidence;
}

module.exports = Object.freeze({ validateH3VideoEvidence, validateH3VideoOutput });
