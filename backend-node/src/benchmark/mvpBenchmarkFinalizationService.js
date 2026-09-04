'use strict';

const { types: { isProxy } } = require('node:util');

const {
  canonicalHash,
  canonicalUid,
  denseArray,
  exactObject,
} = require('../audio/audioContract');
const {
  createAudioTimeline,
  createAudioTimelineVerifier,
} = require('../audio/audioTimeline');
const {
  createAudioMixPlan,
  createAudioMixPlanVerifier,
} = require('../audio/audioMixPlan');
const {
  createProductionTimelineSnapshot,
  createProductionTimelineSnapshotVerifier,
} = require('../audio/productionTimelineSnapshot');
const {
  createMediaNormalizationPlan,
  createMediaNormalizationPlanVerifier,
} = require('../media/mediaNormalizationPlan');
const {
  createMediaExportExecutionPlan,
  parseMediaExportExecutionPlanRecord,
} = require('../media/mediaExportExecutionPlan');
const { validateRunAggregate } = require('../workflows/runState');

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PUSH = Array.prototype.push;
const ARRAY_SORT = Array.prototype.sort;
const MAP_CONSTRUCTOR = Map;
const MAP_DELETE = Map.prototype.delete;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const OBJECT_CREATE = Object.create;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const SET_CONSTRUCTOR = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;

function append(target, value) {
  REFLECT_APPLY(ARRAY_PUSH, target, [value]);
}

function mapDelete(target, key) {
  return REFLECT_APPLY(MAP_DELETE, target, [key]);
}

function mapGet(target, key) {
  return REFLECT_APPLY(MAP_GET, target, [key]);
}

function mapSet(target, key, value) {
  REFLECT_APPLY(MAP_SET, target, [key, value]);
}

const INPUT_CODE = 'MVP_BENCHMARK_FINALIZATION_INPUT_INVALID';
const UNAVAILABLE_CODE = 'MVP_BENCHMARK_FINALIZATION_UNAVAILABLE';
const IN_PROGRESS_CODE = 'MVP_BENCHMARK_FINALIZATION_IN_PROGRESS';
const FAILED_CODE = 'MVP_BENCHMARK_FINALIZATION_FAILED';
const REQUEST_SCHEMA_VERSION = 'mvp-benchmark-finalization-request.v1';
const REORDERED_REQUEST_SCHEMA_VERSION = 'mvp-benchmark-finalization-request.v2';
const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'dramaUid',
  'expectedBatchSha256', 'bgmTrackUid',
]);
const REORDERED_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'dramaUid',
  'expectedBatchSha256', 'bgmTrackUid', 'shotTaskOrder',
]);
const FINALIZATION_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'expectedBatchSha256',
  'bgmTrackUid', 'executionPlanSha256',
]);
const REORDERED_FINALIZATION_INPUT_KEYS = Object.freeze([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'expectedBatchSha256',
  'bgmTrackUid', 'shotTaskOrder', 'executionPlanSha256',
]);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_MEDIA_INPUTS = 100;
const MIN_SHOTS = 4;
const MAX_SHOTS = 6;
const REQUIRED_REPOSITORIES = Object.freeze([
  'assets', 'bgmTracks', 'generationHistory', 'h3GenerationIntents',
  'audioModeIntents', 'mvpBenchmarkExternalAuthorizations',
  'mvpBenchmarkExecutionPreflights', 'mvpBenchmarkSessions', 'runs',
]);

class MvpBenchmarkFinalizationError extends Error {
  constructor(code) {
    const messages = Object.freeze({
      [INPUT_CODE]: 'MVP benchmark finalization input is invalid',
      [UNAVAILABLE_CODE]: 'MVP benchmark finalization is unavailable',
      [IN_PROGRESS_CODE]: 'MVP benchmark finalization is already in progress',
      [FAILED_CODE]: 'MVP benchmark final export failed',
    });
    super(messages[code] ?? messages[FAILED_CODE]);
    this.name = 'MvpBenchmarkFinalizationError';
    this.code = code;
  }

  toJSON() { return Object.freeze({ code: this.code, message: this.message }); }
}

function fail(code = UNAVAILABLE_CODE) {
  throw new MvpBenchmarkFinalizationError(code);
}

function isMvpBenchmarkFinalizationError(error) {
  return error instanceof MvpBenchmarkFinalizationError;
}

