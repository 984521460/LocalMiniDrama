'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  createH3LocalVideoInspector,
  createH3RealValidationCollector,
  createH3TextToVideoWorkflowBundle,
  evaluateH3Phase7Evidence,
  normalizeH3GenerationSpec,
  validateH3RealValidationReceipt,
  validateH3VideoOutput,
} = require('../src/h3');
const { sha256Canonical } = require('../src/h3/contract');

const PROFILE_UID = '70d4f190-d54d-4d27-9a45-c97807ea1b9d';
const RECEIPT_UID = '00000000-0000-4000-8000-000000000071';
const DRAMA_UID = '00000000-0000-4000-8000-000000000072';
const SNAPSHOT_UID = '00000000-0000-4000-8000-000000000073';
const VERSION_UID = '00000000-0000-4000-8000-000000000074';
const PROMPT_ID = '00000000-0000-4000-8000-000000000075';

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8'));
}

function generationSpec(overrides = {}) {
  const text = 'Two performers exchange precise cinematic movements under controlled lighting.';
  return normalizeH3GenerationSpec({
    mode: 't2v',
    prompt: {
      schemaVersion: 'h3-shot-prompt.v1',
      profileUid: PROFILE_UID,
      dramaUid: DRAMA_UID,
      shotId: 'shot-validation-1',
      continuitySnapshotUid: SNAPSHOT_UID,
      semanticSha256: 'a'.repeat(64),
      promptSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
      text,
    },
    width: 608,
    height: 352,
    durationSeconds: 0.2,
    seed: 42,
    referenceImages: [],
    ...overrides,
  });
}

function measured(spec, overrides = {}) {
  return {
    sha256: 'b'.repeat(64),
    bytes: 4096,
    mimeType: 'video/mp4',
    width: spec.width,
    height: spec.height,
    durationMs: Math.round((spec.frames / spec.fps) * 1000),
    frames: spec.frames,
    fps: spec.fps,
    videoCodec: 'h264',
    audioCodec: 'aac',
    audioStreams: 1,
    blackFrameRatio: 0.01,
    frozenFrameRatio: 0.02,
    ...overrides,
  };
}

function receiptFixture(overrides = {}) {
  const spec = overrides.generationSpec ?? generationSpec();
  const payload = {
    schemaVersion: 'h3-real-validation-receipt.v1',
    receiptUid: RECEIPT_UID,
    profileUid: PROFILE_UID,
    gpuClass: 'rtx4090-24gb',
    captureKind: 'local-comfyui',
    mode: spec.mode,
    promptId: PROMPT_ID,
    capturedAtEpochMs: 1_787_000_000_000,
    manifest: createH3TextToVideoWorkflowBundle().manifest,
    generationSpec: spec,
    output: {
      assetVersionUid: VERSION_UID,
      evidence: validateH3VideoOutput({ generationSpec: spec, measured: measured(spec) }),
    },
    ...overrides,
  };
  return { ...payload, receiptSha256: sha256Canonical(payload) };
}

function assertH3Error(callback, code) {
  assert.throws(callback, (error) => error?.code === code && !JSON.stringify(error).includes('b'.repeat(64)));
}

test('real-validation receipt binds the exact Manifest, input, prompt id, output, and content hash', () => {
  const receipt = receiptFixture();
  const validated = validateH3RealValidationReceipt(receipt);
  assert.equal(sha256Canonical(validated), sha256Canonical(receipt));
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.manifest), true);
  assert.equal(Object.isFrozen(validated.generationSpec), true);
  assert.equal(Object.isFrozen(validated.output.evidence), true);

  const mutations = [
    (value) => { value.promptId = 'not-a-prompt-id'; },
    (value) => { value.manifest.workflowSha256 = 'c'.repeat(64); },
    (value) => { value.generationSpec.seed += 1; },
    (value) => { value.output.evidence.sha256 = 'd'.repeat(64); },
    (value) => { value.receiptSha256 = 'e'.repeat(64); },
    (value) => { value.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assertH3Error(() => validateH3RealValidationReceipt(changed), 'H3_REAL_VALIDATION_INVALID');
  }
});

test('receipt and gate Schemas accept only the exact public projections', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schemaPath of [
    'schemas/v6/comfy-workflow-manifest.schema.json',
    'schemas/v7/h3-generation-spec.schema.json',
    'schemas/v7/h3-video-evidence.schema.json',
    'schemas/v7/h3-real-validation-receipt.schema.json',
    'schemas/v7/h3-phase7-evidence-gate.schema.json',
  ]) ajv.addSchema(readSchema(schemaPath));
  const receiptValidate = ajv.getSchema(
    'https://local-mini-drama.invalid/schemas/v7/h3-real-validation-receipt.schema.json',
  );
  const gateValidate = ajv.getSchema(
    'https://local-mini-drama.invalid/schemas/v7/h3-phase7-evidence-gate.schema.json',
  );
  const receipt = receiptFixture();
  const publicReceipt = JSON.parse(JSON.stringify(receipt));
  assert.equal(receiptValidate(publicReceipt), true, JSON.stringify(receiptValidate.errors));
  for (const mutate of [
    (value) => { value.profileUid = '00000000-0000-4000-8000-000000000099'; },
    (value) => { value.manifest.modelFamily = 'synthetic-family'; },
    (value) => { value.generationSpec.profileUid = '00000000-0000-4000-8000-000000000099'; },
    (value) => { value.output.evidence.profileUid = '00000000-0000-4000-8000-000000000099'; },
  ]) {
    const drifted = structuredClone(publicReceipt);
    mutate(drifted);
    assert.equal(receiptValidate(drifted), false);
  }
  for (const mode of ['fl2va-first', 'fl2va-first-last', 'ref2va']) {
    const crossMode = structuredClone(publicReceipt);
    crossMode.mode = mode;
    const payload = { ...crossMode };
    delete payload.receiptSha256;
    crossMode.receiptSha256 = sha256Canonical(payload);
    assert.equal(receiptValidate(crossMode), false);
    assertH3Error(
      () => validateH3RealValidationReceipt(crossMode),
      'H3_REAL_VALIDATION_INVALID',
    );
  }
  for (const mutate of [
    (value) => { value.output.evidence.generationSpecSha256 = '2'.repeat(64); },
    (value) => { value.output.evidence.width = 640; },
    (value) => { value.output.evidence.frames = 22; },
  ]) {
    const runtimeBound = structuredClone(publicReceipt);
    mutate(runtimeBound);
    const payload = { ...runtimeBound };
    delete payload.receiptSha256;
    runtimeBound.receiptSha256 = sha256Canonical(payload);
    assert.equal(receiptValidate(runtimeBound), true, JSON.stringify(receiptValidate.errors));
    assertH3Error(
      () => validateH3RealValidationReceipt(runtimeBound),
      'H3_REAL_VALIDATION_INVALID',
    );
  }
  const gate = evaluateH3Phase7Evidence([receipt]);
  const publicGate = JSON.parse(JSON.stringify(gate));
  assert.equal(gateValidate(publicGate), true, JSON.stringify(gateValidate.errors));
  const forgedComplete = {
    ...publicGate,
    evidenceComplete: true,
    acceptedReceiptModes: ['t2v', 'fl2va-first', 'fl2va-first-last', 'ref2va'],
    missingModes: [],
    workflowUnavailableModes: [],
    receiptCount: 4,
  };
  assert.equal(gateValidate(forgedComplete), false);
  const emptyGate = JSON.parse(JSON.stringify(evaluateH3Phase7Evidence([])));
  assert.equal(gateValidate(emptyGate), true, JSON.stringify(gateValidate.errors));
  emptyGate.receiptsSha256 = '0'.repeat(64);
  assert.equal(gateValidate(emptyGate), false);
});

