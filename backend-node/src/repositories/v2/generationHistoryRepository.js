const { types: { isProxy } } = require('node:util');

const {
  assetVersionEvidenceFromRow,
  assetVersionEvidenceMatches,
  parseCanonicalAssetVersionEvidenceJson,
} = require('../../assets/assetVersionEvidence');
const {
  createAssetVersionSelectionEvent,
  createGenerationHistoryRecord,
  createPromptSemanticVersionRecord,
} = require('../../assets/generationHistory');
const {
  isPromptSemanticVersioningResult,
} = require('../../narrative/promptSemanticVersioning');
const {
  V2RepositoryConflictError,
  V2RepositoryDataError,
} = require('./errors');
const { executeWrite, requiredRow } = require('./repositorySupport');

function invalidData() {
  throw new V2RepositoryDataError('generation history', 'persisted record');
}

function timestampEpoch(value) {
  if (typeof value !== 'string' || value.length !== 24) invalidData();
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) invalidData();
  return parsed;
}

function safeSemanticValue(value) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'semantic');
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    return descriptor.value;
  } catch {
    return null;
  }
}

function historyContractInput(record, overrides = {}) {
  return {
    uid: record.uid,
    runUid: record.runUid,
    dramaUid: record.dramaUid,
    assetUid: record.assetUid,
    promptSemanticUid: record.promptSemanticUid,
    manifestUid: record.manifestUid,
    manifestSha256: record.manifestSha256,
    provider: record.provider,
    model: record.model,
    seed: record.seed,
    parameters: record.parameters,
    input: record.input,
    status: record.status,
    outputVersionUid: record.outputVersionUid,
    outputVersionEvidence: record.outputVersionEvidence,
    parentVersionUid: record.parentVersionUid,
    parentVersionEvidence: record.parentVersionEvidence,
    errorCode: record.errorCode,
    errorDetailRef: record.errorDetailRef,
    createdAtEpochMs: record.createdAtEpochMs,
    completedAtEpochMs: record.completedAtEpochMs,
    ...overrides,
  };
}