function requestRecord(value) {
  try {
    let input;
    let reordered = false;
    try {
      input = exactObject(value, REORDERED_INPUT_KEYS, INPUT_CODE);
      reordered = true;
    } catch {
      input = exactObject(value, INPUT_KEYS, INPUT_CODE);
    }
    if ((input.schemaVersion !== REQUEST_SCHEMA_VERSION
      && input.schemaVersion !== REORDERED_REQUEST_SCHEMA_VERSION)
      || reordered !== (input.schemaVersion === REORDERED_REQUEST_SCHEMA_VERSION)
      || typeof input.expectedBatchSha256 !== 'string'
      || !REFLECT_APPLY(REGEXP_TEST, SHA256, [input.expectedBatchSha256])) fail(INPUT_CODE);
    const base = {
      schemaVersion: input.schemaVersion,
      authorizationUid: canonicalUid(input.authorizationUid, INPUT_CODE),
      sessionUid: canonicalUid(input.sessionUid, INPUT_CODE),
      dramaUid: canonicalUid(input.dramaUid, INPUT_CODE),
      expectedBatchSha256: input.expectedBatchSha256,
      bgmTrackUid: canonicalUid(input.bgmTrackUid, INPUT_CODE),
    };
    if (!reordered) return Object.freeze(base);
    const sourceOrder = denseArray(input.shotTaskOrder, MAX_MEDIA_INPUTS, INPUT_CODE);
    if (sourceOrder.length < MIN_SHOTS || sourceOrder.length > MAX_SHOTS) fail(INPUT_CODE);
    const order = [];
    const unique = new SET_CONSTRUCTOR();
    for (let index = 0; index < sourceOrder.length; index += 1) {
      const taskUid = canonicalUid(sourceOrder[index], INPUT_CODE);
      if (REFLECT_APPLY(SET_HAS, unique, [taskUid])) fail(INPUT_CODE);
      REFLECT_APPLY(SET_ADD, unique, [taskUid]);
      append(order, taskUid);
    }
    return Object.freeze({ ...base, shotTaskOrder: Object.freeze(order) });
  } catch (error) {
    if (isMvpBenchmarkFinalizationError(error)) throw error;
    return fail(INPUT_CODE);
  }
}

function configuration(value) {
  const keys = [
    'repositories', 'h3LocalExecution', 'audioTtsExecution', 'mediaProbe',
    'mediaExportService', 'createUid', 'nowEpochMs',
  ];
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark finalization dependencies are invalid');
  }
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  if (REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]) !== Object.prototype
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) {
    throw new TypeError('MVP benchmark finalization dependencies are invalid');
  }
  const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, keys[index]])) {
      throw new TypeError('MVP benchmark finalization dependencies are invalid');
    }
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) {
      throw new TypeError('MVP benchmark finalization dependencies are invalid');
    }
    output[keys[index]] = descriptor.value;
  }
  if (!output.repositories || typeof output.repositories !== 'object'
    || isProxy(output.repositories)
    || typeof output.repositories.withTransaction !== 'function'
    || !output.h3LocalExecution || typeof output.h3LocalExecution.get !== 'function'
    || !output.audioTtsExecution || typeof output.audioTtsExecution.get !== 'function'
    || typeof output.audioTtsExecution.getPersisted !== 'function'
    || !output.mediaProbe || typeof output.mediaProbe.inspect !== 'function'
    || !output.mediaExportService || typeof output.mediaExportService.start !== 'function'
    || typeof output.createUid !== 'function' || isProxy(output.createUid)
    || typeof output.nowEpochMs !== 'function' || isProxy(output.nowEpochMs)) {
    throw new TypeError('MVP benchmark finalization dependencies are invalid');
  }
  for (let index = 0; index < REQUIRED_REPOSITORIES.length; index += 1) {
    const repository = output.repositories[REQUIRED_REPOSITORIES[index]];
    if (!repository || typeof repository !== 'object' || isProxy(repository)) {
      throw new TypeError('MVP benchmark finalization dependencies are invalid');
    }
  }
  const repositoryMethods = Object.freeze({
    assets: Object.freeze(['get', 'getVersion']),
    bgmTracks: Object.freeze(['get']),
    generationHistory: Object.freeze(['get']),
    h3GenerationIntents: Object.freeze(['getByTask']),
    audioModeIntents: Object.freeze(['getCompletedSource']),
    mvpBenchmarkExternalAuthorizations: Object.freeze(['getStoredBySession']),
    mvpBenchmarkExecutionPreflights: Object.freeze(['getStoredBatchByAuthorization']),
    mvpBenchmarkSessions: Object.freeze(['getStored']),
    runs: Object.freeze([
      'getWorkflowWithNodes', 'transitionNodeStatus', 'transitionWorkflowStatus',
    ]),
  });
  for (let index = 0; index < REQUIRED_REPOSITORIES.length; index += 1) {
    const name = REQUIRED_REPOSITORIES[index];
    const methods = repositoryMethods[name];
    for (let methodIndex = 0; methodIndex < methods.length; methodIndex += 1) {
      if (typeof output.repositories[name][methods[methodIndex]] !== 'function') {
        throw new TypeError('MVP benchmark finalization dependencies are invalid');
      }
    }
  }
  return Object.freeze(output);
}

