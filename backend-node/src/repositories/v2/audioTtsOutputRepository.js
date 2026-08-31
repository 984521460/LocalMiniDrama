'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  createAssetVersionEvidence,
} = require('../../assets/assetVersionEvidence');
const {
  parseMediaProbeEvidenceRecord,
} = require('../../media/mediaProbeEvidence');
const {
  createAudioExecutionEvidence,
  parsePersistedAudioExecutionEvidence,
} = require('../../audio/audioExecutionEvidence');
const { requireTrustedAudioModePlan } = require('../../audio/audioMode');
const {
  canonicalUid,
  canonicalJson: serializeCanonicalJson,
  denseArray,
  exactObject,
  fail,
  isAudioModeContractError,
  sha256,
} = require('../../audio/audioContract');
const { createAudioModeIntentRecord } = require('../../audio/audioModeIntent');

const INPUT_CODE = 'AUDIO_TTS_EXECUTION_INPUT_INVALID';
const DATA_CODE = 'AUDIO_TTS_EXECUTION_DATA_INVALID';
const OUTPUT_KEYS = Object.freeze(['reservation', 'submission', 'probe']);
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_REQUESTS = 1000;
const DEFINE_PROPERTY = Object.defineProperty;
const REGEXP_TEST = RegExp.prototype.test;

function append(target, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, String(target.length), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

function deterministicUid(namespace, intentUid, dialogueDeliveryUid) {
  canonicalUid(intentUid, DATA_CODE);
  canonicalUid(dialogueDeliveryUid, DATA_CODE);
  const bytes = createHash('sha256')
    .update(`${namespace}\0${intentUid}\0${dialogueDeliveryUid}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function outputReservation(intent, requestOrdinal) {
  try {
    const record = createAudioModeIntentRecord(intent, DATA_CODE);
    if (!Number.isSafeInteger(requestOrdinal) || requestOrdinal < 0
      || requestOrdinal >= MAX_REQUESTS || requestOrdinal >= record.plan.ttsRequests.length) {
      fail(DATA_CODE);
    }
    intent = record;
    const intentUid = canonicalUid(intent.uid, DATA_CODE);
    const dramaUid = canonicalUid(intent.dramaUid, DATA_CODE);
    const request = intent.plan.ttsRequests[requestOrdinal];
    const dialogueDeliveryUid = canonicalUid(request.dialogueDeliveryUid, DATA_CODE);
    const assetUid = deterministicUid('audio-tts-asset.v1', intentUid, dialogueDeliveryUid);
    const assetVersionUid = deterministicUid(
      'audio-tts-asset-version.v1', intentUid, dialogueDeliveryUid,
    );
    const locator = Object.freeze({
      storageProvider: 'local',
      logicalUri: `asset://dramas/${dramaUid}/audio/tts/${assetUid}/${assetVersionUid}`,
      relativePath: `projects/${dramaUid}/assets/audio/tts/${assetUid}/${assetVersionUid}.wav`,
    });
    return Object.freeze({
      intentUid,
      dramaUid,
      requestOrdinal,
      dialogueDeliveryUid,
      requestSha256: sha256(request.requestSha256, DATA_CODE),
      assetUid,
      assetVersionUid,
      locator,
    });
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(DATA_CODE);
  }
}

function executionUid(intentUid) {
  return deterministicUid('audio-tts-execution.v1', intentUid, intentUid);
}

function parseCanonicalJson(text, maximumBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maximumBytes) fail(DATA_CODE);
  try {
    const parsed = JSON.parse(text);
    if (serializeCanonicalJson(parsed) !== text) fail(DATA_CODE);
    return parsed;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(DATA_CODE);
  }
}

function probeMatches(value, expected) {
  const probe = parseMediaProbeEvidenceRecord(value);
  if (probe.assetUid !== expected.assetUid
    || probe.assetVersionUid !== expected.assetVersionUid
    || probe.assetVersionSha256 !== expected.sha256
    || probe.relativePathSha256 !== createHash('sha256').update(expected.relativePath).digest('hex')
    || probe.mimeType !== expected.mimeType || probe.mediaKind !== 'audio'
    || probe.bytes !== expected.bytes || probe.durationMs !== expected.durationMs
    || probe.video !== null || probe.audio === null || probe.decoded !== true) fail(DATA_CODE);
  return probe;
}

