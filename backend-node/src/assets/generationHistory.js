const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  createAssetVersionEvidence,
} = require('./assetVersionEvidence');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/u;
const ERROR_DETAIL_REF = /^error-detail:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const CAMERA_SHOT_SIZES = new Set(['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS']);
const CAMERA_ANGLES = new Set(['eye_level', 'high', 'low', 'dutch', 'overhead', 'pov']);
const CAMERA_MOVEMENTS = new Set(['static', 'pan', 'tilt', 'dolly', 'truck', 'crane', 'handheld', 'orbit']);
const LIGHT_QUALITIES = new Set(['soft', 'hard', 'mixed', 'natural', 'practical']);
const LIGHT_DIRECTIONS = new Set(['front', 'side', 'back', 'top', 'ambient', 'mixed']);
const LIGHT_TEMPERATURES = new Set(['warm', 'neutral', 'cool', 'mixed']);
const TRANSITIONS = new Set(['start', 'cut', 'match_cut', 'dissolve']);
const SCREEN_DIRECTIONS = new Set(['left_to_right', 'right_to_left', 'neutral']);
const AXIS_STRATEGIES = new Set(['establish', 'maintain', 'intentional_cross']);
const FORBIDDEN_KEYS = new Set([
  'apikey', 'apisecret', 'accesskey', 'accesssecret', 'authorization', 'bearer',
  'credential', 'credentialref', 'password', 'privatekey', 'refreshtoken', 'secret',
  'secretkey', 'sessiontoken', 'token',
]);
const RAW_SECRET = /^(?:bearer\s+|sk-[a-z0-9_-]{8,}|akia[0-9a-z]{12,}|-----begin [^-]*private key-----)/iu;
const ERROR_MESSAGES = Object.freeze({
  GENERATION_HISTORY_INPUT_INVALID: 'Generation history input is invalid',
  GENERATION_HISTORY_DATA_INVALID: 'Stored generation history data is invalid',
});
const INTERNAL_ERRORS = new WeakSet();
const MAX_EPOCH_MS = 253402300799999;

class GenerationHistoryError extends Error {
  constructor(code = 'GENERATION_HISTORY_INPUT_INVALID') {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES.GENERATION_HISTORY_INPUT_INVALID);
    this.name = 'GenerationHistoryError';
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : 'GENERATION_HISTORY_INPUT_INVALID';
    INTERNAL_ERRORS.add(this);
    Object.freeze(this);
  }
}

function fail(code = 'GENERATION_HISTORY_INPUT_INVALID') {
  throw new GenerationHistoryError(code);
}

function isGenerationHistoryError(error) {
  return INTERNAL_ERRORS.has(error);
}

function snapshotStructured(value, code, options = {}) {
  const maxDepth = options.maxDepth ?? 32;
  const maxNodes = options.maxNodes ?? 20_000;
  const maxStringBytes = options.maxStringBytes ?? (512 * 1024);
  let nodes = 0;
  let stringBytes = 0;

  function visit(current, depth) {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) fail(code);
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') {
      stringBytes += Buffer.byteLength(current, 'utf8');
      if (stringBytes > maxStringBytes || current.includes('\0')) fail(code);
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) fail(code);
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current !== 'object' || isProxy(current)) fail(code);

    let descriptors;
    let prototype;
    try {
      descriptors = Object.getOwnPropertyDescriptors(current);
      prototype = Object.getPrototypeOf(current);
    } catch {
      return fail(code);
    }
    if (Array.isArray(current)) {
      if (prototype !== Array.prototype) fail(code);
      const length = descriptors.length?.value;
      const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) fail(code);
      const output = new Array(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
        output[index] = visit(descriptor.value, depth + 1);
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const output = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      if (typeof key !== 'string'
        || !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value')) fail(code);
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  }
  return visit(value, 0);
}

function exactObject(value, fields, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  const snapshot = snapshotStructured(value, code);
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail(code);
  const actual = Object.keys(snapshot).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])) fail(code);
  return snapshot;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalUid(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function canonicalHash(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function epoch(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MS) fail(code);
  return value;
}

function boundedString(value, maximum, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  if (typeof value !== 'string' || value !== value.trim() || value.includes('\0')) fail(code);
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) fail(code);
  }
  if (length < 1) fail(code);
  return value;
}