function sameRequest(left, right) {
  const keys = INPUT_KEYS;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (left[key] !== right[key]) return false;
  }
  if (left.schemaVersion === REORDERED_REQUEST_SCHEMA_VERSION) {
    if (right.schemaVersion !== REORDERED_REQUEST_SCHEMA_VERSION
      || left.shotTaskOrder.length !== right.shotTaskOrder.length) return false;
    for (let index = 0; index < left.shotTaskOrder.length; index += 1) {
      if (left.shotTaskOrder[index] !== right.shotTaskOrder[index]) return false;
    }
  }
  return true;
}

function loadFrozenContext(repositories, request) {
  const authorization = repositories.mvpBenchmarkExternalAuthorizations.getStoredBySession(
    request.sessionUid,
  );
  if (!authorization || authorization.uid !== request.authorizationUid
    || authorization.sessionUid !== request.sessionUid
    || authorization.dramaUid !== request.dramaUid) fail();
  const batch = repositories.mvpBenchmarkExecutionPreflights.getStoredBatchByAuthorization(
    authorization.uid,
  );
  if (!batch || batch.batchSha256 !== request.expectedBatchSha256
    || batch.authorizationUid !== authorization.uid
    || batch.sessionUid !== request.sessionUid
    || batch.dramaUid !== request.dramaUid) fail();
  const session = repositories.mvpBenchmarkSessions.getStored(request.sessionUid);
  if (!session || session.uid !== request.sessionUid
    || session.dramaUid !== request.dramaUid
    || session.planSha256 !== authorization.sessionPlanSha256
    || session.audioIntents.length !== 1
    || batch.reservations.length !== session.h3Tasks.length + 1) fail();
  for (let index = 0; index < batch.reservations.length; index += 1) {
    const reservation = batch.reservations[index];
    const h3 = index < session.h3Tasks.length;
    const expected = h3 ? session.h3Tasks[index] : session.audioIntents[0];
    if (reservation.itemKind !== (h3 ? 'h3' : 'tts')
      || reservation.itemUid !== (h3 ? expected.taskUid : expected.intentUid)) fail();
  }
  return Object.freeze({ authorization, batch, session });
}

function plannedOrdinal(intent) {
  const shotId = intent.generationSpec?.prompt?.shotId;
  const shots = intent.promptSemantic?.semantic?.output?.semanticShots;
  if (typeof shotId !== 'string' || !Array.isArray(shots)) fail();
  const matching = [];
  for (let index = 0; index < shots.length; index += 1) {
    if (shots[index]?.shotId === shotId) append(matching, shots[index]);
  }
  if (matching.length !== 1 || !Number.isSafeInteger(matching[0].ordinal)
    || matching[0].ordinal < 1) fail();
  return matching[0].ordinal;
}

