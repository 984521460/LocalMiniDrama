'use strict';

const { types: { isProxy } } = require('node:util');

const {
  boundedInteger,
  epoch,
  fail,
  isAudioModeContractError,
} = require('./audioContract');
const {
  createAudioModePlan,
  parseAudioModePlanRecord,
} = require('./audioMode');
const {
  EMOTIONS,
  TIMING_ALGORITHM_VERSION,
  createDialogueDeliveryPlan,
} = require('./dialogueDelivery');
const { validateWorkflowExecutionPlan } = require('../workflows/executionPlan');

const {
  create: OBJECT_CREATE,
  defineProperty: DEFINE_PROPERTY,
  freeze: FREEZE,
  getOwnPropertyDescriptors: GET_OWN_PROPERTY_DESCRIPTORS,
  getPrototypeOf: GET_PROTOTYPE_OF,
  hasOwn: HAS_OWN,
} = Object;
const { apply: REFLECT_APPLY, ownKeys: OWN_KEYS } = Reflect;
const ARRAY_IS_ARRAY = Array.isArray;
const MAP_CONSTRUCTOR = Map;
const MAP_FOR_EACH = Map.prototype.forEach;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const REGEXP_TEST = RegExp.prototype.test;
const SET_ADD = Set.prototype.add;
const SET_CONSTRUCTOR = Set;
const SET_HAS = Set.prototype.has;
const STRING_TO_LOWER_CASE = String.prototype.toLowerCase;
const STRING_TRIM = String.prototype.trim;

const REQUEST_SCHEMA_VERSION = 'audio-mode-intent-request.v1';
const RECORD_SCHEMA_VERSION = 'audio-mode-intent.v1';
const INPUT_CODE = 'AUDIO_MODE_INTENT_INPUT_INVALID';
const DATA_CODE = 'AUDIO_MODE_INTENT_DATA_INVALID';
const MAX_DELIVERIES = 1000;
const ROOT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'nodeRunUid',
  'shotResultUid', 'scriptResultUid', 'deliveries', 'createdAtEpochMs',
]);
const DELIVERY_KEYS = Object.freeze([
  'uid', 'continuitySnapshotUid', 'shotId', 'dialogueEntryId', 'voiceProfileUid',
  'emotion', 'emotionIntensityPermille', 'speedPermille', 'pauseBeforeMs',
  'pauseAfterMs',
]);
const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'dramaUid', 'workflowRunUid', 'nodeRunUid',
  'shotResultUid', 'scriptResultUid', 'request', 'plan', 'createdAtEpochMs',
]);
const SOURCE_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NARRATIVE_EMOTIONS = Object.freeze(new Map([
  ['neutral', 'neutral'], ['中性', 'neutral'], ['平静', 'neutral'], ['冷静', 'neutral'], ['冷峻', 'neutral'],
  ['happy', 'happy'], ['开心', 'happy'], ['高兴', 'happy'], ['喜悦', 'happy'], ['兴奋', 'happy'],
  ['sad', 'sad'], ['悲伤', 'sad'], ['难过', 'sad'], ['低落', 'sad'],
  ['angry', 'angry'], ['愤怒', 'angry'], ['生气', 'angry'], ['恼怒', 'angry'],
  ['fearful', 'fearful'], ['害怕', 'fearful'], ['恐惧', 'fearful'], ['紧张', 'fearful'], ['警惕', 'fearful'],
  ['surprised', 'surprised'], ['惊讶', 'surprised'], ['震惊', 'surprised'], ['意外', 'surprised'],
]));

