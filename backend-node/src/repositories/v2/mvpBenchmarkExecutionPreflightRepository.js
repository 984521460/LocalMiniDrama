'use strict';

const { types: { isProxy } } = require('node:util');

const {
  assertMvpBenchmarkLiveEnvironmentAttestationFresh,
  createMvpBenchmarkExecutionReservation,
  createMvpBenchmarkLiveEnvironmentAttestation,
  isMvpBenchmarkExecutionPreflightError,
  parseMvpBenchmarkCostEstimate,
  parseMvpBenchmarkExecutionReservation,
  parseMvpBenchmarkLiveEnvironmentAttestation,
  parseMvpBenchmarkLiveEnvironmentObservation,
  serializeMvpBenchmarkExecutionPreflightJson,
} = require('../../benchmark/mvpBenchmarkExecutionPreflight');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'MVP benchmark execution preflight';
const JSON_PARSE = JSON.parse;

function requestObject(value, keys) {
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
    throw new TypeError('MVP benchmark execution preflight repository input is invalid');
  }
}

function invalidData() {
  throw new V2RepositoryDataError(ENTITY, 'persisted record');
}

function createMvpBenchmarkExecutionPreflightRepository(database, dependencies) {
  const { authorizations, sessions } = dependencies ?? {};
  if (!authorizations || typeof authorizations.get !== 'function'
    || typeof authorizations.requireActive !== 'function'
    || !sessions || typeof sessions.get !== 'function') {
    throw new TypeError('MVP benchmark execution preflight repository dependencies are invalid');
  }

  const statements = Object.freeze({
    attestation: database.prepare(`
      SELECT attestation.*,seal.attestation_sha256 AS sealed_attestation_sha256
      FROM mvp_benchmark_live_environment_attestations AS attestation
      LEFT JOIN mvp_benchmark_live_environment_attestation_seals AS seal
        ON seal.attestation_uid=attestation.uid
      WHERE attestation.uid=?
    `),
    reservation: database.prepare(`
      SELECT reservation.*,seal.reservation_sha256 AS sealed_reservation_sha256
      FROM mvp_benchmark_execution_reservations AS reservation
      LEFT JOIN mvp_benchmark_execution_reservation_seals AS seal
        ON seal.reservation_uid=reservation.uid
      WHERE reservation.uid=?
    `),
    reservationByItem: database.prepare(`
      SELECT reservation.*,seal.reservation_sha256 AS sealed_reservation_sha256
      FROM mvp_benchmark_execution_reservations AS reservation
      LEFT JOIN mvp_benchmark_execution_reservation_seals AS seal
        ON seal.reservation_uid=reservation.uid
      WHERE reservation.item_kind=? AND reservation.item_uid=?
    `),
    reservedCost: database.prepare(`
      SELECT COALESCE(sum(estimated_cost_cny_fen),0) AS total
      FROM mvp_benchmark_execution_reservations WHERE authorization_uid=?
    `).pluck(),
    insertAttestation: database.prepare(`
      INSERT INTO mvp_benchmark_live_environment_attestations
        (uid,authorization_uid,session_uid,drama_uid,connection_uid,
         connection_evidence_sha256,observation_json,observation_sha256,
         attestation_json,attestation_sha256,attested_at_epoch_ms,expires_at_epoch_ms)
      VALUES
        (@uid,@authorizationUid,@sessionUid,@dramaUid,@connectionUid,
         @connectionEvidenceSha256,@observationJson,@observationSha256,
         @attestationJson,@attestationSha256,@attestedAtEpochMs,@expiresAtEpochMs)
    `),
    insertReservation: database.prepare(`
      INSERT INTO mvp_benchmark_execution_reservations
        (uid,authorization_uid,attestation_uid,session_uid,drama_uid,item_kind,item_uid,
         request_sha256,estimate_json,estimate_sha256,estimated_cost_cny_fen,
         reservation_json,reservation_sha256,reserved_at_epoch_ms)
      VALUES
        (@uid,@authorizationUid,@attestationUid,@sessionUid,@dramaUid,@itemKind,@itemUid,
         @requestSha256,@estimateJson,@estimateSha256,@estimatedCostCnyFen,
         @reservationJson,@reservationSha256,@reservedAtEpochMs)
    `),
  });

  function mapAttestation(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const observation = parseMvpBenchmarkLiveEnvironmentObservation(
        Reflect.apply(JSON_PARSE, JSON, [row.observation_json]),
      );
      const attestation = parseMvpBenchmarkLiveEnvironmentAttestation(
        Reflect.apply(JSON_PARSE, JSON, [row.attestation_json]),
      );
      const authorization = authorizations.get(attestation.authorizationUid);
      const expected = createMvpBenchmarkLiveEnvironmentAttestation({
        uid: attestation.uid,
        authorization,
        observation,
        attestedAtEpochMs: attestation.attestedAtEpochMs,
      }, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID');
      if (serializeMvpBenchmarkExecutionPreflightJson(observation) !== row.observation_json
        || serializeMvpBenchmarkExecutionPreflightJson(attestation) !== row.attestation_json
        || row.uid !== attestation.uid
        || row.authorization_uid !== attestation.authorizationUid
        || row.session_uid !== attestation.sessionUid
        || row.drama_uid !== attestation.dramaUid
        || row.connection_uid !== attestation.connectionUid
        || row.connection_evidence_sha256 !== attestation.connectionEvidenceSha256
        || row.observation_sha256 !== observation.observationSha256
        || row.attestation_sha256 !== attestation.attestationSha256
        || row.sealed_attestation_sha256 !== attestation.attestationSha256
        || row.attested_at_epoch_ms !== attestation.attestedAtEpochMs
        || row.expires_at_epoch_ms !== attestation.expiresAtEpochMs
        || attestation.observation.observationSha256 !== observation.observationSha256
        || authorization.sessionUid !== attestation.sessionUid
        || authorization.dramaUid !== attestation.dramaUid
        || authorization.connectionUid !== attestation.connectionUid
        || authorization.connectionEvidenceSha256 !== attestation.connectionEvidenceSha256
        || authorization.requiredEnvironmentSha256 !== attestation.approvedEnvironmentSha256
        || expected.attestationSha256 !== attestation.attestationSha256) invalidData();
      return attestation;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function getAttestation(uid) {
    return mapAttestation(statements.attestation.get(uid));
  }

  function mapReservation(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const reservation = parseMvpBenchmarkExecutionReservation(
        Reflect.apply(JSON_PARSE, JSON, [row.reservation_json]),
      );
      const estimate = parseMvpBenchmarkCostEstimate(
        Reflect.apply(JSON_PARSE, JSON, [row.estimate_json]),
      );
      const authorization = authorizations.get(reservation.authorizationUid);
      const attestation = getAttestation(reservation.attestationUid);
      const session = sessions.get(reservation.sessionUid);
      const expected = createMvpBenchmarkExecutionReservation({
        uid: reservation.uid,
        authorization,
        attestation,
        session,
        itemKind: reservation.itemKind,
        itemUid: reservation.itemUid,
        requestSha256: reservation.requestSha256,
        estimate,
        reservedAtEpochMs: reservation.reservedAtEpochMs,
      }, 'MVP_BENCHMARK_EXECUTION_PREFLIGHT_DATA_INVALID');
      if (serializeMvpBenchmarkExecutionPreflightJson(estimate) !== row.estimate_json
        || serializeMvpBenchmarkExecutionPreflightJson(reservation) !== row.reservation_json
        || row.uid !== reservation.uid
        || row.authorization_uid !== reservation.authorizationUid
        || row.attestation_uid !== reservation.attestationUid
        || row.session_uid !== reservation.sessionUid
        || row.drama_uid !== reservation.dramaUid
        || row.item_kind !== reservation.itemKind || row.item_uid !== reservation.itemUid
        || row.request_sha256 !== reservation.requestSha256
        || row.estimate_sha256 !== estimate.estimateSha256
        || row.estimated_cost_cny_fen !== reservation.estimatedCostCnyFen
        || row.reservation_sha256 !== reservation.reservationSha256
        || row.sealed_reservation_sha256 !== reservation.reservationSha256
        || row.reserved_at_epoch_ms !== reservation.reservedAtEpochMs
        || statements.reservedCost.get(reservation.authorizationUid)
          > authorization.maximumCostCnyFen
        || expected.reservationSha256 !== reservation.reservationSha256) invalidData();
      return reservation;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function getReservation(uid) {
    return mapReservation(statements.reservation.get(uid));
  }

  const insertAttestation = database.transaction((authorization, observation, input, nowEpochMs) => {
    const attestation = createMvpBenchmarkLiveEnvironmentAttestation({
      uid: input.uid,
      authorization,
      observation,
      attestedAtEpochMs: nowEpochMs,
    });
    statements.insertAttestation.run({
      uid: attestation.uid,
      authorizationUid: attestation.authorizationUid,
      sessionUid: attestation.sessionUid,
      dramaUid: attestation.dramaUid,
      connectionUid: attestation.connectionUid,
      connectionEvidenceSha256: attestation.connectionEvidenceSha256,
      observationJson: serializeMvpBenchmarkExecutionPreflightJson(attestation.observation),
      observationSha256: attestation.observation.observationSha256,
      attestationJson: serializeMvpBenchmarkExecutionPreflightJson(attestation),
      attestationSha256: attestation.attestationSha256,
      attestedAtEpochMs: attestation.attestedAtEpochMs,
      expiresAtEpochMs: attestation.expiresAtEpochMs,
    });
    return mapAttestation(statements.attestation.get(attestation.uid));
  });

  const insertReservation = database.transaction((input, nowEpochMs) => {
    const authorization = authorizations.requireActive(input.authorizationUid, nowEpochMs);
    const attestation = assertMvpBenchmarkLiveEnvironmentAttestationFresh(
      getAttestation(input.attestationUid),
      nowEpochMs,
    );
    const session = sessions.get(authorization.sessionUid);
    const estimate = parseMvpBenchmarkCostEstimate(
      input.estimate,
      'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
    );
    const reservation = createMvpBenchmarkExecutionReservation({
      uid: input.uid,
      authorization,
      attestation,
      session,
      itemKind: input.itemKind,
      itemUid: input.itemUid,
      requestSha256: input.requestSha256,
      estimate,
      reservedAtEpochMs: nowEpochMs,
    });
    statements.insertReservation.run({
      uid: reservation.uid,
      authorizationUid: reservation.authorizationUid,
      attestationUid: reservation.attestationUid,
      sessionUid: reservation.sessionUid,
      dramaUid: reservation.dramaUid,
      itemKind: reservation.itemKind,
      itemUid: reservation.itemUid,
      requestSha256: reservation.requestSha256,
      estimateJson: serializeMvpBenchmarkExecutionPreflightJson(reservation.estimate),
      estimateSha256: reservation.estimate.estimateSha256,
      estimatedCostCnyFen: reservation.estimatedCostCnyFen,
      reservationJson: serializeMvpBenchmarkExecutionPreflightJson(reservation),
      reservationSha256: reservation.reservationSha256,
      reservedAtEpochMs: reservation.reservedAtEpochMs,
    });
    return mapReservation(statements.reservation.get(reservation.uid));
  });

  return Object.freeze({
    attest(value, { nowEpochMs = Date.now() } = {}) {
      const input = requestObject(value, ['uid', 'authorizationUid', 'observation']);
      let observation;
      try {
        observation = parseMvpBenchmarkLiveEnvironmentObservation(
          input.observation,
          'MVP_BENCHMARK_EXECUTION_PREFLIGHT_INPUT_INVALID',
        );
      } catch (error) {
        if (isMvpBenchmarkExecutionPreflightError(error)) throw error;
        throw new TypeError('MVP benchmark live environment attestation input is invalid');
      }
      const authorization = authorizations.requireActive(input.authorizationUid, nowEpochMs);
      if (observation.connectionUid !== authorization.connectionUid
        || observation.connectionEvidenceSha256 !== authorization.connectionEvidenceSha256) {
        throw new V2RepositoryConflictError(ENTITY, 'attested');
      }
      let result;
      executeWrite(ENTITY, 'attested', () => {
        result = insertAttestation.immediate(authorization, observation, input, nowEpochMs);
      });
      return result;
    },
    getAttestation,
    getReservation,
    getReservationByItem(kind, itemUid) {
      return mapReservation(statements.reservationByItem.get(kind, itemUid));
    },
    reserve(value, { nowEpochMs = Date.now() } = {}) {
      const input = requestObject(value, [
        'uid', 'authorizationUid', 'attestationUid', 'itemKind', 'itemUid',
        'requestSha256', 'estimate',
      ]);
      if (statements.reservationByItem.get(input.itemKind, input.itemUid)) {
        throw new V2RepositoryConflictError(ENTITY, 'reserved');
      }
      let result;
      executeWrite(ENTITY, 'reserved', () => {
        result = insertReservation.immediate(input, nowEpochMs);
      });
      return result;
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkExecutionPreflightRepository });
