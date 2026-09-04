'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createV2Repositories } = require('../src/repositories/v2');
const {
  persistApprovedRainNarrativeChain,
  setupRainBeforeClearSource,
} = require('./fixtures/narrative/rainBeforeClearSource');
const { uid } = require('./helpers/v2RepositoryDatabase');

function testConfig(tempRoot) {
  const configDir = path.join(tempRoot, 'configs');
  const databasePath = path.join(tempRoot, 'data', 'workflow.sqlite').replace(/\\/gu, '/');
  const storagePath = path.join(tempRoot, 'storage').replace(/\\/gu, '/');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.yaml'), [
    'app:',
    '  name: LocalMiniDrama-Workflow-Canvas',
    '  version: 0.0.0-test',
    'server:',
    '  port: 0',
    '  host: 127.0.0.1',
    '  insecure_tls: false',
    'database:',
    '  type: sqlite',
    `  path: "${databasePath}"`,
    'storage:',
    `  local_path: "${storagePath}"`,
    '',
  ].join('\n'), 'utf8');
}

function apiNode(nodeUid, nodeType, x, domainRef) {
  return {
    uid: nodeUid,
    node_type: nodeType,
    position: { x, y: 0 },
    config: {},
    domain_ref: domainRef,
    status: 'ready',
  };
}

function apiEdge(edgeUid, sourceNodeUid, sourcePort, targetNodeUid, targetPort) {
  return {
    uid: edgeUid,
    source_node_uid: sourceNodeUid,
    source_port: sourcePort,
    target_node_uid: targetNodeUid,
    target_port: targetPort,
  };
}

async function waitForRun(request, runUid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request(`/workflow-runs/${runUid}`);
    assert.equal(response.status, 200);
    if (['succeeded', 'failed', 'cancelled'].includes(response.body.data.run.status)) {
      return response.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`workflow run ${runUid} did not settle`);
}

function dependency(node, sourceNodeUid, sourcePort, targetPort, output) {
  assert.deepEqual(node.inputSnapshot, {
    dependencies: [{
      sourceNodeUid,
      sourcePort,
      targetPort,
      selected: true,
      status: 'succeeded',
      output,
    }],
  });
}