function assertKeys(value, fields, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])) fail(code);
  return value;
}

function validateText(value, code) {
  return boundedString(value, 4000, code);
}

function validateIdentifier(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(code);
  return value;
}

function validatePromptSemantic(value, code) {
  const semantic = exactObject(value, [
    'taskType', 'schemaVersion', 'inputHash', 'upstreamPromptHash', 'dramaUid',
    'shotResultUid', 'shotResultHash', 'shotEnvelopeHash', 'shotApprovalRef', 'output',
  ], code);
  if (semantic.taskType !== 'PromptSemanticVersioningTask'
    || semantic.schemaVersion !== 'prompt-semantic-versioned.v1'
    || !REVIEW_REF.test(semantic.shotApprovalRef)) fail(code);
  for (const field of ['inputHash', 'upstreamPromptHash', 'shotResultHash', 'shotEnvelopeHash']) {
    canonicalHash(semantic[field], code);
  }
  canonicalUid(semantic.dramaUid, code);
  canonicalUid(semantic.shotResultUid, code);
  const output = assertKeys(semantic.output, ['aspectRatio', 'durationSummary', 'semanticShots'], code);
  if (output.aspectRatio !== '16:9') fail(code);
  const duration = assertKeys(output.durationSummary, ['totalSeconds'], code);
  if (!Number.isSafeInteger(duration.totalSeconds)
    || duration.totalSeconds < 45
    || duration.totalSeconds > 75
    || !Array.isArray(output.semanticShots)
    || output.semanticShots.length < 4
    || output.semanticShots.length > 6) fail(code);
  let totalSeconds = 0;
  const shotIds = new Set();
  output.semanticShots.forEach((shot, index) => {
    assertKeys(shot, [
      'shotId', 'ordinal', 'durationSeconds', 'continuitySnapshotUid', 'subjects',
      'environment', 'action', 'camera', 'lighting', 'continuity',
    ], code);
    validateIdentifier(shot.shotId, code);
    if (shotIds.has(shot.shotId) || shot.ordinal !== index + 1
      || !Number.isSafeInteger(shot.durationSeconds)
      || shot.durationSeconds < 1
      || shot.durationSeconds > 60) fail(code);
    shotIds.add(shot.shotId);
    totalSeconds += shot.durationSeconds;
    canonicalUid(shot.continuitySnapshotUid, code);
    validateText(shot.action, code);

    const subjects = assertKeys(shot.subjects, ['description', 'characters'], code);
    validateText(subjects.description, code);
    if (!Array.isArray(subjects.characters) || subjects.characters.length > 128) fail(code);
    const characterFacts = new Set();
    for (const character of subjects.characters) {
      assertKeys(character, [
        'factRef', 'characterUid', 'referencePackageUid', 'identityVersionUid',
        'costumeVersionUid',
      ], code);
      validateIdentifier(character.factRef, code);
      if (characterFacts.has(character.factRef)) fail(code);
      characterFacts.add(character.factRef);
      for (const field of [
        'characterUid', 'referencePackageUid', 'identityVersionUid', 'costumeVersionUid',
      ]) canonicalUid(character[field], code);
    }

    const environment = assertKeys(
      shot.environment,
      ['sceneId', 'description', 'scene', 'props'],
      code,
    );
    validateIdentifier(environment.sceneId, code);
    validateText(environment.description, code);
    assertKeys(environment.scene, ['sceneUid', 'versionUid'], code);
    canonicalUid(environment.scene.sceneUid, code);
    canonicalUid(environment.scene.versionUid, code);
    if (!Array.isArray(environment.props) || environment.props.length > 128) fail(code);
    const propFacts = new Set();
    for (const prop of environment.props) {
      assertKeys(prop, ['factRef', 'propUid', 'versionUid'], code);
      validateIdentifier(prop.factRef, code);
      if (propFacts.has(prop.factRef)) fail(code);
      propFacts.add(prop.factRef);
      canonicalUid(prop.propUid, code);
      canonicalUid(prop.versionUid, code);
    }

    const camera = assertKeys(
      shot.camera,
      ['shotSize', 'cameraAngle', 'cameraMovement', 'composition'],
      code,
    );
    if (!CAMERA_SHOT_SIZES.has(camera.shotSize)
      || !CAMERA_ANGLES.has(camera.cameraAngle)
      || !CAMERA_MOVEMENTS.has(camera.cameraMovement)) fail(code);
    validateText(camera.composition, code);
    const lighting = assertKeys(
      shot.lighting,
      ['quality', 'direction', 'colorTemperature', 'description'],
      code,
    );
    if (!LIGHT_QUALITIES.has(lighting.quality)
      || !LIGHT_DIRECTIONS.has(lighting.direction)
      || !LIGHT_TEMPERATURES.has(lighting.colorTemperature)) fail(code);
    validateText(lighting.description, code);
    const continuity = assertKeys(
      shot.continuity,
      ['transitionFromPrevious', 'screenDirection', 'axisStrategy', 'notes'],
      code,
    );
    if (!TRANSITIONS.has(continuity.transitionFromPrevious)
      || !SCREEN_DIRECTIONS.has(continuity.screenDirection)
      || !AXIS_STRATEGIES.has(continuity.axisStrategy)) fail(code);
    validateText(continuity.notes, code);
  });
  if (totalSeconds !== duration.totalSeconds) fail(code);
  return deepFreeze(semantic);
}

