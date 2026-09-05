'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { createReferenceOwnershipResolver } = require('../assets/referenceOwnership');
const { createNarrativeExecutionService } = require('../narrative/execution');
const { createNarrativeReviewService } = require('../narrative/reviews');
const { createNarrativeStalenessService } = require('../narrative/staleness');
const {
  V2RepositoryNotFoundError,
  createV2Repositories,
} = require('../repositories/v2');
const {
  DURATION_BUDGET,
  STYLE,
  createRainAdaptationOutput,
  createRainExtractionOutput,
  createRainScriptOutput,
  createRainShotOutput,
} = require('./rainBeforeClearNarrativePlan');
const { WORKSPACE_NAME } = require('./mvpBenchmarkWorkspace');

const ERROR_CODE = 'MVP_BENCHMARK_NARRATIVE_INVALID';
const STATUS_SCHEMA_VERSION = 'mvp-benchmark-narrative-status.v2';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const STAGES = Object.freeze(['extraction', 'adaptation', 'script', 'shot']);
const MAX_REVISIONS_PER_STAGE = 32;
const OUTPUT_BUILDERS = Object.freeze({
  extraction: (command) => createRainExtractionOutput(command.source.blocks),
  adaptation: () => createRainAdaptationOutput(),
  script: () => createRainScriptOutput(),
  shot: () => createRainShotOutput(),
});

class MvpBenchmarkNarrativeError extends Error {
  constructor() {
    super('MVP benchmark narrative preparation is invalid');
    this.name = 'MvpBenchmarkNarrativeError';
    this.code = ERROR_CODE;
    Object.freeze(this);
  }
}

function fail() {
  throw new MvpBenchmarkNarrativeError();
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail();
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) fail();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!Object.hasOwn(descriptors, key)) fail();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[key] = descriptor.value;
  }
  return output;
}

