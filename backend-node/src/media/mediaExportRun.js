'use strict';

const {
  boundedInteger,
  canonicalUid,
  exactObject,
  fail,
  sha256,
} = require('../audio/audioContract');

const INPUT_CODE = 'MEDIA_EXPORT_RUN_INPUT_INVALID';
const DATA_CODE = 'MEDIA_EXPORT_RUN_DATA_INVALID';
const RUN_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'sourceNodeRunUid',
  'executionPlanSha256', 'status', 'outputAssetUid', 'outputAssetVersionUid',
  'output', 'errorCode', 'createdAt', 'startedAt', 'completedAt',
]);
const OUTPUT_KEYS = Object.freeze([
  'relativePath', 'sha256', 'bytes', 'durationMs', 'width', 'height',
  'frameRate', 'videoCodec', 'audioCodec',
]);
const STATUS = new Set(['queued', 'running', 'succeeded', 'failed']);
const ERROR_CODES = new Set(['MEDIA_EXPORT_FAILED', 'MEDIA_EXPORT_CLEANUP_FAILED']);

function invalid(code) {
  fail(code);
}

function timestamp(value, nullable, code) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length !== 24
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) invalid(code);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) invalid(code);
  return value;
}

function token(value, expected, code) {
  if (value !== expected) invalid(code);
  return value;
}

function safeRelativePath(value, runUid, dramaUid, code) {
  const expected = `projects/${dramaUid}/exports/${runUid}.mp4`;
  if (value !== expected || value.length > 1024 || value.includes('\\') || value.includes('\0')) {
    invalid(code);
  }
  return value;
}

function outputRecord(value, runUid, dramaUid, code) {
  const input = exactObject(value, OUTPUT_KEYS, code);
  return Object.freeze({
    relativePath: safeRelativePath(input.relativePath, runUid, dramaUid, code),
    sha256: sha256(input.sha256, code),
    bytes: boundedInteger(input.bytes, 1, 64 * 1024 * 1024 * 1024, code),
    durationMs: boundedInteger(input.durationMs, 1, 3_600_100, code),
    width: token(input.width, 1920, code),
    height: token(input.height, 1080, code),
    frameRate: token(input.frameRate, '24/1', code),
    videoCodec: token(input.videoCodec, 'h264', code),
    audioCodec: token(input.audioCodec, 'aac', code),
  });
}

function createMediaExportRunRequest(value) {
  try {
    const input = exactObject(value, ['nodeRunUid'], INPUT_CODE);
    return Object.freeze({ nodeRunUid: canonicalUid(input.nodeRunUid, INPUT_CODE) });
  } catch {
    return invalid(INPUT_CODE);
  }
}

function createMediaExportRunPublicRecord(value) {
  try {
    const input = exactObject(value, RUN_KEYS, DATA_CODE);
    if (input.schemaVersion !== 'media-export-run.v1' || !STATUS.has(input.status)) invalid(DATA_CODE);
    const uid = canonicalUid(input.uid, DATA_CODE);
    const dramaUid = canonicalUid(input.dramaUid, DATA_CODE);
    const workflowRunUid = canonicalUid(input.workflowRunUid, DATA_CODE);
    const sourceNodeRunUid = canonicalUid(input.sourceNodeRunUid, DATA_CODE);
    const executionPlanSha256 = sha256(input.executionPlanSha256, DATA_CODE);
    const createdAt = timestamp(input.createdAt, false, DATA_CODE);
    const startedAt = timestamp(input.startedAt, true, DATA_CODE);
    const completedAt = timestamp(input.completedAt, true, DATA_CODE);
    const succeeded = input.status === 'succeeded';
    const failed = input.status === 'failed';
    const outputAssetUid = succeeded ? canonicalUid(input.outputAssetUid, DATA_CODE) : null;
    const outputAssetVersionUid = succeeded
      ? canonicalUid(input.outputAssetVersionUid, DATA_CODE) : null;
    const output = succeeded ? outputRecord(input.output, uid, dramaUid, DATA_CODE) : null;
    const errorCode = failed && ERROR_CODES.has(input.errorCode) ? input.errorCode : null;
    if ((!succeeded && (input.outputAssetUid !== null || input.outputAssetVersionUid !== null
      || input.output !== null))
      || (succeeded && input.errorCode !== null)
      || (failed && errorCode === null)
      || (!failed && input.errorCode !== null)
      || (input.status === 'queued' && (startedAt !== null || completedAt !== null))
      || (input.status === 'running' && (startedAt === null || completedAt !== null))
      || ((succeeded || failed) && (startedAt === null || completedAt === null))
      || (startedAt !== null && Date.parse(startedAt) < Date.parse(createdAt))
      || (completedAt !== null && Date.parse(completedAt) < Date.parse(startedAt))) invalid(DATA_CODE);
    return Object.freeze({
      schemaVersion: 'media-export-run.v1', uid, dramaUid, workflowRunUid,
      sourceNodeRunUid, executionPlanSha256, status: input.status,
      outputAssetUid, outputAssetVersionUid, output, errorCode,
      createdAt, startedAt, completedAt,
    });
  } catch {
    return invalid(DATA_CODE);
  }
}

function publicOutputFromReceipt(receipt) {
  try {
    return outputRecord({
      relativePath: receipt.output.relativePath,
      sha256: receipt.output.sha256,
      bytes: receipt.output.bytes,
      durationMs: receipt.output.durationMs,
      width: receipt.output.video.width,
      height: receipt.output.video.height,
      frameRate: `${receipt.output.video.averageFrameRate.numerator}/${receipt.output.video.averageFrameRate.denominator}`,
      videoCodec: receipt.output.video.codecName,
      audioCodec: receipt.output.audio.codecName,
    }, receipt.uid, receipt.dramaUid, DATA_CODE);
  } catch {
    return invalid(DATA_CODE);
  }
}

module.exports = Object.freeze({
  createMediaExportRunPublicRecord,
  createMediaExportRunRequest,
  publicOutputFromReceipt,
});
