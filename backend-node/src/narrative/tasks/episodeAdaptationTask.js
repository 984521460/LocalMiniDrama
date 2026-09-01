const path = require('node:path');

const Ajv = require('ajv/dist/2020');

const { normalizeApprovedExtraction } = require('./approvedExtraction');
const { narrativeTaskError } = require('./errors');
const {
  JsonSnapshotError,
  sha256Canonical,
  snapshotJson,
} = require('./jsonSnapshot');
const {
  createAuditedTaskResult,
  normalizeTaskEnvelope,
  parseStructuredResponse,
} = require('./structuredTask');

const schema = require(path.resolve(
  __dirname,
  '../../../../schemas/v3/episode-adaptation.schema.json',
));

const TASK_TYPE = 'EpisodeAdaptationTask';
const SCHEMA_VERSION = 'episode-adaptation.v1';
const DOMAIN_KEYS = Object.freeze([
  'approvedExtraction',
  'approval',
  'durationBudget',
  'style',
]);
const BEAT_KINDS = Object.freeze(['hook', 'setup', 'escalation', 'climax', 'cliffhanger']);
const validateSchema = new Ajv({ allErrors: true, strict: true }).compile(schema);

function invalidInput() {
  throw narrativeTaskError('NARRATIVE_TASK_INPUT_INVALID');
}

function isCleanBoundedText(value) {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  let codePoints = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return false;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) return false;
    codePoints += 1;
    if (codePoints > 128) return false;
  }
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= 512;
}

function normalizeAdaptationDomain(domain) {
  const approved = normalizeApprovedExtraction(domain.approvedExtraction, domain.approval);
  let settings;
  try {
    settings = snapshotJson({
      durationBudget: domain.durationBudget,
      style: domain.style,
    }, {
      maxDepth: 4,
      maxNodes: 16,
      maxStringBytes: 1024,
    });
  } catch (error) {
    if (error instanceof JsonSnapshotError && error.limitExceeded) {
      throw narrativeTaskError('NARRATIVE_TASK_LIMIT_EXCEEDED');
    }
    return invalidInput();
  }
  const durationBudget = settings.durationBudget;
  const style = settings.style;
  if (!durationBudget
    || typeof durationBudget !== 'object'
    || Array.isArray(durationBudget)
    || Object.keys(durationBudget).sort().join('\0') !== 'targetSeconds\0toleranceSeconds'
    || !Number.isSafeInteger(durationBudget.targetSeconds)
    || durationBudget.targetSeconds < 45
    || durationBudget.targetSeconds > 75
    || !Number.isSafeInteger(durationBudget.toleranceSeconds)
    || durationBudget.toleranceSeconds < 0
    || durationBudget.toleranceSeconds > 15
    || !style
    || typeof style !== 'object'
    || Array.isArray(style)
    || Object.keys(style).sort().join('\0') !== 'audience\0genre\0tone'
    || !isCleanBoundedText(style.genre)
    || !isCleanBoundedText(style.tone)
    || !isCleanBoundedText(style.audience)) invalidInput();

  return {
    ...approved,
    durationBudget,
    style,
  };
}

function createEpisodeAdaptationInputHash(domain) {
  return sha256Canonical({
    approval: domain.approval,
    approvedExtraction: domain.extraction,
    durationBudget: domain.durationBudget,
    style: domain.style,
  });
}

function assertAdaptationSemantics(domain, output) {
  const factIds = new Set(domain.factIds);
  const beatIds = new Set();
  const decisionIds = new Set();
  const usedDecisionIds = new Set();

  for (let index = 0; index < output.beats.length; index += 1) {
    const beat = output.beats[index];
    if (beat.kind !== BEAT_KINDS[index] || beatIds.has(beat.beatId)) {
      throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    }
    beatIds.add(beat.beatId);
    if (beat.factRefs.some((factId) => !factIds.has(factId))) {
      throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    }
    for (const decisionId of beat.adaptationDecisionRefs) usedDecisionIds.add(decisionId);
  }

  for (const decision of output.adaptationDecisions) {
    if (decisionIds.has(decision.decisionId)
      || decision.factRefs.some((factId) => !factIds.has(factId))) {
      throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
    }
    decisionIds.add(decision.decisionId);
  }
  if ([...usedDecisionIds].some((decisionId) => !decisionIds.has(decisionId))
    || [...decisionIds].some((decisionId) => !usedDecisionIds.has(decisionId))) {
    throw narrativeTaskError('NARRATIVE_TASK_REFERENCE_INVALID');
  }

  const totalSeconds = output.beats.reduce(
    (total, beat) => total + beat.estimatedDurationSeconds,
    0,
  );
  const { targetSeconds, toleranceSeconds } = domain.durationBudget;
  if (!Number.isSafeInteger(totalSeconds)
    || output.durationSummary.targetSeconds !== targetSeconds
    || output.durationSummary.toleranceSeconds !== toleranceSeconds
    || output.durationSummary.totalSeconds !== totalSeconds
    || totalSeconds < targetSeconds - toleranceSeconds
    || totalSeconds > targetSeconds + toleranceSeconds) {
    throw narrativeTaskError('NARRATIVE_TASK_RESPONSE_INVALID');
  }
}

function createEpisodeAdaptationTask() {
  return Object.freeze({
    complete(input) {
      const metadata = normalizeTaskEnvelope(input, DOMAIN_KEYS);
      const domain = normalizeAdaptationDomain(metadata.domain);
      const output = parseStructuredResponse(metadata.rawResponse, validateSchema);
      assertAdaptationSemantics(domain, output);
      const inputHash = createEpisodeAdaptationInputHash(domain);

      return createAuditedTaskResult({
        taskType: TASK_TYPE,
        schemaVersion: SCHEMA_VERSION,
        inputHash,
        metadata,
        auditFields: {
          upstreamResultHash: domain.approval.resultHash,
          approvalRef: domain.approval.reviewRef,
          durationBudget: domain.durationBudget,
          style: domain.style,
        },
        output,
      });
    },
  });
}

module.exports = {
  SCHEMA_VERSION,
  TASK_TYPE,
  createEpisodeAdaptationInputHash,
  createEpisodeAdaptationTask,
  normalizeAdaptationDomain,
};
