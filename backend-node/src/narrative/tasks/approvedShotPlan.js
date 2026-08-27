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
  assertShotSemantics,
  createShotPlanningInputHash,
  normalizeShotDomain,
} = require('./shotDomain');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/shot-planning.schema.json',
));

const CANONICAL_REF = /^(?:response|review):v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION_TOKEN = /^[a-z][a-z0-9.-]{0,127}$/u;
const RESULT_KEYS = Object.freeze([
  'assetCatalogHash',
  'inputHash',
  'model',
  'output',
  'parameters',
  'promptVersion',
  'rawResponseRef',
  'rawResponseSha256',
  'schemaVersion',
  'scriptApprovalRef',
  'taskType',
  'upstreamScriptHash',
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

function normalizeApprovedShotPlan(shotPlanningResult, approval, upstreamDomain) {
  let snapshot;
  try {
    snapshot = snapshotJson({ shotPlanningResult, approval }, {
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
  const result = snapshot.shotPlanningResult;
  const approvalSnapshot = snapshot.approval;
  if (!exactKeys(result, RESULT_KEYS)
    || result.taskType !== 'ShotPlanningTask'
    || result.schemaVersion !== 'shot-planning.v1'
    || typeof result.promptVersion !== 'string'
    || !VERSION_TOKEN.test(result.promptVersion)
    || typeof result.inputHash !== 'string'
    || !SHA256.test(result.inputHash)
    || typeof result.rawResponseRef !== 'string'
    || !CANONICAL_REF.test(result.rawResponseRef)
    || !result.rawResponseRef.startsWith('response:v1:')
    || typeof result.rawResponseSha256 !== 'string'
    || !SHA256.test(result.rawResponseSha256)
    || typeof result.upstreamScriptHash !== 'string'
    || !SHA256.test(result.upstreamScriptHash)
    || typeof result.scriptApprovalRef !== 'string'
    || !CANONICAL_REF.test(result.scriptApprovalRef)
    || !result.scriptApprovalRef.startsWith('review:v1:')
    || typeof result.assetCatalogHash !== 'string'
    || !SHA256.test(result.assetCatalogHash)
    || !exactKeys(result.model, ['name', 'provider'])
    || !isCleanBoundedText(result.model.name)
    || !isCleanBoundedText(result.model.provider)
    || !result.parameters
    || typeof result.parameters !== 'object'
    || Array.isArray(result.parameters)
    || !validateSchema(result.output)
    || !exactKeys(approvalSnapshot, ['envelopeHash', 'resultHash', 'reviewRef', 'status'])
    || approvalSnapshot.status !== 'approved'
    || typeof approvalSnapshot.envelopeHash !== 'string'
    || !SHA256.test(approvalSnapshot.envelopeHash)
    || approvalSnapshot.envelopeHash !== sha256Canonical(result)
    || typeof approvalSnapshot.resultHash !== 'string'
    || !SHA256.test(approvalSnapshot.resultHash)
    || approvalSnapshot.resultHash !== sha256Canonical(result.output)
    || typeof approvalSnapshot.reviewRef !== 'string'
    || !CANONICAL_REF.test(approvalSnapshot.reviewRef)
    || !approvalSnapshot.reviewRef.startsWith('review:v1:')) invalidInput();

  let domain;
  try {
    domain = normalizeShotDomain(upstreamDomain);
    if (result.upstreamScriptHash !== domain.script.approval.resultHash
      || result.scriptApprovalRef !== domain.script.approval.reviewRef
      || result.assetCatalogHash !== sha256Canonical(domain.assetVersions)
      || result.inputHash !== createShotPlanningInputHash(domain)) invalidInput();
    assertShotSemantics(domain, result.output);
  } catch (error) {
    if (error instanceof NarrativeTaskError
      && error.code === 'NARRATIVE_TASK_LIMIT_EXCEEDED') throw error;
    return invalidInput();
  }

  return deepFreeze({
    approval: approvalSnapshot,
    assetVersions: domain.assetVersions,
    output: result.output,
    result,
    upstream: {
      ...domain.script.upstream,
      scriptApproval: domain.script.approval,
      scriptResult: domain.script.result,
    },
  });
}

module.exports = {
  normalizeApprovedShotPlan,
};