function loadH3Sources(config, context, request) {
  const sources = [];
  for (let index = 0; index < context.session.h3Tasks.length; index += 1) {
    const item = context.session.h3Tasks[index];
    const result = config.h3LocalExecution.get(item.taskUid);
    if (!result || result.status !== 'succeeded'
      || result.taskUid !== item.taskUid
      || result.workflowRunUid !== context.session.workflowRunUid
      || result.nodeRunUid !== item.nodeRunUid
      || result.assetUid !== item.assetUid) fail();
    const intent = config.repositories.h3GenerationIntents.getByTask(item.taskUid);
    const history = config.repositories.generationHistory.get(result.historyUid);
    const asset = config.repositories.assets.get(result.assetUid);
    const assetVersion = config.repositories.assets.getVersion(result.assetVersionUid);
    if (intent.uid !== item.intentUid || intent.historyUid !== result.historyUid
      || asset.currentVersionUid !== assetVersion.uid) fail();
    append(sources, Object.freeze({
      taskUid: item.taskUid,
      shot: Object.freeze({
        shotId: intent.generationSpec.prompt.shotId,
        plannedOrdinal: plannedOrdinal(intent),
        h3ExecutionResult: result,
        generationHistory: history,
        asset,
        assetVersion,
      }),
    }));
  }
  REFLECT_APPLY(ARRAY_SORT, sources, [(left, right) => (
    left.shot.plannedOrdinal - right.shot.plannedOrdinal
  )]);
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index].shot.plannedOrdinal !== index + 1) fail();
  }
  const shots = [];
  if (request.schemaVersion === REQUEST_SCHEMA_VERSION) {
    for (let index = 0; index < sources.length; index += 1) append(shots, sources[index].shot);
    return Object.freeze(shots);
  }
  if (request.shotTaskOrder.length !== sources.length) fail();
  const byTaskUid = new MAP_CONSTRUCTOR();
  for (let index = 0; index < sources.length; index += 1) {
    mapSet(byTaskUid, sources[index].taskUid, sources[index].shot);
  }
  for (let index = 0; index < request.shotTaskOrder.length; index += 1) {
    const shot = mapGet(byTaskUid, request.shotTaskOrder[index]);
    if (!shot) fail();
    append(shots, shot);
    mapDelete(byTaskUid, request.shotTaskOrder[index]);
  }
  if (shots.length !== sources.length) fail();
  return Object.freeze(shots);
}

async function loadAudioSource(config, context) {
  const item = context.session.audioIntents[0];
  const intent = config.repositories.audioModeIntents.getCompletedSource(item.intentUid);
  if (intent.uid !== item.intentUid || intent.plan.planSha256 !== item.planSha256
    || intent.plan.mode !== 'independent_tts'
    || intent.workflowRunUid !== context.session.workflowRunUid) fail();
  const record = await config.audioTtsExecution.get(item.intentUid, context.session.dramaUid);
  if (!record || record.intentUid !== item.intentUid
    || record.workflowRunUid !== context.session.workflowRunUid
    || record.nodeRunUid !== item.nodeRunUid) fail();
  return Object.freeze({ intent, record });
}

function loadBgmSource(repositories, request) {
  const track = repositories.bgmTracks.get(request.bgmTrackUid);
  const asset = repositories.assets.get(track.assetVersion.assetUid);
  const version = repositories.assets.getVersion(track.assetVersion.uid);
  if (track.dramaUid !== request.dramaUid || asset.currentVersionUid !== version.uid
    || canonicalHash(version) !== canonicalHash(track.assetVersion)) fail();
  return track;
}

function graphContext(repositories, session) {
  const aggregate = validateRunAggregate(repositories.runs.getWorkflowWithNodes(
    session.workflowRunUid,
  ));
  if (aggregate.run.workflowUid !== session.workflowUid
    || aggregate.run.graphHash !== session.graphHash
    || aggregate.run.graphRevision !== session.graphRevision) fail();
  const definitions = aggregate.run.graphSnapshot.snapshot.nodes;
  const exportDefinitions = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const node = definitions[index];
    if (node.nodeType === 'export.final' && node.enabled === true) {
      append(exportDefinitions, node);
    }
  }
  if (exportDefinitions.length !== 1) fail();
  const definition = exportDefinitions[0];
  if (definition.config.format !== 'mp4' || definition.config.width !== 1920
    || definition.config.height !== 1080 || definition.config.fps !== 30) fail();
  const nodeMatches = [];
  for (let index = 0; index < aggregate.nodes.length; index += 1) {
    if (aggregate.nodes[index].nodeUid === definition.uid) {
      append(nodeMatches, aggregate.nodes[index]);
    }
  }
  if (nodeMatches.length !== 1) fail();
  const sourceVideoNodes = new SET_CONSTRUCTOR();
  let audioMatches = 0;
  const edges = aggregate.run.graphSnapshot.snapshot.edges;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    if (edge.targetNodeUid !== definition.uid) continue;
    if (edge.targetPort === 'videos' && edge.sourcePort === 'video') {
      REFLECT_APPLY(SET_ADD, sourceVideoNodes, [edge.sourceNodeUid]);
    } else if (edge.targetPort === 'audio' && edge.sourcePort === 'audio'
      && edge.sourceNodeUid === session.audioIntents[0].nodeUid) {
      audioMatches += 1;
    } else {
      fail();
    }
  }
  if (REFLECT_APPLY(SET_SIZE, sourceVideoNodes, []) !== session.h3Tasks.length
    || audioMatches !== 1) fail();
  for (let index = 0; index < session.h3Tasks.length; index += 1) {
    if (!REFLECT_APPLY(SET_HAS, sourceVideoNodes, [session.h3Tasks[index].nodeUid])) fail();
  }
  for (let index = 0; index < aggregate.nodes.length; index += 1) {
    const node = aggregate.nodes[index];
    if (node.uid === nodeMatches[0].uid) continue;
    let planNode = null;
    for (let definitionIndex = 0; definitionIndex < definitions.length; definitionIndex += 1) {
      if (definitions[definitionIndex].uid === node.nodeUid) {
        planNode = definitions[definitionIndex];
        break;
      }
    }
    if (planNode?.enabled === true && node.status !== 'succeeded' && node.status !== 'skipped') {
      fail();
    }
  }
  return Object.freeze({ aggregate, definition, node: nodeMatches[0] });
}

function placementsFor(plan, shots, executionEvidence, chronological) {
  if (plan.dialogueBindings.length !== executionEvidence.ttsOutputs.length) fail();
  const shotWindows = new MAP_CONSTRUCTOR();
  let targetDurationMs = 0;
  for (let index = 0; index < shots.length; index += 1) {
    const durationMs = shots[index].assetVersion.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs < 1) fail();
    mapSet(shotWindows, shots[index].shotId, Object.freeze({
      startMs: targetDurationMs,
      endMs: targetDurationMs + durationMs,
    }));
    targetDurationMs += durationMs;
  }
  const cursors = new MAP_CONSTRUCTOR();
  const placements = [];
  const sourcesByShot = chronological ? new MAP_CONSTRUCTOR() : null;
  if (chronological) {
    for (let index = 0; index < plan.dialogueBindings.length; index += 1) {
      const binding = plan.dialogueBindings[index];
      const output = executionEvidence.ttsOutputs[index];
      if (output.dialogueDeliveryUid !== binding.dialogueDeliveryUid) fail();
      const shotId = binding.dialogueDelivery.shotId;
      const entries = mapGet(sourcesByShot, shotId) ?? [];
      append(entries, Object.freeze({ binding, output }));
      mapSet(sourcesByShot, shotId, entries);
    }
  }
  let previousEndMs = 0;
  const appendPlacement = (binding, output) => {
    const shotId = binding.dialogueDelivery.shotId;
    const window = mapGet(shotWindows, shotId);
    if (!window || output.dialogueDeliveryUid !== binding.dialogueDeliveryUid) fail();
    const cursor = mapGet(cursors, shotId) ?? window.startMs;
    const startMs = cursor + binding.dialogueDelivery.pauseBeforeMs;
    const endMs = startMs + output.audioVersionEvidence.durationMs;
    const nextCursor = endMs + binding.dialogueDelivery.pauseAfterMs;
    if (startMs < previousEndMs || endMs > window.endMs || nextCursor > window.endMs) fail();
    append(placements, Object.freeze({ dialogueDeliveryUid: binding.dialogueDeliveryUid, startMs }));
    mapSet(cursors, shotId, nextCursor);
    previousEndMs = endMs;
  };
  if (chronological) {
    for (let shotIndex = 0; shotIndex < shots.length; shotIndex += 1) {
      const entries = mapGet(sourcesByShot, shots[shotIndex].shotId) ?? [];
      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        appendPlacement(entries[entryIndex].binding, entries[entryIndex].output);
      }
    }
  } else {
    for (let index = 0; index < plan.dialogueBindings.length; index += 1) {
      appendPlacement(plan.dialogueBindings[index], executionEvidence.ttsOutputs[index]);
    }
  }
  if (placements.length !== plan.dialogueBindings.length) fail();
  return Object.freeze({ placements: Object.freeze(placements), targetDurationMs });
}