test('Phase 7 gate stays incomplete until every mode has independent trusted evidence', () => {
  const empty = evaluateH3Phase7Evidence([]);
  assert.deepEqual(empty.acceptedReceiptModes, []);
  assert.deepEqual(empty.missingModes, ['t2v', 'fl2va-first', 'fl2va-first-last', 'ref2va']);
  assert.deepEqual(empty.workflowUnavailableModes, ['fl2va-first', 'fl2va-first-last', 'ref2va']);
  assert.equal(empty.evidenceComplete, false);

  const t2v = receiptFixture();
  const partial = evaluateH3Phase7Evidence([t2v]);
  assert.deepEqual(partial.acceptedReceiptModes, ['t2v']);
  assert.deepEqual(partial.missingModes, ['fl2va-first', 'fl2va-first-last', 'ref2va']);
  assert.equal(partial.evidenceComplete, false);
  assertH3Error(
    () => evaluateH3Phase7Evidence([t2v, structuredClone(t2v)]),
    'H3_REAL_VALIDATION_INVALID',
  );

  const wrongGpu = structuredClone(t2v);
  wrongGpu.gpuClass = 'rtx-pro-6000-blackwell-96gb';
  const payload = { ...wrongGpu };
  delete payload.receiptSha256;
  wrongGpu.receiptSha256 = sha256Canonical(payload);
  assertH3Error(() => evaluateH3Phase7Evidence([wrongGpu]), 'H3_REAL_VALIDATION_INVALID');

  const withAudioSpec = generationSpec({
    referenceAudio: {
      dramaUid: DRAMA_UID,
      assetVersionUid: '00000000-0000-4000-8000-000000000080',
      sha256: '1'.repeat(64),
      mimeType: 'audio/wav',
      durationMs: 1000,
    },
  });
  const withAudio = receiptFixture({ generationSpec: withAudioSpec });
  assertH3Error(
    () => evaluateH3Phase7Evidence([withAudio]),
    'H3_REAL_VALIDATION_INVALID',
  );
});

test('collector re-inspects a local output and refuses modes without a trusted workflow', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-real-validation-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-local-video-evidence', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'output.mp4'), bytes);
  let processCalls = 0;
  const inspector = createH3LocalVideoInspector({
    localRoot: tempRoot,
    ffprobePath: 'synthetic-ffprobe',
    ffmpegPath: 'synthetic-ffmpeg',
    async runProcess() {
      processCalls += 1;
      if (processCalls === 1) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            streams: [
              {
                codec_type: 'video', codec_name: 'h264', width: 608, height: 352,
                nb_read_frames: '5', avg_frame_rate: '24/1', duration: '0.208',
              },
              { codec_type: 'audio', codec_name: 'aac' },
            ],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '0.208' },
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const collector = createH3RealValidationCollector({ inspector });
  const spec = generationSpec();
  const receipt = await collector.collect({
    receiptUid: RECEIPT_UID,
    gpuClass: 'rtx4090-24gb',
    promptId: PROMPT_ID,
    manifest: createH3TextToVideoWorkflowBundle().manifest,
    generationSpec: spec,
    assetVersionUid: VERSION_UID,
    localRelativePath: 'output.mp4',
    remoteSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    remoteBytes: bytes.length,
  });
  assert.equal(processCalls, 2);
  assert.equal(receipt.output.evidence.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(validateH3RealValidationReceipt(receipt).receiptSha256, receipt.receiptSha256);

  const firstFrameSpec = structuredClone(spec);
  firstFrameSpec.mode = 'fl2va-first';
  firstFrameSpec.referenceImages = [{
    ordinal: 1,
    role: 'first',
    dramaUid: DRAMA_UID,
    assetVersionUid: '00000000-0000-4000-8000-000000000076',
    sha256: 'f'.repeat(64),
    mimeType: 'image/png',
    width: 608,
    height: 352,
  }];
  assertH3Error(
    () => collector.collect({
      receiptUid: '00000000-0000-4000-8000-000000000077',
      gpuClass: 'rtx4090-24gb',
      promptId: '00000000-0000-4000-8000-000000000078',
      manifest: createH3TextToVideoWorkflowBundle().manifest,
      generationSpec: firstFrameSpec,
      assetVersionUid: '00000000-0000-4000-8000-000000000079',
      localRelativePath: 'output.mp4',
      remoteSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      remoteBytes: bytes.length,
    }),
    'H3_WORKFLOW_UNVERIFIED',
  );
});
