'use strict';

const { types: { isProxy } } = require('node:util');

const {
  MvpBenchmarkExternalAuthorizationError,
  assertMvpBenchmarkExternalAuthorizationActive,
  createMvpBenchmarkExternalAuthorization,
  isMvpBenchmarkExternalAuthorizationError,
  mvpBenchmarkExternalAuthorizationRequestSha256,
  parseMvpBenchmarkExternalAuthorization,
  parseMvpBenchmarkExternalAuthorizationRequest,
  parseCurrentMvpBenchmarkExternalAuthorizationRequest,
  serializeMvpBenchmarkExternalAuthorizationJson,
} = require('../../benchmark/mvpBenchmarkExternalAuthorization');
const {
  createMvpBenchmarkOperatorAttestation,
} = require('../../benchmark/mvpBenchmarkOperatorAttestation');
const { remoteConnectionEvidenceSha256 } = require('../../remote/connectionProfile');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'MVP benchmark external authorization';
const JSON_PARSE = JSON.parse;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const DERIVED_KEYS = Object.freeze([
  'uid', 'sessionUid', 'dramaUid', 'connectionUid',
  'maximumCostCnyFen', 'validityDurationMs', 'operatorAttestation',
]);

function invalidData() {
  throw new V2RepositoryDataError(ENTITY, 'persisted record');
}