function trustedTimeline(
  config, context, shots, audio, bgmTrack, createdAtEpochMs, chronological,
) {
  const placement = placementsFor(
    audio.intent.plan, shots, audio.record.evidence, chronological,
  );
  const timelineInput = Object.freeze({
    schemaVersion: '8.0',
    uid: config.createUid(),
    plan: audio.intent.plan,
    executionEvidence: audio.record.evidence,
    targetDurationMs: placement.targetDurationMs,
    ...(chronological ? { placementOrder: 'chronological' } : {}),
    placements: placement.placements,
    createdAtEpochMs,
  });
  const timeline = createAudioTimelineVerifier({
    loadTrustedEnvelope(uid) { if (uid !== timelineInput.uid) fail(); return timelineInput; },
  }).verify(createAudioTimeline(timelineInput), timelineInput.uid);
  const mixInput = Object.freeze({
    schemaVersion: '8.0',
    uid: config.createUid(),
    audioTimeline: timeline,
    bgmTrack,
    settings: Object.freeze({
      dialogueGainMilliDb: 0,
      nativeGainMilliDb: null,
      bgmGainMilliDb: -9_000,
      duckedBgmGainMilliDb: -18_000,
      fadeInMs: Math.min(300, timeline.durationMs),
      fadeOutMs: Math.min(500, Math.max(0, timeline.durationMs - 300)),
      duckingAttackMs: 50,
      duckingReleaseMs: 100,
    }),
    createdAtEpochMs,
  });
  const mix = createAudioMixPlanVerifier({
    loadTrustedEnvelope(uid) { if (uid !== mixInput.uid) fail(); return mixInput; },
  }).verify(createAudioMixPlan(mixInput), mixInput.uid);
  const audioSources = [];
  for (let index = 0; index < audio.record.evidence.ttsOutputs.length; index += 1) {
    const output = audio.record.evidence.ttsOutputs[index];
    append(audioSources, Object.freeze({
      sourceKind: 'tts_asset', asset: output.audioAsset,
      assetVersion: output.audioVersionEvidence,
    }));
  }
  const snapshotInput = Object.freeze({
    schemaVersion: '8.0',
    uid: config.createUid(),
    audioTimeline: timeline,
    audioMixPlan: mix,
    shots,
    audioSources: Object.freeze(audioSources),
    bgmTrack,
    createdAtEpochMs,
  });
  const histories = new MAP_CONSTRUCTOR();
  const results = new MAP_CONSTRUCTOR();
  for (let index = 0; index < shots.length; index += 1) {
    mapSet(histories, shots[index].generationHistory.uid, shots[index].generationHistory);
    mapSet(results, shots[index].h3ExecutionResult.taskUid, shots[index].h3ExecutionResult);
  }
  const snapshot = createProductionTimelineSnapshotVerifier({
    loadTrustedEnvelope(uid) { if (uid !== snapshotInput.uid) fail(); return snapshotInput; },
    loadGenerationHistory(uid) { return mapGet(histories, uid) ?? fail(); },
    loadH3ExecutionResult(uid) { return mapGet(results, uid) ?? fail(); },
  }).verify(createProductionTimelineSnapshot(snapshotInput), snapshotInput.uid);
  return Object.freeze({ snapshot, timeline });
}

async function trustedExecutionPlan(config, context, shots, audio, bgmTrack, chronological) {
  const createdAtEpochMs = config.nowEpochMs();
  if (!Number.isSafeInteger(createdAtEpochMs) || createdAtEpochMs < 0) fail();
  const production = trustedTimeline(
    config, context, shots, audio, bgmTrack, createdAtEpochMs, chronological,
  );
  const versions = [];
  for (let index = 0; index < production.snapshot.shots.length; index += 1) {
    append(versions, production.snapshot.shots[index].assetVersion);
  }
  for (let index = 0; index < production.snapshot.audioSources.length; index += 1) {
    append(versions, production.snapshot.audioSources[index].assetVersion);
  }
  append(versions, production.snapshot.bgmTrack.assetVersion);
  if (versions.length > MAX_MEDIA_INPUTS) fail();
  const probes = [];
  for (let index = 0; index < versions.length; index += 1) {
    append(probes, await config.mediaProbe.inspect(Object.freeze({
      schemaVersion: '8.0', uid: config.createUid(), assetVersion: versions[index],
      probedAtEpochMs: createdAtEpochMs,
    })));
  }
  const normalizationInput = Object.freeze({
    schemaVersion: '8.0', uid: config.createUid(),
    productionTimelineSnapshot: production.snapshot,
    mediaProbes: Object.freeze(probes), createdAtEpochMs,
  });
  const probesByUid = new MAP_CONSTRUCTOR();
  for (let index = 0; index < probes.length; index += 1) {
    mapSet(probesByUid, probes[index].uid, probes[index]);
  }
  const mediaProbeUids = [];
  for (let index = 0; index < probes.length; index += 1) {
    append(mediaProbeUids, probes[index].uid);
  }
  const normalization = createMediaNormalizationPlanVerifier({
    loadTrustedEnvelope(uid) {
      if (uid !== normalizationInput.uid) fail();
      return Object.freeze({
        schemaVersion: '8.0', uid,
        productionTimelineSnapshot: production.snapshot,
        mediaProbeUids: Object.freeze(mediaProbeUids),
        createdAtEpochMs,
      });
    },
    loadMediaProbeEvidence(uid) { return mapGet(probesByUid, uid) ?? fail(); },
  }).verify(createMediaNormalizationPlan(normalizationInput), normalizationInput.uid);
  return createMediaExportExecutionPlan({
    schemaVersion: '8.0', uid: config.createUid(),
    productionTimelineSnapshot: production.snapshot,
    normalizationPlan: normalization,
    createdAtEpochMs,
  });
}

