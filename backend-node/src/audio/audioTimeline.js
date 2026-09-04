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
  isAudioModeContractError,
  sha256,
} = require('./audioContract');
const { parseAudioExecutionEvidence } = require('./audioExecutionEvidence');
const { requireTrustedAudioModePlan } = require('./audioMode');
const { buildSubtitleTrack, parseSubtitleTrack } = require('./subtitleTrack');

const MAP_CONSTRUCTOR = Map;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const REFLECT_APPLY = Reflect.apply;
const SET_CONSTRUCTOR = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

function mapGet(target, key) {
  return REFLECT_APPLY(MAP_GET, target, [key]);
}

function mapHas(target, key) {
  return REFLECT_APPLY(MAP_HAS, target, [key]);
}

function mapSet(target, key, value) {
  REFLECT_APPLY(MAP_SET, target, [key, value]);
}

function setAdd(target, value) {
  REFLECT_APPLY(SET_ADD, target, [value]);
}

function setHas(target, value) {
  return REFLECT_APPLY(SET_HAS, target, [value]);
}

function setSize(target) {
  return REFLECT_APPLY(SET_SIZE, target, []);
}

const AUDIO_TIMELINE_ALGORITHM_VERSION = 'audio-timeline-ms.v1';
const PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION = 'audio-timeline-ms.v2';
const CHRONOLOGICAL_PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION = 'audio-timeline-ms.v3';
const INPUT_CODE = 'AUDIO_TIMELINE_INPUT_INVALID';
const DATA_CODE = 'AUDIO_TIMELINE_DATA_INVALID';
const MAX_SEGMENTS = 1000;
const MAX_TIMELINE_MS = 3_600_000;
const TRUSTED_TIMELINES = new WeakSet();
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'plan', 'executionEvidence', 'createdAtEpochMs',
]);
const PLACED_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'plan', 'executionEvidence', 'targetDurationMs',
  'placements', 'createdAtEpochMs',
]);
const CHRONOLOGICAL_PLACED_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'plan', 'executionEvidence', 'targetDurationMs',
  'placementOrder', 'placements', 'createdAtEpochMs',
]);
const PLACEMENT_KEYS = Object.freeze(['dialogueDeliveryUid', 'startMs']);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'timingAlgorithmVersion', 'uid', 'dramaUid', 'workflowRunUid',
  'planUid', 'planSha256', 'executionUid', 'executionSha256', 'mode',
  'durationMs', 'nativeTrack', 'segments', 'subtitleTrack', 'timelineSha256',
  'createdAtEpochMs',
]);
const SEGMENT_KEYS = Object.freeze([
  'ordinal', 'dialogueDeliveryUid', 'dialogueEntryId', 'characterUid',
  'startMs', 'endMs', 'durationMs', 'sourceKind', 'sourceAssetUid',
  'sourceAssetVersionUid', 'sourceMediaSha256', 'sourceMimeType',
]);
const NATIVE_TRACK_KEYS = Object.freeze([
  'sourceKind', 'sourceAssetUid', 'sourceAssetVersionUid', 'sourceMediaSha256',
  'sourceMimeType', 'durationMs', 'h3SourceSha256',
]);
const AUDIO_MIME_TYPES = Object.freeze(new SET_CONSTRUCTOR([
  'audio/aac', 'audio/flac', 'audio/mpeg', 'audio/wav', 'audio/x-wav',
]));

function safePlan(value, code) {
  try {
    return requireTrustedAudioModePlan(value);
  } catch {
    return fail(code);
  }
}

function safeExecution(value, plan, code) {
  try {
    return parseAudioExecutionEvidence(value, plan);
  } catch {
    return fail(code);
  }
}

function mediaSource(output) {
  const version = output.audioVersionEvidence;
  return Object.freeze({
    sourceKind: 'tts_asset',
    sourceAssetUid: version.assetUid,
    sourceAssetVersionUid: version.uid,
    sourceMediaSha256: version.sha256,
    sourceMimeType: version.mimeType,
  });
}

function nativeTrack(source) {
  if (source === null) return null;
  return Object.freeze({
    sourceKind: 'h3_native',
    sourceAssetUid: source.videoAsset.uid,
    sourceAssetVersionUid: source.videoVersionEvidence.uid,
    sourceMediaSha256: source.videoVersionEvidence.sha256,
    sourceMimeType: source.videoVersionEvidence.mimeType,
    durationMs: source.durationMs,
    h3SourceSha256: source.sourceSha256,
  });
}

function segment(binding, ordinal, startMs, durationMs, source) {
  return Object.freeze({
    ordinal,
    dialogueDeliveryUid: binding.dialogueDeliveryUid,
    dialogueEntryId: binding.dialogueDelivery.dialogueEntryId,
    characterUid: binding.characterUid,
    startMs,
    endMs: startMs + durationMs,
    durationMs,
    sourceKind: source.sourceKind,
    sourceAssetUid: source.sourceAssetUid,
    sourceAssetVersionUid: source.sourceAssetVersionUid,
    sourceMediaSha256: source.sourceMediaSha256,
    sourceMimeType: source.sourceMimeType,
  });
}

function proportionalDurations(bindings, totalDurationMs) {
  const count = bindings.length;
  if (count < 1 || totalDurationMs < count) fail(INPUT_CODE);
  const weights = bindings.map((binding) => BigInt(binding.estimatedTotalDurationMs));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeight < 1n) fail(INPUT_CODE);
  const distributable = BigInt(totalDurationMs - count);
  const durations = new Array(count).fill(1);
  const remainders = [];
  let allocated = count;
  for (let index = 0; index < count; index += 1) {
    const scaled = distributable * weights[index];
    const quotient = scaled / totalWeight;
    const remainder = scaled % totalWeight;
    const extra = Number(quotient);
    durations[index] += extra;
    allocated += extra;
    remainders.push({ index, remainder });
  }
  remainders.sort((left, right) => (
    left.remainder === right.remainder
      ? left.index - right.index
      : (left.remainder > right.remainder ? -1 : 1)
  ));
  for (let index = 0; index < totalDurationMs - allocated; index += 1) {
    durations[remainders[index].index] += 1;
  }
  return durations;
}

function placedSegments(
  plan, execution, targetDurationMs, placementValues, placementOrder = 'plan',
) {
  if (plan.mode !== 'independent_tts') fail(INPUT_CODE);
  const durationMs = boundedInteger(targetDurationMs, 1, MAX_TIMELINE_MS, INPUT_CODE);
  const placements = denseArray(placementValues, MAX_SEGMENTS, INPUT_CODE);
  if (placements.length !== plan.dialogueBindings.length) fail(INPUT_CODE);
  const segments = [];
  const subtitleBindings = [];
  let previousEndMs = 0;
  const chronological = placementOrder === 'chronological';
  if (!chronological && placementOrder !== 'plan') fail(INPUT_CODE);
  const sourcesByUid = chronological ? new MAP_CONSTRUCTOR() : null;
  const used = chronological ? new SET_CONSTRUCTOR() : null;
  if (chronological) {
    for (let index = 0; index < plan.dialogueBindings.length; index += 1) {
      const binding = plan.dialogueBindings[index];
      const output = execution.ttsOutputs[index];
      if (output.dialogueDeliveryUid !== binding.dialogueDeliveryUid
        || mapHas(sourcesByUid, binding.dialogueDeliveryUid)) fail(INPUT_CODE);
      mapSet(sourcesByUid, binding.dialogueDeliveryUid, Object.freeze({ binding, output }));
    }
  }
  for (let index = 0; index < placements.length; index += 1) {
    const placement = exactObject(placements[index], PLACEMENT_KEYS, INPUT_CODE);
    const source = chronological
      ? mapGet(sourcesByUid, placement.dialogueDeliveryUid)
      : Object.freeze({
        binding: plan.dialogueBindings[index], output: execution.ttsOutputs[index],
      });
    if (!source || chronological && setHas(used, placement.dialogueDeliveryUid)) fail(INPUT_CODE);
    const { binding, output } = source;
    const startMs = boundedInteger(placement.startMs, 0, durationMs, INPUT_CODE);
    const sourceDurationMs = output.audioVersionEvidence.durationMs;
    if (placement.dialogueDeliveryUid !== binding.dialogueDeliveryUid
      || startMs < previousEndMs || startMs + sourceDurationMs > durationMs) fail(INPUT_CODE);
    const current = segment(binding, index, startMs, sourceDurationMs, mediaSource(output));
    segments.push(current);
    subtitleBindings.push(binding);
    if (chronological) setAdd(used, placement.dialogueDeliveryUid);
    previousEndMs = current.endMs;
  }
  if (chronological && setSize(used) !== plan.dialogueBindings.length) fail(INPUT_CODE);
  return Object.freeze({
    durationMs,
    nativeTrack: null,
    segments: frozenArray(segments),
    subtitleBindings: frozenArray(subtitleBindings),
    timingAlgorithmVersion: chronological
      ? CHRONOLOGICAL_PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION
      : PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
  });
}

