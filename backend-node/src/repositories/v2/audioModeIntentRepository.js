'use strict';

const {
  DATA_CODE,
  RECORD_SCHEMA_VERSION,
  createAudioModeIntentRecord,
  parseAudioModeIntentRequest,
  resolveAudioModeIntent,
  resolveAudioModeIntentCompletedSource,
  resolveAudioModeIntentExecutionSource,
} = require('../../audio/audioModeIntent');
const {
  canonicalJson: serializeCanonicalJson,
  canonicalUid,
  isAudioModeContractError,
} = require('../../audio/audioContract');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');

function canonicalJson(text, maximumBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new TypeError();
  }
  const value = JSON.parse(text);
  if (serializeCanonicalJson(value) !== text) throw new TypeError();
  return value;
}

function createAudioModeIntentRepository(database, dependencies) {
  if (!dependencies || typeof dependencies.requireApprovedNarrative !== 'function'
    || !dependencies.runs || !dependencies.shotContinuitySnapshots
    || !dependencies.voiceProfiles || !dependencies.workflows) {
    throw new TypeError('Audio mode intent repository dependencies are invalid');
  }
  let statements;

  function prepared() {
    if (statements) return statements;
    statements = Object.freeze({
      get: database.prepare('SELECT * FROM audio_mode_intents WHERE uid=?'),
      insert: database.prepare(`
        INSERT INTO audio_mode_intents
          (uid, drama_uid, workflow_run_uid, node_run_uid, shot_result_uid,
           script_result_uid, request_json, plan_json, plan_sha256, created_at_epoch_ms)
        VALUES
          (@uid, @dramaUid, @workflowRunUid, @nodeRunUid, @shotResultUid,
           @scriptResultUid, @requestJson, @planJson, @planSha256, @createdAtEpochMs)
      `),
    });
    return statements;
  }

  function expected(request, ErrorClass, sourcePhase = 'preparing') {
    try {
      if (sourcePhase === 'execution') {
        return resolveAudioModeIntentExecutionSource(request, dependencies);
      }
      if (sourcePhase === 'completed') {
        return resolveAudioModeIntentCompletedSource(request, dependencies);
      }
      return resolveAudioModeIntent(request, dependencies);
    } catch (error) {
      if (isAudioModeContractError(error) && error.code === DATA_CODE) {
        throw new ErrorClass('audio mode intent', 'referenced');
      }
      throw error;
    }
  }

  function mapRow(row, sourcePhase = 'preparing') {
    try {
      const requestJson = canonicalJson(row.request_json, 4 * 1024 * 1024);
      const planJson = canonicalJson(row.plan_json, 32 * 1024 * 1024);
      const stored = createAudioModeIntentRecord({
        schemaVersion: RECORD_SCHEMA_VERSION,
        uid: row.uid,
        dramaUid: row.drama_uid,
        workflowRunUid: row.workflow_run_uid,
        nodeRunUid: row.node_run_uid,
        shotResultUid: row.shot_result_uid,
        scriptResultUid: row.script_result_uid,
        request: requestJson,
        plan: planJson,
        createdAtEpochMs: row.created_at_epoch_ms,
      });
      if (stored.plan.planSha256 !== row.plan_sha256) throw new TypeError();
      const resolved = expected(stored.request, V2RepositoryDataError, sourcePhase);
      if (serializeCanonicalJson(resolved.request) !== row.request_json
        || serializeCanonicalJson(resolved.plan) !== row.plan_json) throw new TypeError();
      return Object.freeze({ ...stored, request: resolved.request, plan: resolved.plan });
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      throw new V2RepositoryDataError('audio mode intent', 'persisted record');
    }
  }

  function get(uid) {
    let canonical;
    try {
      canonical = canonicalUid(uid, DATA_CODE);
    } catch {
      throw new TypeError('Audio mode intent uid is invalid');
    }
    return mapRow(requiredRow(prepared().get.get(canonical), 'audio mode intent', canonical));
  }

  return Object.freeze({
    get,
    getExecutionSource(uid) {
      let canonical;
      try {
        canonical = canonicalUid(uid, DATA_CODE);
      } catch {
        throw new TypeError('Audio mode intent uid is invalid');
      }
      return mapRow(
        requiredRow(prepared().get.get(canonical), 'audio mode intent', canonical),
        'execution',
      );
    },
    getCompletedSource(uid) {
      let canonical;
      try {
        canonical = canonicalUid(uid, DATA_CODE);
      } catch {
        throw new TypeError('Audio mode intent uid is invalid');
      }
      return mapRow(
        requiredRow(prepared().get.get(canonical), 'audio mode intent', canonical),
        'completed',
      );
    },
    prepare(value) {
      const request = parseAudioModeIntentRequest(value);
      const resolved = expected(request, V2RepositoryConflictError);
      const requestJson = serializeCanonicalJson(resolved.request);
      const planJson = serializeCanonicalJson(resolved.plan);
      const existing = prepared().get.get(request.uid);
      if (existing) {
        const mapped = mapRow(existing);
        if (serializeCanonicalJson(mapped.request) !== requestJson) {
          throw new V2RepositoryConflictError('audio mode intent', 'prepared');
        }
        return mapped;
      }
      executeWrite('audio mode intent', 'prepared', () => prepared().insert.run({
        uid: request.uid,
        dramaUid: request.dramaUid,
        workflowRunUid: request.workflowRunUid,
        nodeRunUid: request.nodeRunUid,
        shotResultUid: request.shotResultUid,
        scriptResultUid: request.scriptResultUid,
        requestJson,
        planJson,
        planSha256: resolved.plan.planSha256,
        createdAtEpochMs: request.createdAtEpochMs,
      }));
      return get(request.uid);
    },
  });
}

module.exports = Object.freeze({ createAudioModeIntentRepository });
