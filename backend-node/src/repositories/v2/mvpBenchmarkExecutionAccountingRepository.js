'use strict';

const { types: { isProxy } } = require('node:util');

const {
  createMvpBenchmarkExecutionSettlement,
  createMvpBenchmarkResourceReleaseObligation,
  createMvpBenchmarkResourceReleaseReceipt,
  mvpBenchmarkH3TerminalEvidenceSha256,
  parseMvpBenchmarkExecutionSettlement,
  parseMvpBenchmarkResourceReleaseObligation,
  parseMvpBenchmarkResourceReleaseReceipt,
} = require('../../benchmark/mvpBenchmarkExecutionAccounting');
const {
  parseMvpBenchmarkExecutionReservation,
  parseMvpBenchmarkLiveEnvironmentAttestation,
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('../../benchmark/mvpBenchmarkExecutionPreflight');
const {
  parseMvpBenchmarkExternalAuthorization,
  serializeMvpBenchmarkExternalAuthorizationJson,
} = require('../../benchmark/mvpBenchmarkExternalAuthorization');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'MVP benchmark execution accounting';
const JSON_PARSE = JSON.parse;
const MAX_OPEN_OBLIGATIONS = 10_000;

function invalidData() {
  throw new V2RepositoryDataError(ENTITY, 'persisted record');
}

function exactRequest(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) {
      throw new TypeError('invalid');
    }
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if ((prototype !== Object.prototype && prototype !== null)
      || Reflect.ownKeys(descriptors).length !== keys.length) throw new TypeError('invalid');
    const output = Object.create(null);
    for (let index = 0; index < keys.length; index += 1) {
      const descriptor = descriptors[keys[index]];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('invalid');
      }
      output[keys[index]] = descriptor.value;
    }
    return output;
  } catch {
    throw new TypeError('MVP benchmark execution accounting repository input is invalid');
  }
}

function parseJson(value) {
  return Reflect.apply(JSON_PARSE, JSON, [value]);
}

function createMvpBenchmarkExecutionAccountingRepository(database) {
  const statements = Object.freeze({
    reservation: database.prepare(`
      SELECT reservation.*,seal.reservation_sha256 AS sealed_reservation_sha256,
             authorization.authorization_json,authorization.authorization_sha256,
             attestation.attestation_json,attestation.attestation_sha256,
             attestation_seal.attestation_sha256 AS sealed_attestation_sha256
      FROM mvp_benchmark_execution_reservations AS reservation
      LEFT JOIN mvp_benchmark_execution_reservation_seals AS seal
        ON seal.reservation_uid=reservation.uid
      LEFT JOIN mvp_benchmark_external_authorizations AS authorization
        ON authorization.uid=reservation.authorization_uid
      LEFT JOIN mvp_benchmark_live_environment_attestations AS attestation
        ON attestation.uid=reservation.attestation_uid
      LEFT JOIN mvp_benchmark_live_environment_attestation_seals AS attestation_seal
        ON attestation_seal.attestation_uid=attestation.uid
      WHERE reservation.uid=?
    `),
    h3Terminal: database.prepare(`
      SELECT uid,connection_evidence_sha256,request_sha256,stage,status,prompt_id,
             output_asset_version_uid,error_code,error_phase,recovery_state,state_version,
             error_retryable,completed_at
      FROM remote_tasks WHERE uid=? AND contract_version='remote-task.v1'
    `),
    ttsTerminal: database.prepare(`
      SELECT execution_sha256,created_at_epoch_ms
      FROM audio_tts_execution_evidence WHERE intent_uid=?
    `),
    settlement: database.prepare(`
      SELECT settlement.*,seal.settlement_sha256 AS sealed_settlement_sha256
      FROM mvp_benchmark_execution_settlements AS settlement
      LEFT JOIN mvp_benchmark_execution_settlement_seals AS seal
        ON seal.settlement_uid=settlement.uid
      WHERE settlement.uid=?
    `),
    settlementByReservation: database.prepare(`
      SELECT settlement.*,seal.settlement_sha256 AS sealed_settlement_sha256
      FROM mvp_benchmark_execution_settlements AS settlement
      LEFT JOIN mvp_benchmark_execution_settlement_seals AS seal
        ON seal.settlement_uid=settlement.uid
      WHERE settlement.reservation_uid=?
    `),
    settlementsByAuthorization: database.prepare(`
      SELECT settlement.*,seal.settlement_sha256 AS sealed_settlement_sha256
      FROM mvp_benchmark_execution_settlements AS settlement
      LEFT JOIN mvp_benchmark_execution_settlement_seals AS seal
        ON seal.settlement_uid=settlement.uid
      WHERE settlement.authorization_uid=? ORDER BY settlement.uid
    `),
    insertSettlement: database.prepare(`
      INSERT INTO mvp_benchmark_execution_settlements
        (uid,reservation_uid,authorization_uid,session_uid,drama_uid,item_kind,item_uid,
         request_sha256,outcome,terminal_evidence_sha256,estimated_cost_cny_fen,
         actual_cost_cny_fen,billing_evidence_sha256,settled_at_epoch_ms,
         settlement_json,settlement_sha256)
      VALUES
        (@uid,@reservationUid,@authorizationUid,@sessionUid,@dramaUid,@itemKind,@itemUid,
         @requestSha256,@outcome,@terminalEvidenceSha256,@estimatedCostCnyFen,
         @actualCostCnyFen,@billingEvidenceSha256,@settledAtEpochMs,
         @settlementJson,@settlementSha256)
    `),
    obligation: database.prepare(`
      SELECT obligation.*,seal.obligation_sha256 AS sealed_obligation_sha256,
             authorization.authorization_json,attestation.attestation_json
      FROM mvp_benchmark_resource_release_obligations AS obligation
      LEFT JOIN mvp_benchmark_resource_release_obligation_seals AS seal
        ON seal.authorization_uid=obligation.authorization_uid
      LEFT JOIN mvp_benchmark_external_authorizations AS authorization
        ON authorization.uid=obligation.authorization_uid
      LEFT JOIN mvp_benchmark_live_environment_attestations AS attestation
        ON attestation.uid=obligation.first_attestation_uid
      WHERE obligation.authorization_uid=?
    `),
    receipt: database.prepare(`
      SELECT receipt.*,seal.receipt_sha256 AS sealed_receipt_sha256
      FROM mvp_benchmark_resource_release_receipts AS receipt
      LEFT JOIN mvp_benchmark_resource_release_receipt_seals AS seal
        ON seal.authorization_uid=receipt.authorization_uid
      WHERE receipt.authorization_uid=?
    `),
    openObligations: database.prepare(`
      SELECT obligation.authorization_uid
      FROM mvp_benchmark_resource_release_obligations AS obligation
      LEFT JOIN mvp_benchmark_resource_release_receipts AS receipt
        ON receipt.authorization_uid=obligation.authorization_uid
      WHERE receipt.authorization_uid IS NULL
      ORDER BY obligation.required_at_epoch_ms,obligation.authorization_uid
      LIMIT ?
    `).pluck(),
    openCount: database.prepare(`
      SELECT count(*) FROM mvp_benchmark_resource_release_obligations AS obligation
      LEFT JOIN mvp_benchmark_resource_release_receipts AS receipt
        ON receipt.authorization_uid=obligation.authorization_uid
      WHERE receipt.authorization_uid IS NULL
    `).pluck(),
    insertReceipt: database.prepare(`
      INSERT INTO mvp_benchmark_resource_release_receipts
        (authorization_uid,connection_uid,connection_evidence_sha256,obligation_sha256,
         release_evidence_sha256,released_at_epoch_ms,receipt_json,receipt_sha256)
      VALUES
        (@authorizationUid,@connectionUid,@connectionEvidenceSha256,@obligationSha256,
         @releaseEvidenceSha256,@releasedAtEpochMs,@receiptJson,@receiptSha256)
    `),
  });

  function reservationSnapshot(uid) {
    const row = statements.reservation.get(uid);
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const reservation = parseMvpBenchmarkExecutionReservation(parseJson(row.reservation_json));
      const authorization = parseMvpBenchmarkExternalAuthorization(parseJson(row.authorization_json));
      const attestation = parseMvpBenchmarkLiveEnvironmentAttestation(parseJson(row.attestation_json));
      if (serializeMvpBenchmarkExecutionPreflightJson(reservation) !== row.reservation_json
        || row.uid !== reservation.uid || row.reservation_sha256 !== reservation.reservationSha256
        || row.sealed_reservation_sha256 !== reservation.reservationSha256
        || row.authorization_uid !== reservation.authorizationUid
        || row.attestation_uid !== reservation.attestationUid
        || row.session_uid !== reservation.sessionUid || row.drama_uid !== reservation.dramaUid
        || row.item_kind !== reservation.itemKind || row.item_uid !== reservation.itemUid
        || row.request_sha256 !== reservation.requestSha256
        || row.estimated_cost_cny_fen !== reservation.estimatedCostCnyFen
        || authorization.uid !== reservation.authorizationUid
        || authorization.authorizationSha256 !== row.authorization_sha256
        || serializeMvpBenchmarkExternalAuthorizationJson(authorization) !== row.authorization_json
        || authorization.sessionUid !== reservation.sessionUid
        || authorization.dramaUid !== reservation.dramaUid
        || attestation.uid !== reservation.attestationUid
        || attestation.attestationSha256 !== row.attestation_sha256
        || row.sealed_attestation_sha256 !== attestation.attestationSha256
        || serializeMvpBenchmarkExecutionPreflightJson(attestation) !== row.attestation_json
        || attestation.authorizationUid !== authorization.uid
        || attestation.sessionUid !== reservation.sessionUid
        || attestation.dramaUid !== reservation.dramaUid
        || attestation.connectionUid !== authorization.connectionUid
        || attestation.connectionEvidenceSha256 !== authorization.connectionEvidenceSha256) invalidData();
      return reservation;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function terminalEvidence(reservation) {
    try {
      if (reservation.itemKind === 'tts') {
        const evidence = statements.ttsTerminal.get(reservation.itemUid);
        if (!evidence || typeof evidence.execution_sha256 !== 'string'
          || !/^[0-9a-f]{64}$/u.test(evidence.execution_sha256)
          || !Number.isSafeInteger(evidence.created_at_epoch_ms)
          || evidence.created_at_epoch_ms < 0
          || evidence.created_at_epoch_ms > 253402300799999) invalidData();
        return Object.freeze({
          outcome: 'succeeded',
          terminalEvidenceSha256: evidence.execution_sha256,
          completedAtEpochMs: evidence.created_at_epoch_ms,
        });
      }
      const row = statements.h3Terminal.get(reservation.itemUid);
      if (!row) invalidData();
      const terminalEvidenceSha256 = mvpBenchmarkH3TerminalEvidenceSha256({
        uid: row.uid,
        connectionEvidenceSha256: row.connection_evidence_sha256,
        requestSha256: row.request_sha256,
        stage: row.stage,
        status: row.status,
        promptId: row.prompt_id,
        outputAssetVersionUid: row.output_asset_version_uid,
        errorCode: row.error_code,
        errorPhase: row.error_phase,
        errorRetryable: row.error_retryable,
        recoveryState: row.recovery_state,
        stateVersion: row.state_version,
        completedAt: row.completed_at,
      });
      const completedAtEpochMs = Date.parse(row.completed_at);
      if (!Number.isSafeInteger(completedAtEpochMs)
        || completedAtEpochMs < 0 || completedAtEpochMs > 253402300799999) invalidData();
      return Object.freeze({ outcome: row.status, terminalEvidenceSha256, completedAtEpochMs });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function mapSettlement(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const settlement = parseMvpBenchmarkExecutionSettlement(parseJson(row.settlement_json));
      const reservation = reservationSnapshot(settlement.reservationUid);
      const terminal = terminalEvidence(reservation);
      if (row.uid !== settlement.uid || row.reservation_uid !== settlement.reservationUid
        || row.authorization_uid !== settlement.authorizationUid
        || row.session_uid !== settlement.sessionUid || row.drama_uid !== settlement.dramaUid
        || row.item_kind !== settlement.itemKind || row.item_uid !== settlement.itemUid
        || row.request_sha256 !== settlement.requestSha256 || row.outcome !== settlement.outcome
        || row.terminal_evidence_sha256 !== settlement.terminalEvidenceSha256
        || row.estimated_cost_cny_fen !== settlement.estimatedCostCnyFen
        || row.actual_cost_cny_fen !== settlement.actualCostCnyFen
        || row.billing_evidence_sha256 !== settlement.billingEvidenceSha256
        || row.settled_at_epoch_ms !== settlement.settledAtEpochMs
        || row.settlement_sha256 !== settlement.settlementSha256
        || row.sealed_settlement_sha256 !== settlement.settlementSha256
        || serializeMvpBenchmarkExecutionPreflightJson(settlement) !== row.settlement_json
        || settlement.authorizationUid !== reservation.authorizationUid
        || settlement.sessionUid !== reservation.sessionUid
        || settlement.dramaUid !== reservation.dramaUid
        || settlement.itemKind !== reservation.itemKind
        || settlement.itemUid !== reservation.itemUid
        || settlement.requestSha256 !== reservation.requestSha256
        || settlement.estimatedCostCnyFen !== reservation.estimatedCostCnyFen
        || settlement.outcome !== terminal.outcome
        || settlement.terminalEvidenceSha256 !== terminal.terminalEvidenceSha256
        || settlement.settledAtEpochMs < terminal.completedAtEpochMs) invalidData();
      return settlement;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function mapObligation(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const obligation = parseMvpBenchmarkResourceReleaseObligation(parseJson(row.obligation_json));
      const authorization = parseMvpBenchmarkExternalAuthorization(parseJson(row.authorization_json));
      const attestation = parseMvpBenchmarkLiveEnvironmentAttestation(parseJson(row.attestation_json));
      const expected = createMvpBenchmarkResourceReleaseObligation({
        authorization,
        attestation: {
          uid: attestation.uid,
          authorizationUid: attestation.authorizationUid,
          sessionUid: attestation.sessionUid,
          dramaUid: attestation.dramaUid,
          connectionUid: attestation.connectionUid,
          connectionEvidenceSha256: attestation.connectionEvidenceSha256,
          attestedAtEpochMs: attestation.attestedAtEpochMs,
          attestationSha256: attestation.attestationSha256,
        },
      });
      if (row.authorization_uid !== obligation.authorizationUid
        || row.session_uid !== obligation.sessionUid || row.drama_uid !== obligation.dramaUid
        || row.connection_uid !== obligation.connectionUid
        || row.connection_evidence_sha256 !== obligation.connectionEvidenceSha256
        || row.authorization_sha256 !== obligation.authorizationSha256
        || row.first_attestation_uid !== obligation.firstAttestationUid
        || row.attestation_sha256 !== obligation.attestationSha256
        || row.required_at_epoch_ms !== obligation.requiredAtEpochMs
        || row.expires_at_epoch_ms !== obligation.expiresAtEpochMs
        || row.obligation_sha256 !== obligation.obligationSha256
        || row.sealed_obligation_sha256 !== obligation.obligationSha256
        || serializeMvpBenchmarkExecutionPreflightJson(obligation) !== row.obligation_json
        || expected.obligationSha256 !== obligation.obligationSha256) invalidData();
      return obligation;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function mapReceipt(row, obligation) {
    if (!row) return null;
    try {
      const receipt = parseMvpBenchmarkResourceReleaseReceipt(parseJson(row.receipt_json));
      const expected = createMvpBenchmarkResourceReleaseReceipt({
        obligation,
        releaseEvidenceSha256: receipt.releaseEvidenceSha256,
        releasedAtEpochMs: receipt.releasedAtEpochMs,
      });
      if (row.authorization_uid !== receipt.authorizationUid
        || row.connection_uid !== receipt.connectionUid
        || row.connection_evidence_sha256 !== receipt.connectionEvidenceSha256
        || row.obligation_sha256 !== receipt.obligationSha256
        || row.release_evidence_sha256 !== receipt.releaseEvidenceSha256
        || row.released_at_epoch_ms !== receipt.releasedAtEpochMs
        || row.receipt_sha256 !== receipt.receiptSha256
        || row.sealed_receipt_sha256 !== receipt.receiptSha256
        || serializeMvpBenchmarkExecutionPreflightJson(receipt) !== row.receipt_json
        || expected.receiptSha256 !== receipt.receiptSha256) invalidData();
      return receipt;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  const insertSettlement = database.transaction((input, nowEpochMs) => {
    const reservation = reservationSnapshot(input.reservationUid);
    const terminal = terminalEvidence(reservation);
    if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < terminal.completedAtEpochMs) {
      throw new TypeError('MVP benchmark settlement time is invalid');
    }
    const settlement = createMvpBenchmarkExecutionSettlement({
      uid: input.uid,
      reservation,
      outcome: terminal.outcome,
      terminalEvidenceSha256: terminal.terminalEvidenceSha256,
      actualCostCnyFen: input.actualCostCnyFen,
      billingEvidenceSha256: input.billingEvidenceSha256,
      settledAtEpochMs: nowEpochMs,
    });
    statements.insertSettlement.run({
      ...settlement,
      settlementJson: serializeMvpBenchmarkExecutionPreflightJson(settlement),
    });
    return mapSettlement(statements.settlement.get(settlement.uid));
  });

  const insertReceipt = database.transaction((input, nowEpochMs) => {
    const obligation = mapObligation(statements.obligation.get(input.authorizationUid));
    const receipt = createMvpBenchmarkResourceReleaseReceipt({
      obligation,
      releaseEvidenceSha256: input.releaseEvidenceSha256,
      releasedAtEpochMs: nowEpochMs,
    });
    statements.insertReceipt.run({
      ...receipt,
      receiptJson: serializeMvpBenchmarkExecutionPreflightJson(receipt),
    });
    return mapReceipt(statements.receipt.get(input.authorizationUid), obligation);
  });

  const listOpenReleaseObligations = () => {
    const count = statements.openCount.get();
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_OPEN_OBLIGATIONS) invalidData();
    const uids = statements.openObligations.all(MAX_OPEN_OBLIGATIONS);
    if (uids.length !== count) invalidData();
    const output = new Array(count);
    for (let index = 0; index < count; index += 1) {
      output[index] = mapObligation(statements.obligation.get(uids[index]));
    }
    return Object.freeze(output);
  };

  return Object.freeze({
    inspectTerminalReservation(uid) {
      const reservation = reservationSnapshot(uid);
      return Object.freeze({ reservation, ...terminalEvidence(reservation) });
    },
    settle(value, { nowEpochMs = Date.now() } = {}) {
      const input = exactRequest(value, [
        'uid', 'reservationUid', 'actualCostCnyFen', 'billingEvidenceSha256',
      ]);
      if (statements.settlementByReservation.get(input.reservationUid)) {
        throw new V2RepositoryConflictError(ENTITY, 'settled');
      }
      let result;
      executeWrite(ENTITY, 'settled', () => {
        result = insertSettlement.immediate(input, nowEpochMs);
      });
      return result;
    },
    getSettlement(uid) {
      return mapSettlement(statements.settlement.get(uid));
    },
    getSettlementByReservation(reservationUid) {
      const row = statements.settlementByReservation.get(reservationUid);
      return row ? mapSettlement(row) : null;
    },
    getActualCostCnyFen(authorizationUid) {
      const rows = statements.settlementsByAuthorization.all(authorizationUid);
      let value = 0;
      for (let index = 0; index < rows.length; index += 1) {
        const settlement = mapSettlement(rows[index]);
        if (settlement.authorizationUid !== authorizationUid) invalidData();
        value += settlement.actualCostCnyFen;
        if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) invalidData();
      }
      return value;
    },
    getReleaseObligation(authorizationUid) {
      const obligation = mapObligation(statements.obligation.get(authorizationUid));
      const receipt = mapReceipt(statements.receipt.get(authorizationUid), obligation);
      return Object.freeze({ obligation, receipt, state: receipt ? 'released' : 'required' });
    },
    listOpenReleaseObligations() {
      return listOpenReleaseObligations();
    },
    confirmRelease(value, { nowEpochMs = Date.now() } = {}) {
      const input = exactRequest(value, ['authorizationUid', 'releaseEvidenceSha256']);
      if (statements.receipt.get(input.authorizationUid)) {
        throw new V2RepositoryConflictError(ENTITY, 'released');
      }
      let result;
      executeWrite(ENTITY, 'released', () => {
        result = insertReceipt.immediate(input, nowEpochMs);
      });
      return result;
    },
    recoverOpen() {
      return Object.freeze({
        recoveredCount: 0,
        failedCount: listOpenReleaseObligations().length,
      });
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkExecutionAccountingRepository });
