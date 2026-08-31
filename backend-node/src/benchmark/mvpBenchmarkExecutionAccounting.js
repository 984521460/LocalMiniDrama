'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  parseMvpBenchmarkExecutionReservation,
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('./mvpBenchmarkExecutionPreflight');
const {
  parseMvpBenchmarkExternalAuthorization,
} = require('./mvpBenchmarkExternalAuthorization');

const SETTLEMENT_SCHEMA_VERSION = 'mvp-benchmark-execution-settlement.v1';
const RELEASE_OBLIGATION_SCHEMA_VERSION = 'mvp-benchmark-resource-release-obligation.v1';
const RELEASE_RECEIPT_SCHEMA_VERSION = 'mvp-benchmark-resource-release-receipt.v1';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

class MvpBenchmarkExecutionAccountingError extends Error {
  constructor(code) {
    const messages = Object.freeze({
      MVP_BENCHMARK_EXECUTION_ACCOUNTING_INPUT_INVALID: 'MVP benchmark execution accounting input is invalid',
      MVP_BENCHMARK_EXECUTION_ACCOUNTING_DATA_INVALID: 'MVP benchmark execution accounting data is invalid',
      MVP_BENCHMARK_EXECUTION_ACCOUNTING_UNAVAILABLE: 'MVP benchmark execution accounting is unavailable',
      MVP_BENCHMARK_RESOURCE_RELEASE_REQUIRED: 'MVP benchmark compute resource release is still required',
    });
    super(messages[code] ?? messages.MVP_BENCHMARK_EXECUTION_ACCOUNTING_INPUT_INVALID);
    this.name = 'MvpBenchmarkExecutionAccountingError';
    this.code = code;
    Object.freeze(this);
  }
}

function fail(code) {
  throw new MvpBenchmarkExecutionAccountingError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail(code);
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(code);
  }
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) fail(code);
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
    output[keys[index]] = descriptor.value;
  }
  return output;
}

function uid(value, code) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(code);
  return value;
}

function sha256(value, code) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function integer(value, minimum, maximum, code) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function digest(value) {
  return createHash('sha256')
    .update(serializeMvpBenchmarkExecutionPreflightJson(value), 'utf8')
    .digest('hex');
}

function terminalOutcome(value) {
  return value === 'succeeded' || value === 'failed' || value === 'cancelled';
}

function nullableString(value, code) {
  if (value !== null && typeof value !== 'string') fail(code);
  return value;
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  try {
    if (new Date(value).toISOString() !== value) fail(code);
  } catch {
    fail(code);
  }
  return value;
}