function buildSegments(plan, execution, placementInput = null) {
  if (placementInput !== null) {
    return placedSegments(
      plan, execution, placementInput.targetDurationMs, placementInput.placements,
      placementInput.placementOrder,
    );
  }
  if (plan.mode === 'h3_native') {
    const source = nativeTrack(execution.h3NativeSource);
    const durations = proportionalDurations(plan.dialogueBindings, source.durationMs);
    let cursor = 0;
    const segments = plan.dialogueBindings.map((binding, index) => {
      const current = segment(binding, index, cursor, durations[index], source);
      cursor = current.endMs;
      return current;
    });
    return Object.freeze({
      durationMs: source.durationMs,
      nativeTrack: source,
      segments: frozenArray(segments),
      subtitleBindings: plan.dialogueBindings,
      timingAlgorithmVersion: AUDIO_TIMELINE_ALGORITHM_VERSION,
    });
  }

  let cursor = 0;
  const segments = plan.dialogueBindings.map((binding, index) => {
    const output = execution.ttsOutputs[index];
    const durationMs = output.audioVersionEvidence.durationMs;
    if (cursor + durationMs > MAX_TIMELINE_MS) fail(INPUT_CODE);
    const current = segment(binding, index, cursor, durationMs, mediaSource(output));
    cursor = current.endMs;
    return current;
  });
  const source = nativeTrack(execution.h3NativeSource);
  if (plan.mode === 'hybrid' && cursor > source.durationMs) fail(INPUT_CODE);
  return Object.freeze({
    durationMs: plan.mode === 'hybrid' ? source.durationMs : cursor,
    nativeTrack: source,
    segments: frozenArray(segments),
    subtitleBindings: plan.dialogueBindings,
    timingAlgorithmVersion: AUDIO_TIMELINE_ALGORITHM_VERSION,
  });
}

function timelineRecord(input) {
  const subtitleTrack = buildSubtitleTrack({
    timelineUid: input.uid,
    planUid: input.plan.uid,
    executionUid: input.execution.uid,
    durationMs: input.durationMs,
    timingAlgorithmVersion: input.timingAlgorithmVersion,
    bindings: input.subtitleBindings,
    segments: input.segments,
  });
  const base = Object.freeze({
    schemaVersion: '8.0',
    timingAlgorithmVersion: input.timingAlgorithmVersion,
    uid: input.uid,
    dramaUid: input.plan.dramaUid,
    workflowRunUid: input.plan.workflowRunUid,
    planUid: input.plan.uid,
    planSha256: input.plan.planSha256,
    executionUid: input.execution.uid,
    executionSha256: input.execution.executionSha256,
    mode: input.plan.mode,
    durationMs: input.durationMs,
    nativeTrack: input.nativeTrack,
    segments: input.segments,
    subtitleTrack,
    createdAtEpochMs: input.createdAtEpochMs,
  });
  return Object.freeze({
    schemaVersion: base.schemaVersion,
    timingAlgorithmVersion: base.timingAlgorithmVersion,
    uid: base.uid,
    dramaUid: base.dramaUid,
    workflowRunUid: base.workflowRunUid,
    planUid: base.planUid,
    planSha256: base.planSha256,
    executionUid: base.executionUid,
    executionSha256: base.executionSha256,
    mode: base.mode,
    durationMs: base.durationMs,
    nativeTrack: base.nativeTrack,
    segments: base.segments,
    subtitleTrack: base.subtitleTrack,
    timelineSha256: canonicalHash(base),
    createdAtEpochMs: base.createdAtEpochMs,
  });
}

function createAudioTimeline(value) {
  try {
    let input;
    let placementInput = null;
    try {
      input = exactObject(value, CHRONOLOGICAL_PLACED_INPUT_KEYS, INPUT_CODE);
      if (input.placementOrder !== 'chronological') fail(INPUT_CODE);
      placementInput = Object.freeze({
        targetDurationMs: input.targetDurationMs,
        placementOrder: input.placementOrder,
        placements: input.placements,
      });
    } catch {
      try {
        input = exactObject(value, PLACED_INPUT_KEYS, INPUT_CODE);
        placementInput = Object.freeze({
          targetDurationMs: input.targetDurationMs,
          placementOrder: 'plan',
          placements: input.placements,
        });
      } catch {
        input = exactObject(value, INPUT_KEYS, INPUT_CODE);
      }
    }
    if (input.schemaVersion !== '8.0') fail(INPUT_CODE);
    const plan = safePlan(input.plan, INPUT_CODE);
    const execution = safeExecution(input.executionEvidence, plan, INPUT_CODE);
    const uid = canonicalUid(input.uid, INPUT_CODE);
    const createdAtEpochMs = epoch(input.createdAtEpochMs, INPUT_CODE);
    if (uid === plan.uid || uid === execution.uid
      || createdAtEpochMs < plan.createdAtEpochMs
      || createdAtEpochMs < execution.createdAtEpochMs) fail(INPUT_CODE);
    const built = buildSegments(plan, execution, placementInput);
    return timelineRecord({ uid, plan, execution, createdAtEpochMs, ...built });
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === INPUT_CODE) throw error;
    return fail(INPUT_CODE);
  }
}

function parseNativeTrack(value, code) {
  if (value === null) return null;
  const input = exactObject(value, NATIVE_TRACK_KEYS, code);
  if (input.sourceKind !== 'h3_native' || input.sourceMimeType !== 'video/mp4') fail(code);
  return Object.freeze({
    sourceKind: input.sourceKind,
    sourceAssetUid: canonicalUid(input.sourceAssetUid, code),
    sourceAssetVersionUid: canonicalUid(input.sourceAssetVersionUid, code),
    sourceMediaSha256: sha256(input.sourceMediaSha256, code),
    sourceMimeType: input.sourceMimeType,
    durationMs: boundedInteger(input.durationMs, 1, MAX_TIMELINE_MS, code),
    h3SourceSha256: sha256(input.h3SourceSha256, code),
  });
}

