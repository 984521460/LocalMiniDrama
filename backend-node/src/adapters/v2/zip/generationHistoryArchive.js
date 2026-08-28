const {
  createAssetVersionSelectionEvent,
  createGenerationHistoryRecord,
  createPromptSemanticVersionRecord,
} = require('../../../assets/generationHistory');
const {
  assetVersionEvidenceFromRow,
  assetVersionEvidenceMatches,
  parseCanonicalAssetVersionEvidenceJson,
} = require('../../../assets/assetVersionEvidence');
const { archiveError } = require('./errors');

const GENERATION_HISTORY_RECORD_SPECS = Object.freeze({
  workflowManifests: Object.freeze({
    table: 'workflow_manifests',
    columns: Object.freeze([
      'uid', 'manifest_id', 'version', 'engine', 'workflow_file', 'workflow_sha256',
      'model_family', 'requirements_json', 'inputs_json', 'outputs_json',
      'validation_json', 'status', 'created_at', 'updated_at',
    ]),
    json: Object.freeze({
      requirements_json: 'array',
      inputs_json: 'object',
      outputs_json: 'object',
      validation_json: 'object',
    }),
  }),
  promptSemanticVersions: Object.freeze({
    table: 'prompt_semantic_versions',
    columns: Object.freeze([
      'uid', 'drama_uid', 'shot_result_uid', 'shot_result_hash', 'shot_envelope_hash',
      'shot_approval_ref', 'semantic_sha256', 'semantic_json', 'created_at_epoch_ms',
    ]),
    json: Object.freeze({ semantic_json: 'object' }),
  }),
  assetGenerationHistory: Object.freeze({
    table: 'asset_generation_history',
    columns: Object.freeze([
      'uid', 'run_uid', 'drama_uid', 'asset_uid', 'prompt_semantic_uid', 'manifest_uid',
      'manifest_sha256', 'provider', 'model', 'seed', 'parameters_json',
      'parameters_sha256', 'input_json', 'input_sha256', 'status', 'output_version_uid',
      'parent_version_uid', 'output_version_evidence_json', 'parent_version_evidence_json',
      'error_code', 'error_detail_ref', 'created_at_epoch_ms', 'completed_at_epoch_ms',
    ]),
    json: Object.freeze({
      parameters_json: 'object',
      input_json: 'object',
      output_version_evidence_json: 'object?',
      parent_version_evidence_json: 'object?',
    }),
  }),
  assetVersionSelectionEvents: Object.freeze({
    table: 'asset_version_selection_events',
    columns: Object.freeze([
      'uid', 'history_uid', 'asset_uid', 'selected_version_uid', 'previous_version_uid',
      'state_version', 'changed_at_epoch_ms',
    ]),
  }),
});

function invalidArchive() {
  throw archiveError('PROJECT_ARCHIVE_MANIFEST_INVALID');
}

function timestampEpoch(value) {
  if (typeof value !== 'string' || value.length !== 24) invalidArchive();
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) invalidArchive();
  return parsed;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return invalidArchive();
  }
}

function promptRecord(row) {
  const record = createPromptSemanticVersionRecord({
    uid: row.uid,
    semantic: parseJson(row.semantic_json),
    createdAtEpochMs: row.created_at_epoch_ms,
  }, 'GENERATION_HISTORY_DATA_INVALID');
  if (record.dramaUid !== row.drama_uid
    || record.shotResultUid !== row.shot_result_uid
    || record.shotResultHash !== row.shot_result_hash
    || record.shotEnvelopeHash !== row.shot_envelope_hash
    || record.shotApprovalRef !== row.shot_approval_ref
    || record.semanticSha256 !== row.semantic_sha256) invalidArchive();
  return record;
}

function historyRecord(row) {
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
    parameters: parseJson(row.parameters_json),
    input: parseJson(row.input_json),
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
    || record.inputSha256 !== row.input_sha256) invalidArchive();
  return record;
}

function selectionRecord(row) {
  return createAssetVersionSelectionEvent({
    uid: row.uid,
    historyUid: row.history_uid,
    assetUid: row.asset_uid,
    selectedVersionUid: row.selected_version_uid,
    previousVersionUid: row.previous_version_uid,
    stateVersion: row.state_version,
    changedAtEpochMs: row.changed_at_epoch_ms,
  }, 'GENERATION_HISTORY_DATA_INVALID');
}