function finalizationInput(request, executionPlan) {
  const base = {
    schemaVersion: request.schemaVersion === REORDERED_REQUEST_SCHEMA_VERSION
      ? 'mvp-benchmark-finalization-input.v2'
      : 'mvp-benchmark-finalization-input.v1',
    authorizationUid: request.authorizationUid,
    sessionUid: request.sessionUid,
    expectedBatchSha256: request.expectedBatchSha256,
    bgmTrackUid: request.bgmTrackUid,
    executionPlanSha256: executionPlan.executionPlanSha256,
  };
  if (request.schemaVersion === REORDERED_REQUEST_SCHEMA_VERSION) {
    return Object.freeze({ ...base, shotTaskOrder: request.shotTaskOrder });
  }
  return Object.freeze(base);
}

function parseExistingNode(node, request) {
  try {
    const reordered = request.schemaVersion === REORDERED_REQUEST_SCHEMA_VERSION;
    const input = exactObject(
      node.inputSnapshot,
      reordered ? REORDERED_FINALIZATION_INPUT_KEYS : FINALIZATION_INPUT_KEYS,
      UNAVAILABLE_CODE,
    );
    const output = exactObject(node.output, ['schemaVersion', 'executionPlan'], UNAVAILABLE_CODE);
    if (input.schemaVersion !== (reordered
      ? 'mvp-benchmark-finalization-input.v2'
      : 'mvp-benchmark-finalization-input.v1')
      || input.authorizationUid !== request.authorizationUid
      || input.sessionUid !== request.sessionUid
      || input.expectedBatchSha256 !== request.expectedBatchSha256
      || input.bgmTrackUid !== request.bgmTrackUid
      || output.schemaVersion !== 'media-export-node-output.v1') fail();
    if (reordered) {
      const order = denseArray(input.shotTaskOrder, MAX_MEDIA_INPUTS, UNAVAILABLE_CODE);
      if (order.length !== request.shotTaskOrder.length) fail();
      for (let index = 0; index < order.length; index += 1) {
        if (order[index] !== request.shotTaskOrder[index]) fail();
      }
    }
    const plan = parseMediaExportExecutionPlanRecord(output.executionPlan);
    if (input.executionPlanSha256 !== plan.executionPlanSha256
      || plan.workflowRunUid !== request.workflowRunUid
      || plan.dramaUid !== request.dramaUid
      || plan.audioMixPlan.bgm.trackUid !== request.bgmTrackUid) fail();
    return plan;
  } catch (error) {
    if (isMvpBenchmarkFinalizationError(error)) throw error;
    return fail();
  }
}

