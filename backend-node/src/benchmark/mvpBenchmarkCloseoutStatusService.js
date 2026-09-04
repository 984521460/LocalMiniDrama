'use strict';

const { types: { isProxy } } = require('node:util');

const { sha256Canonical } = require('../h3/contract');
const { parseMvpBenchmarkSessionPlan } = require('./mvpBenchmarkSession');
const {
  parseMvpBenchmarkExternalAuthorization,
} = require('./mvpBenchmarkExternalAuthorization');
const { validateRunAggregate } = require('../workflows/runState');
const {
  GATE_DEFINITIONS,
  GLOBAL_EVIDENCE_IDS,
  MvpBenchmarkCloseoutStatusError,
  SCHEMA_VERSION,
  createMvpBenchmarkCloseoutStatus,
  isMvpBenchmarkCloseoutStatusError,
  parseMvpBenchmarkCloseoutStatusRequest,
} = require('./mvpBenchmarkCloseoutStatus');

const OBJECT_FREEZE = Object.freeze;
const OBJECT_CREATE = Object.create;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY = Array;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PROTOTYPE = Array.prototype;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const STRING = String;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REGEXP_TEST = RegExp.prototype.test;
const TERMINAL_FAILURES = OBJECT_FREEZE(['failed', 'blocked', 'cancelled']);

function unavailable() {
  throw new MvpBenchmarkCloseoutStatusError('MVP_BENCHMARK_CLOSEOUT_STATUS_UNAVAILABLE');
}

function captureMethod(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) unavailable();
  let descriptor;
  try {
    descriptor = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, Object, [target, name]);
  } catch {
    unavailable();
  }
  if (!descriptor?.enumerable || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])
    || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) unavailable();
  return OBJECT_FREEZE({ method: descriptor.value, target });
}

function ownData(target, name) {
  if (!target || typeof target !== 'object' || isProxy(target)) unavailable();
  let descriptor;
  try {
    descriptor = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTOR, Object, [target, name]);
  } catch {
    unavailable();
  }
  if (!descriptor?.enumerable || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) {
    unavailable();
  }
  return descriptor.value;
}

function exactConfiguration(value) {
  const keys = ['repositories', 'h3LocalExecution', 'audioTtsExecution', 'accountingStatus'];
  if (!value || typeof value !== 'object'
    || REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [value]) || isProxy(value)) unavailable();
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  if ((prototype !== OBJECT_PROTOTYPE && prototype !== null)
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== keys.length) unavailable();
  const input = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) unavailable();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) unavailable();
    input[key] = descriptor.value;
  }
  const repositories = input.repositories;
  return OBJECT_FREEZE({
    sessionStored: captureMethod(ownData(repositories, 'mvpBenchmarkSessions'), 'getStored'),
    authorizationStored: captureMethod(
      ownData(repositories, 'mvpBenchmarkExternalAuthorizations'), 'getStoredBySession',
    ),
    batchStored: captureMethod(
      ownData(repositories, 'mvpBenchmarkExecutionPreflights'),
      'getStoredBatchByAuthorization',
    ),
    workflowAggregate: captureMethod(ownData(repositories, 'runs'), 'getWorkflowWithNodes'),
    exportBySource: captureMethod(
      ownData(repositories, 'mediaExportRuns'), 'getBySourceNodeRun',
    ),
    reviewByAuthorization: captureMethod(
      ownData(repositories, 'mvpBenchmarkHumanAvReviews'), 'getByAuthorization',
    ),
    h3Get: captureMethod(input.h3LocalExecution, 'get'),
    audioGet: captureMethod(input.audioTtsExecution, 'getPersisted'),
    accountingRead: captureMethod(input.accountingStatus, 'read'),
  });
}

function call(binding, args) {
  return REFLECT_APPLY(binding.method, binding.target, args);
}

function isUid(value) {
  return typeof value === 'string' && REFLECT_APPLY(REGEXP_TEST, UUID_V4, [value]);
}

function isSha256(value) {
  return typeof value === 'string' && REFLECT_APPLY(REGEXP_TEST, SHA256, [value]);
}