function exactConfiguration(value) {
  try {
    const input = exactObject(value, ['database', 'repositories'], INPUT_CODE);
    if (!input.database || typeof input.database.prepare !== 'function'
      || typeof input.database.transaction !== 'function' || isProxy(input.database)
      || !input.repositories?.assets || !input.repositories?.runs
      || typeof input.repositories.withTransaction !== 'function') fail(INPUT_CODE);
    return input;
  } catch (error) {
    if (isAudioModeContractError(error)) throw error;
    return fail(INPUT_CODE);
  }
}

function createAudioTtsOutputRepository(value) {
  const config = exactConfiguration(value);
  const { database, repositories } = config;
  const statements = Object.freeze({
    execution: database.prepare(`
      SELECT evidence.*, intent.plan_json,
             intent.drama_uid AS intent_drama_uid,
             intent.workflow_run_uid AS intent_workflow_run_uid,
             intent.node_run_uid AS intent_node_run_uid,
             intent.plan_sha256 AS intent_plan_sha256
      FROM audio_tts_execution_evidence AS evidence
      JOIN audio_mode_intents AS intent ON intent.uid=evidence.intent_uid
      WHERE evidence.intent_uid=?
    `),
    outputs: database.prepare(`
      SELECT * FROM audio_tts_outputs WHERE intent_uid=? ORDER BY request_ordinal
    `),
    outputByOrdinal: database.prepare(`
      SELECT * FROM audio_tts_outputs WHERE intent_uid=? AND request_ordinal=?
    `),
    assetRow: database.prepare('SELECT * FROM assets WHERE uid=?'),
    versionRow: database.prepare('SELECT * FROM asset_versions WHERE uid=?'),
    insertOutput: database.prepare(`
      INSERT INTO audio_tts_outputs
        (dialogue_delivery_uid,intent_uid,request_ordinal,asset_uid,asset_version_uid,
         response_sha256,response_bytes,mime_type,media_probe_json,created_at_epoch_ms)
      VALUES (@dialogueDeliveryUid,@intentUid,@requestOrdinal,@assetUid,@assetVersionUid,
              @responseSha256,@responseBytes,@mimeType,@mediaProbeJson,@createdAtEpochMs)
    `),
    insertExecution: database.prepare(`
      INSERT INTO audio_tts_execution_evidence
        (uid,intent_uid,drama_uid,workflow_run_uid,node_run_uid,plan_uid,plan_sha256,
         evidence_json,execution_sha256,created_at_epoch_ms)
      VALUES (@uid,@intentUid,@dramaUid,@workflowRunUid,@nodeRunUid,@planUid,@planSha256,
              @evidenceJson,@executionSha256,@createdAtEpochMs)
    `),
    now: database.prepare("SELECT unixepoch('now') * 1000").pluck(),
  });

  function readExecution(intentUidValue) {
    const intentUid = canonicalUid(intentUidValue, INPUT_CODE);
    const row = statements.execution.get(intentUid);
    if (!row) return null;
    try {
      if (row.uid !== executionUid(intentUid) || row.intent_uid !== intentUid
        || row.plan_uid !== intentUid
        || row.drama_uid !== row.intent_drama_uid
        || row.workflow_run_uid !== row.intent_workflow_run_uid
        || row.node_run_uid !== row.intent_node_run_uid
        || row.plan_sha256 !== row.intent_plan_sha256
        || !Reflect.apply(REGEXP_TEST, SHA256, [row.plan_sha256])) fail(DATA_CODE);
      const plan = parseCanonicalJson(row.plan_json, 32 * 1024 * 1024);
      if (plan.uid !== row.intent_uid || plan.dramaUid !== row.drama_uid
        || plan.workflowRunUid !== row.workflow_run_uid
        || plan.planSha256 !== row.plan_sha256) fail(DATA_CODE);
      const evidence = parsePersistedAudioExecutionEvidence(
        parseCanonicalJson(row.evidence_json, 32 * 1024 * 1024), plan,
      );
      if (evidence.uid !== row.uid || evidence.planUid !== row.plan_uid
        || evidence.planSha256 !== row.plan_sha256
        || evidence.executionSha256 !== row.execution_sha256
        || evidence.createdAtEpochMs !== row.created_at_epoch_ms) fail(DATA_CODE);
      const outputRows = statements.outputs.all(intentUid);
      if (outputRows.length !== evidence.ttsOutputs.length) fail(DATA_CODE);
      for (let index = 0; index < outputRows.length; index += 1) {
        const outputRow = outputRows[index];
        const output = evidence.ttsOutputs[index];
        const asset = repositories.assets.get(outputRow.asset_uid);
        const version = repositories.assets.getVersion(outputRow.asset_version_uid);
        if (outputRow.request_ordinal !== index
          || outputRow.dialogue_delivery_uid !== output.dialogueDeliveryUid
          || outputRow.asset_uid !== output.audioAsset.uid
          || outputRow.asset_version_uid !== output.audioVersionEvidence.uid
          || serializeCanonicalJson(asset) !== serializeCanonicalJson(output.audioAsset)
          || serializeCanonicalJson(createAssetVersionEvidence(version))
            !== serializeCanonicalJson(output.audioVersionEvidence)) fail(DATA_CODE);
        probeMatches(parseCanonicalJson(outputRow.media_probe_json, 1024 * 1024), {
          assetUid: version.assetUid,
          assetVersionUid: version.uid,
          sha256: version.sha256,
          relativePath: version.relativePath,
          mimeType: version.mimeType,
          bytes: outputRow.response_bytes,
          durationMs: version.durationMs,
        });
        if (outputRow.response_sha256 !== version.sha256
          || outputRow.mime_type !== version.mimeType) fail(DATA_CODE);
      }
      const aggregate = repositories.runs.getWorkflowWithNodes(row.workflow_run_uid);
      let node = null;
      for (let index = 0; index < aggregate.nodes.length; index += 1) {
        const candidate = aggregate.nodes[index];
        if (candidate.uid !== row.node_run_uid) continue;
        if (node !== null) fail(DATA_CODE);
        node = candidate;
      }
      if (!node || node.workflowRunUid !== aggregate.run.uid || node.status !== 'succeeded'
        || (aggregate.run.status !== 'running' && aggregate.run.status !== 'succeeded')
        || serializeCanonicalJson(node.inputSnapshot)
          !== serializeCanonicalJson({ audioModeIntentUid: intentUid })) {
        fail(DATA_CODE);
      }
      const versionUids = [];
      for (let index = 0; index < evidence.ttsOutputs.length; index += 1) {
        append(versionUids, evidence.ttsOutputs[index].audioVersionEvidence.uid);
      }
      if (serializeCanonicalJson(node.output) !== serializeCanonicalJson({
        audioExecutionEvidenceUid: evidence.uid,
        audioExecutionSha256: evidence.executionSha256,
        audioAssetVersionUids: versionUids,
      })) fail(DATA_CODE);
      return Object.freeze({
        schemaVersion: 'audio-tts-execution-record.v1',
        intentUid,
        dramaUid: canonicalUid(row.drama_uid, DATA_CODE),
        workflowRunUid: canonicalUid(row.workflow_run_uid, DATA_CODE),
        nodeRunUid: canonicalUid(row.node_run_uid, DATA_CODE),
        evidence,
      });
    } catch (error) {
      if (isAudioModeContractError(error)) throw error;
      return fail(DATA_CODE);
    }
  }

  const finalizeTransaction = database.transaction((intent, preparedOutputs) => {
    const trustedPlan = requireTrustedAudioModePlan(intent.plan);
    const parsedIntent = createAudioModeIntentRecord(intent, DATA_CODE);
    if (serializeCanonicalJson(trustedPlan) !== serializeCanonicalJson(parsedIntent.plan)) {
      fail(DATA_CODE);
    }
    intent = Object.freeze({ ...parsedIntent, plan: trustedPlan });
    const existing = readExecution(intent.uid);
    if (existing) return existing;
    const ttsOutputs = [];
    for (let index = 0; index < preparedOutputs.length; index += 1) {
      const prepared = exactObject(
        parseCanonicalJson(serializeCanonicalJson(preparedOutputs[index]), 4 * 1024 * 1024),
        OUTPUT_KEYS,
        INPUT_CODE,
      );
      const reservation = outputReservation(intent, index);
      if (serializeCanonicalJson(prepared.reservation) !== serializeCanonicalJson(reservation)
        || (prepared.submission.state !== 'received'
          && prepared.submission.state !== 'submission_unknown')
        || prepared.submission.intentUid !== intent.uid
        || prepared.submission.requestOrdinal !== index
        || prepared.submission.dialogueDeliveryUid !== reservation.dialogueDeliveryUid) fail(DATA_CODE);
      const recoveredResponse = prepared.submission.response ?? Object.freeze({
        sha256: prepared.probe.assetVersionSha256,
        bytes: prepared.probe.bytes,
        mimeType: prepared.probe.mimeType,
      });
      if (recoveredResponse.mimeType !== 'audio/wav') fail(DATA_CODE);
      const probe = probeMatches(prepared.probe, {
        assetUid: reservation.assetUid,
        assetVersionUid: reservation.assetVersionUid,
        sha256: recoveredResponse.sha256,
        relativePath: reservation.locator.relativePath,
        mimeType: recoveredResponse.mimeType,
        bytes: recoveredResponse.bytes,
        durationMs: prepared.probe.durationMs,
      });
      if (!statements.assetRow.get(reservation.assetUid)) {
        repositories.assets.create({
          uid: reservation.assetUid,
          ownerType: 'drama',
          ownerUid: reservation.dramaUid,
          assetType: 'audio',
          status: 'draft',
        });
        repositories.assets.addVersion({
          uid: reservation.assetVersionUid,
          assetUid: reservation.assetUid,
          storageProvider: reservation.locator.storageProvider,
          logicalUri: reservation.locator.logicalUri,
          relativePath: reservation.locator.relativePath,
          sha256: recoveredResponse.sha256,
          mimeType: recoveredResponse.mimeType,
          width: null,
          height: null,
          durationMs: probe.durationMs,
          parentUid: null,
          status: 'ready',
        }, { makeCurrent: true });
      }
      const asset = repositories.assets.get(reservation.assetUid);
      const version = repositories.assets.getVersion(reservation.assetVersionUid);
      const canonicalVersion = createAssetVersionEvidence(version);
      if (asset.ownerType !== 'drama' || asset.ownerUid !== reservation.dramaUid
        || asset.assetType !== 'audio' || asset.currentVersionUid !== version.uid
        || asset.status !== 'ready' || canonicalVersion.sha256 !== probe.assetVersionSha256
        || canonicalVersion.relativePath !== reservation.locator.relativePath
        || canonicalVersion.logicalUri !== reservation.locator.logicalUri
        || canonicalVersion.durationMs !== probe.durationMs) fail(DATA_CODE);
      const existingOutput = statements.outputByOrdinal.get(intent.uid, index);
      const mediaProbeJson = serializeCanonicalJson(probe);
      if (!existingOutput) {
        statements.insertOutput.run({
          dialogueDeliveryUid: reservation.dialogueDeliveryUid,
          intentUid: intent.uid,
          requestOrdinal: index,
          assetUid: reservation.assetUid,
          assetVersionUid: reservation.assetVersionUid,
          responseSha256: recoveredResponse.sha256,
          responseBytes: recoveredResponse.bytes,
          mimeType: recoveredResponse.mimeType,
          mediaProbeJson,
          createdAtEpochMs: statements.now.get(),
        });
      } else if (existingOutput.dialogue_delivery_uid !== reservation.dialogueDeliveryUid
        || existingOutput.asset_uid !== reservation.assetUid
        || existingOutput.asset_version_uid !== reservation.assetVersionUid
        || existingOutput.response_sha256 !== recoveredResponse.sha256
        || existingOutput.response_bytes !== recoveredResponse.bytes
        || existingOutput.mime_type !== recoveredResponse.mimeType
        || existingOutput.media_probe_json !== mediaProbeJson) fail(DATA_CODE);
      append(ttsOutputs, Object.freeze({
        dialogueDeliveryUid: reservation.dialogueDeliveryUid,
        requestSha256: reservation.requestSha256,
        audioAsset: asset,
        audioVersionEvidence: canonicalVersion,
      }));
    }
    const createdAtEpochMs = statements.now.get();
    const evidence = createAudioExecutionEvidence({
      schemaVersion: '8.0',
      uid: executionUid(intent.uid),
      plan: intent.plan,
      ttsOutputs,
      createdAtEpochMs,
    });
    statements.insertExecution.run({
      uid: evidence.uid,
      intentUid: intent.uid,
      dramaUid: intent.dramaUid,
      workflowRunUid: intent.workflowRunUid,
      nodeRunUid: intent.nodeRunUid,
      planUid: evidence.planUid,
      planSha256: evidence.planSha256,
      evidenceJson: serializeCanonicalJson(evidence),
      executionSha256: evidence.executionSha256,
      createdAtEpochMs,
    });
    const run = repositories.runs.getWorkflowWithNodes(intent.workflowRunUid);
    let node = null;
    for (let index = 0; index < run.nodes.length; index += 1) {
      if (run.nodes[index].uid !== intent.nodeRunUid) continue;
      if (node !== null) fail(DATA_CODE);
      node = run.nodes[index];
    }
    if (run.run.status !== 'queued' || node?.status !== 'queued') fail(DATA_CODE);
    repositories.runs.transitionWorkflowStatus({
      uid: run.run.uid, expectedStatus: 'queued', nextStatus: 'running',
    });
    repositories.runs.transitionNodeStatus({
      uid: node.uid,
      expectedStatus: 'queued',
      nextStatus: 'running',
      inputSnapshot: { audioModeIntentUid: intent.uid },
    });
    repositories.runs.transitionNodeStatus({
      uid: node.uid,
      expectedStatus: 'running',
      nextStatus: 'succeeded',
      output: (() => {
        const audioAssetVersionUids = [];
        for (let index = 0; index < evidence.ttsOutputs.length; index += 1) {
          append(audioAssetVersionUids, evidence.ttsOutputs[index].audioVersionEvidence.uid);
        }
        return {
        audioExecutionEvidenceUid: evidence.uid,
        audioExecutionSha256: evidence.executionSha256,
          audioAssetVersionUids,
        };
      })(),
    });
    const after = repositories.runs.getWorkflowWithNodes(intent.workflowRunUid);
    let allTerminal = true;
    for (let index = 0; index < after.nodes.length; index += 1) {
      if (after.nodes[index].status === 'succeeded' || after.nodes[index].status === 'skipped') {
        continue;
      }
      allTerminal = false;
      break;
    }
    if (allTerminal) {
      repositories.runs.transitionWorkflowStatus({
        uid: after.run.uid, expectedStatus: 'running', nextStatus: 'succeeded',
      });
    }
    return evidence;
  });

  return Object.freeze({
    get: readExecution,
    reservation: outputReservation,
    finalize(intent, outputs) {
      try {
        const trustedPlan = requireTrustedAudioModePlan(intent?.plan);
        const record = createAudioModeIntentRecord(intent, INPUT_CODE);
        if (serializeCanonicalJson(trustedPlan) !== serializeCanonicalJson(record.plan)) {
          fail(INPUT_CODE);
        }
        const trustedRecord = Object.freeze({ ...record, plan: trustedPlan });
        const prepared = denseArray(outputs, MAX_REQUESTS, INPUT_CODE);
        if (prepared.length !== trustedRecord.plan.ttsRequests.length || prepared.length < 1) {
          fail(INPUT_CODE);
        }
        finalizeTransaction.immediate(trustedRecord, prepared);
        return readExecution(trustedRecord.uid);
      } catch (error) {
        if (isAudioModeContractError(error)) throw error;
        return fail(DATA_CODE);
      }
    },
  });
}

function audioTtsProbeRecordValid(
  probeJson,
  assetUid,
  assetVersionUid,
  responseSha256,
  relativePath,
  mimeType,
  responseBytes,
  durationMs,
) {
  try {
    probeMatches(parseCanonicalJson(probeJson, 1024 * 1024), {
      assetUid,
      assetVersionUid,
      sha256: responseSha256,
      relativePath,
      mimeType,
      bytes: responseBytes,
      durationMs,
    });
    return 1;
  } catch {
    return 0;
  }
}

function audioTtsExecutionRecordValid(planJson, evidenceJson, executionSha256) {
  try {
    const plan = parseCanonicalJson(planJson, 32 * 1024 * 1024);
    const evidence = parsePersistedAudioExecutionEvidence(
      parseCanonicalJson(evidenceJson, 32 * 1024 * 1024), plan,
    );
    return evidence.executionSha256 === executionSha256 ? 1 : 0;
  } catch {
    return 0;
  }
}

module.exports = Object.freeze({
  audioTtsExecutionRecordValid,
  audioTtsProbeRecordValid,
  createAudioTtsOutputRepository,
  deterministicUid,
  executionUid,
  outputReservation,
});
