'use strict';

const {
  boundedInteger,
  canonicalHash,
  canonicalUid,
  denseArray,
  epoch,
  exactObject,
  fail,
  frozenArray,
  sha256,
} = require('../audio/audioContract');
const {
  requireTrustedMediaExportExecutionPlan,
} = require('./mediaExportExecutionPlan');

const INPUT_CODE = 'MEDIA_EXPORT_OUTPUT_INVALID';
const DATA_CODE = 'MEDIA_EXPORT_DATA_INVALID';
const SCHEMA_VERSION = 'media-export-receipt.v1';
const ALGORITHM_VERSION = 'local-ffmpeg-export.v1';
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024;
const ROOT_KEYS = Object.freeze([
  'schemaVersion', 'algorithmVersion', 'uid', 'dramaUid', 'workflowRunUid',
  'productionTimelineSnapshotUid', 'productionTimelineSnapshotSha256',
  'normalizationPlanUid', 'normalizationPlanSha256', 'executionPlanSha256',
  'profileSha256', 'output', 'startedAtEpochMs', 'completedAtEpochMs',
  'receiptSha256',
]);
const OUTPUT_KEYS = Object.freeze([
  'relativePath', 'sha256', 'bytes', 'durationMs', 'formatNames', 'video', 'audio',
  'decoded', 'fastStart',
]);
const VIDEO_KEYS = Object.freeze([
  'codecName', 'width', 'height', 'pixelFormat', 'averageFrameRate', 'timeBase',
  'sampleAspectRatio', 'displayAspectRatio', 'frameCount',
]);
const AUDIO_KEYS = Object.freeze([
  'codecName', 'sampleRateHz', 'channels', 'channelLayout', 'sampleFormat',
]);
const RATIONAL_KEYS = Object.freeze(['numerator', 'denominator']);

function invalid(code = INPUT_CODE) {
  fail(code);
}

function token(value, maximum, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || !/^[A-Za-z0-9][A-Za-z0-9._:+()-]*$/u.test(value)) invalid(code);
  return value;
}

function rational(value, code) {
  const input = exactObject(value, RATIONAL_KEYS, code);
  return Object.freeze({
    numerator: boundedInteger(input.numerator, 1, 1_000_000_000, code),
    denominator: boundedInteger(input.denominator, 1, 1_000_000_000, code),
  });
}

function video(value, code) {
  const input = exactObject(value, VIDEO_KEYS, code);
  return Object.freeze({
    codecName: token(input.codecName, 64, code),
    width: boundedInteger(input.width, 1, 16_384, code),
    height: boundedInteger(input.height, 1, 16_384, code),
    pixelFormat: token(input.pixelFormat, 64, code),
    averageFrameRate: rational(input.averageFrameRate, code),
    timeBase: rational(input.timeBase, code),
    sampleAspectRatio: token(input.sampleAspectRatio, 32, code),
    displayAspectRatio: token(input.displayAspectRatio, 32, code),
    frameCount: boundedInteger(input.frameCount, 1, 10_000_000, code),
  });
}

function audio(value, code) {
  const input = exactObject(value, AUDIO_KEYS, code);
  return Object.freeze({
    codecName: token(input.codecName, 64, code),
    sampleRateHz: boundedInteger(input.sampleRateHz, 8_000, 384_000, code),
    channels: boundedInteger(input.channels, 1, 32, code),
    channelLayout: token(input.channelLayout, 128, code),
    sampleFormat: token(input.sampleFormat, 64, code),
  });
}

function safeRelativeOutput(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
    || value.includes('\\') || value.includes('\0') || value !== value.trim()
    || !/^projects\/[0-9a-f-]{36}\/exports\/[0-9a-f-]{36}\.mp4$/u.test(value)) {
    invalid(code);
  }
  return value;
}

function canonicalOutput(value, code) {
  const input = exactObject(value, OUTPUT_KEYS, code);
  const formatNames = denseArray(input.formatNames, 16, code)
    .map((entry) => token(entry, 32, code));
  if (formatNames.length < 1 || new Set(formatNames).size !== formatNames.length) invalid(code);
  return Object.freeze({
    relativePath: safeRelativeOutput(input.relativePath, code),
    sha256: sha256(input.sha256, code),
    bytes: boundedInteger(input.bytes, 1, MAX_OUTPUT_BYTES, code),
    durationMs: boundedInteger(input.durationMs, 1, 3_600_100, code),
    formatNames: frozenArray(formatNames),
    video: video(input.video, code),
    audio: audio(input.audio, code),
    decoded: input.decoded === true ? true : invalid(code),
    fastStart: input.fastStart === true ? true : invalid(code),
  });
}

function assertProfile(output, plan, code) {
  const videoProfile = plan.profile.video;
  const audioProfile = plan.profile.audio;
  const minimumFrames = Math.max(1, Math.floor((plan.durationMs * 24) / 1000));
  const maximumFrames = Math.max(1, Math.ceil((plan.durationMs * 24) / 1000));
  assertFixedOutputProfile(output, code);
  if (output.relativePath !== plan.outputRelativePath
    || Math.abs(output.durationMs - plan.durationMs) > 50
    || output.video.codecName !== videoProfile.codec
    || output.video.width !== videoProfile.width || output.video.height !== videoProfile.height
    || output.video.pixelFormat !== videoProfile.pixelFormat
    || output.video.averageFrameRate.numerator !== 24
    || output.video.averageFrameRate.denominator !== 1
    || output.video.timeBase.numerator !== 1
    || output.video.timeBase.denominator !== videoProfile.timeBase.denominator
    || output.video.sampleAspectRatio !== videoProfile.sampleAspectRatio
    || output.video.displayAspectRatio !== videoProfile.displayAspectRatio
    || output.video.frameCount < minimumFrames || output.video.frameCount > maximumFrames
    || output.audio.codecName !== audioProfile.codec
    || output.audio.sampleRateHz !== audioProfile.sampleRateHz
    || output.audio.channels !== audioProfile.channels
    || output.audio.channelLayout !== audioProfile.channelLayout) invalid(code);
}