function plainRecord(value) {
  if (!value || typeof value !== 'object'
    || REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [value]) || isProxy(value)) unavailable();
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) unavailable();
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]);
  const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== 'string' || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) {
      unavailable();
    }
    const descriptor = descriptors[key];
    if (!descriptor.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) unavailable();
    output[key] = descriptor.value;
  }
  return output;
}

function arraySnapshot(value, minimum, maximum) {
  if (!REFLECT_APPLY(ARRAY_IS_ARRAY, Array, [value]) || isProxy(value)
    || REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]) !== ARRAY_PROTOTYPE) unavailable();
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, 'length'])) unavailable();
  const lengthDescriptor = descriptors.length;
  if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [lengthDescriptor, 'value'])) unavailable();
  const length = lengthDescriptor.value;
  if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [length])
    || length < minimum || length > maximum
    || REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== length + 1) unavailable();
  const output = new ARRAY(length);
  for (let index = 0; index < length; index += 1) {
    const key = REFLECT_APPLY(STRING, null, [index]);
    if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) unavailable();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) unavailable();
    output[index] = descriptor.value;
  }
  return output;
}

function validateBatch(value, session, authorization, request) {
  const batch = plainRecord(value);
  if (batch.schemaVersion !== 'mvp-benchmark-execution-preflight-batch.v1'
    || batch.authorizationUid !== authorization.uid || batch.sessionUid !== session.uid
    || batch.dramaUid !== session.dramaUid || batch.batchSha256 !== request.batchSha256
    || !isUid(batch.attestationUid) || !isSha256(batch.batchSha256)) unavailable();
  const reservations = arraySnapshot(batch.reservations, 1, 128);
  if (reservations.length !== session.h3Tasks.length + session.audioIntents.length) unavailable();
  for (let index = 0; index < reservations.length; index += 1) {
    const reservation = plainRecord(reservations[index]);
    const h3 = index < session.h3Tasks.length;
    const item = h3 ? session.h3Tasks[index] : session.audioIntents[index - session.h3Tasks.length];
    if (reservation.itemKind !== (h3 ? 'h3' : 'tts')
      || reservation.itemUid !== (h3 ? item.taskUid : item.intentUid)
      || reservation.requestSha256 !== (h3 ? item.planEvidenceSha256 : item.planSha256)) {
      unavailable();
    }
  }
  return OBJECT_FREEZE({ ...batch, reservations: OBJECT_FREEZE(reservations) });
}

function gate(definition, status, evidenceSha256 = null) {
  return OBJECT_FREEZE({
    id: definition.id,
    status,
    evidenceSha256,
    blockerCode: status === 'complete'
      ? null : (status === 'pending' ? definition.pending : definition.failed),
  });
}

function nodeByUid(aggregate, uid) {
  let found = null;
  for (let index = 0; index < aggregate.nodes.length; index += 1) {
    const node = aggregate.nodes[index];
    if (node.uid !== uid) continue;
    if (found !== null) unavailable();
    found = node;
  }
  if (!found) unavailable();
  return found;
}

function isFailureStatus(status) {
  for (let index = 0; index < TERMINAL_FAILURES.length; index += 1) {
    if (status === TERMINAL_FAILURES[index]) return true;
  }
  return false;
}