function append(target, value) {
  DEFINE_PROPERTY(target, String(target.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function frozenCopy(values) {
  const output = [];
  for (let index = 0; index < values.length; index += 1) append(output, values[index]);
  return FREEZE(output);
}

function exactObject(value, expectedKeys, code) {
  try {
    if (value === null || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
      fail(code);
    }
    const prototype = GET_PROTOTYPE_OF(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
    const keys = OWN_KEYS(descriptors);
    if (keys.length !== expectedKeys.length) fail(code);
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') fail(code);
    }
    const output = OBJECT_CREATE(null);
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const key = expectedKeys[index];
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) fail(code);
      DEFINE_PROPERTY(output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return output;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function denseArray(value, maximumLength, code) {
  try {
    if (isProxy(value) || !ARRAY_IS_ARRAY(value)
      || GET_PROTOTYPE_OF(value) !== Array.prototype) fail(code);
    const descriptors = GET_OWN_PROPERTY_DESCRIPTORS(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !HAS_OWN(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0 || lengthDescriptor.value > maximumLength) fail(code);
    const length = lengthDescriptor.value;
    const keys = OWN_KEYS(descriptors);
    if (keys.length !== length + 1) fail(code);
    for (let index = 0; index < keys.length; index += 1) {
      if (typeof keys[index] !== 'string') fail(code);
    }
    const output = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) fail(code);
      append(output, descriptor.value);
    }
    return output;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function includes(values, expected) {
  if (!ARRAY_IS_ARRAY(values)) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function uniqueItemByKey(values, key, expected) {
  if (!ARRAY_IS_ARRAY(values)) return null;
  let matched = null;
  for (let index = 0; index < values.length; index += 1) {
    const candidate = values[index];
    if (candidate?.[key] !== expected) continue;
    if (matched !== null) return null;
    matched = candidate;
  }
  return matched;
}

function mapValues(map) {
  const output = [];
  REFLECT_APPLY(MAP_FOR_EACH, map, [(value) => append(output, value)]);
  return output;
}

function sourceId(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SOURCE_ID, [value])) fail(code);
  return value;
}

function canonicalUid(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value])) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !REFLECT_APPLY(REGEXP_TEST, SHA256, [value])) fail(code);
  return value;
}

function narrativeEmotion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = REFLECT_APPLY(STRING_TRIM, value, []);
  const normalized = REFLECT_APPLY(STRING_TO_LOWER_CASE, trimmed, []);
  return REFLECT_APPLY(MAP_GET, NARRATIVE_EMOTIONS, [normalized]) ?? null;
}

function audioModeNarrativeEmotion(value) {
  return narrativeEmotion(value);
}

function parseDelivery(value, code) {
  const input = exactObject(value, DELIVERY_KEYS, code);
  if (!includes(EMOTIONS, input.emotion)) fail(code);
  return Object.freeze({
    uid: canonicalUid(input.uid, code),
    continuitySnapshotUid: canonicalUid(input.continuitySnapshotUid, code),
    shotId: sourceId(input.shotId, code),
    dialogueEntryId: sourceId(input.dialogueEntryId, code),
    voiceProfileUid: canonicalUid(input.voiceProfileUid, code),
    emotion: input.emotion,
    emotionIntensityPermille: boundedInteger(
      input.emotionIntensityPermille, 0, 1000, code,
    ),
    speedPermille: boundedInteger(input.speedPermille, 500, 2000, code),
    pauseBeforeMs: boundedInteger(input.pauseBeforeMs, 0, 5000, code),
    pauseAfterMs: boundedInteger(input.pauseAfterMs, 0, 5000, code),
  });
}

