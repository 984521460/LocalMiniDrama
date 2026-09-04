const crypto = require('node:crypto');
const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const { narrativeTaskError } = require('./errors');
const {
  JsonSnapshotError,
  deepFreeze,
  snapshotJson,
} = require('./jsonSnapshot');
const {
  assertEvidenceReferences,
  normalizeSource,
} = require('./sourceEvidence');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/novel-extraction.schema.json',
));

const TASK_TYPE = 'NovelExtractionTask';
const SCHEMA_VERSION = 'novel-extraction.v1';
const MAX_RAW_RESPONSE_BYTES = 4 * 1024 * 1024;
const VERSION_TOKEN = /^[a-z][a-z0-9.-]{0,127}$/u;
const RESPONSE_REF = /^response:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function exactObjectValues(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidInput();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return invalidInput();
  }
  if (prototype !== Object.prototype && prototype !== null) invalidInput();
  const allowed = new Set(keys);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string'
    || !allowed.has(key)
    || !Object.hasOwn(descriptors[key], 'value'))
    || keys.some((key) => !descriptors[key])) invalidInput();
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function normalizeMetadata(input) {
  const values = exactObjectValues(input, [
    'source',
    'promptVersion',
    'model',
    'parameters',
    'rawResponseRef',
    'rawResponse',
  ]);
  if (typeof values.promptVersion !== 'string'
    || !VERSION_TOKEN.test(values.promptVersion)
    || typeof values.rawResponseRef !== 'string'
    || !RESPONSE_REF.test(values.rawResponseRef)
    || typeof values.rawResponse !== 'string') invalidInput();
  if (Buffer.byteLength(values.rawResponse, 'utf8') > MAX_RAW_RESPONSE_BYTES) {
    throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
  }

  let model;
  let parameters;
  try {
    model = snapshotJson(values.model, { maxDepth: 2, maxNodes: 8, maxStringBytes: 512 });
    parameters = snapshotJson(values.parameters, {
      maxDepth: 12,
      maxNodes: 2000,
      maxStringBytes: 64 * 1024,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    return invalidInput();
  }
  if (!model
    || typeof model !== 'object'
    || Array.isArray(model)
    || Object.keys(model).sort().join('\0') !== 'name\0provider'
    || typeof model.provider !== 'string'
    || model.provider.length < 1
    || model.provider.length > 128
    || typeof model.name !== 'string'
    || model.name.length < 1
    || model.name.length > 128
    || !parameters
    || typeof parameters !== 'object'
    || Array.isArray(parameters)) invalidInput();

  return {
    ...values,
    model,
    parameters,
  };
}

function parseResponse(rawResponse) {
  let parsed;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
  }
  try {
    parsed = snapshotJson(parsed, {
      maxDepth: 32,
      maxNodes: 30000,
      maxStringBytes: MAX_RAW_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
  }
  if (!validateSchema(parsed)) throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
  return parsed;
}

function assertFactReferences(output) {
  const groups = [
    output.characters,
    output.scenes,
    output.props,
    output.relationships,
    output.events,
    output.dialogue,
  ];
  const allIds = new Set();
  for (const fact of groups.flat()) {
    if (allIds.has(fact.factId)) throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    allIds.add(fact.factId);
  }
  const characterIds = new Set(output.characters.map((fact) => fact.factId));
  const sceneIds = new Set(output.scenes.map((fact) => fact.factId));
  const propIds = new Set(output.props.map((fact) => fact.factId));

  for (const relationship of output.relationships) {
    if (!characterIds.has(relationship.fromCharacterFactId)
      || !characterIds.has(relationship.toCharacterFactId)) {
      throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    }
  }
  for (const event of output.events) {
    if (event.characterFactIds.some((id) => !characterIds.has(id))
      || (event.sceneFactId !== null && !sceneIds.has(event.sceneFactId))
      || event.propFactIds.some((id) => !propIds.has(id))) {
      throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    }
  }
  for (const line of output.dialogue) {
    if (line.speakerCharacterFactId !== null
      && !characterIds.has(line.speakerCharacterFactId)) {
      throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    }
  }
}

function createNovelExtractionTask() {
  return Object.freeze({
    complete(input) {
      const metadata = normalizeMetadata(input);
      const source = normalizeSource(metadata.source);
      const output = parseResponse(metadata.rawResponse);
      assertEvidenceReferences(source, output);
      assertFactReferences(output);

      return deepFreeze({
        taskType: TASK_TYPE,
        schemaVersion: SCHEMA_VERSION,
        promptVersion: metadata.promptVersion,
        inputHash: source.inputHash,
        model: metadata.model,
        parameters: metadata.parameters,
        rawResponseRef: metadata.rawResponseRef,
        rawResponseSha256: sha256(metadata.rawResponse),
        output,
      });
    },
  });
}

module.exports = {
  MAX_RAW_RESPONSE_BYTES,
  SCHEMA_VERSION,
  TASK_TYPE,
  assertFactReferences,
  createNovelExtractionTask,
};