function executionGate(config, context) {
  const evidence = [];
  let pending = false;
  let failed = isFailureStatus(context.aggregate.run.status);
  for (let index = 0; index < context.session.h3Tasks.length; index += 1) {
    const item = context.session.h3Tasks[index];
    const node = nodeByUid(context.aggregate, item.nodeRunUid);
    if (node.nodeUid !== item.nodeUid || node.workflowRunUid !== context.session.workflowRunUid) {
      unavailable();
    }
    if (isFailureStatus(node.status)) { failed = true; continue; }
    if (node.status !== 'succeeded') { pending = true; continue; }
    const result = plainRecord(call(config.h3Get, [item.taskUid]));
    if (result.status !== 'succeeded' || result.taskUid !== item.taskUid
      || result.workflowRunUid !== context.session.workflowRunUid
      || result.nodeRunUid !== item.nodeRunUid || result.assetUid !== item.assetUid
      || !isUid(result.assetVersionUid) || !isUid(result.historyUid)) unavailable();
    evidence.push(OBJECT_FREEZE({
      itemKind: 'h3', itemUid: item.taskUid, nodeRunUid: item.nodeRunUid,
      assetUid: item.assetUid, assetVersionUid: result.assetVersionUid,
      historyUid: result.historyUid,
    }));
  }
  for (let index = 0; index < context.session.audioIntents.length; index += 1) {
    const item = context.session.audioIntents[index];
    const node = nodeByUid(context.aggregate, item.nodeRunUid);
    if (node.nodeUid !== item.nodeUid || node.workflowRunUid !== context.session.workflowRunUid) {
      unavailable();
    }
    if (isFailureStatus(node.status)) { failed = true; continue; }
    if (node.status !== 'succeeded') { pending = true; continue; }
    const result = plainRecord(call(config.audioGet, [item.intentUid, context.session.dramaUid]));
    const resultEvidence = plainRecord(result.evidence);
    const executionSha256 = resultEvidence.executionSha256;
    if (result.intentUid !== item.intentUid || result.dramaUid !== context.session.dramaUid
      || result.workflowRunUid !== context.session.workflowRunUid
      || result.nodeRunUid !== item.nodeRunUid || !isSha256(executionSha256)) unavailable();
    evidence.push(OBJECT_FREEZE({
      itemKind: 'tts', itemUid: item.intentUid, nodeRunUid: item.nodeRunUid,
      executionSha256,
    }));
  }
  if (failed) return gate(GATE_DEFINITIONS[0], 'failed');
  if (pending || evidence.length !== context.batch.reservations.length) {
    return gate(GATE_DEFINITIONS[0], 'pending');
  }
  return gate(GATE_DEFINITIONS[0], 'complete', sha256Canonical(evidence));
}

function exportContext(config, context) {
  const definitions = context.aggregate.run.graphSnapshot.snapshot.nodes;
  let definition = null;
  for (let index = 0; index < definitions.length; index += 1) {
    const candidate = definitions[index];
    if (candidate.nodeType !== 'export.final' || candidate.enabled !== true) continue;
    if (definition !== null) unavailable();
    definition = candidate;
  }
  if (!definition || definition.config?.format !== 'mp4'
    || definition.config?.width !== 1920 || definition.config?.height !== 1080
    || definition.config?.fps !== 30) unavailable();
  let node = null;
  for (let index = 0; index < context.aggregate.nodes.length; index += 1) {
    const candidate = context.aggregate.nodes[index];
    if (candidate.nodeUid !== definition.uid) continue;
    if (node !== null) unavailable();
    node = candidate;
  }
  if (!node || node.workflowRunUid !== context.session.workflowRunUid) unavailable();
  if (isFailureStatus(node.status) || isFailureStatus(context.aggregate.run.status)) {
    return OBJECT_FREEZE({ gate: gate(GATE_DEFINITIONS[1], 'failed'), run: null });
  }
  const runValue = call(config.exportBySource, [node.uid]);
  if (runValue === null) {
    return OBJECT_FREEZE({ gate: gate(GATE_DEFINITIONS[1], 'pending'), run: null });
  }
  const run = plainRecord(runValue);
  if (run.dramaUid !== context.session.dramaUid
    || run.workflowRunUid !== context.session.workflowRunUid
    || run.sourceNodeRunUid !== node.uid || !isUid(run.uid)
    || !isSha256(run.executionPlanSha256)) unavailable();
  if (run.status === 'failed' || run.status === 'cancelled') {
    return OBJECT_FREEZE({ gate: gate(GATE_DEFINITIONS[1], 'failed'), run });
  }
  if (run.status !== 'succeeded') {
    if (run.status !== 'queued' && run.status !== 'running') unavailable();
    return OBJECT_FREEZE({ gate: gate(GATE_DEFINITIONS[1], 'pending'), run });
  }
  const output = plainRecord(run.output);
  if (node.status !== 'succeeded' || context.aggregate.run.status !== 'succeeded'
    || run.outputAssetUid !== output.assetUid || run.outputAssetVersionUid !== output.assetVersionUid
    || !isUid(output.assetUid) || !isUid(output.assetVersionUid) || !isSha256(output.sha256)
    || output.mimeType !== 'video/mp4' || output.width !== 1920 || output.height !== 1080
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [output.bytes]) || output.bytes < 1
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [output.durationMs])
    || output.durationMs < 1) unavailable();
  return OBJECT_FREEZE({
    gate: gate(GATE_DEFINITIONS[1], 'complete', sha256Canonical({
      exportRunUid: run.uid,
      executionPlanSha256: run.executionPlanSha256,
      outputAssetUid: output.assetUid,
      outputAssetVersionUid: output.assetVersionUid,
      outputSha256: output.sha256,
      outputBytes: output.bytes,
      outputDurationMs: output.durationMs,
    })),
    run,
  });
}