function parseAudioModeIntentRequest(value, code = INPUT_CODE) {
  try {
    const input = exactObject(value, ROOT_KEYS, code);
    if (input.schemaVersion !== REQUEST_SCHEMA_VERSION) fail(code);
    const deliveryInputs = denseArray(input.deliveries, MAX_DELIVERIES, code);
    const deliveries = [];
    for (let index = 0; index < deliveryInputs.length; index += 1) {
      append(deliveries, parseDelivery(deliveryInputs[index], code));
    }
    if (deliveries.length < 1) fail(code);
    const deliveryUids = new SET_CONSTRUCTOR();
    const dialogueEntryIds = new SET_CONSTRUCTOR();
    for (let index = 0; index < deliveries.length; index += 1) {
      const delivery = deliveries[index];
      if (REFLECT_APPLY(SET_HAS, deliveryUids, [delivery.uid])
        || REFLECT_APPLY(SET_HAS, dialogueEntryIds, [delivery.dialogueEntryId])) {
        fail(code);
      }
      REFLECT_APPLY(SET_ADD, deliveryUids, [delivery.uid]);
      REFLECT_APPLY(SET_ADD, dialogueEntryIds, [delivery.dialogueEntryId]);
    }
    return Object.freeze({
      schemaVersion: REQUEST_SCHEMA_VERSION,
      uid: canonicalUid(input.uid, code),
      dramaUid: canonicalUid(input.dramaUid, code),
      workflowRunUid: canonicalUid(input.workflowRunUid, code),
      nodeRunUid: canonicalUid(input.nodeRunUid, code),
      shotResultUid: canonicalUid(input.shotResultUid, code),
      scriptResultUid: canonicalUid(input.scriptResultUid, code),
      deliveries: frozenCopy(deliveries),
      createdAtEpochMs: epoch(input.createdAtEpochMs, code),
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(code);
  }
}

function matchingDialogue(scriptResult, dialogueEntryId) {
  let matched = null;
  const scenes = scriptResult?.output?.scenes;
  if (!ARRAY_IS_ARRAY(scenes)) return null;
  for (let sceneIndex = 0; sceneIndex < scenes.length; sceneIndex += 1) {
    const entries = scenes[sceneIndex]?.entries;
    if (!ARRAY_IS_ARRAY(entries)) return null;
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      if (entry?.entryId !== dialogueEntryId) continue;
      if (matched !== null || entry.type !== 'dialogue') return null;
      matched = entry;
    }
  }
  return matched;
}

function findPlanNode(run, node) {
  const nodes = run?.graphSnapshot?.snapshot?.nodes;
  return uniqueItemByKey(nodes, 'uid', node.nodeUid);
}

function configuration(dependencies) {
  if (!dependencies || typeof dependencies !== 'object'
    || typeof dependencies.requireApprovedNarrative !== 'function'
    || typeof dependencies.runs?.getWorkflow !== 'function'
    || typeof dependencies.runs?.getNode !== 'function'
    || typeof dependencies.workflows?.getDefinition !== 'function'
    || typeof dependencies.shotContinuitySnapshots?.get !== 'function'
    || typeof dependencies.voiceProfiles?.getActive !== 'function') {
    throw new TypeError('Audio mode intent dependencies are invalid');
  }
  return dependencies;
}

function resolveAudioModeIntent(value, dependencies) {
  const request = parseAudioModeIntentRequest(value);
  const configured = configuration(dependencies);
  try {
    const run = configured.runs.getWorkflow(request.workflowRunUid);
    const node = configured.runs.getNode(request.nodeRunUid);
    const definition = configured.workflows.getDefinition(run.workflowUid);
    const executionPlan = validateWorkflowExecutionPlan(run.graphSnapshot);
    const planNode = findPlanNode({ graphSnapshot: executionPlan }, node);
    if (node.workflowRunUid !== run.uid || node.status !== 'queued' || run.status !== 'queued'
      || definition.dramaUid !== request.dramaUid
      || definition.uid !== run.workflowUid
      || definition.registryVersion !== executionPlan.registryVersion
      || definition.graphRevision !== executionPlan.graphRevision
      || executionPlan.workflowUid !== run.workflowUid
      || executionPlan.graphHash !== run.graphHash
      || executionPlan.graphRevision !== run.graphRevision
      || !planNode || planNode.nodeType !== 'audio.tts' || planNode.enabled !== true
      || planNode.domainRef?.type !== 'narrative_result'
      || planNode.domainRef.uid !== request.shotResultUid) {
      fail(DATA_CODE);
    }
    const expectedSpeedPermille = Math.round(planNode.config.speed * 1000);
    if (!Number.isSafeInteger(expectedSpeedPermille)
      || expectedSpeedPermille < 500 || expectedSpeedPermille > 2000) fail(DATA_CODE);

    const shot = configured.requireApprovedNarrative(request.shotResultUid, 'shot');
    const script = configured.requireApprovedNarrative(request.scriptResultUid, 'script');
    if (shot.record.dramaUid !== request.dramaUid
      || script.record.dramaUid !== request.dramaUid
      || shot.record.upstreamResultUid !== script.record.uid) fail(DATA_CODE);

    const deliveries = [];
    const profiles = new MAP_CONSTRUCTOR();
    for (let index = 0; index < request.deliveries.length; index += 1) {
      const choice = request.deliveries[index];
      const snapshot = configured.shotContinuitySnapshots.get(choice.continuitySnapshotUid);
      const plannedShot = uniqueItemByKey(shot.result.output.shots, 'shotId', choice.shotId);
      const dialogue = matchingDialogue(script.result, choice.dialogueEntryId);
      if (!plannedShot || !dialogue || dialogue.speakerCharacterFactId === null
        || !includes(plannedShot.dialogueEntryRefs, choice.dialogueEntryId)
        || snapshot.dramaUid !== request.dramaUid
        || snapshot.shotResultUid !== request.shotResultUid
        || snapshot.shotResultHash !== shot.approval.resultHash
        || snapshot.shotEnvelopeHash !== shot.approval.envelopeHash
        || snapshot.shotApprovalRef !== shot.approval.reviewRef
        || snapshot.shotId !== choice.shotId
        || choice.emotion !== narrativeEmotion(dialogue.emotion)
        || choice.speedPermille !== expectedSpeedPermille) fail(DATA_CODE);
      const characterMatch = uniqueItemByKey(
        snapshot.characters, 'factRef', dialogue.speakerCharacterFactId,
      );
      if (!characterMatch) fail(DATA_CODE);
      const characterUid = characterMatch.characterUid;
      const active = configured.voiceProfiles.getActive(characterUid);
      if (!active || active.profile.uid !== choice.voiceProfileUid
        || active.profile.dramaUid !== request.dramaUid
        || active.profile.characterUid !== characterUid
        || planNode.config.profileUid !== active.profile.uid
        || planNode.config.credentialRef !== active.profile.credentialRef
        || choice.speedPermille < active.profile.minimumSpeedPermille
        || choice.speedPermille > active.profile.maximumSpeedPermille) fail(DATA_CODE);
      REFLECT_APPLY(MAP_SET, profiles, [active.profile.uid, active.profile]);
      append(deliveries, createDialogueDeliveryPlan({
        schemaVersion: '8.0',
        timingAlgorithmVersion: TIMING_ALGORITHM_VERSION,
        uid: choice.uid,
        dramaUid: request.dramaUid,
        scriptResultUid: request.scriptResultUid,
        shotId: choice.shotId,
        dialogueEntryId: choice.dialogueEntryId,
        characterUid,
        voiceProfileUid: choice.voiceProfileUid,
        text: dialogue.text,
        emotion: choice.emotion,
        emotionIntensityPermille: choice.emotionIntensityPermille,
        speedPermille: choice.speedPermille,
        pauseBeforeMs: choice.pauseBeforeMs,
        pauseAfterMs: choice.pauseAfterMs,
      }));
    }
    const plan = createAudioModePlan({
      schemaVersion: '8.0',
      uid: request.uid,
      dramaUid: request.dramaUid,
      workflowRunUid: request.workflowRunUid,
      mode: 'independent_tts',
      dialogueDeliveries: deliveries,
      voiceProfiles: mapValues(profiles),
      h3GenerationSource: null,
      createdAtEpochMs: request.createdAtEpochMs,
    });
    return Object.freeze({ request, plan });
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === INPUT_CODE) throw error;
    return fail(DATA_CODE);
  }
}

