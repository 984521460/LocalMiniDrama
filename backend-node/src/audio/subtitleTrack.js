'use strict';

const {
  boundedInteger,
  canonicalHash,
  canonicalUid,
  denseArray,
  exactObject,
  fail,
  frozenArray,
  sha256,
  textHash,
} = require('./audioContract');

const ALGORITHM_VERSIONS = Object.freeze(new Set([
  'audio-timeline-ms.v1', 'audio-timeline-ms.v2',
]));
const MAX_SEGMENTS = 1000;
const TRACK_KEYS = Object.freeze([
  'schemaVersion', 'timingAlgorithmVersion', 'timelineUid', 'planUid',
  'executionUid', 'durationMs', 'cues', 'trackSha256',
]);
const CUE_KEYS = Object.freeze([
  'ordinal', 'dialogueDeliveryUid', 'dialogueEntryId', 'characterUid',
  'startMs', 'endMs', 'text', 'textSha256', 'sourceKind',
  'sourceAssetVersionUid', 'sourceMediaSha256',
]);
const SOURCE_KINDS = Object.freeze(new Set(['tts_asset', 'h3_native']));
const FORBIDDEN_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;

function trackRecord(input) {
  const base = Object.freeze({
    schemaVersion: '8.0',
    timingAlgorithmVersion: input.timingAlgorithmVersion,
    timelineUid: input.timelineUid,
    planUid: input.planUid,
    executionUid: input.executionUid,
    durationMs: input.durationMs,
    cues: input.cues,
  });
  return Object.freeze({ ...base, trackSha256: canonicalHash(base) });
}

function cueFrom(binding, segment) {
  const delivery = binding.dialogueDelivery;
  return Object.freeze({
    ordinal: segment.ordinal,
    dialogueDeliveryUid: delivery.uid,
    dialogueEntryId: delivery.dialogueEntryId,
    characterUid: delivery.characterUid,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: delivery.text,
    textSha256: delivery.textSha256,
    sourceKind: segment.sourceKind,
    sourceAssetVersionUid: segment.sourceAssetVersionUid,
    sourceMediaSha256: segment.sourceMediaSha256,
  });
}

function buildSubtitleTrack(input) {
  const cues = frozenArray(input.bindings.map((binding, index) => (
    cueFrom(binding, input.segments[index])
  )));
  return trackRecord({
    timelineUid: input.timelineUid,
    timingAlgorithmVersion: input.timingAlgorithmVersion,
    planUid: input.planUid,
    executionUid: input.executionUid,
    durationMs: input.durationMs,
    cues,
  });
}

function parseCue(value, durationMs, code) {
  const input = exactObject(value, CUE_KEYS, code);
  const startMs = boundedInteger(input.startMs, 0, durationMs, code);
  const endMs = boundedInteger(input.endMs, 1, durationMs, code);
  let textPoints = 0;
  if (typeof input.text === 'string' && input.text.length <= 4096) {
    for (const _point of input.text) {
      textPoints += 1;
      if (textPoints > 1024) break;
    }
  }
  if (endMs <= startMs || typeof input.dialogueEntryId !== 'string'
    || input.dialogueEntryId.length < 1 || input.dialogueEntryId.length > 128
    || input.dialogueEntryId !== input.dialogueEntryId.trim()
    || typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 4096
    || input.text !== input.text.trim() || input.text.normalize('NFC') !== input.text
    || FORBIDDEN_TEXT.test(input.text) || Buffer.byteLength(input.text, 'utf8') > 4096
    || textPoints < 1 || textPoints > 1024
    || textHash(input.text) !== input.textSha256
    || !SOURCE_KINDS.has(input.sourceKind)) fail(code);
  return Object.freeze({
    ordinal: boundedInteger(input.ordinal, 0, MAX_SEGMENTS - 1, code),
    dialogueDeliveryUid: canonicalUid(input.dialogueDeliveryUid, code),
    dialogueEntryId: input.dialogueEntryId,
    characterUid: canonicalUid(input.characterUid, code),
    startMs,
    endMs,
    text: input.text,
    textSha256: sha256(input.textSha256, code),
    sourceKind: input.sourceKind,
    sourceAssetVersionUid: canonicalUid(input.sourceAssetVersionUid, code),
    sourceMediaSha256: sha256(input.sourceMediaSha256, code),
  });
}

function parseSubtitleTrack(value, expected, code) {
  const input = exactObject(value, TRACK_KEYS, code);
  if (input.schemaVersion !== '8.0'
    || !ALGORITHM_VERSIONS.has(input.timingAlgorithmVersion)
    || input.timingAlgorithmVersion !== expected.timingAlgorithmVersion) fail(code);
  const durationMs = boundedInteger(input.durationMs, 1, expected.maximumDurationMs, code);
  const cues = denseArray(input.cues, MAX_SEGMENTS, code)
    .map((cue) => parseCue(cue, durationMs, code));
  if (cues.length < 1 || cues.length !== expected.segments.length) fail(code);
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const segment = expected.segments[index];
    if (cue.ordinal !== index || cue.ordinal !== segment.ordinal
      || cue.dialogueDeliveryUid !== segment.dialogueDeliveryUid
      || cue.characterUid !== segment.characterUid
      || cue.startMs !== segment.startMs || cue.endMs !== segment.endMs
      || cue.sourceKind !== segment.sourceKind
      || cue.sourceAssetVersionUid !== segment.sourceAssetVersionUid
      || cue.sourceMediaSha256 !== segment.sourceMediaSha256
      || (index > 0 && cue.startMs < cues[index - 1].endMs)) fail(code);
  }
  const canonical = trackRecord({
    timelineUid: canonicalUid(input.timelineUid, code),
    timingAlgorithmVersion: input.timingAlgorithmVersion,
    planUid: canonicalUid(input.planUid, code),
    executionUid: canonicalUid(input.executionUid, code),
    durationMs,
    cues: frozenArray(cues),
  });
  if (canonical.timelineUid !== expected.timelineUid
    || canonical.planUid !== expected.planUid
    || canonical.executionUid !== expected.executionUid
    || canonical.durationMs !== expected.durationMs
    || canonical.trackSha256 !== input.trackSha256) fail(code);
  return canonical;
}

module.exports = Object.freeze({
  buildSubtitleTrack,
  parseSubtitleTrack,
});