function mvpBenchmarkH3TerminalEvidenceSha256(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_DATA_INVALID') {
  const input = exactObject(value, [
    'uid', 'connectionEvidenceSha256', 'requestSha256', 'stage', 'status', 'promptId',
    'outputAssetVersionUid', 'errorCode', 'errorPhase', 'errorRetryable', 'recoveryState',
    'stateVersion', 'completedAt',
  ], code);
  if (input.errorRetryable !== null
    && input.errorRetryable !== false && input.errorRetryable !== true
    && input.errorRetryable !== 0 && input.errorRetryable !== 1) fail(code);
  const errorRetryable = input.errorRetryable === null ? null : Boolean(input.errorRetryable);
  if (!terminalOutcome(input.status)
    || (input.status === 'succeeded' && input.stage !== 'completed')
    || (input.status === 'failed'
      && (input.stage !== 'failed' || input.recoveryState !== 'orphaned'
        || errorRetryable !== false))
    || (input.status === 'cancelled' && input.stage !== 'cancelled')
    || (input.status !== 'failed' && errorRetryable !== null)) fail(code);
  return digest(Object.freeze({
    schemaVersion: 'mvp-benchmark-h3-terminal-evidence.v1',
    uid: uid(input.uid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    requestSha256: sha256(input.requestSha256, code),
    stage: input.stage,
    status: input.status,
    promptId: nullableString(input.promptId, code),
    outputAssetVersionUid: input.outputAssetVersionUid === null
      ? null : uid(input.outputAssetVersionUid, code),
    errorCode: nullableString(input.errorCode, code),
    errorPhase: nullableString(input.errorPhase, code),
    errorRetryable: errorRetryable === null ? null : Number(errorRetryable),
    recoveryState: nullableString(input.recoveryState, code),
    stateVersion: integer(input.stateVersion, 0, 2_147_483_647, code),
    completedAt: canonicalTimestamp(input.completedAt, code),
  }));
}

const SETTLEMENT_KEYS = Object.freeze([
  'schemaVersion', 'uid', 'reservationUid', 'authorizationUid', 'sessionUid', 'dramaUid',
  'itemKind', 'itemUid', 'requestSha256', 'outcome', 'terminalEvidenceSha256',
  'estimatedCostCnyFen', 'actualCostCnyFen', 'billingEvidenceSha256', 'settledAtEpochMs',
  'settlementSha256',
]);

function settlementBase(value, code) {
  const input = exactObject(value, SETTLEMENT_KEYS, code);
  if (input.schemaVersion !== SETTLEMENT_SCHEMA_VERSION
    || (input.itemKind !== 'h3' && input.itemKind !== 'tts')
    || !terminalOutcome(input.outcome)
    || (input.itemKind === 'tts' && input.outcome !== 'succeeded')) fail(code);
  const estimatedCostCnyFen = integer(input.estimatedCostCnyFen, 0, 1_000_000, code);
  const actualCostCnyFen = integer(input.actualCostCnyFen, 0, estimatedCostCnyFen, code);
  return Object.freeze({
    schemaVersion: SETTLEMENT_SCHEMA_VERSION,
    uid: uid(input.uid, code),
    reservationUid: uid(input.reservationUid, code),
    authorizationUid: uid(input.authorizationUid, code),
    sessionUid: uid(input.sessionUid, code),
    dramaUid: uid(input.dramaUid, code),
    itemKind: input.itemKind,
    itemUid: uid(input.itemUid, code),
    requestSha256: sha256(input.requestSha256, code),
    outcome: input.outcome,
    terminalEvidenceSha256: sha256(input.terminalEvidenceSha256, code),
    estimatedCostCnyFen,
    actualCostCnyFen,
    billingEvidenceSha256: sha256(input.billingEvidenceSha256, code),
    settledAtEpochMs: integer(input.settledAtEpochMs, 0, 253402300799999, code),
    settlementSha256: sha256(input.settlementSha256, code),
  });
}

function createMvpBenchmarkExecutionSettlement(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_INPUT_INVALID') {
  const input = exactObject(value, [
    'uid', 'reservation', 'outcome', 'terminalEvidenceSha256', 'actualCostCnyFen',
    'billingEvidenceSha256', 'settledAtEpochMs',
  ], code);
  const reservation = parseMvpBenchmarkExecutionReservation(input.reservation, code);
  const settledAtEpochMs = integer(input.settledAtEpochMs, 0, 253402300799999, code);
  if (settledAtEpochMs < reservation.reservedAtEpochMs) fail(code);
  const placeholder = settlementBase({
    schemaVersion: SETTLEMENT_SCHEMA_VERSION,
    uid: input.uid,
    reservationUid: reservation.uid,
    authorizationUid: reservation.authorizationUid,
    sessionUid: reservation.sessionUid,
    dramaUid: reservation.dramaUid,
    itemKind: reservation.itemKind,
    itemUid: reservation.itemUid,
    requestSha256: reservation.requestSha256,
    outcome: input.outcome,
    terminalEvidenceSha256: input.terminalEvidenceSha256,
    estimatedCostCnyFen: reservation.estimatedCostCnyFen,
    actualCostCnyFen: input.actualCostCnyFen,
    billingEvidenceSha256: input.billingEvidenceSha256,
    settledAtEpochMs,
    settlementSha256: '0'.repeat(64),
  }, code);
  return Object.freeze({ ...placeholder, settlementSha256: digest(placeholder) });
}

function parseMvpBenchmarkExecutionSettlement(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_DATA_INVALID') {
  const parsed = settlementBase(value, code);
  if (digest({ ...parsed, settlementSha256: '0'.repeat(64) }) !== parsed.settlementSha256) fail(code);
  return parsed;
}

const OBLIGATION_KEYS = Object.freeze([
  'schemaVersion', 'authorizationUid', 'sessionUid', 'dramaUid', 'connectionUid',
  'connectionEvidenceSha256', 'authorizationSha256', 'firstAttestationUid',
  'attestationSha256', 'requiredAtEpochMs', 'expiresAtEpochMs', 'obligationSha256',
]);

function createMvpBenchmarkResourceReleaseObligation(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_INPUT_INVALID') {
  const input = exactObject(value, ['authorization', 'attestation'], code);
  const authorization = parseMvpBenchmarkExternalAuthorization(input.authorization, code);
  const attestation = input.attestation;
  const attestationInput = exactObject(attestation, [
    'uid', 'authorizationUid', 'sessionUid', 'dramaUid', 'connectionUid',
    'connectionEvidenceSha256', 'attestedAtEpochMs', 'attestationSha256',
  ], code);
  if (attestationInput.authorizationUid !== authorization.uid
    || attestationInput.sessionUid !== authorization.sessionUid
    || attestationInput.dramaUid !== authorization.dramaUid
    || attestationInput.connectionUid !== authorization.connectionUid
    || attestationInput.connectionEvidenceSha256 !== authorization.connectionEvidenceSha256) fail(code);
  const base = Object.freeze({
    schemaVersion: RELEASE_OBLIGATION_SCHEMA_VERSION,
    authorizationUid: authorization.uid,
    sessionUid: authorization.sessionUid,
    dramaUid: authorization.dramaUid,
    connectionUid: authorization.connectionUid,
    connectionEvidenceSha256: authorization.connectionEvidenceSha256,
    authorizationSha256: authorization.authorizationSha256,
    firstAttestationUid: uid(attestationInput.uid, code),
    attestationSha256: sha256(attestationInput.attestationSha256, code),
    requiredAtEpochMs: integer(attestationInput.attestedAtEpochMs, 0, 253402300799999, code),
    expiresAtEpochMs: authorization.expiresAtEpochMs,
    obligationSha256: '0'.repeat(64),
  });
  if (base.requiredAtEpochMs < authorization.authorizedAtEpochMs
    || base.requiredAtEpochMs >= base.expiresAtEpochMs) fail(code);
  return Object.freeze({ ...base, obligationSha256: digest(base) });
}

function parseMvpBenchmarkResourceReleaseObligation(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_DATA_INVALID') {
  const input = exactObject(value, OBLIGATION_KEYS, code);
  if (input.schemaVersion !== RELEASE_OBLIGATION_SCHEMA_VERSION) fail(code);
  const parsed = Object.freeze({
    schemaVersion: RELEASE_OBLIGATION_SCHEMA_VERSION,
    authorizationUid: uid(input.authorizationUid, code),
    sessionUid: uid(input.sessionUid, code),
    dramaUid: uid(input.dramaUid, code),
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    authorizationSha256: sha256(input.authorizationSha256, code),
    firstAttestationUid: uid(input.firstAttestationUid, code),
    attestationSha256: sha256(input.attestationSha256, code),
    requiredAtEpochMs: integer(input.requiredAtEpochMs, 0, 253402300799999, code),
    expiresAtEpochMs: integer(input.expiresAtEpochMs, 0, 253402300799999, code),
    obligationSha256: sha256(input.obligationSha256, code),
  });
  if (parsed.requiredAtEpochMs >= parsed.expiresAtEpochMs
    || digest({ ...parsed, obligationSha256: '0'.repeat(64) }) !== parsed.obligationSha256) fail(code);
  return parsed;
}

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'authorizationUid', 'connectionUid', 'connectionEvidenceSha256',
  'obligationSha256', 'releaseEvidenceSha256', 'releasedAtEpochMs', 'receiptSha256',
]);