function parseSegment(value, durationMs, code) {
  const input = exactObject(value, SEGMENT_KEYS, code);
  const sourceKind = input.sourceKind;
  if (!['tts_asset', 'h3_native'].includes(sourceKind)
    || (sourceKind === 'tts_asset' && !setHas(AUDIO_MIME_TYPES, input.sourceMimeType))
    || (sourceKind === 'h3_native' && input.sourceMimeType !== 'video/mp4')) fail(code);
  const startMs = boundedInteger(input.startMs, 0, durationMs, code);
  const endMs = boundedInteger(input.endMs, 1, durationMs, code);
  const segmentDurationMs = boundedInteger(input.durationMs, 1, MAX_TIMELINE_MS, code);
  if (endMs <= startMs || endMs - startMs !== segmentDurationMs
    || typeof input.dialogueEntryId !== 'string' || input.dialogueEntryId.length < 1
    || input.dialogueEntryId.length > 128 || input.dialogueEntryId !== input.dialogueEntryId.trim()) fail(code);
  return Object.freeze({
    ordinal: boundedInteger(input.ordinal, 0, MAX_SEGMENTS - 1, code),
    dialogueDeliveryUid: canonicalUid(input.dialogueDeliveryUid, code),
    dialogueEntryId: input.dialogueEntryId,
    characterUid: canonicalUid(input.characterUid, code),
    startMs,
    endMs,
    durationMs: segmentDurationMs,
    sourceKind,
    sourceAssetUid: canonicalUid(input.sourceAssetUid, code),
    sourceAssetVersionUid: canonicalUid(input.sourceAssetVersionUid, code),
    sourceMediaSha256: sha256(input.sourceMediaSha256, code),
    sourceMimeType: input.sourceMimeType,
  });
}

function parseAudioTimelineRecord(value) {
  try {
    const input = exactObject(value, RECORD_KEYS, DATA_CODE);
    if (input.schemaVersion !== '8.0'
      || ![
        AUDIO_TIMELINE_ALGORITHM_VERSION,
        PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
        CHRONOLOGICAL_PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
      ]
        .includes(input.timingAlgorithmVersion)
      || !['independent_tts', 'h3_native', 'hybrid'].includes(input.mode)) fail(DATA_CODE);
    const durationMs = boundedInteger(input.durationMs, 1, MAX_TIMELINE_MS, DATA_CODE);
    const native = parseNativeTrack(input.nativeTrack, DATA_CODE);
    const segments = denseArray(input.segments, MAX_SEGMENTS, DATA_CODE)
      .map((value) => parseSegment(value, durationMs, DATA_CODE));
    if (segments.length < 1) fail(DATA_CODE);
    for (let index = 0; index < segments.length; index += 1) {
      const current = segments[index];
      if (current.ordinal !== index
        || (input.timingAlgorithmVersion === AUDIO_TIMELINE_ALGORITHM_VERSION && (
          (index === 0 && current.startMs !== 0)
          || (index > 0 && current.startMs !== segments[index - 1].endMs)
        ))
        || ([
          PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
          CHRONOLOGICAL_PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
        ].includes(input.timingAlgorithmVersion) && (
          input.mode !== 'independent_tts'
          || (index > 0 && current.startMs < segments[index - 1].endMs)
        ))) fail(DATA_CODE);
    }
    const lastEndMs = segments[segments.length - 1].endMs;
    if ((input.mode === 'independent_tts' && (native !== null
      || segments.some((entry) => entry.sourceKind !== 'tts_asset')
      || (input.timingAlgorithmVersion === AUDIO_TIMELINE_ALGORITHM_VERSION
        && lastEndMs !== durationMs)))
      || (input.mode === 'h3_native' && (native === null || lastEndMs !== durationMs
        || segments.some((entry) => entry.sourceKind !== 'h3_native')))
      || (input.mode === 'hybrid' && (native === null || lastEndMs > durationMs
        || segments.some((entry) => entry.sourceKind !== 'tts_asset')))) fail(DATA_CODE);
    if (native !== null && (native.durationMs !== durationMs
      || input.mode === 'h3_native' && segments.some((entry) => (
        entry.sourceAssetUid !== native.sourceAssetUid
        || entry.sourceAssetVersionUid !== native.sourceAssetVersionUid
        || entry.sourceMediaSha256 !== native.sourceMediaSha256
        || entry.sourceMimeType !== native.sourceMimeType
      )))) fail(DATA_CODE);
    const metadata = Object.freeze({
      timelineUid: canonicalUid(input.uid, DATA_CODE),
      planUid: canonicalUid(input.planUid, DATA_CODE),
      executionUid: canonicalUid(input.executionUid, DATA_CODE),
      durationMs,
      maximumDurationMs: MAX_TIMELINE_MS,
      segments,
      timingAlgorithmVersion: input.timingAlgorithmVersion,
    });
    const subtitleTrack = parseSubtitleTrack(input.subtitleTrack, metadata, DATA_CODE);
    const base = Object.freeze({
      schemaVersion: '8.0',
      timingAlgorithmVersion: input.timingAlgorithmVersion,
      uid: metadata.timelineUid,
      dramaUid: canonicalUid(input.dramaUid, DATA_CODE),
      workflowRunUid: canonicalUid(input.workflowRunUid, DATA_CODE),
      planUid: metadata.planUid,
      planSha256: sha256(input.planSha256, DATA_CODE),
      executionUid: metadata.executionUid,
      executionSha256: sha256(input.executionSha256, DATA_CODE),
      mode: input.mode,
      durationMs,
      nativeTrack: native,
      segments: frozenArray(segments),
      subtitleTrack,
      createdAtEpochMs: epoch(input.createdAtEpochMs, DATA_CODE),
    });
    const canonical = Object.freeze({
      schemaVersion: base.schemaVersion,
      timingAlgorithmVersion: base.timingAlgorithmVersion,
      uid: base.uid,
      dramaUid: base.dramaUid,
      workflowRunUid: base.workflowRunUid,
      planUid: base.planUid,
      planSha256: base.planSha256,
      executionUid: base.executionUid,
      executionSha256: base.executionSha256,
      mode: base.mode,
      durationMs: base.durationMs,
      nativeTrack: base.nativeTrack,
      segments: base.segments,
      subtitleTrack: base.subtitleTrack,
      timelineSha256: canonicalHash(base),
      createdAtEpochMs: base.createdAtEpochMs,
    });
    if (canonical.timelineSha256 !== input.timelineSha256) fail(DATA_CODE);
    return canonical;
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === DATA_CODE) throw error;
    return fail(DATA_CODE);
  }
}

