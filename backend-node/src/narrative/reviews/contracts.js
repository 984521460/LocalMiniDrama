const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const {
  JsonSnapshotError,
  sha256Canonical,
  snapshotJson,
} = require('../tasks/jsonSnapshot');
const { narrativeReviewError } = require('./errors');

const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[a-z][a-z0-9.-]{0,127}$/u;
const RESPONSE_REF = /^response:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

const ajv = new Ajv({ allErrors: true, strict: true });

function schema(name) {
  return require(path.resolve(__dirname, `../../../../schemas/v3/${name}.schema.json`));
}

const BASE_KEYS = Object.freeze([
  'taskType',
  'schemaVersion',
  'promptVersion',
  'inputHash',
  'model',
  'parameters',
  'rawResponseRef',
  'rawResponseSha256',
  'output',
]);

const RESULT_CONTRACTS = Object.freeze({
  extraction: Object.freeze({
    taskType: 'NovelExtractionTask',
    schemaVersion: 'novel-extraction.v1',
    auditKeys: Object.freeze([]),
    validateOutput: ajv.compile(schema('novel-extraction')),
  }),
  adaptation: Object.freeze({
    taskType: 'EpisodeAdaptationTask',
    schemaVersion: 'episode-adaptation.v1',
    auditKeys: Object.freeze(['upstreamResultHash', 'approvalRef', 'durationBudget', 'style']),
    validateOutput: ajv.compile(schema('episode-adaptation')),
  }),
  script: Object.freeze({
    taskType: 'ScriptFormattingTask',
    schemaVersion: 'script-formatting.v1',
    auditKeys: Object.freeze([
      'upstreamExtractionHash',
      'upstreamAdaptationHash',
      'extractionApprovalRef',
      'adaptationApprovalRef',
    ]),
    validateOutput: ajv.compile(schema('script-formatting')),
  }),
  shot: Object.freeze({
    taskType: 'ShotPlanningTask',
    schemaVersion: 'shot-planning.v1',
    auditKeys: Object.freeze(['upstreamScriptHash', 'scriptApprovalRef', 'assetCatalogHash']),
    validateOutput: ajv.compile(schema('shot-planning')),
  }),
});

function invalidInput() {
  throw narrativeReviewError('NARRATIVE_REVIEW_INPUT_INVALID');
}

function assertExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalidInput();
}

function normalizeNarrativeResult(resultType, input) {
  const contract = RESULT_CONTRACTS[resultType];
  if (!contract) invalidInput();
  let result;
  try {
    result = snapshotJson(input, {
      maxDepth: 40,
      maxNodes: 32000,
      maxStringBytes: MAX_RESULT_BYTES,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError) invalidInput();
    throw error;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) invalidInput();
  assertExactKeys(result, [...BASE_KEYS, ...contract.auditKeys]);
  if (result.taskType !== contract.taskType
    || result.schemaVersion !== contract.schemaVersion
    || !VERSION.test(result.promptVersion)
    || !SHA256.test(result.inputHash)
    || !SHA256.test(result.rawResponseSha256)
    || !RESPONSE_REF.test(result.rawResponseRef)
    || !result.model
    || typeof result.model !== 'object'
    || Array.isArray(result.model)
    || Object.keys(result.model).sort().join('\0') !== 'name\0provider'
    || typeof result.model.provider !== 'string'
    || result.model.provider.length < 1
    || result.model.provider.length > 128
    || typeof result.model.name !== 'string'
    || result.model.name.length < 1
    || result.model.name.length > 128
    || !result.parameters
    || typeof result.parameters !== 'object'
    || Array.isArray(result.parameters)
    || !contract.validateOutput(result.output)) invalidInput();
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) invalidInput();
  return result;
}

function resultHashes(result) {
  return Object.freeze({
    resultHash: sha256Canonical(result.output),
    envelopeHash: sha256Canonical(result),
  });
}

function resultContract(resultType) {
  const contract = RESULT_CONTRACTS[resultType];
  if (!contract) invalidInput();
  return contract;
}

module.exports = {
  MAX_RESULT_BYTES,
  RESULT_CONTRACTS,
  normalizeNarrativeResult,
  resultContract,
  resultHashes,
};