function createAudioModeIntentRecord(value, code = DATA_CODE) {
  try {
    const input = exactObject(value, RECORD_KEYS, code);
    if (input.schemaVersion !== RECORD_SCHEMA_VERSION) fail(code);
    const request = parseAudioModeIntentRequest(input.request, code);
    const plan = parseAudioModePlanRecord(input.plan);
    const uid = canonicalUid(input.uid, code);
    const dramaUid = canonicalUid(input.dramaUid, code);
    const workflowRunUid = canonicalUid(input.workflowRunUid, code);
    const nodeRunUid = canonicalUid(input.nodeRunUid, code);
    const shotResultUid = canonicalUid(input.shotResultUid, code);
    const scriptResultUid = canonicalUid(input.scriptResultUid, code);
    const createdAtEpochMs = epoch(input.createdAtEpochMs, code);
    if (request.uid !== uid || request.dramaUid !== dramaUid
      || request.workflowRunUid !== workflowRunUid || request.nodeRunUid !== nodeRunUid
      || request.shotResultUid !== shotResultUid
      || request.scriptResultUid !== scriptResultUid
      || request.createdAtEpochMs !== createdAtEpochMs
      || plan.uid !== uid || plan.dramaUid !== dramaUid
      || plan.workflowRunUid !== workflowRunUid || plan.mode !== 'independent_tts'
      || plan.createdAtEpochMs !== createdAtEpochMs
      || plan.dialogueBindings.length !== request.deliveries.length
      || plan.ttsRequests.length !== request.deliveries.length
      || plan.h3NativeSource !== null) fail(code);
    for (let index = 0; index < request.deliveries.length; index += 1) {
      const choice = request.deliveries[index];
      const delivery = plan.dialogueBindings[index].dialogueDelivery;
      if (delivery.uid !== choice.uid || delivery.scriptResultUid !== scriptResultUid
        || delivery.shotId !== choice.shotId
        || delivery.dialogueEntryId !== choice.dialogueEntryId
        || delivery.voiceProfileUid !== choice.voiceProfileUid
        || delivery.emotion !== choice.emotion
        || delivery.emotionIntensityPermille !== choice.emotionIntensityPermille
        || delivery.speedPermille !== choice.speedPermille
        || delivery.pauseBeforeMs !== choice.pauseBeforeMs
        || delivery.pauseAfterMs !== choice.pauseAfterMs) fail(code);
    }
    return Object.freeze({
      schemaVersion: RECORD_SCHEMA_VERSION,
      uid,
      dramaUid,
      workflowRunUid,
      nodeRunUid,
      shotResultUid,
      scriptResultUid,
      request,
      plan,
      createdAtEpochMs,
    });
  } catch (error) {
    if (isAudioModeContractError(error) && error.code === code) throw error;
    return fail(code);
  }
}