function deterministicUid(value) {
  const bytes = createHash('sha256').update(value, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
    + `-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function exactResultIdentity(value) {
  const input = exactObject(value, ['stage', 'resultUid', 'resultHash', 'envelopeHash']);
  if (typeof input.stage !== 'string' || !STAGES.includes(input.stage)
    || typeof input.resultUid !== 'string' || !UUID_V4.test(input.resultUid)
    || typeof input.resultHash !== 'string' || !SHA256.test(input.resultHash)
    || typeof input.envelopeHash !== 'string' || !SHA256.test(input.envelopeHash)) fail();
  return input;
}

function workspaceIdentity(value) {
  const input = exactObject(value, [
    'workspaceName', 'sourceId', 'dramaUid', 'sourceSelectionUid',
  ]);
  if (input.workspaceName !== WORKSPACE_NAME || input.sourceId !== 'rain-before-clear-v1'
    || typeof input.dramaUid !== 'string' || !UUID_V4.test(input.dramaUid)
    || typeof input.sourceSelectionUid !== 'string'
    || !UUID_V4.test(input.sourceSelectionUid)) fail();
  return Object.freeze({
    workspaceName: input.workspaceName,
    sourceId: input.sourceId,
    dramaUid: input.dramaUid,
    sourceSelectionUid: input.sourceSelectionUid,
  });
}

function provider() {
  return Object.freeze({
    scope: 'configured-text',
    isAvailable() { return true; },
    generate(command) {
      const builder = OUTPUT_BUILDERS[command?.resultType];
      if (typeof builder !== 'function') fail();
      return {
        model: {
          provider: 'repository-benchmark-plan',
          name: 'rain-before-clear-v1',
        },
        parameters: {
          networkUsed: false,
          planVersion: 'rain-before-clear-narrative.v1',
        },
        promptVersion: `mvp-benchmark-${command.resultType}.v1`,
        rawResponse: JSON.stringify(builder(command)),
      };
    },
  });
}

function createMvpBenchmarkNarrativePreparation({
  database,
  workspace,
  createUid = randomUUID,
} = {}) {
  if (!database || typeof database.prepare !== 'function'
    || typeof database.transaction !== 'function' || typeof createUid !== 'function') fail();
  const identity = workspaceIdentity(workspace);
  const repositories = createV2Repositories(database);
  const reviews = createNarrativeReviewService({ repositories });
  const staleHistory = createNarrativeStalenessService({ repositories });
  const executions = createNarrativeExecutionService({
    repositories,
    provider: provider(),
    assetOwnership: createReferenceOwnershipResolver(database),
    createUid,
  });

  function operationUid(stage, revision) {
    if (!Number.isSafeInteger(revision) || revision < 1
      || revision > MAX_REVISIONS_PER_STAGE) fail();
    const key = revision === 1
      ? `rain-before-clear-narrative:${identity.sourceSelectionUid}:${stage}`
      : `rain-before-clear-narrative:r${revision}:${identity.sourceSelectionUid}:${stage}`;
    return deterministicUid(key);
  }

  function boundExecution(record, revisionCount, requireCurrent) {
    let matched = null;
    for (let revision = 1; revision <= revisionCount; revision += 1) {
      const uid = operationUid(record.resultType, revision);
      let execution;
      try { execution = repositories.narrativeExecutions.get(uid); } catch (error) {
        if (error instanceof V2RepositoryNotFoundError) continue;
        return fail();
      }
      if (execution.resultUid !== record.uid) continue;
      if (matched !== null || execution.state !== 'succeeded') fail();
      matched = Object.freeze({ uid, execution });
    }
    if (matched === null) fail();
    if (requireCurrent) {
      let current;
      try { current = executions.get(matched.uid); } catch { return fail(); }
      if (current?.execution?.state !== 'succeeded' || current?.result?.uid !== record.uid) fail();
    }
    return matched;
  }

  function publicReview(review, record) {
    if (!review || typeof review !== 'object'
      || typeof review.uid !== 'string' || !UUID_V4.test(review.uid)
      || review.resultUid !== record.uid
      || !['approve', 'reject'].includes(review.decision)
      || review.resultHash !== record.resultHash
      || review.envelopeHash !== record.envelopeHash
      || (review.comment !== null && typeof review.comment !== 'string')
      || typeof review.createdAt !== 'string' || !ISO_INSTANT.test(review.createdAt)
      || new Date(review.createdAt).toISOString() !== review.createdAt) fail();
    return Object.freeze({
      uid: review.uid,
      decision: review.decision,
      resultHash: review.resultHash,
      envelopeHash: review.envelopeHash,
      comment: review.comment,
      createdAt: review.createdAt,
    });
  }

  function inspect() {
    let records;
    try {
      const selection = repositories.sources.getSelection(identity.sourceSelectionUid);
      const document = repositories.sources.getDocument(selection.documentUid);
      if (document.dramaUid !== identity.dramaUid) fail();
      records = reviews.listForSelection(identity.sourceSelectionUid);
    } catch (error) {
      if (error instanceof MvpBenchmarkNarrativeError) throw error;
      return fail();
    }
    if (!Array.isArray(records)
      || records.length > STAGES.length * MAX_REVISIONS_PER_STAGE) fail();
    const counts = Object.create(null);
    for (let index = 0; index < STAGES.length; index += 1) counts[STAGES[index]] = 0;
    for (let index = 0; index < records.length; index += 1) {
      if (!Object.hasOwn(counts, records[index]?.resultType)) fail();
      counts[records[index].resultType] += 1;
      if (counts[records[index].resultType] > MAX_REVISIONS_PER_STAGE) fail();
    }
    const stages = [];
    const history = [];
    const active = records.filter((record) => record.status !== 'stale');
    let blocked = false;
    for (let index = 0; index < active.length; index += 1) {
      const record = active[index];
      const expectedStage = STAGES[index];
      if (blocked || record.resultType !== expectedStage
        || record.dramaUid !== identity.dramaUid
        || record.sourceSelectionUid !== identity.sourceSelectionUid
        || (index === 0 ? record.upstreamResultUid !== null
          : record.upstreamResultUid !== active[index - 1].uid)
        || !UUID_V4.test(record.uid) || !SHA256.test(record.resultHash)
        || !SHA256.test(record.envelopeHash)
        || !['pending_review', 'approved', 'rejected'].includes(record.status)) fail();
      let detail;
      try { detail = reviews.getResult(record.uid); } catch { return fail(); }
      boundExecution(record, counts[expectedStage], true);
      const approvalRef = detail.approval?.reviewRef ?? null;
      if ((record.status === 'approved') !== (approvalRef !== null)) fail();
      stages.push(Object.freeze({
        stage: expectedStage,
        status: record.status,
        resultUid: record.uid,
        resultHash: record.resultHash,
        envelopeHash: record.envelopeHash,
        approvalRef,
        output: record.result.output,
      }));
      if (record.status !== 'approved') blocked = true;
    }
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.status !== 'stale') continue;
      if (record.dramaUid !== identity.dramaUid
        || record.sourceSelectionUid !== identity.sourceSelectionUid
        || !UUID_V4.test(record.uid) || !SHA256.test(record.resultHash)
        || !SHA256.test(record.envelopeHash)) fail();
      let detail;
      let events;
      try {
        detail = reviews.getResult(record.uid);
        events = staleHistory.listEvents(record.uid);
      } catch { return fail(); }
      if (events.length !== 1 || events[0].resultUid !== record.uid
        || events[0].rootKind !== 'narrative_result'
        || events[0].reasonCode !== 'narrative_result_superseded') fail();
      boundExecution(record, counts[record.resultType], false);
      history.push(Object.freeze({
        stage: record.resultType,
        status: 'stale',
        resultUid: record.uid,
        resultHash: record.resultHash,
        envelopeHash: record.envelopeHash,
        output: record.result.output,
        reviews: Object.freeze(detail.reviews.map((review) => publicReview(review, record))),
        staleEvent: events[0],
      }));
    }
    const last = stages.length === 0 ? null : stages[stages.length - 1];
    const candidateStage = blocked || stages.length === STAGES.length
      ? null : STAGES[stages.length];
    const replacementRequired = candidateStage !== null
      && history.some((item) => item.stage === candidateStage);
    const nextStage = replacementRequired ? null : candidateStage;
    const status = replacementRequired ? 'replacement_required'
      : stages.length === 0 ? 'not_started'
      : last.status === 'pending_review' ? 'awaiting_review'
        : last.status === 'rejected' ? 'rejected'
          : stages.length === STAGES.length ? 'approved_complete' : 'ready_for_next_stage';
    return Object.freeze({
      schemaVersion: STATUS_SCHEMA_VERSION,
      ...identity,
      status,
      nextStage,
      stages: Object.freeze(stages),
      history: Object.freeze(history),
    });
  }

  function requestFor(stage, current, allowReplacement = false) {
    const index = STAGES.indexOf(stage);
    if (index < 0 || index !== current.stages.length
      || (current.nextStage !== stage
        && !(allowReplacement && current.status === 'replacement_required'
          && current.history.some((item) => item.stage === stage)))) fail();
    const upstream = index === 0 ? null : current.stages[index - 1];
    if (upstream && (upstream.status !== 'approved' || upstream.approvalRef === null)) fail();
    return Object.freeze({
      schemaVersion: 'narrative-execution-request.v1',
      operationUid: operationUid(
        stage,
        current.stages.filter((item) => item.stage === stage).length
          + current.history.filter((item) => item.stage === stage).length + 1,
      ),
      dramaUid: identity.dramaUid,
      sourceSelectionUid: identity.sourceSelectionUid,
      resultType: stage,
      upstreamResultUid: upstream?.resultUid ?? null,
      upstreamResultHash: upstream?.resultHash ?? null,
      upstreamEnvelopeHash: upstream?.envelopeHash ?? null,
      upstreamApprovalRef: upstream?.approvalRef ?? null,
      durationBudget: stage === 'adaptation' ? DURATION_BUDGET : null,
      style: stage === 'adaptation' ? STYLE : null,
      assetVersions: [],
    });
  }

  async function stageCurrent(stage, current, allowReplacement = false) {
    const existing = current.stages.find((item) => item.stage === stage);
    if (existing) return current;
    let completed;
    try {
      completed = await executions.execute(requestFor(stage, current, allowReplacement));
    } catch {
      return fail();
    }
    if (completed?.execution?.state !== 'succeeded'
      || completed?.result?.resultType !== stage
      || completed.result.status !== 'pending_review') fail();
    return inspect();
  }

  return Object.freeze({
    inspect,

    async stage(stage) {
      if (typeof stage !== 'string' || !STAGES.includes(stage)) fail();
      const current = inspect();
      return stageCurrent(stage, current);
    },

    approve(value) {
      const input = exactResultIdentity(value);
      const current = inspect();
      const stage = current.stages.find((item) => item.stage === input.stage);
      if (!stage || stage.resultUid !== input.resultUid
        || stage.resultHash !== input.resultHash
        || stage.envelopeHash !== input.envelopeHash) fail();
      if (stage.status === 'approved') return current;
      if (stage.status !== 'pending_review') fail();
      const approvalService = createNarrativeReviewService({
        repositories,
        createUid: () => deterministicUid(
          `rain-before-clear-review:${stage.resultUid}:${stage.envelopeHash}`,
        ),
      });
      try {
        approvalService.reviewResult({
          resultUid: stage.resultUid,
          decision: 'approve',
          comment: 'Explicit operator approval for the fixed MVP benchmark narrative stage.',
        });
      } catch {
        return fail();
      }
      return inspect();
    },

    async supersede(value) {
      const input = exactResultIdentity(value);
      let current = inspect();
      const historical = current.history.find((item) => item.stage === input.stage
        && item.resultUid === input.resultUid
        && item.resultHash === input.resultHash
        && item.envelopeHash === input.envelopeHash);
      const activeStage = current.stages.find((item) => item.stage === input.stage);
      if (historical) {
        if (activeStage) return current;
        return stageCurrent(input.stage, current, true);
      }
      if (!activeStage || !['pending_review', 'approved', 'rejected'].includes(activeStage.status)
        || activeStage.resultUid !== input.resultUid
        || activeStage.resultHash !== input.resultHash
        || activeStage.envelopeHash !== input.envelopeHash) fail();
      const staleness = createNarrativeStalenessService({
        repositories,
        createUid: () => deterministicUid(
          `rain-before-clear-supersede:${input.resultUid}:${input.envelopeHash}`,
        ),
      });
      try {
        staleness.invalidate({ rootKind: 'narrative_result', rootUid: input.resultUid });
      } catch {
        return fail();
      }
      current = inspect();
      if (current.status !== 'replacement_required'
        || !current.history.some((item) => item.resultUid === input.resultUid
          && item.resultHash === input.resultHash
          && item.envelopeHash === input.envelopeHash)) fail();
      return stageCurrent(input.stage, current, true);
    },
  });
}

module.exports = Object.freeze({
  ERROR_CODE,
  MvpBenchmarkNarrativeError,
  STATUS_SCHEMA_VERSION,
  STAGES,
  createMvpBenchmarkNarrativePreparation,
});
