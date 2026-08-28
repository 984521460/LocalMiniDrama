'use strict';

const { isProviderNeutralText } = require('../narrative/tasks/providerNeutralText');
const {
  boundedText,
  exactKeys,
  sha256,
  sha256Canonical,
  sha256Text,
  snapshot,
  uid,
} = require('./contract');
const { fail } = require('./errors');
const { H3_PROFILE } = require('./profile');

const CODE = 'H3_GENERATION_INPUT_INVALID';
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AUDIO_MIMES = new Set(['audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav']);
const PROMPT_FIELDS = [
  'schemaVersion', 'profileUid', 'dramaUid', 'shotId', 'continuitySnapshotUid',
  'semanticSha256', 'promptSha256', 'text',
];

function h3FramesForDuration(durationSeconds) {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0 || durationSeconds > 15
    || Math.round(durationSeconds * 1000) !== durationSeconds * 1000) fail(CODE);
  const rawFrames = Math.max(H3_PROFILE.frameGrid.minimum, Math.round(durationSeconds * H3_PROFILE.fps));
  return rawFrames + ((H3_PROFILE.frameGrid.offset
    - (rawFrames % H3_PROFILE.frameGrid.stride)
    + H3_PROFILE.frameGrid.stride) % H3_PROFILE.frameGrid.stride);
}

function promptRecord(value) {
  exactKeys(value, PROMPT_FIELDS, CODE);
  if (value.schemaVersion !== 'h3-shot-prompt.v1' || value.profileUid !== H3_PROFILE.uid) fail(CODE);
  uid(value.dramaUid, CODE);
  uid(value.continuitySnapshotUid, CODE);
  sha256(value.semanticSha256, CODE);
  sha256(value.promptSha256, CODE);
  boundedText(value.shotId, 64, 128, CODE);
  boundedText(value.text, 12_000, 32 * 1024, CODE);
  if (!isProviderNeutralText(value.text) || sha256Text(value.text) !== value.promptSha256) fail(CODE);
  return value;
}

function canvas(width, height) {
  for (const value of [width, height]) {
    if (!Number.isSafeInteger(value) || value < 32
      || value % H3_PROFILE.canvas.multipleOf !== 0) fail(CODE);
  }
  if (Math.max(width, height) > H3_PROFILE.canvas.maximumLongEdge
    || Math.min(width, height) > H3_PROFILE.canvas.maximumShortEdge
    || width * height > H3_PROFILE.canvas.maximumPixels) fail(CODE);
}

function imageEvidence(value, expectedDramaUid) {
  exactKeys(value, ['ordinal', 'role', 'dramaUid', 'assetVersionUid', 'sha256', 'mimeType', 'width', 'height'], CODE);
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 4
    || !['first', 'last', 'reference'].includes(value.role)
    || value.dramaUid !== expectedDramaUid
    || !IMAGE_MIMES.has(value.mimeType)
    || !Number.isSafeInteger(value.width) || value.width < 1 || value.width > 16_384
    || !Number.isSafeInteger(value.height) || value.height < 1 || value.height > 16_384) fail(CODE);
  uid(value.dramaUid, CODE);
  uid(value.assetVersionUid, CODE);
  sha256(value.sha256, CODE);
  return value;
}

function audioEvidence(value, expectedDramaUid) {
  if (value === null) return null;
  exactKeys(value, ['dramaUid', 'assetVersionUid', 'sha256', 'mimeType', 'durationMs'], CODE);
  if (value.dramaUid !== expectedDramaUid || !AUDIO_MIMES.has(value.mimeType)
    || !Number.isSafeInteger(value.durationMs) || value.durationMs < 1 || value.durationMs > 900_000) fail(CODE);
  uid(value.dramaUid, CODE);
  uid(value.assetVersionUid, CODE);
  sha256(value.sha256, CODE);
  return value;
}

function assertImageRoles(mode, images) {
  const profileMode = H3_PROFILE.modes[mode];
  if (!profileMode || images.length < profileMode.minimumReferenceImages
    || images.length > profileMode.maximumReferenceImages) fail(CODE);
  const expected = mode === 'ref2va'
    ? images.map(() => 'reference')
    : profileMode.referenceImageRoles;
  const identities = new Set();
  const hashes = new Set();
  images.forEach((image, index) => {
    if (image.ordinal !== index + 1 || image.role !== expected[index]
      || identities.has(image.assetVersionUid) || hashes.has(image.sha256)) fail(CODE);
    identities.add(image.assetVersionUid);
    hashes.add(image.sha256);
  });
}

function normalizeH3GenerationSpec(input) {
  const root = snapshot(input, CODE);
  const allowed = new Set([
    'mode', 'prompt', 'width', 'height', 'durationSeconds', 'seed',
    'referenceImages', 'referenceAudio',
  ]);
  const required = ['mode', 'prompt', 'width', 'height', 'durationSeconds', 'seed', 'referenceImages'];
  if (root === null || typeof root !== 'object' || Array.isArray(root)
    || Object.keys(root).some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(root, key))) fail(CODE);
  const prompt = promptRecord(root.prompt);
  if (!Object.hasOwn(H3_PROFILE.modes, root.mode)
    || !Number.isSafeInteger(root.seed) || root.seed < 0 || root.seed > 4_294_967_295
    || !Array.isArray(root.referenceImages)) fail(CODE);
  canvas(root.width, root.height);
  const referenceImages = root.referenceImages.map((value) => imageEvidence(value, prompt.dramaUid));
  assertImageRoles(root.mode, referenceImages);
  const referenceAudio = Object.hasOwn(root, 'referenceAudio')
    ? audioEvidence(root.referenceAudio, prompt.dramaUid)
    : null;
  return snapshot({
    schemaVersion: 'h3-generation-spec.v1',
    profileUid: H3_PROFILE.uid,
    mode: root.mode,
    prompt,
    width: root.width,
    height: root.height,
    durationSeconds: root.durationSeconds,
    fps: H3_PROFILE.fps,
    frames: h3FramesForDuration(root.durationSeconds),
    seed: root.seed,
    referenceImages,
    referenceAudio,
  }, CODE);
}

function validateH3GenerationSpec(input) {
  const stored = snapshot(input, CODE);
  exactKeys(stored, [
    'schemaVersion', 'profileUid', 'mode', 'prompt', 'width', 'height',
    'durationSeconds', 'fps', 'frames', 'seed', 'referenceImages', 'referenceAudio',
  ], CODE);
  const normalized = normalizeH3GenerationSpec({
    mode: stored.mode,
    prompt: stored.prompt,
    width: stored.width,
    height: stored.height,
    durationSeconds: stored.durationSeconds,
    seed: stored.seed,
    referenceImages: stored.referenceImages,
    referenceAudio: stored.referenceAudio,
  });
  if (stored.schemaVersion !== normalized.schemaVersion
    || stored.profileUid !== normalized.profileUid
    || stored.fps !== normalized.fps
    || stored.frames !== normalized.frames
    || sha256Canonical(stored) !== sha256Canonical(normalized)) fail(CODE);
  return stored;
}

module.exports = Object.freeze({
  h3FramesForDuration,
  normalizeH3GenerationSpec,
  validateH3GenerationSpec,
});
