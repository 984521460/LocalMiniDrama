'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { remoteConnectionEvidenceSha256 } = require('../src/remote/connectionProfile');
const { resolveRemoteExecutionBinding } = require('../src/remote/remoteExecutionBinding');
const { remoteExecutionRequest } = require('../src/remote/remoteExecutionRequest');
const requestSchema = require('../../schemas/v6/remote-execution-request.schema.json');
const { uid } = require('./helpers/v2RepositoryDatabase');

function requestFixture(overrides = {}) {
  return {
    expectedStateVersion: 0,
    workflowBase64: Buffer.from('{"1":{"class_type":"Prompt"}}').toString('base64'),
    values: { prompt: 'Synthetic local prompt', width: 1280 },
    uploads: [{
      localRelativePath: 'input/source.bin',
      remoteRelativePath: 'input/source.bin',
      sha256: 'a'.repeat(64),
    }],
    output: { logicalName: 'video', assetUid: uid(9980) },
    ...overrides,
  };
}

test('remote execution request has one strict runtime and JSON Schema shape', () => {
  const request = requestFixture();
  const parsed = remoteExecutionRequest(request);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(requestSchema);
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.values), true);
  assert.equal(Object.isFrozen(parsed.uploads), true);
  assert.deepEqual(parsed.workflowBytes, Buffer.from(request.workflowBase64, 'base64'));

  for (const invalid of [
    { ...request, unexpected: true },
    { ...request, workflowBase64: '*' },
    { ...request, uploads: [{ ...request.uploads[0], remoteRelativePath: '../escape.bin' }] },
    { ...request, output: { ...request.output, assetUid: 'not-a-uuid' } },
  ]) {
    assert.equal(validate(invalid), false);
    assert.throws(
      () => remoteExecutionRequest(invalid),
      (error) => error.code === 'REMOTE_TASK_INPUT_INVALID',
    );
  }
  assert.throws(
    () => remoteExecutionRequest({ ...request, workflowBase64: `${request.workflowBase64}=` }),
    (error) => error.code === 'REMOTE_TASK_INPUT_INVALID',
  );
});

test('remote execution request rejects hostile and sparse containers without invoking traps', () => {
  let trapReads = 0;
  const proxied = new Proxy(requestFixture(), {
    getPrototypeOf() { trapReads += 1; throw new Error('synthetic trap'); },
    ownKeys() { trapReads += 1; throw new Error('synthetic trap'); },
  });
  assert.throws(
    () => remoteExecutionRequest(proxied),
    (error) => error.code === 'REMOTE_TASK_INPUT_INVALID',
  );
  assert.equal(trapReads, 0);

  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () => remoteExecutionRequest(requestFixture({ uploads: sparse })),
    (error) => error.code === 'REMOTE_TASK_INPUT_INVALID',
  );
});

test('remote execution binding is exact for node, manifest, connection, credential, and output asset', () => {
  const connectionUid = uid(9990);
  const manifestUid = uid(9991);
  const assetUid = uid(9992);
  const credentialRef = `credential:v1:${uid(9993)}`;
  const connection = {
    uid: connectionUid,
    name: 'Synthetic execution connection',
    host: 'worker.example.invalid',
    port: 22,
    username: 'worker',
    hostFingerprint: `SHA256:${'A'.repeat(43)}`,
    credentialRef,
    status: 'ready',
    createdAt: '2026-08-28T06:00:00.000Z',
    updatedAt: '2026-08-28T06:00:00.000Z',
    authMethod: 'password',
    comfyHost: '127.0.0.1',
    comfyPort: 8188,
    remoteWorkDir: 'ai-drama-studio',
    environmentReport: null,
    environmentCheckedAtEpochMs: null,
    stateVersion: 4,
  };
  const connectionEvidenceSha256 = remoteConnectionEvidenceSha256(connection);
  const fixture = {
    planNode: {
      nodeType: 'shot.video',
      enabled: true,
      config: { connectionEvidenceSha256, connectionUid, credentialRef, manifestUid },
      domainRef: { type: 'asset', uid: assetUid },
    },
    task: { connectionUid, connectionEvidenceSha256, workflowManifestUid: manifestUid },
    connection,
    asset: {
      uid: assetUid, ownerType: 'drama', ownerUid: uid(9994), assetType: 'video', status: 'draft',
    },
  };
  assert.deepEqual(resolveRemoteExecutionBinding(fixture), { mediaKind: 'video' });
  for (const invalid of [
    { planNode: { ...fixture.planNode, nodeType: 'source.selection' } },
    { planNode: { ...fixture.planNode, enabled: false } },
    { planNode: { ...fixture.planNode, config: { ...fixture.planNode.config, manifestUid: uid(9995) } } },
    { planNode: { ...fixture.planNode, config: { ...fixture.planNode.config, connectionUid: uid(9996) } } },
    { planNode: { ...fixture.planNode, config: { ...fixture.planNode.config, credentialRef: `credential:v1:${uid(9997)}` } } },
    {
      connection: { ...fixture.connection, status: 'unverified', hostFingerprint: null },
      planNode: {
        ...fixture.planNode,
        config: {
          ...fixture.planNode.config,
          connectionEvidenceSha256: remoteConnectionEvidenceSha256({
            ...fixture.connection,
            status: 'unverified',
            hostFingerprint: null,
          }),
        },
      },
    },
    { connection: { ...fixture.connection, stateVersion: 5 } },
    {
      connection: {
        ...fixture.connection,
        stateVersion: 8,
        host: 'rotated.example.invalid',
        port: 2200,
        hostFingerprint: `SHA256:${'B'.repeat(43)}`,
        comfyPort: 9199,
      },
    },
    { planNode: { ...fixture.planNode, domainRef: { type: 'asset', uid: uid(9998) } } },
    { asset: { ...fixture.asset, assetType: 'image' } },
  ]) {
    assert.equal(resolveRemoteExecutionBinding({ ...fixture, ...invalid }), null);
  }
});