function commitPlan(config, request, expectedContext, expectedSources, executionPlan) {
  let nodeRunUid = null;
  config.repositories.withTransaction((repositories) => {
    const context = loadFrozenContext(repositories, request);
    if (canonicalHash(context) !== canonicalHash(expectedContext)) fail();
    const graph = graphContext(repositories, context.session);
    const currentH3 = loadH3Sources(config, context, request);
    const currentIntent = repositories.audioModeIntents.getCompletedSource(
      context.session.audioIntents[0].intentUid,
    );
    const currentAudio = config.audioTtsExecution.getPersisted(
      context.session.audioIntents[0].intentUid, request.dramaUid,
    );
    const currentTrack = loadBgmSource(repositories, request);
    if (canonicalHash(currentH3) !== canonicalHash(expectedSources.shots)
      || canonicalHash(currentIntent) !== canonicalHash(expectedSources.audio.intent)
      || canonicalHash(currentAudio) !== canonicalHash(expectedSources.audio.record)
      || canonicalHash(currentTrack) !== canonicalHash(expectedSources.bgmTrack)) fail();
    if (graph.node.status === 'succeeded' && graph.aggregate.run.status === 'succeeded') {
      parseExistingNode(graph.node, Object.freeze({ ...request, workflowRunUid: context.session.workflowRunUid }));
      nodeRunUid = graph.node.uid;
      return;
    }
    if (graph.aggregate.run.status !== 'running' || graph.node.status !== 'queued') fail();
    const inputSnapshot = finalizationInput(request, executionPlan);
    repositories.runs.transitionNodeStatus({
      uid: graph.node.uid, expectedStatus: 'queued', nextStatus: 'running',
      inputSnapshot,
    });
    repositories.runs.transitionNodeStatus({
      uid: graph.node.uid, expectedStatus: 'running', nextStatus: 'succeeded',
      output: Object.freeze({
        schemaVersion: 'media-export-node-output.v1', executionPlan,
      }),
    });
    repositories.runs.transitionWorkflowStatus({
      uid: graph.aggregate.run.uid, expectedStatus: 'running', nextStatus: 'succeeded',
    });
    validateRunAggregate(repositories.runs.getWorkflowWithNodes(graph.aggregate.run.uid));
    nodeRunUid = graph.node.uid;
  });
  return nodeRunUid;
}

async function startExport(config, nodeRunUid, dramaUid) {
  try {
    const result = await config.mediaExportService.start(
      Object.freeze({ nodeRunUid }), dramaUid,
    );
    if (!result || result.status !== 'succeeded' || result.dramaUid !== dramaUid
      || result.sourceNodeRunUid !== nodeRunUid) fail(FAILED_CODE);
    return result;
  } catch (error) {
    if (isMvpBenchmarkFinalizationError(error)) throw error;
    return fail(FAILED_CODE);
  }
}

function createMvpBenchmarkFinalizationService(value) {
  const config = configuration(value);
  const active = new MAP_CONSTRUCTOR();

  async function finalizeOperation(request) {
    const context = loadFrozenContext(config.repositories, request);
    const graph = graphContext(config.repositories, context.session);
    if (graph.node.status === 'succeeded' && graph.aggregate.run.status === 'succeeded') {
      parseExistingNode(graph.node, Object.freeze({
        ...request, workflowRunUid: context.session.workflowRunUid,
      }));
      return startExport(config, graph.node.uid, request.dramaUid);
    }
    const shots = loadH3Sources(config, context, request);
    const audio = await loadAudioSource(config, context);
    const bgmTrack = loadBgmSource(config.repositories, request);
    const executionPlan = await trustedExecutionPlan(
      config, context, shots, audio, bgmTrack,
      request.schemaVersion === REORDERED_REQUEST_SCHEMA_VERSION,
    );
    const nodeRunUid = commitPlan(
      config,
      request,
      context,
      Object.freeze({ shots, audio, bgmTrack }),
      executionPlan,
    );
    return startExport(config, nodeRunUid, request.dramaUid);
  }

  function finalize(valueToFinalize) {
    const request = requestRecord(valueToFinalize);
    const running = mapGet(active, request.sessionUid);
    if (running) {
      if (sameRequest(running.request, request)) return running.promise;
      return Promise.reject(new MvpBenchmarkFinalizationError(IN_PROGRESS_CODE));
    }
    const promise = (async () => {
      try {
        return await finalizeOperation(request);
      } catch (error) {
        if (isMvpBenchmarkFinalizationError(error)) throw error;
        return fail(error?.code === 'MEDIA_EXPORT_FAILED' ? FAILED_CODE : UNAVAILABLE_CODE);
      } finally {
        mapDelete(active, request.sessionUid);
      }
    })();
    mapSet(active, request.sessionUid, Object.freeze({ request, promise }));
    return promise;
  }

  return Object.freeze({ finalize });
}

module.exports = Object.freeze({
  MvpBenchmarkFinalizationError,
  createMvpBenchmarkFinalizationService,
  isMvpBenchmarkFinalizationError,
});
