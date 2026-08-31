'use strict';

const {
  MvpBenchmarkExternalAuthorizationError,
  assertMvpBenchmarkExternalAuthorizationActive,
  createMvpBenchmarkExternalAuthorization,
  isMvpBenchmarkExternalAuthorizationError,
  parseMvpBenchmarkExternalAuthorization,
  parseMvpBenchmarkExternalAuthorizationRequest,
  serializeMvpBenchmarkExternalAuthorizationJson,
} = require('../../benchmark/mvpBenchmarkExternalAuthorization');
const { remoteConnectionEvidenceSha256 } = require('../../remote/connectionProfile');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
  V2RepositoryNotFoundError,
} = require('./errors');
const { executeWrite } = require('./repositorySupport');

const ENTITY = 'MVP benchmark external authorization';
const JSON_PARSE = JSON.parse;

function invalidData() {
  throw new V2RepositoryDataError(ENTITY, 'persisted record');
}

function createMvpBenchmarkExternalAuthorizationRepository(database, dependencies) {
  const { mvpBenchmarkSessions, remote } = dependencies ?? {};
  if (!mvpBenchmarkSessions || typeof mvpBenchmarkSessions.get !== 'function'
    || !remote || typeof remote.getConnection !== 'function'
    || typeof remote.getFormalTask !== 'function') {
    throw new TypeError('MVP benchmark external authorization repository dependencies are invalid');
  }

  const statements = Object.freeze({
    get: database.prepare('SELECT * FROM mvp_benchmark_external_authorizations WHERE uid=?'),
    getBySession: database.prepare(
      'SELECT * FROM mvp_benchmark_external_authorizations WHERE session_uid=?',
    ),
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
        (uid,session_uid,drama_uid,request_json,authorization_json,authorization_sha256,
         authorized_at_epoch_ms,expires_at_epoch_ms)
      VALUES
        (@uid,@sessionUid,@dramaUid,@requestJson,@authorizationJson,@authorizationSha256,
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

  function mapRow(row) {
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
        || serializeMvpBenchmarkExternalAuthorizationJson(authorization) !== row.authorization_json
        || row.uid !== request.uid || row.uid !== authorization.uid
        || row.session_uid !== request.sessionUid || row.session_uid !== authorization.sessionUid
        || row.drama_uid !== request.dramaUid || row.drama_uid !== authorization.dramaUid
        || row.authorization_sha256 !== authorization.authorizationSha256
        || row.authorized_at_epoch_ms !== authorization.authorizedAtEpochMs
        || row.expires_at_epoch_ms !== authorization.expiresAtEpochMs) invalidData();
      const session = assertSources(request, invalidData);
      if (authorization.h3SubmissionLimit !== session.h3Tasks.length
        || authorization.ttsSubmissionLimit !== session.audioIntents.length
        || authorization.sessionPlanSha256 !== session.planSha256) invalidData();
      return authorization;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
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

  const insertAndRead = database.transaction((request, authorization) => {
    statements.insert.run({
      uid: authorization.uid,
      sessionUid: authorization.sessionUid,
      dramaUid: authorization.dramaUid,
      requestJson: serializeMvpBenchmarkExternalAuthorizationJson(request),
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
    prepare(value, { nowEpochMs = Date.now() } = {}) {
      let request;
      try { request = parseMvpBenchmarkExternalAuthorizationRequest(value); } catch (error) {
        if (isMvpBenchmarkExternalAuthorizationError(error)) throw error;
        throw new TypeError('MVP benchmark external authorization request is invalid');
      }
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
      let result;
      executeWrite(ENTITY, 'authorized', () => {
        result = insertAndRead.immediate(request, authorization);
      });
      return result;
    },
    requireActive(uid, nowEpochMs) {
      return assertMvpBenchmarkExternalAuthorizationActive(get(uid), nowEpochMs);
    },
  });
}

module.exports = Object.freeze({ createMvpBenchmarkExternalAuthorizationRepository });
