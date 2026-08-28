'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { createComfyDependencyChecker } = require('../src/remote/comfyDependencyChecker');
const {
  createComfyWorkflowManifest,
  isComfyWorkflowManifest,
} = require('../src/remote/workflowManifest');
const {
  createComfyManifestRepository,
} = require('../src/repositories/v2/comfyManifestRepository');
const { createMigratedV2Database, uid } = require('./helpers/v2RepositoryDatabase');

function workflowFixture() {
  return {
    10: {
      class_type: 'PromptNode',
      inputs: { text: 'old prompt', width: 64 },
      _meta: { title: 'APP_GENERATION_INPUTS' },
    },
    15: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: 'models/h3.safetensors' },
      _meta: { title: 'Load H3 checkpoint' },
    },
    20: {
      class_type: 'SaveVideo',
      inputs: { video: ['10', 0] },
      _meta: { title: 'APP_OUTPUT_VIDEO' },
    },
  };
}

function manifestFixture(workflowBytes) {
  return {
    schemaVersion: 'comfy-workflow-manifest.v1',
    uid: uid(9601),
    manifestId: 'h3-t2v-test-v1',
    version: '1.0.0',
    engine: 'comfyui',
    workflowFile: 'workflows/h3-t2v-test-api.json',
    workflowSha256: crypto.createHash('sha256').update(workflowBytes).digest('hex'),
    modelFamily: 'minimax-h3',
    requirements: [
      { kind: 'node', nodeType: 'PromptNode' },
      { kind: 'node', nodeType: 'CheckpointLoaderSimple' },
      { kind: 'node', nodeType: 'SaveVideo' },
      {
        kind: 'model',
        nodeType: 'CheckpointLoaderSimple',
        inputName: 'ckpt_name',
        fileName: 'models/h3.safetensors',
      },
    ],
    inputs: {
      prompt: {
        marker: 'APP_GENERATION_INPUTS', inputName: 'text', valueType: 'string', required: true,
      },
      width: {
        marker: 'APP_GENERATION_INPUTS', inputName: 'width', valueType: 'integer', required: true,
      },
    },
    outputs: { video: { marker: 'APP_OUTPUT_VIDEO' } },
    validation: {
      schemaVersion: 'comfy-workflow-manifest.v1',
      workflowFormat: 'api',
      markersValidated: true,
    },
    status: 'validated',
  };
}

function objectInfoFixture() {
  return {
    PromptNode: { input: { required: {} } },
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [['models/h3.safetensors'], {}] } },
    },
    SaveVideo: { input: { required: {} } },
  };
}

test('formal Comfy manifest binds workflow hash, markers, inputs, outputs, nodes, and models', () => {
  const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
  const manifest = createComfyWorkflowManifest(manifestFixture(workflowBytes), workflowBytes);
  assert.equal(isComfyWorkflowManifest(manifest), true);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.requirements), true);

  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v6/comfy-workflow-manifest.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const transportManifest = JSON.parse(JSON.stringify(manifest));
  assert.equal(validate(transportManifest), true, JSON.stringify(validate.errors));
  const duplicateRequirement = JSON.parse(JSON.stringify(transportManifest));
  duplicateRequirement.requirements.push({ ...duplicateRequirement.requirements[0] });
  assert.equal(validate(duplicateRequirement), false);

  const wrongHash = manifestFixture(workflowBytes);
  wrongHash.workflowSha256 = '0'.repeat(64);
  assert.throws(
    () => createComfyWorkflowManifest(wrongHash, workflowBytes),
    (error) => error.code === 'COMFY_MANIFEST_WORKFLOW_MISMATCH',
  );

  const missingNodeRequirement = manifestFixture(workflowBytes);
  missingNodeRequirement.requirements = missingNodeRequirement.requirements.filter(
    (item) => item.nodeType !== 'SaveVideo',
  );
  assert.throws(
    () => createComfyWorkflowManifest(missingNodeRequirement, workflowBytes),
    (error) => error.code === 'COMFY_MANIFEST_INVALID',
  );

  const wrongModelBinding = manifestFixture(workflowBytes);
  wrongModelBinding.requirements.at(-1).fileName = 'models/other.safetensors';
  assert.throws(
    () => createComfyWorkflowManifest(wrongModelBinding, workflowBytes),
    (error) => error.code === 'COMFY_MANIFEST_INVALID',
  );
});

