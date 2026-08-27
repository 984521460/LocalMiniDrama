const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const {
  assertScriptSemantics,
  createScriptInputHash,
  normalizeScriptDomain,
} = require('./scriptDomain');
const {
  createAuditedTaskResult,
  normalizeTaskEnvelope,
  parseStructuredResponse,
} = require('./structuredTask');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/script-formatting.schema.json',
));

const TASK_TYPE = 'ScriptFormattingTask';
const SCHEMA_VERSION = 'script-formatting.v1';
const DOMAIN_KEYS = Object.freeze([
  'approvedExtraction',
  'extractionApproval',
  'adaptationResult',
  'adaptationApproval',
]);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function createScriptFormattingTask() {
  return Object.freeze({
    complete(input) {
      const metadata = normalizeTaskEnvelope(input, DOMAIN_KEYS);
      const domain = normalizeScriptDomain(metadata.domain);
      const output = parseStructuredResponse(metadata.rawResponse, validateSchema);
      assertScriptSemantics(domain, output);
      const inputHash = createScriptInputHash(domain);
      return createAuditedTaskResult({
        taskType: TASK_TYPE,
        schemaVersion: SCHEMA_VERSION,
        inputHash,
        metadata,
        auditFields: {
          upstreamExtractionHash: domain.extraction.approval.resultHash,
          upstreamAdaptationHash: domain.adaptation.approval.resultHash,
          extractionApprovalRef: domain.extraction.approval.reviewRef,
          adaptationApprovalRef: domain.adaptation.approval.reviewRef,
        },
        output,
      });
    },
  });
}

module.exports = {
  SCHEMA_VERSION,
  TASK_TYPE,
  createScriptFormattingTask,
};