function validateGenerationHistoryArchive({
  records,
  project,
  assetByUid,
  versionByUid,
  generationRunByUid,
}) {
  try {
    const manifestByUid = new Map(records.workflowManifests.map((row) => [row.uid, row]));
    const promptByUid = new Map(records.promptSemanticVersions.map((row) => {
      const prompt = promptRecord(row);
      if (prompt.dramaUid !== project.dramaUid) invalidArchive();
      return [prompt.uid, prompt];
    }));
    const historyByUid = new Map();
    const referencedPrompts = new Set();
    const referencedManifests = new Set();
    for (const row of records.assetGenerationHistory) {
      const history = historyRecord(row);
      const prompt = promptByUid.get(history.promptSemanticUid);
      const manifest = manifestByUid.get(history.manifestUid);
      const run = generationRunByUid.get(history.runUid);
      const asset = assetByUid.get(history.assetUid);
      if (!prompt || !manifest || !run || !asset
        || history.dramaUid !== project.dramaUid
        || prompt.dramaUid !== history.dramaUid
        || manifest.status !== 'validated'
        || manifest.workflow_sha256 !== history.manifestSha256
        || run.owner_type !== asset.owner_type
        || run.owner_uid !== asset.owner_uid
        || run.prompt_version_uid !== history.promptSemanticUid
        || run.provider !== history.provider
        || run.model !== history.model
        || run.seed !== history.seed
        || run.parameters_json !== row.parameters_json
        || run.input_json !== row.input_json
        || run.status !== history.status
        || run.output_asset_version_uid !== history.outputVersionUid
        || run.error_code !== history.errorCode
        || run.error_detail_ref !== history.errorDetailRef
        || timestampEpoch(run.created_at) !== history.createdAtEpochMs
        || timestampEpoch(run.completed_at) !== history.completedAtEpochMs) invalidArchive();
      if (history.status === 'succeeded') {
        const output = versionByUid.get(history.outputVersionUid);
        if (!output || !assetVersionEvidenceMatches(
          assetVersionEvidenceFromRow(output),
          history.outputVersionEvidence,
        )) invalidArchive();
      }
      if (history.parentVersionUid !== null) {
        const parent = versionByUid.get(history.parentVersionUid);
        if (!parent || !assetVersionEvidenceMatches(
          assetVersionEvidenceFromRow(parent),
          history.parentVersionEvidence,
        )) invalidArchive();
      }
      historyByUid.set(history.uid, history);
      referencedPrompts.add(history.promptSemanticUid);
      referencedManifests.add(history.manifestUid);
    }
    if (referencedPrompts.size !== promptByUid.size
      || referencedManifests.size !== manifestByUid.size) invalidArchive();
    for (const run of records.generationRuns) {
      if (run.prompt_version_uid !== null && !promptByUid.has(run.prompt_version_uid)) {
        invalidArchive();
      }
    }

    const selectionsByAsset = new Map();
    for (const row of records.assetVersionSelectionEvents) {
      const event = selectionRecord(row);
      const history = historyByUid.get(event.historyUid);
      const selected = versionByUid.get(event.selectedVersionUid);
      const previous = event.previousVersionUid === null
        ? null
        : versionByUid.get(event.previousVersionUid);
      if (!history
        || history.status !== 'succeeded'
        || history.assetUid !== event.assetUid
        || history.outputVersionUid !== event.selectedVersionUid
        || !selected
        || selected.asset_uid !== event.assetUid
        || (previous !== null && previous.asset_uid !== event.assetUid)) invalidArchive();
      const events = selectionsByAsset.get(event.assetUid) || [];
      events.push(event);
      selectionsByAsset.set(event.assetUid, events);
    }
    for (const [assetUid, events] of selectionsByAsset) {
      events.sort((left, right) => left.stateVersion - right.stateVersion);
      for (let index = 0; index < events.length; index += 1) {
        if (events[index].stateVersion !== index + 1
          || (index > 0 && events[index].previousVersionUid !== events[index - 1].selectedVersionUid)
          || (index > 0 && events[index].changedAtEpochMs < events[index - 1].changedAtEpochMs)
          || events[index].changedAtEpochMs < historyByUid.get(events[index].historyUid).completedAtEpochMs) {
          invalidArchive();
        }
      }
      if (assetByUid.get(assetUid)?.current_version_uid !== events.at(-1).selectedVersionUid) {
        invalidArchive();
      }
    }
    return Object.freeze({ historyByUid, promptByUid, selectionsByAsset });
  } catch (error) {
    if (error?.code === 'PROJECT_ARCHIVE_MANIFEST_INVALID') throw error;
    return invalidArchive();
  }
}

module.exports = {
  GENERATION_HISTORY_RECORD_SPECS,
  validateGenerationHistoryArchive,
};
