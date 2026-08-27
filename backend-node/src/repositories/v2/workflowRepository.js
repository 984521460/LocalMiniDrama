const { executeWrite, requiredRow } = require('./repositorySupport');
const { freezeSnapshot, mapRow, mapRows, serializeJson } = require('./rowMapping');

const DEFINITION_MAP = Object.freeze({ entity: 'workflow definition' });
const NODE_MAP = Object.freeze({
  entity: 'canvas node',
  jsonFields: Object.freeze({
    position_json: 'position',
    config_json: 'config',
  }),
  jsonKinds: Object.freeze({
    position_json: 'object',
    config_json: 'object',
  }),
});
const EDGE_MAP = Object.freeze({ entity: 'canvas edge' });
const MANIFEST_MAP = Object.freeze({
  entity: 'workflow manifest',
  jsonFields: Object.freeze({
    requirements_json: 'requirements',
    inputs_json: 'inputs',
    outputs_json: 'outputs',
    validation_json: 'validation',
  }),
  jsonKinds: Object.freeze({
    requirements_json: 'array',
    inputs_json: 'object',
    outputs_json: 'object',
    validation_json: 'object',
  }),
});

function createWorkflowRepository(database) {
  const insertDefinition = database.prepare(`
    INSERT INTO workflow_definitions
      (uid, drama_uid, name, version, status, description)
    VALUES
      (@uid, @dramaUid, @name, @version, @status, @description)
  `);
  const insertNode = database.prepare(`
    INSERT INTO canvas_nodes
      (uid, workflow_uid, node_type, position_json, config_json,
       domain_ref_type, domain_ref_uid, status)
    VALUES
      (@uid, @workflowUid, @nodeType, @positionJson, @configJson,
       @domainRefType, @domainRefUid, @status)
  `);
  const insertEdge = database.prepare(`
    INSERT INTO canvas_edges
      (uid, workflow_uid, source_node_uid, source_port, target_node_uid, target_port)
    VALUES
      (@uid, @workflowUid, @sourceNodeUid, @sourcePort, @targetNodeUid, @targetPort)
  `);
  const insertManifest = database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES
      (@uid, @manifestId, @version, @engine, @workflowFile, @workflowSha256, @modelFamily,
       @requirementsJson, @inputsJson, @outputsJson, @validationJson, @status)
  `);
  const getDefinitionRow = database.prepare('SELECT * FROM workflow_definitions WHERE uid = ?');
  const getManifestRow = database.prepare('SELECT * FROM workflow_manifests WHERE uid = ?');
  const findManifestRow = database.prepare(`
    SELECT * FROM workflow_manifests WHERE manifest_id = ? AND version = ?
  `);
  const listDefinitionRows = database.prepare(`
    SELECT * FROM workflow_definitions WHERE drama_uid = ? ORDER BY name, version, uid
  `);
  const listNodeRows = database.prepare(`
    SELECT * FROM canvas_nodes WHERE workflow_uid = ? ORDER BY created_at, uid
  `);
  const listEdgeRows = database.prepare(`
    SELECT * FROM canvas_edges WHERE workflow_uid = ? ORDER BY created_at, uid
  `);

  const insertGraph = database.transaction(({ definition, nodes, edges }) => {
    insertDefinition.run(definition);
    for (const node of nodes) {
      insertNode.run({
        ...node,
        workflowUid: definition.uid,
        positionJson: serializeJson(node.position, {}),
        configJson: serializeJson(node.config, {}),
      });
    }
    for (const edge of edges) insertEdge.run({ ...edge, workflowUid: definition.uid });
  });

  function getDefinition(uid) {
    return mapRow(requiredRow(getDefinitionRow.get(uid), 'workflow definition', uid), DEFINITION_MAP);
  }

  function getManifest(uid) {
    return mapRow(requiredRow(getManifestRow.get(uid), 'workflow manifest', uid), MANIFEST_MAP);
  }

  function getGraph(uid) {
    return freezeSnapshot({
      definition: getDefinition(uid),
      nodes: mapRows(listNodeRows.all(uid), NODE_MAP),
      edges: mapRows(listEdgeRows.all(uid), EDGE_MAP),
    });
  }

  return Object.freeze({
    createGraph({ definition, nodes = [], edges = [] }) {
      executeWrite('workflow graph', 'created', () => insertGraph({ definition, nodes, edges }));
      return getGraph(definition.uid);
    },

    createManifest(manifest) {
      const persisted = {
        ...manifest,
        requirementsJson: serializeJson(manifest.requirements, []),
        inputsJson: serializeJson(manifest.inputs, {}),
        outputsJson: serializeJson(manifest.outputs, {}),
        validationJson: serializeJson(manifest.validation, {}),
      };
      executeWrite('workflow manifest', 'created', () => insertManifest.run(persisted));
      return getManifest(manifest.uid);
    },

    findManifest(manifestId, version) {
      const row = findManifestRow.get(manifestId, version);
      return row ? mapRow(row, MANIFEST_MAP) : null;
    },

    getDefinition,
    getGraph,
    getManifest,

    listByDrama(dramaUid) {
      return mapRows(listDefinitionRows.all(dramaUid), DEFINITION_MAP);
    },
  });
}

module.exports = { createWorkflowRepository };
