'use strict';

const { isComfyWorkflowManifest, validateStoredComfyWorkflowManifest } = require('../../remote/workflowManifest');
const { createComfyManifestError } = require('../../remote/comfyManifestErrors');
const { V2RepositoryDataError } = require('./errors');
const { assertDatabase, executeWrite, requiredRow } = require('./repositorySupport');

const ENTITY = 'ComfyUI workflow manifest';

function parseCanonicalJson(raw, field) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new V2RepositoryDataError(ENTITY, field); }
  if (JSON.stringify(value) !== raw) throw new V2RepositoryDataError(ENTITY, field);
  return value;
}

function createComfyManifestRepository(database) {
  assertDatabase(database);
  const insert = database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES
      (@uid, @manifestId, @version, @engine, @workflowFile, @workflowSha256, @modelFamily,
       @requirementsJson, @inputsJson, @outputsJson, @validationJson, @status)
  `);
  const getRow = database.prepare(`
    SELECT uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
           requirements_json, inputs_json, outputs_json, validation_json, status
    FROM workflow_manifests WHERE uid = ?
  `);
  const findRow = database.prepare(`
    SELECT uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
           requirements_json, inputs_json, outputs_json, validation_json, status
    FROM workflow_manifests WHERE manifest_id = ? AND version = ?
  `);

  function mapRow(row) {
    const candidate = {
      schemaVersion: 'comfy-workflow-manifest.v1',
      uid: row.uid,
      manifestId: row.manifest_id,
      version: row.version,
      engine: row.engine,
      workflowFile: row.workflow_file,
      workflowSha256: row.workflow_sha256,
      modelFamily: row.model_family,
      requirements: parseCanonicalJson(row.requirements_json, 'requirements_json'),
      inputs: parseCanonicalJson(row.inputs_json, 'inputs_json'),
      outputs: parseCanonicalJson(row.outputs_json, 'outputs_json'),
      validation: parseCanonicalJson(row.validation_json, 'validation_json'),
      status: row.status,
    };
    try { return validateStoredComfyWorkflowManifest(candidate); } catch {
      throw new V2RepositoryDataError(ENTITY, 'record');
    }
  }

  function get(uid) {
    return mapRow(requiredRow(getRow.get(uid), ENTITY, uid));
  }

  return Object.freeze({
    create(manifest) {
      if (!isComfyWorkflowManifest(manifest)) {
        throw createComfyManifestError('COMFY_MANIFEST_INVALID');
      }
      executeWrite(ENTITY, 'created', () => insert.run({
        ...manifest,
        requirementsJson: JSON.stringify(manifest.requirements),
        inputsJson: JSON.stringify(manifest.inputs),
        outputsJson: JSON.stringify(manifest.outputs),
        validationJson: JSON.stringify(manifest.validation),
      }));
      return get(manifest.uid);
    },
    find(manifestId, version) {
      const row = findRow.get(manifestId, version);
      return row ? mapRow(row) : null;
    },
    get,
  });
}

module.exports = Object.freeze({ createComfyManifestRepository });