function createAudioTimelineVerifier(value) {
  const dependencies = exactObject(value, ['loadTrustedEnvelope'], INPUT_CODE);
  if (typeof dependencies.loadTrustedEnvelope !== 'function') fail(INPUT_CODE);
  const loadTrustedEnvelope = dependencies.loadTrustedEnvelope;
  return Object.freeze({
    verify(timelineValue, expectedTimelineUid) {
      try {
        const anchorUid = canonicalUid(expectedTimelineUid, DATA_CODE);
        const stored = parseAudioTimelineRecord(timelineValue);
        const expected = createAudioTimeline(loadTrustedEnvelope(anchorUid));
        if (expected.uid !== anchorUid) fail(DATA_CODE);
        if (canonicalHash(stored) !== canonicalHash(expected)) fail(DATA_CODE);
        REFLECT_APPLY(WEAK_SET_ADD, TRUSTED_TIMELINES, [expected]);
        return expected;
      } catch {
        return fail(DATA_CODE);
      }
    },
  });
}

function requireTrustedAudioTimeline(value) {
  if ((typeof value === 'object' || typeof value === 'function')
    && value !== null && REFLECT_APPLY(WEAK_SET_HAS, TRUSTED_TIMELINES, [value])) return value;
  return fail(DATA_CODE);
}

module.exports = Object.freeze({
  AUDIO_TIMELINE_ALGORITHM_VERSION,
  CHRONOLOGICAL_PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
  PLACED_AUDIO_TIMELINE_ALGORITHM_VERSION,
  createAudioTimeline,
  createAudioTimelineVerifier,
  parseAudioTimelineRecord,
  requireTrustedAudioTimeline,
});