function publicAudioModeIntent(value) {
  const record = createAudioModeIntentRecord(value);
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    uid: record.uid,
    dramaUid: record.dramaUid,
    workflowRunUid: record.workflowRunUid,
    nodeRunUid: record.nodeRunUid,
    shotResultUid: record.shotResultUid,
    scriptResultUid: record.scriptResultUid,
    plan: record.plan,
    createdAtEpochMs: record.createdAtEpochMs,
  });
}

function canonicalJsonRecord(text, maximumBytes) {
  if (typeof text !== 'string' || text.length > maximumBytes
    || Buffer.byteLength(text, 'utf8') > maximumBytes) throw new TypeError();
  const parsed = JSON.parse(text);
  if (JSON.stringify(parsed) !== text) throw new TypeError();
  return parsed;
}

function audioModeIntentRecordValid(
  uidValue,
  dramaUidValue,
  workflowRunUidValue,
  nodeRunUidValue,
  shotResultUidValue,
  scriptResultUidValue,
  requestJson,
  planJson,
  planSha256Value,
  createdAtEpochMsValue,
) {
  try {
    const record = createAudioModeIntentRecord({
      schemaVersion: RECORD_SCHEMA_VERSION,
      uid: uidValue,
      dramaUid: dramaUidValue,
      workflowRunUid: workflowRunUidValue,
      nodeRunUid: nodeRunUidValue,
      shotResultUid: shotResultUidValue,
      scriptResultUid: scriptResultUidValue,
      request: canonicalJsonRecord(requestJson, 4 * 1024 * 1024),
      plan: canonicalJsonRecord(planJson, 32 * 1024 * 1024),
      createdAtEpochMs: createdAtEpochMsValue,
    });
    if (record.plan.planSha256 !== sha256(planSha256Value, DATA_CODE)) return 0;
    return 1;
  } catch {
    return 0;
  }
}

module.exports = Object.freeze({
  DATA_CODE,
  INPUT_CODE,
  RECORD_SCHEMA_VERSION,
  REQUEST_SCHEMA_VERSION,
  audioModeNarrativeEmotion,
  audioModeIntentRecordValid,
  createAudioModeIntentRecord,
  parseAudioModeIntentRequest,
  publicAudioModeIntent,
  resolveAudioModeIntent,
});