function safePayload(value, code) {
  const snapshot = snapshotStructured(value, code, {
    maxDepth: 16,
    maxNodes: 10_000,
    maxStringBytes: 512 * 1024,
  });
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail(code);
  function inspect(current) {
    if (typeof current === 'string') {
      if (RAW_SECRET.test(current)) fail(code);
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach(inspect);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (FORBIDDEN_KEYS.has(normalized)) fail(code);
      inspect(child);
    }
  }
  inspect(snapshot);
  return deepFreeze(snapshot);
}

function createGenerationPayloadSnapshot(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  const input = exactObject(value, ['parameters', 'input'], code);
  return deepFreeze({
    parameters: safePayload(input.parameters, code),
    input: safePayload(input.input, code),
  });
}

function createPromptSemanticVersionRecord(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  const input = exactObject(value, ['uid', 'semantic', 'createdAtEpochMs'], code);
  const semantic = safePayload(validatePromptSemantic(input.semantic, code), code);
  return deepFreeze({
    schemaVersion: 'prompt-semantic-storage.v1',
    uid: canonicalUid(input.uid, code),
    dramaUid: semantic.dramaUid,
    shotResultUid: semantic.shotResultUid,
    shotResultHash: semantic.shotResultHash,
    shotEnvelopeHash: semantic.shotEnvelopeHash,
    shotApprovalRef: semantic.shotApprovalRef,
    semanticSha256: sha256Canonical(semantic),
    semantic,
    createdAtEpochMs: epoch(input.createdAtEpochMs, code),
  });
}