test('formal Comfy manifest repository persists strict records and freezes them', (t) => {
  const database = createMigratedV2Database(t);
  const repository = createComfyManifestRepository(database);
  const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
  const manifest = createComfyWorkflowManifest(manifestFixture(workflowBytes), workflowBytes);

  const created = repository.create(manifest);
  assert.equal(created.uid, manifest.uid);
  const restored = repository.get(manifest.uid);
  assert.equal(restored.workflowSha256, manifest.workflowSha256);
  assert.equal(repository.find(manifest.manifestId, manifest.version).manifestId, manifest.manifestId);

  assert.throws(() => database.prepare(`
    UPDATE workflow_manifests SET workflow_sha256=? WHERE uid=?
  `).run('f'.repeat(64), manifest.uid));
  assert.throws(() => database.prepare('DELETE FROM workflow_manifests WHERE uid=?').run(manifest.uid));
  assert.throws(() => repository.create(manifest));

  assert.throws(() => database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    SELECT ?, 'invalid-formal', version, engine, workflow_file, workflow_sha256, model_family,
           '[{}]', inputs_json, outputs_json, validation_json, status
    FROM workflow_manifests WHERE uid=?
  `).run(uid(9602), manifest.uid));
  assert.throws(() => database.prepare(`
    INSERT OR REPLACE INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    SELECT ?, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
           requirements_json, inputs_json, outputs_json, validation_json, status
    FROM workflow_manifests WHERE uid=?
  `).run(uid(9603), manifest.uid));

  const validationTail = '"workflowFormat":"api","markersValidated":true';
  const duplicateFirstLegacy = `{"schemaVersion":"legacy","schemaVersion":"comfy-workflow-manifest.v1",${validationTail}}`;
  const duplicateLastLegacy = `{"schemaVersion":"comfy-workflow-manifest.v1",${validationTail},"schemaVersion":"legacy"}`;
  const replaceAmbiguous = database.prepare(`
    INSERT OR REPLACE INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    SELECT uid, manifest_id, version, engine, workflow_file, workflow_sha256, ?,
           requirements_json, inputs_json, outputs_json, ?, status
    FROM workflow_manifests WHERE uid=?
  `);
  for (const recursiveTriggers of [0, 1]) {
    database.pragma(`recursive_triggers = ${recursiveTriggers}`);
    for (const ambiguousValidation of [duplicateFirstLegacy, duplicateLastLegacy]) {
      assert.throws(() => replaceAmbiguous.run(
        'poisoned-model-family', ambiguousValidation, manifest.uid,
      ));
      assert.equal(
        database.prepare('SELECT model_family FROM workflow_manifests WHERE uid=?').get(manifest.uid).model_family,
        manifest.modelFamily,
      );
    }
  }

  database.exec('DROP TRIGGER v2_comfy_workflow_manifests_immutable_update');
  database.prepare(`
    UPDATE workflow_manifests SET requirements_json=' ' || requirements_json WHERE uid=?
  `).run(manifest.uid);
  assert.throws(
    () => repository.get(manifest.uid),
    (error) => error.code === 'V2_REPOSITORY_DATA_INVALID',
  );
});

test('dependency checker distinguishes missing nodes and models and gates readiness', async () => {
  const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
  const manifest = createComfyWorkflowManifest(manifestFixture(workflowBytes), workflowBytes);
  let objectInfo = objectInfoFixture();
  const checker = createComfyDependencyChecker({
    client: { async objectInfo() { return objectInfo; } },
  });

  const ready = await checker.requireReady(manifest);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missingNodes, []);
  assert.deepEqual(ready.missingModels, []);

  objectInfo = objectInfoFixture();
  delete objectInfo.SaveVideo;
  const missingNode = await checker.check(manifest);
  assert.equal(missingNode.ready, false);
  assert.deepEqual(missingNode.missingNodes, ['SaveVideo']);
  assert.deepEqual(missingNode.missingModels, []);
  await assert.rejects(
    checker.requireReady(manifest),
    (error) => error.code === 'COMFY_DEPENDENCIES_MISSING',
  );

  objectInfo = objectInfoFixture();
  objectInfo.CheckpointLoaderSimple.input.required.ckpt_name[0] = [];
  const missingModel = await checker.check(manifest);
  assert.equal(missingModel.ready, false);
  assert.deepEqual(missingModel.missingNodes, []);
  assert.deepEqual(missingModel.missingModels, [{
    nodeType: 'CheckpointLoaderSimple',
    inputName: 'ckpt_name',
    fileName: 'models/h3.safetensors',
  }]);

  for (const malformedNode of [
    null,
    'not-an-object',
    [],
    {},
    { input: null },
    { input: {} },
    { input: { required: [] } },
  ]) {
    objectInfo = objectInfoFixture();
    objectInfo.SaveVideo = malformedNode;
    await assert.rejects(
      checker.check(manifest),
      (error) => error.code === 'COMFY_DEPENDENCY_RESPONSE_INVALID',
    );
  }

  objectInfo = objectInfoFixture();
  objectInfo.CheckpointLoaderSimple.input.required.ckpt_name = 'malformed';
  await assert.rejects(
    checker.check(manifest),
    (error) => error.code === 'COMFY_DEPENDENCY_RESPONSE_INVALID',
  );
});

test('database rejects malformed formal manifests before immutable evidence is created', (t) => {
  const database = createMigratedV2Database(t);
  const repository = createComfyManifestRepository(database);
  const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
  const manifest = createComfyWorkflowManifest(manifestFixture(workflowBytes), workflowBytes);
  repository.create(manifest);
  const source = database.prepare('SELECT * FROM workflow_manifests WHERE uid=?').get(manifest.uid);
  const insert = database.prepare(`
    INSERT INTO workflow_manifests
      (uid, manifest_id, version, engine, workflow_file, workflow_sha256, model_family,
       requirements_json, inputs_json, outputs_json, validation_json, status)
    VALUES
      (@uid, @manifest_id, @version, @engine, @workflow_file, @workflow_sha256, @model_family,
       @requirements_json, @inputs_json, @outputs_json, @validation_json, @status)
  `);
  const requirements = JSON.parse(source.requirements_json);
  const inputs = JSON.parse(source.inputs_json);
  const outputs = JSON.parse(source.outputs_json);
  const validation = JSON.parse(source.validation_json);
  const nodeRequirement = requirements.find((item) => item.kind === 'node');
  const modelRequirement = requirements.find((item) => item.kind === 'model');
  const cases = [
    { manifest_id: 'Bad-Manifest' },
    { version: '01.0.0' },
    { workflow_file: '../private/workflow.json' },
    { model_family: 'minimax--h3' },
    {
      requirements_json: JSON.stringify(requirements.map((item) => (
        item.kind === 'model' ? { ...item, fileName: '../private/model.bin' } : item
      ))),
    },
    { inputs_json: JSON.stringify({ ...inputs, promptAlias: inputs.prompt }) },
    { outputs_json: JSON.stringify({ ...outputs, duplicate: outputs.video }) },
    {
      inputs_json: JSON.stringify({
        ...inputs,
        prompt: { ...inputs.prompt, inputName: 'a'.repeat(129) },
      }),
    },
    {
      inputs_json: JSON.stringify({
        ...inputs,
        prompt: { ...inputs.prompt, inputName: 'a'.repeat(4096) },
      }),
    },
    {
      inputs_json: `{"prompt":${JSON.stringify(inputs.prompt)},"prompt":${JSON.stringify({
        ...inputs.prompt, marker: 'APP_DIFFERENT_INPUT',
      })}}`,
    },
    {
      outputs_json: `{"video":${JSON.stringify(outputs.video)},"video":${JSON.stringify({
        marker: 'APP_DIFFERENT_OUTPUT',
      })}}`,
    },
    {
      validation_json: String.raw`{"schemaVersion":"comfy-workflow-manifest.v\u0031","workflowFormat":"api","markersValidated":true}`,
    },
    {
      validation_json: String.raw`{"schema\u0056ersion":"comfy-workflow-manifest.v1","workflowFormat":"api","markersValidated":true}`,
    },
    { inputs_json: source.inputs_json.replace('APP_GENERATION_INPUTS', String.raw`APP_\u0047ENERATION_INPUTS`) },
    { requirements_json: source.requirements_json.replace('PromptNode', String.raw`Prompt\u004Eode`) },
    {
      validation_json: JSON.stringify({
        schemaVersion: validation.schemaVersion,
        markersValidated: true,
        unexpected: 'api',
      }),
    },
    {
      validation_json: JSON.stringify({
        schemaVersion: validation.schemaVersion,
        workflowFormat: 'api',
        unexpected: true,
      }),
    },
    {
      inputs_json: JSON.stringify({
        ...inputs,
        prompt: {
          marker: inputs.prompt.marker,
          inputName: inputs.prompt.inputName,
          required: inputs.prompt.required,
          unexpected: inputs.prompt.valueType,
        },
      }),
    },
    {
      inputs_json: JSON.stringify({
        ...inputs,
        prompt: {
          marker: inputs.prompt.marker,
          inputName: inputs.prompt.inputName,
          valueType: inputs.prompt.valueType,
          unexpected: inputs.prompt.required,
        },
      }),
    },
    {
      requirements_json: JSON.stringify([
        { kind: 'node', unexpected: nodeRequirement.nodeType },
        ...requirements.slice(1),
      ]),
    },
    {
      requirements_json: JSON.stringify(requirements.map((item) => (
        item.kind === 'model'
          ? {
            kind: item.kind,
            nodeType: item.nodeType,
            inputName: item.inputName,
            unexpected: modelRequirement.fileName,
          }
          : item
      ))),
    },
    { outputs_json: JSON.stringify({ video: { unexpected: outputs.video.marker } }) },
    { validation_json: JSON.stringify({ ...validation, unexpected: true }) },
  ];
  for (const [index, change] of cases.entries()) {
    assert.throws(() => insert.run({
      ...source,
      uid: uid(9700 + index),
      manifest_id: `formal-probe-${index}`,
      ...change,
    }));
  }
  assert.equal(database.prepare('SELECT count(*) AS count FROM workflow_manifests').get().count, 1);

  const boundaryUid = uid(9799);
  database.exec('SAVEPOINT formal_input_name_boundary');
  insert.run({
    ...source,
    uid: boundaryUid,
    manifest_id: 'formal-input-name-boundary',
    inputs_json: JSON.stringify({
      ...inputs,
      prompt: { ...inputs.prompt, inputName: 'a'.repeat(128) },
    }),
  });
  assert.equal(repository.get(boundaryUid).inputs.prompt.inputName.length, 128);
  database.exec('ROLLBACK TO formal_input_name_boundary');
  database.exec('RELEASE formal_input_name_boundary');
});

test('manifest and dependency public boundaries fail closed without leaking values', async () => {
  const workflowBytes = Buffer.from(JSON.stringify(workflowFixture()));
  let reads = 0;
  const proxied = new Proxy(manifestFixture(workflowBytes), {
    ownKeys(target) {
      reads += 1;
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(
    () => createComfyWorkflowManifest(proxied, workflowBytes),
    (error) => error.code === 'COMFY_MANIFEST_INVALID',
  );
  assert.equal(reads, 0);

  let optionReads = 0;
  const hostileOptions = new Proxy({ client: {} }, {
    get(target, key, receiver) {
      optionReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(() => createComfyDependencyChecker(hostileOptions), TypeError);
  assert.equal(optionReads, 0);

  let clientReads = 0;
  const hostileClient = {};
  Object.defineProperty(hostileClient, 'objectInfo', {
    enumerable: true,
    get() {
      clientReads += 1;
      return async () => ({});
    },
  });
  assert.throws(() => createComfyDependencyChecker({ client: hostileClient }), TypeError);
  assert.equal(clientReads, 0);

  const manifest = createComfyWorkflowManifest(manifestFixture(workflowBytes), workflowBytes);
  const checker = createComfyDependencyChecker({
    client: { async objectInfo() { return { secret_marker: 'must-not-leak' }; } },
  });
  await assert.rejects(checker.requireReady(manifest), (error) => (
    error.code === 'COMFY_DEPENDENCIES_MISSING'
      && !error.message.includes('secret_marker')
      && !JSON.stringify(error).includes('must-not-leak')
  ));
});