function derivedInput(value) {
  try {
    if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) {
      throw new TypeError('MVP benchmark external authorization request is invalid');
    }
    const prototype = Reflect.apply(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = Reflect.apply(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    if ((prototype !== Object.prototype && prototype !== null)
      || Reflect.apply(REFLECT_OWN_KEYS, Reflect, [descriptors]).length !== DERIVED_KEYS.length) {
      throw new TypeError('MVP benchmark external authorization request is invalid');
    }
    const output = Reflect.apply(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < DERIVED_KEYS.length; index += 1) {
      const key = DERIVED_KEYS[index];
      if (!Reflect.apply(OBJECT_HAS_OWN, Object, [descriptors, key])) {
        throw new TypeError('MVP benchmark external authorization request is invalid');
      }
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable
        || !Reflect.apply(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) {
        throw new TypeError('MVP benchmark external authorization request is invalid');
      }
      output[key] = descriptor.value;
    }
    return Reflect.apply(OBJECT_FREEZE, Object, [output]);
  } catch (error) {
    if (error instanceof TypeError
      && error.message === 'MVP benchmark external authorization request is invalid') throw error;
    throw new TypeError('MVP benchmark external authorization request is invalid');
  }
}

function createMvpBenchmarkExternalAuthorizationRepository(database, dependencies) {
  const { mvpBenchmarkSessions, remote } = dependencies ?? {};
  if (!mvpBenchmarkSessions || typeof mvpBenchmarkSessions.get !== 'function'
    || !remote || typeof remote.getConnection !== 'function'
    || typeof remote.getFormalTask !== 'function') {
    throw new TypeError('MVP benchmark external authorization repository dependencies are invalid');
  }

  const statements = Object.freeze({
    get: database.prepare(`
      SELECT authorization.*, seal.request_sha256 AS sealed_request_sha256
      FROM mvp_benchmark_external_authorizations AS authorization
      LEFT JOIN mvp_benchmark_external_authorization_request_seals AS seal
        ON seal.authorization_uid=authorization.uid
      WHERE authorization.uid=?
    `),
    getBySession: database.prepare(`
      SELECT authorization.*, seal.request_sha256 AS sealed_request_sha256
      FROM mvp_benchmark_external_authorizations AS authorization
      LEFT JOIN mvp_benchmark_external_authorization_request_seals AS seal
        ON seal.authorization_uid=authorization.uid
      WHERE authorization.session_uid=?
    `),
    reservedAudioIntent: database.prepare(`
      SELECT session.uid
      FROM mvp_benchmark_sessions AS session,
           json_each(session.plan_json,'$.audioIntents') AS planned
      WHERE json_extract(planned.value,'$.intentUid')=?
      LIMIT 1
    `),
    reservedH3Task: database.prepare(`
      SELECT session.uid
      FROM mvp_benchmark_sessions AS session,
           json_each(session.plan_json,'$.h3Tasks') AS planned
      WHERE json_extract(planned.value,'$.taskUid')=?
      LIMIT 1
    `),
    insert: database.prepare(`
      INSERT INTO mvp_benchmark_external_authorizations
        (uid,session_uid,drama_uid,request_json,request_sha256,
         authorization_json,authorization_sha256,
         authorized_at_epoch_ms,expires_at_epoch_ms)
      VALUES
        (@uid,@sessionUid,@dramaUid,@requestJson,@requestSha256,
         @authorizationJson,@authorizationSha256,
         @authorizedAtEpochMs,@expiresAtEpochMs)
    `),
  });

  function assertSources(request, failure) {
    let session;
    try { session = mvpBenchmarkSessions.get(request.sessionUid); } catch { return failure(); }
    if (session.dramaUid !== request.dramaUid
      || session.planSha256 !== request.sessionPlanSha256) return failure();
    for (let index = 0; index < session.h3Tasks.length; index += 1) {
      let task;
      try { task = remote.getFormalTask(session.h3Tasks[index].taskUid); } catch { return failure(); }
      if (task.connectionUid !== request.connectionUid
        || task.connectionEvidenceSha256 !== request.connectionEvidenceSha256
        || task.stage !== 'prepared' || task.status !== 'queued'
        || task.promptId !== null || task.outputAssetVersionUid !== null) return failure();
    }
    let connection;
    try { connection = remote.getConnection(request.connectionUid); } catch { return failure(); }
    if (connection.status !== 'ready'
      || remoteConnectionEvidenceSha256(connection) !== request.connectionEvidenceSha256) {
      return failure();
    }
    return session;
  }

  function mapStoredRow(row) {
    if (!row) throw new V2RepositoryNotFoundError(ENTITY);
    try {
      const request = parseMvpBenchmarkExternalAuthorizationRequest(
        Reflect.apply(JSON_PARSE, JSON, [row.request_json]),
        'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID',
      );
      const authorization = parseMvpBenchmarkExternalAuthorization(
        Reflect.apply(JSON_PARSE, JSON, [row.authorization_json]),
      );
      if (serializeMvpBenchmarkExternalAuthorizationJson(request) !== row.request_json
        || (request.schemaVersion === 'mvp-benchmark-external-authorization-request.v2'
          ? row.request_sha256 !== mvpBenchmarkExternalAuthorizationRequestSha256(request)
            || row.sealed_request_sha256 !== row.request_sha256
          : row.request_sha256 !== null || row.sealed_request_sha256 !== null)
        || serializeMvpBenchmarkExternalAuthorizationJson(authorization) !== row.authorization_json
        || row.uid !== request.uid || row.uid !== authorization.uid
        || row.session_uid !== request.sessionUid || row.session_uid !== authorization.sessionUid
        || row.drama_uid !== request.dramaUid || row.drama_uid !== authorization.dramaUid
        || row.authorization_sha256 !== authorization.authorizationSha256
        || row.authorized_at_epoch_ms !== authorization.authorizedAtEpochMs
        || row.expires_at_epoch_ms !== authorization.expiresAtEpochMs) invalidData();
      return Object.freeze({ authorization, request });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function mapRow(row) {
    const stored = mapStoredRow(row);
    try {
      parseCurrentMvpBenchmarkExternalAuthorizationRequest(
        stored.request,
        'MVP_BENCHMARK_EXTERNAL_AUTHORIZATION_DATA_INVALID',
      );
    } catch {
      return invalidData();
    }
    const session = assertSources(stored.request, invalidData);
    if (stored.authorization.h3SubmissionLimit !== session.h3Tasks.length
      || stored.authorization.ttsSubmissionLimit !== session.audioIntents.length
      || stored.authorization.sessionPlanSha256 !== session.planSha256) invalidData();
    return stored.authorization;
  }

  function get(uid) {
    return mapRow(statements.get.get(uid));
  }

  function assertNotReserved(statement, itemUid) {
    try {
      if (statement.get(itemUid)) {
        throw new MvpBenchmarkExternalAuthorizationError(
          'MVP_BENCHMARK_EXTERNAL_EXECUTION_UNAVAILABLE',
        );
      }
    } catch (error) {
      if (isMvpBenchmarkExternalAuthorizationError(error)) throw error;
      return invalidData();
    }
    return true;
  }

  const prepareAndRead = database.transaction((request, nowEpochMs) => {
    const existing = statements.get.get(request.uid) ?? statements.getBySession.get(request.sessionUid);
    if (existing) {
      const mapped = mapRow(existing);
      if (existing.request_json !== serializeMvpBenchmarkExternalAuthorizationJson(request)) {
        throw new V2RepositoryConflictError(ENTITY, 'authorized');
      }
      return mapped;
    }
    const session = assertSources(
      request,
      () => { throw new V2RepositoryConflictError(ENTITY, 'authorized'); },
    );
    const authorization = createMvpBenchmarkExternalAuthorization({
      request,
      h3SubmissionLimit: session.h3Tasks.length,
      ttsSubmissionLimit: session.audioIntents.length,
      authorizedAtEpochMs: nowEpochMs,
    });
    statements.insert.run({
      uid: authorization.uid,
      sessionUid: authorization.sessionUid,
      dramaUid: authorization.dramaUid,
      requestJson: serializeMvpBenchmarkExternalAuthorizationJson(request),
      requestSha256: mvpBenchmarkExternalAuthorizationRequestSha256(request),
      authorizationJson: serializeMvpBenchmarkExternalAuthorizationJson(authorization),
      authorizationSha256: authorization.authorizationSha256,
      authorizedAtEpochMs: authorization.authorizedAtEpochMs,
      expiresAtEpochMs: authorization.expiresAtEpochMs,
    });
    return mapRow(statements.get.get(authorization.uid));
  });

  function sameDerivedRequest(left, right) {
    return left.sessionUid === right.sessionUid
      && left.dramaUid === right.dramaUid
      && left.sessionPlanSha256 === right.sessionPlanSha256
      && left.connectionUid === right.connectionUid
      && left.connectionEvidenceSha256 === right.connectionEvidenceSha256
      && left.maximumCostCnyFen === right.maximumCostCnyFen
      && left.validityDurationMs === right.validityDurationMs
      && left.operatorAttestation.attestationSha256
        === right.operatorAttestation.attestationSha256;
  }

  const prepareDerivedAndRead = database.transaction((input, nowEpochMs) => {
    let session;
    let connection;
    try {
      session = mvpBenchmarkSessions.get(input.sessionUid);
      connection = remote.getConnection(input.connectionUid);
    } catch {
      throw new V2RepositoryConflictError(ENTITY, 'authorized');
    }
    if (session.dramaUid !== input.dramaUid) {
      throw new V2RepositoryConflictError(ENTITY, 'authorized');
    }
    const request = parseCurrentMvpBenchmarkExternalAuthorizationRequest({
      schemaVersion: 'mvp-benchmark-external-authorization-request.v2',
      uid: input.uid,
      sessionUid: session.uid,
      dramaUid: session.dramaUid,
      sessionPlanSha256: session.planSha256,
      connectionUid: connection.uid,
      connectionEvidenceSha256: remoteConnectionEvidenceSha256(connection),
      maximumCostCnyFen: input.maximumCostCnyFen,
      validityDurationMs: input.validityDurationMs,
      operatorAttestation: createMvpBenchmarkOperatorAttestation(input.operatorAttestation),
    });
    const existing = statements.getBySession.get(session.uid);
    if (existing) {
      const stored = mapStoredRow(existing);
      const mapped = mapRow(existing);
      if (!sameDerivedRequest(stored.request, request)) {
        throw new V2RepositoryConflictError(ENTITY, 'authorized');
      }
      return mapped;
    }
    const currentSession = assertSources(
      request,
      () => { throw new V2RepositoryConflictError(ENTITY, 'authorized'); },
    );
    const authorization = createMvpBenchmarkExternalAuthorization({
      request,
      h3SubmissionLimit: currentSession.h3Tasks.length,
      ttsSubmissionLimit: currentSession.audioIntents.length,
      authorizedAtEpochMs: nowEpochMs,
    });
    statements.insert.run({
      uid: authorization.uid,
      sessionUid: authorization.sessionUid,
      dramaUid: authorization.dramaUid,
      requestJson: serializeMvpBenchmarkExternalAuthorizationJson(request),
      requestSha256: mvpBenchmarkExternalAuthorizationRequestSha256(request),
      authorizationJson: serializeMvpBenchmarkExternalAuthorizationJson(authorization),
      authorizationSha256: authorization.authorizationSha256,
      authorizedAtEpochMs: authorization.authorizedAtEpochMs,
      expiresAtEpochMs: authorization.expiresAtEpochMs,
    });
    return mapRow(statements.get.get(authorization.uid));
  });

  return Object.freeze({
    assertAudioIntentExecutionOpen(intentUid) {
      return assertNotReserved(statements.reservedAudioIntent, intentUid);
    },
    assertH3TaskExecutionOpen(taskUid) {
      return assertNotReserved(statements.reservedH3Task, taskUid);
    },
    get,
    getStored(uid) {
      return mapStoredRow(statements.get.get(uid)).authorization;
    },
    getStoredBySession(sessionUid) {
      const row = statements.getBySession.get(sessionUid);
      return row ? mapStoredRow(row).authorization : null;
    },
    prepare(value, { nowEpochMs = Date.now() } = {}) {
      let request;
      try { request = parseCurrentMvpBenchmarkExternalAuthorizationRequest(value); } catch (error) {
        if (isMvpBenchmarkExternalAuthorizationError(error)) throw error;
        throw new TypeError('MVP benchmark external authorization request is invalid');
      }
      let result;
      executeWrite(ENTITY, 'authorized', () => {
        result = prepareAndRead.immediate(request, nowEpochMs);
      });
      return result;
    },
    prepareFromSession(value, { nowEpochMs = Date.now() } = {}) {
      const input = derivedInput(value);
      let result;
      executeWrite(ENTITY, 'authorized', () => {
        result = prepareDerivedAndRead.immediate(input, nowEpochMs);
      });
      return result;
    },
    requireActive(uid, nowEpochMs) {
      return assertMvpBenchmarkExternalAuthorizationActive(get(uid), nowEpochMs);
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkExternalAuthorizationRepository });
