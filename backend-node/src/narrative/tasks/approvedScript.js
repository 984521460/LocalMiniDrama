const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const { NarrativeTaskError, narrativeTaskError } = require('./errors');
const {
  JsonSnapshotError,
  deepFreeze,
  sha256Canonical,
  snapshotJson,
} = require('./jsonSnapshot');
const {
  assertScriptSemantics,
  createScriptInputHash,
  normalizeScriptDomain,
} = require('./scriptDomain');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/script-formatting.schema.json',
));

const CANONICAL_REF = /^(?:response|review):v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION_TOKEN = /^[a-z][a-z0-9.-]{0,127}$/u;
const RESULT_KEYS = Object.freeze([
  'adaptationApprovalRef',
  'extractionApprovalRef',
  'inputHash',
  'model',
  'output',
  'parameters',
  'promptVersion',
  'rawResponseRef',
  'rawResponseSha256',
  'schemaVersion',
  'taskType',
  'upstreamAdaptationHash',
  'upstreamExtractionHash',
]);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isCleanBoundedText(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function describeScriptOutput(output) {
  const sceneIds = new Set();
  const entryIds = new Set();
  const orderedEntries = [];
  for (const scene of output.scenes) {
    sceneIds.add(scene.sceneId);
    for (const entry of scene.entries) {
      entryIds.add(entry.entryId);
      orderedEntries.push(entry.entryId);
    }
  }
  return {
    entryIds: Object.freeze([...entryIds]),
    orderedEntries: Object.freeze(orderedEntries),
    sceneIds: Object.freeze([...sceneIds]),
  };
}

function normalizeApprovedScript(scriptResult, approval, upstreamDomain) {
  let snapshot;
  try {
    snapshot = snapshotJson({ scriptResult, approval }, {
      maxDepth: 32,
      maxNodes: 50000,
      maxStringBytes: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    return invalidInput();
  }
  const result = snapshot.scriptResult;
  const approvalSnapshot = snapshot.approval;
  if (!exactKeys(result, RESULT_KEYS)
    || result.taskType !== 'ScriptFormattingTask'
    || result.schemaVersion !== 'script-formatting.v1'
    || typeof result.promptVersion !== 'string'
    || !VERSION_TOKEN.test(result.promptVersion)
    || typeof result.inputHash !== 'string'
    || !SHA256.test(result.inputHash)
    || typeof result.rawResponseRef !== 'string'
    || !CANONICAL_REF.test(result.rawResponseRef)
    || !result.rawResponseRef.startsWith('response:v1:')
    || typeof result.rawResponseSha256 !== 'string'
    || !SHA256.test(result.rawResponseSha256)
    || typeof result.upstreamExtractionHash !== 'string'
    || !SHA256.test(result.upstreamExtractionHash)
    || typeof result.upstreamAdaptationHash !== 'string'
    || !SHA256.test(result.upstreamAdaptationHash)
    || typeof result.extractionApprovalRef !== 'string'
    || !CANONICAL_REF.test(result.extractionApprovalRef)
    || !result.extractionApprovalRef.startsWith('review:v1:')
    || typeof result.adaptationApprovalRef !== 'string'
    || !CANONICAL_REF.test(result.adaptationApprovalRef)
    || !result.adaptationApprovalRef.startsWith('review:v1:')
    || !exactKeys(result.model, ['name', 'provider'])
    || !isCleanBoundedText(result.model.name)
    || !isCleanBoundedText(result.model.provider)
    || !result.parameters
    || typeof result.parameters !== 'object'
    || Array.isArray(result.parameters)
    || !validateSchema(result.output)
    || !exactKeys(approvalSnapshot, ['resultHash', 'reviewRef', 'status'])
    || approvalSnapshot.status !== 'approved'
    || typeof approvalSnapshot.resultHash !== 'string'
    || !SHA256.test(approvalSnapshot.resultHash)
    || approvalSnapshot.resultHash !== sha256Canonical(result.output)
    || typeof approvalSnapshot.reviewRef !== 'string'
    || !CANONICAL_REF.test(approvalSnapshot.reviewRef)
    || !approvalSnapshot.reviewRef.startsWith('review:v1:')) invalidInput();

  let domain;
  try {
    domain = normalizeScriptDomain(upstreamDomain);
    if (result.upstreamExtractionHash !== domain.extraction.approval.resultHash
      || result.upstreamAdaptationHash !== domain.adaptation.approval.resultHash
      || result.extractionApprovalRef !== domain.extraction.approval.reviewRef
      || result.adaptationApprovalRef !== domain.adaptation.approval.reviewRef
      || result.inputHash !== createScriptInputHash(domain)) invalidInput();
    assertScriptSemantics(domain, result.output);
  } catch (error) {
    if (error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_LIMIT_EXCEEDED') throw error;
    return invalidInput();
  }

  const description = describeScriptOutput(result.output);

  return deepFreeze({
    approval: approvalSnapshot,
    output: result.output,
    result,
    upstream: {
      adaptationApproval: domain.adaptation.approval,
      adaptationResult: domain.adaptation.result,
      approvedExtraction: domain.extraction.extraction,
      extractionApproval: domain.extraction.approval,
    },
    ...description,
  });
}

module.exports = {
  normalizeApprovedScript,
};
