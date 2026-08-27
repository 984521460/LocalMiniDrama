const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  createMigratedV2Database,
  insertDrama,
  uid,
} = require('./helpers/v2RepositoryDatabase');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function seedSelection(repositories, dramaUid) {
  const documentUid = uid(5001);
  const blockUid = uid(5002);
  const selectionUid = uid(5003);
  repositories.sources.createDocumentWithBlocks({
    document: {
      uid: documentUid,
      dramaUid,
      sourceType: 'txt',
      originalName: 'workflow-source.txt',
      encoding: 'utf-8',
      contentSha256: sha256('source'),
      fullText: 'source',
    },
    blocks: [{
      uid: blockUid,
      ordinal: 0,
      headingPath: [],
      charStart: 0,
      charEnd: 6,
      text: 'source',
      textSha256: sha256('source'),
    }],
  });
  repositories.sources.createSelection({
    uid: selectionUid,
    documentUid,
    startBlockUid: blockUid,
    endBlockUid: blockUid,
    startOffset: 0,
    endOffset: 6,
    selectedTextSha256: sha256('source'),
  });
  return selectionUid;
}

function validGraph(selectionUid) {
  const sourceUid = uid(5011);
  const factsUid = uid(5012);
  const beatsUid = uid(5013);
  return {
    expectedRevision: 0,
    nodes: [
      {
        uid: sourceUid,
        nodeType: 'source.selection',
        position: { x: 0, y: 0 },
        config: {},
        domainRef: { type: 'source_selection', uid: selectionUid },
      },
      { uid: factsUid, nodeType: 'story.facts', position: { x: 200, y: 0 }, config: {} },
      { uid: beatsUid, nodeType: 'episode.adaptation', position: { x: 400, y: 0 }, config: {} },
    ],
    edges: [
      {
        uid: uid(5021),
        sourceNodeUid: sourceUid,
        sourcePort: 'selection',
        targetNodeUid: factsUid,
        targetPort: 'selection',
      },
      {
        uid: uid(5022),
        sourceNodeUid: factsUid,
        sourcePort: 'facts',
        targetNodeUid: beatsUid,
        targetPort: 'facts',
      },
    ],
  };
}

test('workflow service enforces graph ports, types, required inputs, cycles, and bound references', (t) => {
  const { createWorkflowService, isWorkflowError } = require('../src/workflows');
  const database = createMigratedV2Database(t);
  const dramaUid = uid(5000);
  insertDrama(database, dramaUid);
  const repositories = createV2Repositories(database);
  const selectionUid = seedSelection(repositories, dramaUid);
  const service = createWorkflowService({ repositories, createUid: () => uid(5010) });
  const workflow = service.createWorkflow({ dramaId: 1, name: 'Validated graph' });

  const saved = service.replaceGraph(workflow.definition.uid, validGraph(selectionUid));
  assert.equal(saved.definition.graphRevision, 1);

  const invalidGraphs = [];
  const missingReference = validGraph(uid(5999));
  missingReference.expectedRevision = 1;
  invalidGraphs.push(missingReference);

  const wrongReferenceType = validGraph(selectionUid);
  wrongReferenceType.expectedRevision = 1;
  wrongReferenceType.nodes[0].domainRef.type = 'source_document';
  invalidGraphs.push(wrongReferenceType);

  const missingRequired = validGraph(selectionUid);
  missingRequired.expectedRevision = 1;
  missingRequired.edges.shift();
  invalidGraphs.push(missingRequired);

  const incompatible = validGraph(selectionUid);
  incompatible.expectedRevision = 1;
  incompatible.edges[0].targetNodeUid = incompatible.nodes[2].uid;
  incompatible.edges[0].targetPort = 'facts';
  invalidGraphs.push(incompatible);

  const cycle = validGraph(selectionUid);
  cycle.expectedRevision = 1;
  cycle.edges.push({
    uid: uid(5023),
    sourceNodeUid: cycle.nodes[2].uid,
    sourcePort: 'beats',
    targetNodeUid: cycle.nodes[1].uid,
    targetPort: 'selection',
  });
  invalidGraphs.push(cycle);

  for (const graph of invalidGraphs) {
    assert.throws(() => service.replaceGraph(workflow.definition.uid, graph), (error) => {
      assert.equal(isWorkflowError(error), true);
      assert.equal(error.code, 'WORKFLOW_GRAPH_INVALID');
      return true;
    });
  }
  assert.deepEqual(service.getWorkflow(workflow.definition.uid), saved);
});