function humanGate(config, context, exportState) {
  const value = call(config.reviewByAuthorization, [context.authorization.uid]);
  if (value === null) return gate(GATE_DEFINITIONS[2], 'pending');
  if (exportState.gate.status !== 'complete' || !exportState.run) unavailable();
  const review = plainRecord(value);
  const output = plainRecord(exportState.run.output);
  if (review.sessionUid !== context.session.uid
    || review.authorizationUid !== context.authorization.uid
    || review.batchSha256 !== context.batch.batchSha256
    || review.dramaUid !== context.session.dramaUid
    || review.workflowRunUid !== context.session.workflowRunUid
    || review.exportRunUid !== exportState.run.uid
    || review.exportExecutionPlanSha256 !== exportState.run.executionPlanSha256
    || review.outputAssetUid !== output.assetUid
    || review.outputAssetVersionUid !== output.assetVersionUid
    || review.outputSha256 !== output.sha256 || review.outputBytes !== output.bytes
    || review.outputDurationMs !== output.durationMs
    || review.outputWidth !== 1920 || review.outputHeight !== 1080
    || review.videoPlaybackAccepted !== true || review.subtitleSyncAccepted !== true
    || review.bgmBalanceAccepted !== true || !isSha256(review.reviewSha256)) unavailable();
  return gate(GATE_DEFINITIONS[2], 'complete', review.reviewSha256);
}

function accountingGates(config, context) {
  const status = plainRecord(call(config.accountingRead, [{
    dramaUid: context.session.dramaUid,
    sessionUid: context.session.uid,
    authorizationUid: context.authorization.uid,
    batchSha256: context.batch.batchSha256,
  }]));
  if (status.dramaUid !== context.session.dramaUid || status.sessionUid !== context.session.uid
    || status.authorizationUid !== context.authorization.uid
    || status.batchSha256 !== context.batch.batchSha256
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [status.totalCount])
    || status.totalCount !== context.batch.reservations.length
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [status.settledCount])
    || status.settledCount < 0
    || status.settledCount > status.totalCount
    || status.allSettled !== (status.settledCount === status.totalCount)
    || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [status.actualCostCnyFen])
    || status.actualCostCnyFen < 0 || status.actualCostCnyFen > 1_000_000
    || !isSha256(status.obligationSha256)) unavailable();
  const itemValues = arraySnapshot(status.items, status.totalCount, status.totalCount);
  const items = new ARRAY(status.totalCount);
  let settledCount = 0;
  let actualCostCnyFen = 0;
  for (let index = 0; index < itemValues.length; index += 1) {
    const item = plainRecord(itemValues[index]);
    const reservation = plainRecord(context.batch.reservations[index]);
    if (item.ordinal !== index || item.itemKind !== reservation.itemKind
      || item.itemUid !== reservation.itemUid || item.reservationUid !== reservation.uid) {
      unavailable();
    }
    if (item.settlementState === 'pending') {
      if (item.settlementUid !== null || item.settlementSha256 !== null
        || item.actualCostCnyFen !== null) unavailable();
    } else if (item.settlementState === 'settled') {
      if (!isUid(item.settlementUid) || !isSha256(item.settlementSha256)
        || !REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [item.actualCostCnyFen])
        || item.actualCostCnyFen < 0 || item.actualCostCnyFen > 1_000_000) unavailable();
      settledCount += 1;
      actualCostCnyFen += item.actualCostCnyFen;
      if (!REFLECT_APPLY(NUMBER_IS_SAFE_INTEGER, Number, [actualCostCnyFen])
        || actualCostCnyFen > 1_000_000) unavailable();
    } else {
      unavailable();
    }
    items[index] = OBJECT_FREEZE({
      ordinal: index,
      itemKind: item.itemKind,
      itemUid: item.itemUid,
      reservationUid: item.reservationUid,
      settlementState: item.settlementState,
      settlementUid: item.settlementUid,
      settlementSha256: item.settlementSha256,
      actualCostCnyFen: item.actualCostCnyFen,
    });
  }
  if (settledCount !== status.settledCount || actualCostCnyFen !== status.actualCostCnyFen) {
    unavailable();
  }
  OBJECT_FREEZE(items);
  const settlement = status.allSettled
    ? gate(GATE_DEFINITIONS[3], 'complete', sha256Canonical({
      batchSha256: status.batchSha256,
      totalCount: status.totalCount,
      settledCount: status.settledCount,
      actualCostCnyFen: status.actualCostCnyFen,
      items,
    }))
    : gate(GATE_DEFINITIONS[3], 'pending');
  let release;
  if (status.releaseState === 'released' && isSha256(status.receiptSha256)) {
    release = gate(GATE_DEFINITIONS[4], 'complete', status.receiptSha256);
  } else if (status.releaseState === 'required' && status.receiptSha256 === null) {
    release = gate(GATE_DEFINITIONS[4], 'pending');
  } else {
    unavailable();
  }
  return OBJECT_FREEZE({ settlement, release });
}