function assertFixedOutputProfile(output, code) {
  if (!output.formatNames.includes('mp4') || !output.formatNames.includes('mov')
    || output.video.codecName !== 'h264' || output.video.width !== 1920
    || output.video.height !== 1080 || output.video.pixelFormat !== 'yuv420p'
    || output.video.averageFrameRate.numerator !== 24
    || output.video.averageFrameRate.denominator !== 1
    || output.video.timeBase.numerator !== 1 || output.video.timeBase.denominator !== 90_000
    || output.video.sampleAspectRatio !== '1:1'
    || output.video.displayAspectRatio !== '16:9'
    || output.audio.codecName !== 'aac' || output.audio.sampleRateHz !== 48_000
    || output.audio.channels !== 2 || output.audio.channelLayout !== 'stereo') invalid(code);
}

function baseRecord(plan, output, completedAtEpochMs) {
  const completed = epoch(completedAtEpochMs, INPUT_CODE);
  if (completed < plan.createdAtEpochMs) invalid();
  assertProfile(output, plan, INPUT_CODE);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    uid: plan.uid,
    dramaUid: plan.dramaUid,
    workflowRunUid: plan.workflowRunUid,
    productionTimelineSnapshotUid: plan.productionTimelineSnapshotUid,
    productionTimelineSnapshotSha256: plan.productionTimelineSnapshotSha256,
    normalizationPlanUid: plan.normalizationPlanUid,
    normalizationPlanSha256: plan.normalizationPlanSha256,
    executionPlanSha256: plan.executionPlanSha256,
    profileSha256: plan.profile.profileSha256,
    output,
    startedAtEpochMs: plan.createdAtEpochMs,
    completedAtEpochMs: completed,
  });
}

function createMediaExportReceipt(value) {
  try {
    const input = exactObject(
      value, ['schemaVersion', 'executionPlan', 'output', 'completedAtEpochMs'], INPUT_CODE,
    );
    if (input.schemaVersion !== '8.0') invalid();
    const plan = requireTrustedMediaExportExecutionPlan(input.executionPlan);
    const output = canonicalOutput(input.output, INPUT_CODE);
    const base = baseRecord(plan, output, input.completedAtEpochMs);
    return Object.freeze({ ...base, receiptSha256: canonicalHash(base) });
  } catch {
    return invalid();
  }
}

function parseMediaExportReceiptRecord(value) {
  try {
    const input = exactObject(value, ROOT_KEYS, DATA_CODE);
    if (input.schemaVersion !== SCHEMA_VERSION || input.algorithmVersion !== ALGORITHM_VERSION) {
      invalid(DATA_CODE);
    }
    const base = Object.freeze({
      schemaVersion: input.schemaVersion,
      algorithmVersion: input.algorithmVersion,
      uid: canonicalUid(input.uid, DATA_CODE),
      dramaUid: canonicalUid(input.dramaUid, DATA_CODE),
      workflowRunUid: canonicalUid(input.workflowRunUid, DATA_CODE),
      productionTimelineSnapshotUid: canonicalUid(input.productionTimelineSnapshotUid, DATA_CODE),
      productionTimelineSnapshotSha256: sha256(input.productionTimelineSnapshotSha256, DATA_CODE),
      normalizationPlanUid: canonicalUid(input.normalizationPlanUid, DATA_CODE),
      normalizationPlanSha256: sha256(input.normalizationPlanSha256, DATA_CODE),
      executionPlanSha256: sha256(input.executionPlanSha256, DATA_CODE),
      profileSha256: sha256(input.profileSha256, DATA_CODE),
      output: canonicalOutput(input.output, DATA_CODE),
      startedAtEpochMs: epoch(input.startedAtEpochMs, DATA_CODE),
      completedAtEpochMs: epoch(input.completedAtEpochMs, DATA_CODE),
    });
    assertFixedOutputProfile(base.output, DATA_CODE);
    if (base.completedAtEpochMs < base.startedAtEpochMs
      || base.output.relativePath !== `projects/${base.dramaUid}/exports/${base.uid}.mp4`
      || new Set([
        base.uid, base.dramaUid, base.workflowRunUid,
        base.productionTimelineSnapshotUid, base.normalizationPlanUid,
      ]).size !== 5
      || canonicalHash(base) !== sha256(input.receiptSha256, DATA_CODE)) invalid(DATA_CODE);
    return Object.freeze({ ...base, receiptSha256: input.receiptSha256 });
  } catch {
    return invalid(DATA_CODE);
  }
}

module.exports = Object.freeze({
  MEDIA_EXPORT_RECEIPT_ALGORITHM_VERSION: ALGORITHM_VERSION,
  MEDIA_EXPORT_RECEIPT_SCHEMA_VERSION: SCHEMA_VERSION,
  createMediaExportReceipt,
  parseMediaExportReceiptRecord,
});