function createGenerationHistoryRepository(database, {
  requireApprovedShot,
} = {}) {
  if (typeof requireApprovedShot !== 'function') {
    throw new TypeError('Generation history approval gate is invalid');
  }
  let statements;

  function getStatements() {
    if (statements) return statements;
    statements = Object.freeze({
      asset: database.prepare('SELECT * FROM assets WHERE uid = ?'),
      getHistory: database.prepare('SELECT * FROM asset_generation_history WHERE uid = ?'),
      getManifest: database.prepare(`
        SELECT uid, workflow_sha256, status FROM workflow_manifests WHERE uid = ?
      `),
      getPrompt: database.prepare('SELECT * FROM prompt_semantic_versions WHERE uid = ?'),
      getRun: database.prepare('SELECT * FROM generation_runs WHERE uid = ?'),
      getVersion: database.prepare('SELECT * FROM asset_versions WHERE uid = ?'),
      insertHistory: database.prepare(`
        INSERT INTO asset_generation_history
          (uid, run_uid, drama_uid, asset_uid, prompt_semantic_uid, manifest_uid,
           manifest_sha256, provider, model, seed, parameters_json, parameters_sha256,
           input_json, input_sha256, status, output_version_uid, parent_version_uid,
           output_version_evidence_json, parent_version_evidence_json,
           error_code, error_detail_ref, created_at_epoch_ms, completed_at_epoch_ms)
        VALUES
          (@uid, @runUid, @dramaUid, @assetUid, @promptSemanticUid, @manifestUid,
           @manifestSha256, @provider, @model, @seed, @parametersJson, @parametersSha256,
           @inputJson, @inputSha256, @status, @outputVersionUid, @parentVersionUid,
           @outputVersionEvidenceJson, @parentVersionEvidenceJson,
           @errorCode, @errorDetailRef, @createdAtEpochMs, @completedAtEpochMs)
      `),
      insertPrompt: database.prepare(`
        INSERT INTO prompt_semantic_versions
          (uid, drama_uid, shot_result_uid, shot_result_hash, shot_envelope_hash,
           shot_approval_ref, semantic_sha256, semantic_json, created_at_epoch_ms)
        VALUES
          (@uid, @dramaUid, @shotResultUid, @shotResultHash, @shotEnvelopeHash,
           @shotApprovalRef, @semanticSha256, @semanticJson, @createdAtEpochMs)
      `),
      insertSelection: database.prepare(`
        INSERT INTO asset_version_selection_events
          (uid, history_uid, asset_uid, selected_version_uid, previous_version_uid,
           state_version, changed_at_epoch_ms)
        VALUES
          (@uid, @historyUid, @assetUid, @selectedVersionUid, @previousVersionUid,
           @stateVersion, @changedAtEpochMs)
      `),
      listHistory: database.prepare(`
        SELECT * FROM asset_generation_history
        WHERE asset_uid = ? ORDER BY completed_at_epoch_ms, uid
      `),
      listSelections: database.prepare(`
        SELECT * FROM asset_version_selection_events
        WHERE asset_uid = ? ORDER BY state_version
      `),
    });
    return statements;
  }

  function mapPrompt(row) {
    try {
      const record = createPromptSemanticVersionRecord({
        uid: row.uid,
        semantic: JSON.parse(row.semantic_json),
        createdAtEpochMs: row.created_at_epoch_ms,
      }, 'GENERATION_HISTORY_DATA_INVALID');
      if (record.dramaUid !== row.drama_uid
        || record.shotResultUid !== row.shot_result_uid
        || record.shotResultHash !== row.shot_result_hash
        || record.shotEnvelopeHash !== row.shot_envelope_hash
        || record.shotApprovalRef !== row.shot_approval_ref
        || record.semanticSha256 !== row.semantic_sha256) invalidData();
      return record;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function mapHistory(row) {
    try {
      const record = createGenerationHistoryRecord({
        uid: row.uid,
        runUid: row.run_uid,
        dramaUid: row.drama_uid,
        assetUid: row.asset_uid,
        promptSemanticUid: row.prompt_semantic_uid,
        manifestUid: row.manifest_uid,
        manifestSha256: row.manifest_sha256,
        provider: row.provider,
        model: row.model,
        seed: row.seed,
        parameters: JSON.parse(row.parameters_json),
        input: JSON.parse(row.input_json),
        status: row.status,
        outputVersionUid: row.output_version_uid,
        outputVersionEvidence: row.output_version_evidence_json === null
          ? null
          : parseCanonicalAssetVersionEvidenceJson(row.output_version_evidence_json),
        parentVersionUid: row.parent_version_uid,
        parentVersionEvidence: row.parent_version_evidence_json === null
          ? null
          : parseCanonicalAssetVersionEvidenceJson(row.parent_version_evidence_json),
        errorCode: row.error_code,
        errorDetailRef: row.error_detail_ref,
        createdAtEpochMs: row.created_at_epoch_ms,
        completedAtEpochMs: row.completed_at_epoch_ms,
      }, 'GENERATION_HISTORY_DATA_INVALID');
      if (record.parametersSha256 !== row.parameters_sha256
        || record.inputSha256 !== row.input_sha256) invalidData();
      return record;
    } catch (error) {
      if (error instanceof V2RepositoryDataError) throw error;
      return invalidData();
    }
  }

  function mapSelection(row) {
    try {
      return createAssetVersionSelectionEvent({
        uid: row.uid,
        historyUid: row.history_uid,
        assetUid: row.asset_uid,
        selectedVersionUid: row.selected_version_uid,
        previousVersionUid: row.previous_version_uid,
        stateVersion: row.state_version,
        changedAtEpochMs: row.changed_at_epoch_ms,
      }, 'GENERATION_HISTORY_DATA_INVALID');
    } catch {
      return invalidData();
    }
  }

  function assertHistoryReferences(record) {
    const prepared = getStatements();
    const promptRow = prepared.getPrompt.get(record.promptSemanticUid);
    const manifest = prepared.getManifest.get(record.manifestUid);
    const run = prepared.getRun.get(record.runUid);
    const asset = prepared.asset.get(record.assetUid);
    if (!promptRow || !manifest || !run || !asset) invalidData();
    const prompt = mapPrompt(promptRow);
    if (prompt.dramaUid !== record.dramaUid
      || manifest.status !== 'validated'
      || manifest.workflow_sha256 !== record.manifestSha256
      || run.prompt_version_uid !== record.promptSemanticUid
      || run.owner_type !== asset.owner_type
      || run.owner_uid !== asset.owner_uid) invalidData();
    let sourceRecord;
    try {
      sourceRecord = createGenerationHistoryRecord(historyContractInput(record, {
        provider: run.provider,
        model: run.model,
        seed: run.seed,
        parameters: JSON.parse(run.parameters_json),
        input: JSON.parse(run.input_json),
        status: run.status,
        outputVersionUid: run.output_asset_version_uid,
        errorCode: run.error_code,
        errorDetailRef: run.error_detail_ref,
      }), 'GENERATION_HISTORY_DATA_INVALID');
    } catch {
      return invalidData();
    }
    if (sourceRecord.provider !== record.provider
      || sourceRecord.model !== record.model
      || sourceRecord.seed !== record.seed
      || sourceRecord.parametersSha256 !== record.parametersSha256
      || sourceRecord.inputSha256 !== record.inputSha256
      || sourceRecord.status !== record.status
      || sourceRecord.outputVersionUid !== record.outputVersionUid
      || sourceRecord.errorCode !== record.errorCode
      || sourceRecord.errorDetailRef !== record.errorDetailRef
      || record.createdAtEpochMs !== timestampEpoch(run.created_at)
      || record.completedAtEpochMs !== timestampEpoch(run.completed_at)) invalidData();
    if (record.status === 'succeeded') {
      const output = prepared.getVersion.get(record.outputVersionUid);
      let outputEvidence;
      try {
        outputEvidence = assetVersionEvidenceFromRow(output);
      } catch {
        return invalidData();
      }
      if (!assetVersionEvidenceMatches(outputEvidence, record.outputVersionEvidence)) invalidData();
    }
    if (record.parentVersionUid !== null) {
      const parent = prepared.getVersion.get(record.parentVersionUid);
      let parentEvidence;
      try {
        parentEvidence = assetVersionEvidenceFromRow(parent);
      } catch {
        return invalidData();
      }
      if (!assetVersionEvidenceMatches(parentEvidence, record.parentVersionEvidence)) invalidData();
    }
    return record;
  }

  function getPrompt(uid) {
    return mapPrompt(requiredRow(
      getStatements().getPrompt.get(uid),
      'prompt semantic version',
      uid,
    ));
  }

  function get(uid) {
    return assertHistoryReferences(mapHistory(requiredRow(
      getStatements().getHistory.get(uid),
      'generation history',
      uid,
    )));
  }

  const appendTransaction = database.transaction((promptInput, historyInput, existingOnly = false) => {
    let prompt;
    if (existingOnly) {
      prompt = mapPrompt(requiredRow(
        getStatements().getPrompt.get(promptInput),
        'prompt semantic version',
        promptInput,
      ));
    } else {
      const originalSemantic = safeSemanticValue(promptInput);
      if (!isPromptSemanticVersioningResult(originalSemantic)) {
        throw new V2RepositoryConflictError('prompt semantic version', 'validated');
      }
      prompt = createPromptSemanticVersionRecord(promptInput);
    }
    const history = createGenerationHistoryRecord(historyInput);
    if (history.promptSemanticUid !== prompt.uid || history.dramaUid !== prompt.dramaUid) {
      throw new V2RepositoryConflictError('generation history', 'referenced');
    }
    const approved = requireApprovedShot(prompt.shotResultUid);
    if (approved.approval.resultHash !== prompt.shotResultHash
      || approved.approval.envelopeHash !== prompt.shotEnvelopeHash
      || approved.approval.reviewRef !== prompt.shotApprovalRef) {
      throw new V2RepositoryConflictError('prompt semantic version', 'approved');
    }
    const prepared = getStatements();
    const manifest = requiredRow(
      prepared.getManifest.get(history.manifestUid),
      'workflow manifest',
      history.manifestUid,
    );
    if (manifest.status !== 'validated' || manifest.workflow_sha256 !== history.manifestSha256) {
      throw new V2RepositoryConflictError('workflow manifest', 'validated');
    }
    const run = requiredRow(prepared.getRun.get(history.runUid), 'generation run', history.runUid);
    let runParameters;
    let runInput;
    try {
      runParameters = JSON.parse(run.parameters_json);
      runInput = JSON.parse(run.input_json);
    } catch {
      return invalidData();
    }
    const sourceRecord = createGenerationHistoryRecord(historyContractInput(history, {
      provider: run.provider,
      model: run.model,
      seed: run.seed,
      parameters: runParameters,
      input: runInput,
      status: run.status,
      outputVersionUid: run.output_asset_version_uid,
      errorCode: run.error_code,
      errorDetailRef: run.error_detail_ref,
    }));
    if (sourceRecord.parametersSha256 !== history.parametersSha256
      || sourceRecord.inputSha256 !== history.inputSha256
      || sourceRecord.promptSemanticUid !== history.promptSemanticUid
      || run.prompt_version_uid !== history.promptSemanticUid
      || history.createdAtEpochMs !== timestampEpoch(run.created_at)
      || history.completedAtEpochMs !== timestampEpoch(run.completed_at)) {
      throw new V2RepositoryConflictError('generation run', 'matched');
    }
    const asset = requiredRow(prepared.asset.get(history.assetUid), 'asset', history.assetUid);
    if (run.owner_type !== asset.owner_type || run.owner_uid !== asset.owner_uid) {
      throw new V2RepositoryConflictError('generation run', 'owned');
    }
    if (history.status === 'succeeded') {
      const output = requiredRow(
        prepared.getVersion.get(history.outputVersionUid),
        'asset version',
        history.outputVersionUid,
      );
      let outputEvidence;
      try {
        outputEvidence = assetVersionEvidenceFromRow(output);
      } catch {
        return invalidData();
      }
      if (!assetVersionEvidenceMatches(outputEvidence, history.outputVersionEvidence)) {
        throw new V2RepositoryConflictError('asset version', 'referenced');
      }
    }
    if (history.parentVersionUid !== null) {
      const parent = requiredRow(
        prepared.getVersion.get(history.parentVersionUid),
        'asset version',
        history.parentVersionUid,
      );
      let parentEvidence;
      try {
        parentEvidence = assetVersionEvidenceFromRow(parent);
      } catch {
        return invalidData();
      }
      if (!assetVersionEvidenceMatches(parentEvidence, history.parentVersionEvidence)) {
        throw new V2RepositoryConflictError('asset version', 'referenced');
      }
    }
    const existingPrompt = prepared.getPrompt.get(prompt.uid);
    if (existingPrompt) {
      const persistedPrompt = mapPrompt(existingPrompt);
      if (persistedPrompt.semanticSha256 !== prompt.semanticSha256
        || persistedPrompt.createdAtEpochMs !== prompt.createdAtEpochMs) {
        throw new V2RepositoryConflictError('prompt semantic version', 'matched');
      }
    } else {
      prepared.insertPrompt.run({ ...prompt, semanticJson: JSON.stringify(prompt.semantic) });
    }
    prepared.insertHistory.run({
      ...history,
      parametersJson: run.parameters_json,
      inputJson: run.input_json,
      outputVersionEvidenceJson: history.outputVersionEvidence === null
        ? null
        : JSON.stringify(history.outputVersionEvidence),
      parentVersionEvidenceJson: history.parentVersionEvidence === null
        ? null
        : JSON.stringify(history.parentVersionEvidence),
    });
    return history.uid;
  });

  function getSelectionState(assetUid) {
    const prepared = getStatements();
    const asset = requiredRow(prepared.asset.get(assetUid), 'asset', assetUid);
    const events = readSelectionEvents(assetUid);
    if (events.length === 0) {
      return Object.freeze({
        assetUid,
        selectedVersionUid: asset.current_version_uid,
        stateVersion: 0,
        latestEvent: null,
      });
    }
    const event = events.at(-1);
    if (asset.current_version_uid !== event.selectedVersionUid) invalidData();
    return Object.freeze({
      assetUid,
      selectedVersionUid: event.selectedVersionUid,
      stateVersion: event.stateVersion,
      latestEvent: event,
    });
  }

  function readSelectionEvents(assetUid) {
    const events = getStatements().listSelections.all(assetUid).map(mapSelection);
    let previousEvent = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const history = get(event.historyUid);
      if (event.assetUid !== assetUid
        || event.stateVersion !== index + 1
        || history.status !== 'succeeded'
        || history.assetUid !== assetUid
        || history.outputVersionUid !== event.selectedVersionUid
        || (previousEvent !== null
          && event.previousVersionUid !== previousEvent.selectedVersionUid)
        || (previousEvent !== null
          && event.changedAtEpochMs < previousEvent.changedAtEpochMs)
        || event.changedAtEpochMs < history.completedAtEpochMs) invalidData();
      previousEvent = event;
    }
    return Object.freeze(events);
  }

  return Object.freeze({
    append(promptSemanticInput, historyInput) {
      let uid;
      executeWrite('generation history', 'created', () => {
        uid = appendTransaction(promptSemanticInput, historyInput);
        return { changes: 1 };
      });
      return get(uid);
    },

    appendPrepared(promptSemanticUid, historyInput) {
      let uid;
      executeWrite('generation history', 'created', () => {
        uid = appendTransaction(promptSemanticUid, historyInput, true);
        return { changes: 1 };
      });
      return get(uid);
    },

    get,
    getPrompt,

    getSelectionState,

    listByAsset(assetUid) {
      requiredRow(getStatements().asset.get(assetUid), 'asset', assetUid);
      return Object.freeze(
        getStatements().listHistory.all(assetUid).map(mapHistory).map(assertHistoryReferences),
      );
    },

    listSelections(assetUid) {
      requiredRow(getStatements().asset.get(assetUid), 'asset', assetUid);
      return readSelectionEvents(assetUid);
    },

    select(input) {
      const event = createAssetVersionSelectionEvent(input);
      executeWrite('asset version selection', 'created', () => (
        getStatements().insertSelection.run({
          uid: event.uid,
          historyUid: event.historyUid,
          assetUid: event.assetUid,
          selectedVersionUid: event.selectedVersionUid,
          previousVersionUid: event.previousVersionUid,
          stateVersion: event.stateVersion,
          changedAtEpochMs: event.changedAtEpochMs,
        })
      ));
      return getSelectionState(event.assetUid);
    },
  });
}

module.exports = { createGenerationHistoryRepository };
