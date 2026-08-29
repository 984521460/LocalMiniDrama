'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const test = require('node:test');

const {
  H3_PROFILE,
  compileH3ShotPrompt,
  createH3TextToVideoWorkflowBundle,
  normalizeH3GenerationSpec,
} = require('../src/h3');
const h3Routes = require('../src/routes/v2/h3');
const { provisionH3TextToVideoManifest } = require('../src/h3/provisioning');
const { createMigratedV2Database } = require('./helpers/v2RepositoryDatabase');
const {
  createPromptSemanticFixture,
  seedContinuityFixture,
} = require('./helpers/v5ContinuityFixtures');

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

test('built-in H3 T2V manifest provisioning is idempotent and drift-sensitive', (t) => {
  const database = createMigratedV2Database(t);
  const first = provisionH3TextToVideoManifest(database);
  const second = provisionH3TextToVideoManifest(database);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.manifest.uid, createH3TextToVideoWorkflowBundle().manifest.uid);
  assert.deepEqual(first.manifest, second.manifest);

  database.exec('DROP TRIGGER v2_comfy_workflow_manifests_immutable_update');
  database.prepare('UPDATE workflow_manifests SET workflow_sha256=? WHERE uid=?').run(
    'f'.repeat(64),
    first.manifest.uid,
  );
  assert.throws(
    () => provisionH3TextToVideoManifest(database),
    (error) => error.code === 'H3_PROFILE_INVALID',
  );
});

test('H3 localhost routes expose only fixed profile, real-validation status and workflow bytes', async (t) => {
  const database = createMigratedV2Database(t);
  const app = express();
  app.use(express.json());
  app.use('/v2', h3Routes({ error() {} }, database));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const profileResponse = await fetch(`${base}/v2/h3/profile`);
  assert.equal(profileResponse.status, 200);
  const profile = (await profileResponse.json()).data;
  assert.equal(profile.uid, H3_PROFILE.uid);
  assert.equal(profile.modes['fl2va-first'].realValidation, 'validated-rtx4090');

  const workflowResponse = await fetch(`${base}/v2/h3/t2v-workflow`);
  assert.equal(workflowResponse.status, 200);
  const workflow = (await workflowResponse.json()).data;
  const bytes = Buffer.from(workflow.workflowBase64, 'base64');
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    workflow.manifest.workflowSha256,
  );
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /password|authorization|credential|api[_-]?key|workspace\.featurize/i,
  );

  const matrixResponse = await fetch(`${base}/v2/h3/real-validation`);
  assert.equal(matrixResponse.status, 200);
  const matrix = (await matrixResponse.json()).data;
  assert.equal(matrix.gpus[1].modes.t2v.status, 'unverified');
});

test('H3 compile route rejects T2V reference audio without returning a prompt', async (t) => {
  const database = createMigratedV2Database(t);
  const continuityFixture = seedContinuityFixture(t);
  const promptFixture = createPromptSemanticFixture(continuityFixture, 33500);
  const semanticShot = promptFixture.semantic.output.semanticShots[0];
  const prompt = compileH3ShotPrompt({
    dramaUid: continuityFixture.dramaUid,
    semanticShot,
  });
  const generationSpec = normalizeH3GenerationSpec({
    mode: 't2v', prompt, width: 608, height: 352,
    durationSeconds: 1, seed: 77, referenceImages: [],
    referenceAudio: {
      dramaUid: continuityFixture.dramaUid,
      assetVersionUid: '71000000-0000-4000-8000-000000000030',
      sha256: 'c'.repeat(64),
      mimeType: 'audio/wav',
      durationMs: 1000,
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/v2', h3Routes({ error() {} }, database));
  const { server, base } = await listen(app);
  t.after(() => server.close());

  const result = await fetch(`${base}/v2/h3/compile-t2v`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ generationSpec, filenamePrefix: 'video/unverified-audio' }),
  });
  const body = await result.json();
  assert.equal(result.status, 409);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'H3_WORKFLOW_UNVERIFIED');
  assert.doesNotMatch(JSON.stringify(body), /prompt|assetVersionUid|sha256/i);
});
