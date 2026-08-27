const { isCanonicalUuid } = require('./identifiers');
const { assertExactObject, snapshotJson } = require('./jsonSnapshot');
const { WorkflowPlanDataError, validateWorkflowExecutionPlan } = require('./executionPlan');
const { isCredentialReference } = require('./credentialReference');

const WORKFLOW_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const NODE_STATUSES = new Set([
  'queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked', 'skipped',
]);
const TRIGGER_TYPES = new Set(['manual', 'node', 'downstream', 'selection', 'full', 'system']);
const WORKFLOW_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed', 'cancelled']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  failed: new Set(['running']),
});
const NODE_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'cancelled', 'blocked', 'skipped']),
  running: new Set(['succeeded', 'failed', 'cancelled']),
  failed: new Set(['queued']),
  blocked: new Set(['queued']),
});
const ERROR_CODE = /^ERR_[A-Z0-9_]{1,60}$/u;
const ERROR_DETAIL_REF = /^error-detail:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_RETRY_COUNT = 100;
const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'apikey', 'accesskey', 'authorization', 'bearer', 'credential', 'password',
  'privatekey', 'refreshtoken', 'secret', 'secretkey', 'sessiontoken', 'token',
]);
const RAW_SECRET = /^(?:bearer\s+|sk-[a-z0-9_-]{8,}|akia[0-9a-z]{12,}|-----begin [^-]*private key-----)/iu;

class WorkflowRunDataError extends Error {
  constructor() {
    super('Stored workflow run data is invalid');
    this.name = 'WorkflowRunDataError';
  }
}

function invalidData() {
  throw new WorkflowRunDataError();
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length !== 24) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function optionalTimestamp(value) {
  if (value === null) return null;
  if (!isCanonicalTimestamp(value)) invalidData();
  return value;
}

function safePayload(value) {
  let snapshot;
  try {
    snapshot = snapshotJson(value, { maxDepth: 16, maxEntries: 10_000, maxTotalBytes: 512 * 1024 });
  } catch {
    invalidData();
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) invalidData();
  function inspect(candidate) {
    if (typeof candidate === 'string') {
      if (RAW_SECRET.test(candidate)) invalidData();
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const child of candidate) inspect(child);
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (normalized === 'credentialref') {
        if (!isCredentialReference(child)) invalidData();
        continue;
      }
      if (FORBIDDEN_PAYLOAD_KEYS.has(normalized)) invalidData();
      inspect(child);
    }
  }
  inspect(snapshot);
  return snapshot;
}

function normalizeErrorFields(errorCode, errorDetailRef, required) {
  if (!required) {
    if (errorCode !== null || errorDetailRef !== null) invalidData();
    return { errorCode: null, errorDetailRef: null };
  }
  if (typeof errorCode !== 'string' || !ERROR_CODE.test(errorCode)) invalidData();
  if (errorDetailRef !== null && (
    typeof errorDetailRef !== 'string' || !ERROR_DETAIL_REF.test(errorDetailRef)
  )) invalidData();
  return { errorCode, errorDetailRef };
}

function normalizeWorkflowRunRecord(value) {
  try {
    const run = snapshotJson(value);
    assertExactObject(run, [
      'uid', 'workflowUid', 'graphSnapshot', 'triggerType', 'status', 'retryCount',
      'errorCode', 'errorDetailRef', 'createdAt', 'startedAt', 'completedAt', 'updatedAt',
      'graphHash', 'graphRevision',
    ]);
    if (
      !isCanonicalUuid(run.uid)
      || !isCanonicalUuid(run.workflowUid)
      || !TRIGGER_TYPES.has(run.triggerType)
      || !WORKFLOW_STATUSES.has(run.status)
      || !Number.isSafeInteger(run.retryCount)
      || run.retryCount < 0
      || run.retryCount > MAX_RETRY_COUNT
      || typeof run.graphHash !== 'string'
      || !HASH.test(run.graphHash)
      || !Number.isSafeInteger(run.graphRevision)
      || run.graphRevision < 0
      || !isCanonicalTimestamp(run.createdAt)
      || !isCanonicalTimestamp(run.updatedAt)
    ) invalidData();
    const graphSnapshot = validateWorkflowExecutionPlan(run.graphSnapshot);
    if (
      graphSnapshot.workflowUid !== run.workflowUid
      || graphSnapshot.graphHash !== run.graphHash
      || graphSnapshot.graphRevision !== run.graphRevision
    ) invalidData();
    const errorRequired = run.status === 'failed';
    const errors = normalizeErrorFields(run.errorCode, run.errorDetailRef, errorRequired);
    const startedAt = optionalTimestamp(run.startedAt);
    const completedAt = optionalTimestamp(run.completedAt);
    if (
      (run.status === 'queued' && (
        run.retryCount !== 0 || startedAt !== null || completedAt !== null
      ))
      || (run.status === 'running' && (startedAt === null || completedAt !== null))
      || (run.status === 'succeeded' && (startedAt === null || completedAt === null))
      || (run.status === 'failed' && completedAt === null)
      || (run.status === 'cancelled' && completedAt === null)
    ) invalidData();
    return snapshotJson({
      uid: run.uid,
      workflowUid: run.workflowUid,
      graphSnapshot,
      graphHash: run.graphHash,
      graphRevision: run.graphRevision,
      triggerType: run.triggerType,
      status: run.status,
      retryCount: run.retryCount,
      ...errors,
      createdAt: run.createdAt,
      startedAt,
      completedAt,
      updatedAt: run.updatedAt,
    });
  } catch (error) {
    if (error instanceof WorkflowRunDataError) throw error;
    if (error instanceof WorkflowPlanDataError) throw new WorkflowRunDataError();
    throw new WorkflowRunDataError();
  }
}

