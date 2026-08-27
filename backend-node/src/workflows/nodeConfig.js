const { isCanonicalUuid } = require('./identifiers');
const { snapshotJson } = require('./jsonSnapshot');
const { isCredentialReference } = require('./credentialReference');

const FIELD_RULES = Object.freeze({
  candidateCount: { kind: 'integer', minimum: 1, maximum: 16 },
  contextAfterBlocks: { kind: 'integer', minimum: 0, maximum: 50 },
  contextBeforeBlocks: { kind: 'integer', minimum: 0, maximum: 50 },
  credentialRef: { kind: 'credentialRef' },
  durationMs: { kind: 'integer', minimum: 1, maximum: 3_600_000 },
  format: { kind: 'enum', values: Object.freeze(['mp4']) },
  fps: { kind: 'integer', minimum: 1, maximum: 120 },
  height: { kind: 'integer', minimum: 64, maximum: 8192 },
  manifestUid: { kind: 'uuid' },
  maxShots: { kind: 'integer', minimum: 1, maximum: 100 },
  profileUid: { kind: 'uuid' },
  seed: { kind: 'integer', minimum: 0, maximum: 4_294_967_295 },
  speed: { kind: 'number', minimum: 0.5, maximum: 2 },
  targetSeconds: { kind: 'integer', minimum: 1, maximum: 3600 },
  temperature: { kind: 'number', minimum: 0, maximum: 2 },
  width: { kind: 'integer', minimum: 64, maximum: 8192 },
});

const NODE_CONFIG_FIELDS = Object.freeze({
  'source.selection': Object.freeze(['contextAfterBlocks', 'contextBeforeBlocks']),
  'story.facts': Object.freeze(['profileUid', 'temperature']),
  'episode.adaptation': Object.freeze(['profileUid', 'targetSeconds', 'temperature']),
  'script.structured': Object.freeze(['profileUid', 'temperature']),
  'asset.character': Object.freeze(['profileUid']),
  'asset.character_candidates': Object.freeze([
    'candidateCount', 'credentialRef', 'height', 'manifestUid', 'profileUid', 'seed', 'width',
  ]),
  'asset.character_pack': Object.freeze(['profileUid']),
  'asset.scene': Object.freeze([
    'candidateCount', 'credentialRef', 'height', 'manifestUid', 'profileUid', 'seed', 'width',
  ]),
  'asset.prop': Object.freeze([
    'candidateCount', 'credentialRef', 'height', 'manifestUid', 'profileUid', 'seed', 'width',
  ]),
  'shot.plan': Object.freeze(['maxShots', 'profileUid', 'targetSeconds', 'temperature']),
  'shot.image': Object.freeze([
    'credentialRef', 'height', 'manifestUid', 'profileUid', 'seed', 'width',
  ]),
  'shot.video': Object.freeze([
    'credentialRef', 'durationMs', 'fps', 'height', 'manifestUid', 'profileUid', 'seed', 'width',
  ]),
  'audio.tts': Object.freeze(['credentialRef', 'profileUid', 'speed']),
  'subtitle.align': Object.freeze(['profileUid']),
  'bgm.track': Object.freeze(['credentialRef', 'profileUid', 'targetSeconds']),
  'export.final': Object.freeze(['format', 'fps', 'height', 'width']),
});

class WorkflowNodeConfigError extends TypeError {
  constructor() {
    super('Workflow node configuration is invalid');
    this.name = 'WorkflowNodeConfigError';
    this.code = 'WORKFLOW_NODE_CONFIG_INVALID';
  }
}

function invalidConfig() {
  throw new WorkflowNodeConfigError();
}

function assertRule(value, rule) {
  if (rule.kind === 'uuid') {
    if (!isCanonicalUuid(value)) invalidConfig();
    return;
  }
  if (rule.kind === 'credentialRef') {
    if (!isCredentialReference(value)) invalidConfig();
    return;
  }
  if (rule.kind === 'enum') {
    if (typeof value !== 'string' || !rule.values.includes(value)) invalidConfig();
    return;
  }
  const validNumber = typeof value === 'number'
    && Number.isFinite(value)
    && value >= rule.minimum
    && value <= rule.maximum;
  if (!validNumber || (rule.kind === 'integer' && !Number.isSafeInteger(value))) invalidConfig();
}

function normalizeWorkflowNodeConfig(nodeType, value) {
  const fields = NODE_CONFIG_FIELDS[nodeType];
  if (!fields) invalidConfig();
  let input;
  try {
    input = snapshotJson(value);
  } catch {
    invalidConfig();
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidConfig();
  const allowed = new Set(fields);
  if (Object.keys(input).some((key) => !allowed.has(key))) invalidConfig();
  const normalized = Object.create(null);
  for (const field of fields) {
    if (!Object.hasOwn(input, field)) continue;
    const rule = FIELD_RULES[field];
    if (!rule) invalidConfig();
    assertRule(input[field], rule);
    normalized[field] = input[field];
  }
  return snapshotJson(normalized);
}

module.exports = {
  NODE_CONFIG_FIELDS,
  WorkflowNodeConfigError,
  normalizeWorkflowNodeConfig,
};