function createMvpBenchmarkCloseoutStatusService(value) {
  const config = exactConfiguration(value);
  return OBJECT_FREEZE({
    read(valueToRead) {
      const request = parseMvpBenchmarkCloseoutStatusRequest(valueToRead);
      try {
        const session = parseMvpBenchmarkSessionPlan(call(config.sessionStored, [request.sessionUid]));
        const authorization = parseMvpBenchmarkExternalAuthorization(
          call(config.authorizationStored, [request.sessionUid]),
        );
        if (session.uid !== request.sessionUid || session.dramaUid !== request.dramaUid
          || authorization.uid !== request.authorizationUid
          || authorization.sessionUid !== session.uid || authorization.dramaUid !== session.dramaUid
          || authorization.sessionPlanSha256 !== session.planSha256) unavailable();
        const batch = validateBatch(
          call(config.batchStored, [authorization.uid]), session, authorization, request,
        );
        const aggregate = validateRunAggregate(call(
          config.workflowAggregate, [session.workflowRunUid],
        ));
        if (aggregate.run.uid !== session.workflowRunUid
          || aggregate.run.workflowUid !== session.workflowUid
          || aggregate.run.graphHash !== session.graphHash
          || aggregate.run.graphRevision !== session.graphRevision) unavailable();
        const context = OBJECT_FREEZE({ session, authorization, batch, aggregate });
        const execution = executionGate(config, context);
        const exported = exportContext(config, context);
        const human = humanGate(config, context, exported);
        const accounting = accountingGates(config, context);
        const gates = OBJECT_FREEZE([
          execution, exported.gate, human, accounting.settlement, accounting.release,
        ]);
        let completedGateCount = 0;
        const remainingMvpEvidenceIds = [];
        for (let index = 0; index < gates.length; index += 1) {
          if (gates[index].status === 'complete') completedGateCount += 1;
          else remainingMvpEvidenceIds.push(gates[index].id);
        }
        for (let index = 0; index < GLOBAL_EVIDENCE_IDS.length; index += 1) {
          remainingMvpEvidenceIds.push(GLOBAL_EVIDENCE_IDS[index]);
        }
        return createMvpBenchmarkCloseoutStatus({
          schemaVersion: SCHEMA_VERSION,
          dramaUid: session.dramaUid,
          sessionUid: session.uid,
          authorizationUid: authorization.uid,
          batchSha256: batch.batchSha256,
          benchmarkEvidenceComplete: completedGateCount === gates.length,
          mvpComplete: false,
          completedGateCount,
          totalGateCount: gates.length,
          gates,
          remainingMvpEvidenceIds,
        });
      } catch (error) {
        if (isMvpBenchmarkCloseoutStatusError(error)) throw error;
        return unavailable();
      }
    },
  });
}

module.exports = OBJECT_FREEZE({ createMvpBenchmarkCloseoutStatusService });
