const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const { sha256Canonical } = require('./jsonSnapshot');
const {
  assertShotSemantics,
  createShotPlanningInputHash,
  normalizeShotDomain,
} = require('./shotDomain');
const {
  createAuditedTaskResult,
  normalizeTaskEnvelope,
  parseStructuredResponse,
} = require('./structuredTask');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/shot-planning.schema.json',
));

const TASK_TYPE = 'ShotPlanningTask';
const SCHEMA_VERSION = 'shot-planning.v1';
const DOMAIN_KEYS = Object.freeze([
  'approvedExtraction',
  'extractionApproval',
  'adaptationResult',
  'adaptationApproval',
  'scriptResult',
  'scriptApproval',
  'assetVersions',
]);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function createShotPlanningTask() {
  return Object.freeze({
    complete(input) {
      const metadata = normalizeTaskEnvelope(input, DOMAIN_KEYS);
      const domain = normalizeShotDomain(metadata.domain);
      const output = parseStructuredResponse(metadata.rawResponse, validateSchema);
      assertShotSemantics(domain, output);
      const inputHash = createShotPlanningInputHash(domain);
      return createAuditedTaskResult({
        taskType: TASK_TYPE,
        schemaVersion: SCHEMA_VERSION,
        inputHash,
        metadata,
        auditFields: {
          upstreamScriptHash: domain.script.approval.resultHash,
          scriptApprovalRef: domain.script.approval.reviewRef,
          assetCatalogHash: sha256Canonical(domain.assetVersions),
        },
        output,
      });
    },
  });
}

module.exports = {
  SCHEMA_VERSION,
  TASK_TYPE,
  createShotPlanningTask,
};
