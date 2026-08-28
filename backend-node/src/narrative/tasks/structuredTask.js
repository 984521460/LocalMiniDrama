const crypto = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { narrativeTaskError } = require('./errors');
const {
  JsonSnapshotError,
  deepFreeze,
  snapshotJson,
} = require('./jsonSnapshot');

const MAX_RAW_RESPONSE_BYTES = 4 * 1024 * 1024;
const VERSION_TOKEN = /^[a-z][a-z0-9.-]{0,127}$/u;
const RESPONSE_REF = /^response:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function exactObjectValues(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
    invalidInput();
  }
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

function normalizeTaskEnvelope(input, domainKeys) {
  const metadataKeys = [
    'promptVersion',
    'model',
    'parameters',
    'rawResponseRef',
    'rawResponse',
  ];
  const values = exactObjectValues(input, [...domainKeys, ...metadataKeys]);
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
    domain: Object.fromEntries(domainKeys.map((key) => [key, values[key]])),
    model,
    parameters,
    promptVersion: values.promptVersion,
    rawResponse: values.rawResponse,
    rawResponseRef: values.rawResponseRef,
  };
}

function parseStructuredResponse(rawResponse, validateSchema) {
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

function createAuditedTaskResult({
  taskType,
  schemaVersion,
  inputHash,
  metadata,
  auditFields,
  output,
}) {
  return deepFreeze({
    taskType,
    schemaVersion,
    promptVersion: metadata.promptVersion,
    inputHash,
    model: metadata.model,
    parameters: metadata.parameters,
    rawResponseRef: metadata.rawResponseRef,
    rawResponseSha256: sha256(metadata.rawResponse),
    ...auditFields,
    output,
  });
}

module.exports = {
  MAX_RAW_RESPONSE_BYTES,
  createAuditedTaskResult,
  exactObjectValues,
  normalizeTaskEnvelope,
  parseStructuredResponse,
};