function createGenerationHistoryRecord(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  const input = exactObject(value, [
    'uid', 'runUid', 'dramaUid', 'assetUid', 'promptSemanticUid', 'manifestUid',
    'manifestSha256', 'provider', 'model', 'seed', 'parameters', 'input', 'status',
    'outputVersionUid', 'outputVersionEvidence', 'parentVersionUid',
    'parentVersionEvidence', 'errorCode', 'errorDetailRef',
    'createdAtEpochMs', 'completedAtEpochMs',
  ], code);
  if (!TERMINAL_STATUSES.has(input.status)) fail(code);
  const succeeded = input.status === 'succeeded';
  const failed = input.status === 'failed';
  if ((succeeded && (
    input.outputVersionUid === null || input.outputVersionEvidence === null
    || input.errorCode !== null || input.errorDetailRef !== null
  )) || (!succeeded && (
    input.outputVersionUid !== null || input.outputVersionEvidence !== null
  ))
    || (failed && (typeof input.errorCode !== 'string' || !ERROR_CODE.test(input.errorCode)))
    || (!failed && (input.errorCode !== null || input.errorDetailRef !== null))
    || (input.errorDetailRef !== null && (
      typeof input.errorDetailRef !== 'string' || !ERROR_DETAIL_REF.test(input.errorDetailRef)
    ))) fail(code);
  if (input.seed !== null && (
    !Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 4_294_967_295
  )) fail(code);
  const createdAtEpochMs = epoch(input.createdAtEpochMs, code);
  const completedAtEpochMs = epoch(input.completedAtEpochMs, code);
  if (completedAtEpochMs < createdAtEpochMs) fail(code);
  const payload = createGenerationPayloadSnapshot({
    parameters: input.parameters,
    input: input.input,
  }, code);
  const { parameters, input: generationInput } = payload;
  const provider = boundedString(input.provider, 128, code);
  const model = boundedString(input.model, 128, code);
  if (RAW_SECRET.test(provider) || RAW_SECRET.test(model)) fail(code);
  if (generationInput.promptSemanticUid !== input.promptSemanticUid
    || generationInput.manifestUid !== input.manifestUid) fail(code);
  let outputVersionEvidence = null;
  let parentVersionEvidence = null;
  try {
    outputVersionEvidence = input.outputVersionEvidence === null
      ? null
      : createAssetVersionEvidence(input.outputVersionEvidence);
    parentVersionEvidence = input.parentVersionEvidence === null
      ? null
      : createAssetVersionEvidence(input.parentVersionEvidence);
  } catch {
    return fail(code);
  }
  const outputVersionUid = input.outputVersionUid === null
    ? null
    : canonicalUid(input.outputVersionUid, code);
  const parentVersionUid = input.parentVersionUid === null
    ? null
    : canonicalUid(input.parentVersionUid, code);
  const assetUid = canonicalUid(input.assetUid, code);
  if ((outputVersionEvidence !== null && (
    outputVersionEvidence.uid !== outputVersionUid
    || outputVersionEvidence.assetUid !== assetUid
    || outputVersionEvidence.parentUid !== parentVersionUid
  )) || (parentVersionEvidence !== null && (
    parentVersionEvidence.uid !== parentVersionUid
    || parentVersionEvidence.assetUid !== assetUid
  )) || (parentVersionUid === null) !== (parentVersionEvidence === null)) fail(code);
  return deepFreeze({
    schemaVersion: 'generation-history.v1',
    uid: canonicalUid(input.uid, code),
    runUid: canonicalUid(input.runUid, code),
    dramaUid: canonicalUid(input.dramaUid, code),
    assetUid,
    promptSemanticUid: canonicalUid(input.promptSemanticUid, code),
    manifestUid: canonicalUid(input.manifestUid, code),
    manifestSha256: canonicalHash(input.manifestSha256, code),
    provider,
    model,
    seed: input.seed,
    parameters,
    parametersSha256: sha256Canonical(parameters),
    input: generationInput,
    inputSha256: sha256Canonical(generationInput),
    status: input.status,
    outputVersionUid,
    outputVersionEvidence,
    parentVersionUid,
    parentVersionEvidence,
    errorCode: input.errorCode,
    errorDetailRef: input.errorDetailRef,
    createdAtEpochMs,
    completedAtEpochMs,
  });
}

function createAssetVersionSelectionEvent(value, code = 'GENERATION_HISTORY_INPUT_INVALID') {
  const input = exactObject(value, [
    'uid', 'historyUid', 'assetUid', 'selectedVersionUid', 'previousVersionUid',
    'stateVersion', 'changedAtEpochMs',
  ], code);
  if (!Number.isSafeInteger(input.stateVersion)
    || input.stateVersion < 1
    || input.stateVersion > Number.MAX_SAFE_INTEGER
    || input.selectedVersionUid === input.previousVersionUid) fail(code);
  return deepFreeze({
    schemaVersion: 'asset-version-selection.v1',
    uid: canonicalUid(input.uid, code),
    historyUid: canonicalUid(input.historyUid, code),
    assetUid: canonicalUid(input.assetUid, code),
    selectedVersionUid: canonicalUid(input.selectedVersionUid, code),
    previousVersionUid: input.previousVersionUid === null
      ? null
      : canonicalUid(input.previousVersionUid, code),
    stateVersion: input.stateVersion,
    changedAtEpochMs: epoch(input.changedAtEpochMs, code),
  });
}

module.exports = {
  GenerationHistoryError,
  createAssetVersionSelectionEvent,
  createGenerationPayloadSnapshot,
  createGenerationHistoryRecord,
  createPromptSemanticVersionRecord,
  isGenerationHistoryError,
};
