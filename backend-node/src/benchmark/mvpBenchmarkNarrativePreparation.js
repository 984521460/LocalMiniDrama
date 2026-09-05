'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const { createReferenceOwnershipResolver } = require('../assets/referenceOwnership');
const { createNarrativeExecutionService } = require('../narrative/execution');
const { createNarrativeReviewService } = require('../narrative/reviews');
const { createV2Repositories } = require('../repositories/v2');
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
const STATUS_SCHEMA_VERSION = 'mvp-benchmark-narrative-status.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STAGES = Object.freeze(['extraction', 'adaptation', 'script', 'shot']);
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
  const executions = createNarrativeExecutionService({
    repositories,
    provider: provider(),
    assetOwnership: createReferenceOwnershipResolver(database),
    createUid,
  });

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
    if (!Array.isArray(records) || records.length > STAGES.length) fail();
    const stages = [];
    let blocked = false;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const expectedStage = STAGES[index];
      if (blocked || record.resultType !== expectedStage
        || record.dramaUid !== identity.dramaUid
        || record.sourceSelectionUid !== identity.sourceSelectionUid
        || (index === 0 ? record.upstreamResultUid !== null
          : record.upstreamResultUid !== records[index - 1].uid)
        || !UUID_V4.test(record.uid) || !SHA256.test(record.resultHash)
        || !SHA256.test(record.envelopeHash)
        || !['pending_review', 'approved', 'rejected'].includes(record.status)) fail();
      let detail;
      try { detail = reviews.getResult(record.uid); } catch { return fail(); }
      try {
        const execution = executions.get(deterministicUid(
          `rain-before-clear-narrative:${identity.sourceSelectionUid}:${expectedStage}`,
        ));
        if (execution?.execution?.state !== 'succeeded'
          || execution?.result?.uid !== record.uid) fail();
      } catch (error) {
        if (error instanceof MvpBenchmarkNarrativeError) throw error;
        return fail();
      }
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
    const last = stages.length === 0 ? null : stages[stages.length - 1];
    const nextStage = blocked || stages.length === STAGES.length
      ? null : STAGES[stages.length];
    const status = stages.length === 0 ? 'not_started'
      : last.status === 'pending_review' ? 'awaiting_review'
        : last.status === 'rejected' ? 'rejected'
          : stages.length === STAGES.length ? 'approved_complete' : 'ready_for_next_stage';
    return Object.freeze({
      schemaVersion: STATUS_SCHEMA_VERSION,
      ...identity,
      status,
      nextStage,
      stages: Object.freeze(stages),
    });
  }

  function requestFor(stage, current) {
    const index = STAGES.indexOf(stage);
    if (index < 0 || current.nextStage !== stage) fail();
    const upstream = index === 0 ? null : current.stages[index - 1];
    if (upstream && (upstream.status !== 'approved' || upstream.approvalRef === null)) fail();
    return Object.freeze({
      schemaVersion: 'narrative-execution-request.v1',
      operationUid: deterministicUid(
        `rain-before-clear-narrative:${identity.sourceSelectionUid}:${stage}`,
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

  return Object.freeze({
    inspect,

    async stage(stage) {
      if (typeof stage !== 'string' || !STAGES.includes(stage)) fail();
      const current = inspect();
      const existing = current.stages.find((item) => item.stage === stage);
      if (existing) return current;
      let completed;
      try { completed = await executions.execute(requestFor(stage, current)); } catch {
        return fail();
      }
      if (completed?.execution?.state !== 'succeeded'
        || completed?.result?.resultType !== stage
        || completed.result.status !== 'pending_review') fail();
      return inspect();
    },

    approve(value) {
      const input = exactObject(value, ['stage', 'resultUid', 'resultHash', 'envelopeHash']);
      if (typeof input.stage !== 'string' || !STAGES.includes(input.stage)
        || typeof input.resultUid !== 'string' || !UUID_V4.test(input.resultUid)
        || typeof input.resultHash !== 'string' || !SHA256.test(input.resultHash)
        || typeof input.envelopeHash !== 'string' || !SHA256.test(input.envelopeHash)) fail();
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
  });
}

module.exports = Object.freeze({
  ERROR_CODE,
  MvpBenchmarkNarrativeError,
  STATUS_SCHEMA_VERSION,
  STAGES,
  createMvpBenchmarkNarrativePreparation,
});
