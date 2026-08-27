const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const { narrativeTaskError } = require('./errors');
const {
  JsonSnapshotError,
  deepFreeze,
  sha256Canonical,
  snapshotJson,
} = require('./jsonSnapshot');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/novel-extraction.schema.json',
));

const REVIEW_REF = /^review:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function assertExtractionReferences(extraction) {
  const groups = [
    extraction.characters,
    extraction.scenes,
    extraction.props,
    extraction.relationships,
    extraction.events,
    extraction.dialogue,
  ];
  const factIds = new Set();
  for (const fact of groups.flat()) {
    if (factIds.has(fact.factId)) invalidInput();
    factIds.add(fact.factId);
  }
  const characterIds = new Set(extraction.characters.map((fact) => fact.factId));
  const sceneIds = new Set(extraction.scenes.map((fact) => fact.factId));
  const propIds = new Set(extraction.props.map((fact) => fact.factId));
  for (const relationship of extraction.relationships) {
    if (!characterIds.has(relationship.fromCharacterFactId)
      || !characterIds.has(relationship.toCharacterFactId)) invalidInput();
  }
  for (const event of extraction.events) {
    if (event.characterFactIds.some((id) => !characterIds.has(id))
      || (event.sceneFactId !== null && !sceneIds.has(event.sceneFactId))
      || event.propFactIds.some((id) => !propIds.has(id))) invalidInput();
  }
  for (const line of extraction.dialogue) {
    if (line.speakerCharacterFactId !== null
      && !characterIds.has(line.speakerCharacterFactId)) invalidInput();
  }
  return Object.freeze([...factIds]);
}

function normalizeApprovedExtraction(approvedExtraction, approval) {
  let snapshot;
  try {
    snapshot = snapshotJson({ approvedExtraction, approval }, {
      maxDepth: 32,
      maxNodes: 50000,
      maxStringBytes: 16 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    return invalidInput();
  }
  const extraction = snapshot.approvedExtraction;
  const approvalSnapshot = snapshot.approval;
  if (!validateSchema(extraction)
    || !approvalSnapshot
    || typeof approvalSnapshot !== 'object'
    || Array.isArray(approvalSnapshot)
    || Object.keys(approvalSnapshot).sort().join('\0') !== 'resultHash\0reviewRef\0status'
    || approvalSnapshot.status !== 'approved'
    || typeof approvalSnapshot.resultHash !== 'string'
    || !SHA256.test(approvalSnapshot.resultHash)
    || approvalSnapshot.resultHash !== sha256Canonical(extraction)
    || typeof approvalSnapshot.reviewRef !== 'string'
    || !REVIEW_REF.test(approvalSnapshot.reviewRef)) invalidInput();

  return deepFreeze({
    approval: approvalSnapshot,
    extraction,
    factIds: assertExtractionReferences(extraction),
  });
}

module.exports = {
  normalizeApprovedExtraction,
};