test('actual canvas graph saves, reopens, and executes one connected approved narrative chain', async (t) => {
  const originalCwd = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-canvas-e2e-'));
  testConfig(tempRoot);
  let server = null;
  let closeDatabase = () => {};
  try {
    process.chdir(tempRoot);
    const { createApp } = require('../src/app');
    const { closeDb } = require('../src/db');
    closeDatabase = closeDb;
    const created = createApp();
    await created.startupRecoveryPromise;
    const current = setupRainBeforeClearSource(t, 860000, created.db);
    const chain = persistApprovedRainNarrativeChain(current, 861000);

    server = await new Promise((resolve, reject) => {
      const instance = created.app.listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const address = server.address();
    const request = async (pathname, options = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/v2${pathname}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      });
      return { status: response.status, body: await response.json() };
    };

    const createdWorkflow = await request(`/dramas/${current.dramaId}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ name: '雨停之前连线执行' }),
    });
    assert.equal(createdWorkflow.status, 201);
    const workflowUid = createdWorkflow.body.data.definition.uid;
    const nodeUids = [uid(862000), uid(862001), uid(862002), uid(862003)];
    const nodes = [
      apiNode(nodeUids[0], 'source.selection', 0, {
        type: 'source_selection', uid: current.selection.selection.uid,
      }),
      apiNode(nodeUids[1], 'story.facts', 260, {
        type: 'narrative_result', uid: chain.extraction.result.uid,
      }),
      apiNode(nodeUids[2], 'episode.adaptation', 520, {
        type: 'narrative_result', uid: chain.adaptation.result.uid,
      }),
      apiNode(nodeUids[3], 'script.structured', 780, {
        type: 'narrative_result', uid: chain.script.result.uid,
      }),
    ];
    const edges = [
      apiEdge(uid(862010), nodeUids[0], 'selection', nodeUids[1], 'selection'),
      apiEdge(uid(862011), nodeUids[1], 'facts', nodeUids[2], 'facts'),
      apiEdge(uid(862012), nodeUids[2], 'beats', nodeUids[3], 'beats'),
    ];
    const saved = await request(`/workflows/${workflowUid}/graph`, {
      method: 'PUT',
      body: JSON.stringify({ expected_revision: 0, nodes, edges }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.definition.graphRevision, 1);

    const reopened = await request(`/workflows/${workflowUid}`);
    assert.equal(reopened.status, 200);
    assert.deepEqual(reopened.body.data, saved.body.data);
    assert.deepEqual(reopened.body.data.edges.map((edge) => edge.uid), edges.map((edge) => edge.uid));

    const started = await request(`/workflows/${workflowUid}/runs`, {
      method: 'POST',
      body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
    });
    assert.equal(started.status, 202);
    const succeeded = await waitForRun(request, started.body.data.run_uid);
    assert.equal(succeeded.run.status, 'succeeded');
    assert.deepEqual(succeeded.nodes.map((node) => node.status), [
      'succeeded', 'succeeded', 'succeeded', 'succeeded',
    ]);
    const outputs = [
      { selection: { type: 'source_selection', uid: current.selection.selection.uid } },
      { facts: { type: 'narrative_result', uid: chain.extraction.result.uid } },
      { beats: { type: 'narrative_result', uid: chain.adaptation.result.uid } },
      { script: { type: 'narrative_result', uid: chain.script.result.uid } },
    ];
    for (let index = 0; index < outputs.length; index += 1) {
      assert.deepEqual(succeeded.nodes[index].output, outputs[index]);
    }
    dependency(succeeded.nodes[1], nodeUids[0], 'selection', 'selection', outputs[0]);
    dependency(succeeded.nodes[2], nodeUids[1], 'facts', 'facts', outputs[1]);
    dependency(succeeded.nodes[3], nodeUids[2], 'beats', 'beats', outputs[2]);

    const sourceBlock = current.imported.blocks.find((block) => (
      block.uid === current.selection.selection.startBlockUid
    ));
    const wrongSelection = current.sourceService.createSelection({
      documentUid: current.imported.document.uid,
      startBlockUid: sourceBlock.uid,
      endBlockUid: sourceBlock.uid,
      startOffset: current.selection.selection.startOffset + 1,
      endOffset: current.selection.selection.endOffset,
    });
    const invalidWorkflow = await request(`/dramas/${current.dramaId}/workflows`, {
      method: 'POST',
      body: JSON.stringify({ name: '来源错绑必须失败' }),
    });
    assert.equal(invalidWorkflow.status, 201);
    const invalidWorkflowUid = invalidWorkflow.body.data.definition.uid;
    const invalidNodes = [
      apiNode(uid(862020), 'source.selection', 0, {
        type: 'source_selection', uid: wrongSelection.selection.uid,
      }),
      apiNode(uid(862021), 'story.facts', 260, {
        type: 'narrative_result', uid: chain.extraction.result.uid,
      }),
    ];
    const invalidGraph = await request(`/workflows/${invalidWorkflowUid}/graph`, {
      method: 'PUT',
      body: JSON.stringify({
        expected_revision: 0,
        nodes: invalidNodes,
        edges: [apiEdge(uid(862022), uid(862020), 'selection', uid(862021), 'selection')],
      }),
    });
    assert.equal(invalidGraph.status, 200);
    const repositories = createV2Repositories(created.db);
    const narrativeCount = created.db.prepare('SELECT COUNT(*) FROM narrative_results').pluck().get();
    const assetCount = created.db.prepare('SELECT COUNT(*) FROM assets').pluck().get();
    const versionCount = created.db.prepare('SELECT COUNT(*) FROM asset_versions').pluck().get();
    assert.ok(repositories.sources.getSelection(wrongSelection.selection.uid));
    const invalidStart = await request(`/workflows/${invalidWorkflowUid}/runs`, {
      method: 'POST',
      body: JSON.stringify({ scope: { mode: 'full' }, max_retries: 0 }),
    });
    assert.equal(invalidStart.status, 202);
    const failed = await waitForRun(request, invalidStart.body.data.run_uid);
    assert.equal(failed.run.status, 'failed');
    assert.equal(failed.nodes[0].status, 'succeeded');
    assert.equal(failed.nodes[1].status, 'failed');
    assert.equal(failed.nodes[1].errorCode, 'ERR_NODE_EXECUTION_DATA_INVALID');
    assert.equal(created.db.prepare('SELECT COUNT(*) FROM narrative_results').pluck().get(), narrativeCount);
    assert.equal(created.db.prepare('SELECT COUNT(*) FROM assets').pluck().get(), assetCount);
    assert.equal(created.db.prepare('SELECT COUNT(*) FROM asset_versions').pluck().get(), versionCount);
    assert.equal(created.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(created.db.pragma('foreign_key_check'), []);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
