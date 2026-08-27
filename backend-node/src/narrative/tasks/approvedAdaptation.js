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
  '../../../../schemas/v3/episode-adaptation.schema.json',
));

const CANONICAL_REF = /^(?:response|review):v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION_TOKEN = /^[a-z][a-z0-9.-]{0,127}$/u;
const RESULT_KEYS = Object.freeze([
  'approvalRef',
  'durationBudget',
  'inputHash',
  'model',
  'output',
  'parameters',
  'promptVersion',
  'rawResponseRef',
  'rawResponseSha256',
  'schemaVersion',
  'style',
  'taskType',
  'upstreamResultHash',
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

function assertAdaptationOutput(output) {
  const beatIds = new Set();
  const decisionIds = new Set();
  const usedDecisionIds = new Set();
  const factIds = new Set();
  for (const beat of output.beats) {
    if (beatIds.has(beat.beatId)) invalidInput();
    beatIds.add(beat.beatId);
    for (const factId of beat.factRefs) factIds.add(factId);
    for (const decisionId of beat.adaptationDecisionRefs) usedDecisionIds.add(decisionId);
  }
  for (const decision of output.adaptationDecisions) {
    if (decisionIds.has(decision.decisionId)) invalidInput();
    decisionIds.add(decision.decisionId);
    for (const factId of decision.factRefs) factIds.add(factId);
  }
  if ([...usedDecisionIds].some((decisionId) => !decisionIds.has(decisionId))
    || [...decisionIds].some((decisionId) => !usedDecisionIds.has(decisionId))) invalidInput();
  const totalSeconds = output.beats.reduce(
    (total, beat) => total + beat.estimatedDurationSeconds,
    0,
  );
  if (!Number.isSafeInteger(totalSeconds)
    || totalSeconds !== output.durationSummary.totalSeconds
    || totalSeconds < output.durationSummary.targetSeconds - output.durationSummary.toleranceSeconds
    || totalSeconds > output.durationSummary.targetSeconds + output.durationSummary.toleranceSeconds) {
    invalidInput();
  }
  return {
    beatIds: Object.freeze([...beatIds]),
    decisionIds: Object.freeze([...decisionIds]),
    factIds: Object.freeze([...factIds]),
  };
}

function normalizeApprovedAdaptation(adaptationResult, approval) {
  let snapshot;
  try {
    snapshot = snapshotJson({ adaptationResult, approval }, {
      maxDepth: 32,
      maxNodes: 40000,
      maxStringBytes: 8 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    return invalidInput();
  }
  const result = snapshot.adaptationResult;
  const approvalSnapshot = snapshot.approval;
  if (!exactKeys(result, RESULT_KEYS)
    || result.taskType !== 'EpisodeAdaptationTask'
    || result.schemaVersion !== 'episode-adaptation.v1'
    || typeof result.promptVersion !== 'string'
    || !VERSION_TOKEN.test(result.promptVersion)
    || typeof result.inputHash !== 'string'
    || !SHA256.test(result.inputHash)
    || typeof result.rawResponseRef !== 'string'
    || !CANONICAL_REF.test(result.rawResponseRef)
    || !result.rawResponseRef.startsWith('response:v1:')
    || typeof result.rawResponseSha256 !== 'string'
    || !SHA256.test(result.rawResponseSha256)
    || typeof result.upstreamResultHash !== 'string'
    || !SHA256.test(result.upstreamResultHash)
    || typeof result.approvalRef !== 'string'
    || !CANONICAL_REF.test(result.approvalRef)
    || !result.approvalRef.startsWith('review:v1:')
    || !exactKeys(result.durationBudget, ['targetSeconds', 'toleranceSeconds'])
    || !Number.isSafeInteger(result.durationBudget.targetSeconds)
    || result.durationBudget.targetSeconds < 45
    || result.durationBudget.targetSeconds > 75
    || !Number.isSafeInteger(result.durationBudget.toleranceSeconds)
    || result.durationBudget.toleranceSeconds < 0
    || result.durationBudget.toleranceSeconds > 15
    || result.durationBudget.targetSeconds !== result.output?.durationSummary?.targetSeconds
    || result.durationBudget.toleranceSeconds !== result.output?.durationSummary?.toleranceSeconds
    || !exactKeys(result.style, ['audience', 'genre', 'tone'])
    || !isCleanBoundedText(result.style.genre)
    || !isCleanBoundedText(result.style.tone)
    || !isCleanBoundedText(result.style.audience)
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

  return deepFreeze({
    approval: approvalSnapshot,
    output: result.output,
    result,
    ...assertAdaptationOutput(result.output),
  });
}

module.exports = {
  normalizeApprovedAdaptation,
};