function normalizeNodeRunRecord(value) {
  try {
    const node = snapshotJson(value);
    assertExactObject(node, [
      'uid', 'workflowRunUid', 'nodeUid', 'ordinal', 'inputSnapshot', 'output', 'cacheKey',
      'status', 'retryCount', 'errorCode', 'errorDetailRef', 'createdAt', 'startedAt',
      'completedAt', 'updatedAt',
    ]);
    if (
      !isCanonicalUuid(node.uid)
      || !isCanonicalUuid(node.workflowRunUid)
      || !isCanonicalUuid(node.nodeUid)
      || !Number.isSafeInteger(node.ordinal)
      || node.ordinal < 0
      || node.ordinal >= 500
      || !NODE_STATUSES.has(node.status)
      || !Number.isSafeInteger(node.retryCount)
      || node.retryCount < 0
      || node.retryCount > MAX_RETRY_COUNT
      || (node.cacheKey !== null && (typeof node.cacheKey !== 'string' || !HASH.test(node.cacheKey)))
      || !isCanonicalTimestamp(node.createdAt)
      || !isCanonicalTimestamp(node.updatedAt)
    ) invalidData();
    const inputSnapshot = safePayload(node.inputSnapshot);
    const output = node.output === null ? null : safePayload(node.output);
    const errorRequired = node.status === 'failed' || node.status === 'blocked';
    const errors = normalizeErrorFields(node.errorCode, node.errorDetailRef, errorRequired);
    const startedAt = optionalTimestamp(node.startedAt);
    const completedAt = optionalTimestamp(node.completedAt);
    if (
      (node.status === 'queued' && (
        Object.keys(inputSnapshot).length !== 0
        || node.cacheKey !== null
        || startedAt !== null
        || completedAt !== null
        || output !== null
      ))
      || (node.status === 'running' && (startedAt === null || completedAt !== null || output !== null))
      || (node.status === 'succeeded' && (startedAt === null || completedAt === null || output === null))
      || (['failed', 'cancelled', 'blocked', 'skipped'].includes(node.status) && completedAt === null)
      || (node.status !== 'succeeded' && output !== null)
    ) invalidData();
    return snapshotJson({
      uid: node.uid,
      workflowRunUid: node.workflowRunUid,
      nodeUid: node.nodeUid,
      ordinal: node.ordinal,
      inputSnapshot,
      output,
      cacheKey: node.cacheKey,
      status: node.status,
      retryCount: node.retryCount,
      ...errors,
      createdAt: node.createdAt,
      startedAt,
      completedAt,
      updatedAt: node.updatedAt,
    });
  } catch (error) {
    if (error instanceof WorkflowRunDataError) throw error;
    throw new WorkflowRunDataError();
  }
}

function validateRunAggregate(value) {
  try {
    const aggregate = snapshotJson(value);
    assertExactObject(aggregate, ['run', 'nodes']);
    if (!Array.isArray(aggregate.nodes)) invalidData();
    const run = normalizeWorkflowRunRecord(aggregate.run);
    const nodes = aggregate.nodes.map(normalizeNodeRunRecord);
    if (
      nodes.length !== run.graphSnapshot.topologicalOrder.length
      || nodes.some((node, ordinal) => (
        node.workflowRunUid !== run.uid
        || node.ordinal !== ordinal
        || node.nodeUid !== run.graphSnapshot.topologicalOrder[ordinal]
      ))
    ) invalidData();
    const nodeStatuses = nodes.map((node) => node.status);
    if (
      (run.status === 'queued' && nodeStatuses.some((status) => status !== 'queued'))
      || (run.status === 'succeeded' && nodeStatuses.some((status) => (
        status !== 'succeeded' && status !== 'skipped'
      )))
      || (run.status === 'failed' && nodeStatuses.every((status) => (
        status !== 'failed' && status !== 'blocked'
      )))
    ) invalidData();
    return snapshotJson({ run, nodes });
  } catch (error) {
    if (error instanceof WorkflowRunDataError) throw error;
    throw new WorkflowRunDataError();
  }
}

function workflowTransitionAllowed(expectedStatus, nextStatus) {
  return WORKFLOW_TRANSITIONS[expectedStatus]?.has(nextStatus) === true;
}

function nodeTransitionAllowed(expectedStatus, nextStatus) {
  return NODE_TRANSITIONS[expectedStatus]?.has(nextStatus) === true;
}

module.exports = {
  ERROR_CODE,
  ERROR_DETAIL_REF,
  HASH,
  MAX_RETRY_COUNT,
  NODE_STATUSES,
  TRIGGER_TYPES,
  WORKFLOW_STATUSES,
  WorkflowRunDataError,
  nodeTransitionAllowed,
  normalizeNodeRunRecord,
  normalizeWorkflowRunRecord,
  safePayload,
  validateRunAggregate,
  workflowTransitionAllowed,
};