function createMvpBenchmarkResourceReleaseReceipt(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_INPUT_INVALID') {
  const input = exactObject(value, ['obligation', 'releaseEvidenceSha256', 'releasedAtEpochMs'], code);
  const obligation = parseMvpBenchmarkResourceReleaseObligation(input.obligation, code);
  const releasedAtEpochMs = integer(input.releasedAtEpochMs, 0, 253402300799999, code);
  if (releasedAtEpochMs < obligation.requiredAtEpochMs) fail(code);
  const base = Object.freeze({
    schemaVersion: RELEASE_RECEIPT_SCHEMA_VERSION,
    authorizationUid: obligation.authorizationUid,
    connectionUid: obligation.connectionUid,
    connectionEvidenceSha256: obligation.connectionEvidenceSha256,
    obligationSha256: obligation.obligationSha256,
    releaseEvidenceSha256: sha256(input.releaseEvidenceSha256, code),
    releasedAtEpochMs,
    receiptSha256: '0'.repeat(64),
  });
  return Object.freeze({ ...base, receiptSha256: digest(base) });
}

function parseMvpBenchmarkResourceReleaseReceipt(value, code = 'MVP_BENCHMARK_EXECUTION_ACCOUNTING_DATA_INVALID') {
  const input = exactObject(value, RECEIPT_KEYS, code);
  if (input.schemaVersion !== RELEASE_RECEIPT_SCHEMA_VERSION) fail(code);
  const parsed = Object.freeze({
    schemaVersion: RELEASE_RECEIPT_SCHEMA_VERSION,
    authorizationUid: uid(input.authorizationUid, code),
    connectionUid: uid(input.connectionUid, code),
    connectionEvidenceSha256: sha256(input.connectionEvidenceSha256, code),
    obligationSha256: sha256(input.obligationSha256, code),
    releaseEvidenceSha256: sha256(input.releaseEvidenceSha256, code),
    releasedAtEpochMs: integer(input.releasedAtEpochMs, 0, 253402300799999, code),
    receiptSha256: sha256(input.receiptSha256, code),
  });
  if (digest({ ...parsed, receiptSha256: '0'.repeat(64) }) !== parsed.receiptSha256) fail(code);
  return parsed;
}

function isMvpBenchmarkExecutionAccountingError(error) {
  return error instanceof MvpBenchmarkExecutionAccountingError;
}

module.exports = Object.freeze({
  MvpBenchmarkExecutionAccountingError,
  RELEASE_OBLIGATION_SCHEMA_VERSION,
  RELEASE_RECEIPT_SCHEMA_VERSION,
  SETTLEMENT_SCHEMA_VERSION,
  createMvpBenchmarkExecutionSettlement,
  createMvpBenchmarkResourceReleaseObligation,
  createMvpBenchmarkResourceReleaseReceipt,
  isMvpBenchmarkExecutionAccountingError,
  mvpBenchmarkH3TerminalEvidenceSha256,
  parseMvpBenchmarkExecutionSettlement,
  parseMvpBenchmarkResourceReleaseObligation,
  parseMvpBenchmarkResourceReleaseReceipt,
});
