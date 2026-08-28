'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  createH3LocalVideoInspector,
  createH3Phase7ValidationPlan,
  createH3RealValidationCollector,
  evaluateH3Phase7Evidence,
  normalizeH3GenerationSpec,
  validateH3Phase7ValidationPlan,
  validateH3RealValidationReceipt,
} = require('../src/h3');
const { sha256Canonical } = require('../src/h3/contract');
const { parseStrictJson } = require('../src/security/strictJson');

const PROFILE_UID = '70d4f190-d54d-4d27-9a45-c97807ea1b9d';
const PLAN_UID = '00000000-0000-4000-8000-000000000701';
const DRAMA_UID = '00000000-0000-4000-8000-000000000702';
const SNAPSHOT_UID = '00000000-0000-4000-8000-000000000703';

function uid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function prompt() {
  const text = 'Two performers exchange precise cinematic movements under controlled lighting.';
  return {
    schemaVersion: 'h3-shot-prompt.v1',
    profileUid: PROFILE_UID,
    dramaUid: DRAMA_UID,
    shotId: 'shot-phase7-real-validation',
    continuitySnapshotUid: SNAPSHOT_UID,
    semanticSha256: 'a'.repeat(64),
    promptSha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  };
}

function imageEvidence(ordinal, role, number) {
  return {
    ordinal,
    role,
    dramaUid: DRAMA_UID,
    assetVersionUid: uid(number),
    sha256: String(number % 10).repeat(64),
    mimeType: 'image/png',
    width: 608,
    height: 352,
  };
}

function mediaBinding(evidence, fileName) {
  return {
    assetVersionUid: evidence.assetVersionUid,
    sha256: evidence.sha256,
    fileName,
  };
}

function validationCase(mode) {
  let referenceImages = [];
  let referenceAudio = null;
  if (mode === 'fl2va-first') {
    referenceImages = [imageEvidence(1, 'first', 711)];
  } else if (mode === 'fl2va-first-last') {
    referenceImages = [
      imageEvidence(1, 'first', 721),
      imageEvidence(2, 'last', 722),
    ];
  } else if (mode === 'ref2va') {
    referenceImages = [1, 2, 3, 4].map((ordinal) => (
      imageEvidence(ordinal, 'reference', 730 + ordinal)
    ));
    referenceAudio = {
      dramaUid: DRAMA_UID,
      assetVersionUid: uid(735),
      sha256: '5'.repeat(64),
      mimeType: 'audio/wav',
      durationMs: 1625,
    };
  }
  const generationSpec = normalizeH3GenerationSpec({
    mode,
    prompt: prompt(),
    width: 608,
    height: 352,
    durationSeconds: 1.625,
    seed: 42,
    referenceImages,
    referenceAudio,
  });
  return {
    generationSpec,
    filenamePrefix: `phase7/${mode}`,
    mediaBindings: mode === 't2v' ? null : {
      referenceImages: referenceImages.map((evidence, index) => (
        mediaBinding(evidence, `h3-input/${mode}-${index + 1}.png`)
      )),
      referenceAudio: referenceAudio === null
        ? null
        : mediaBinding(referenceAudio, 'h3-input/ref2va-audio.wav'),
    },
  };
}

function planInput() {
  return {
    planUid: PLAN_UID,
    gpuClass: 'rtx4090-48gb',
    cases: ['t2v', 'fl2va-first', 'fl2va-first-last', 'ref2va'].map(validationCase),
  };
}

function schema(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', relativePath), 'utf8'));
}

function assertH3Error(callback, code) {
  assert.throws(callback, (error) => error?.code === code && !JSON.stringify(error).includes('a'.repeat(64)));
}

test('Phase 7 validation plan deterministically packages all four modes without promoting candidates', () => {
  const first = createH3Phase7ValidationPlan(planInput());
  const second = createH3Phase7ValidationPlan(planInput());
  assert.equal(sha256Canonical(first), sha256Canonical(second));
  assert.equal(first.schemaVersion, 'h3-phase7-validation-plan.v1');
  assert.equal(first.status, 'prepared-unverified');
  assert.deepEqual(first.cases.map(({ mode }) => mode), [
    't2v', 'fl2va-first', 'fl2va-first-last', 'ref2va',
  ]);
  assert.deepEqual(first.cases.map(({ supportStatus }) => supportStatus), [
    'trusted-workflow',
    'implementation-candidate-unverified',
    'implementation-candidate-unverified',
    'implementation-candidate-unverified',
  ]);
  assert.equal(first.cases[3].generationSpec.referenceImages.length, 4);
  assert.notEqual(first.cases[3].generationSpec.referenceAudio, null);
  assert.equal(new Set(first.cases.map(({ promptSha256 }) => promptSha256)).size, 4);
  assert.equal(first.cases.every(({ expectedOutput }) => (
    expectedOutput.width === 608 && expectedOutput.height === 352
      && expectedOutput.frames === 39 && expectedOutput.fps === 24
      && expectedOutput.durationMs === 1625
  )), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.cases[3].prompt), true);
  assert.equal(validateH3Phase7ValidationPlan(first).planSha256, first.planSha256);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const file of [
    'schemas/v6/comfy-workflow-manifest.schema.json',
    'schemas/v7/h3-generation-spec.schema.json',
    'schemas/v7/h3-real-validation-plan.schema.json',
  ]) ajv.addSchema(schema(file));
  const validate = ajv.getSchema(
    'https://local-mini-drama.invalid/schemas/v7/h3-real-validation-plan.schema.json',
  );
  assert.equal(validate(JSON.parse(JSON.stringify(first))), true, JSON.stringify(validate.errors));
  const unsafePath = JSON.parse(JSON.stringify(first));
  unsafePath.cases[1].filenamePrefix = 'phase7/../escape';
  assert.equal(validate(unsafePath), false);
  const unsafeMedia = JSON.parse(JSON.stringify(first));
  unsafeMedia.cases[1].mediaBindings.referenceImages[0].fileName = 'h3-input/../escape.png';
  assert.equal(validate(unsafeMedia), false);
  const sixteenSegments = JSON.parse(JSON.stringify(first));
  sixteenSegments.cases[0].filenamePrefix = Array.from({ length: 16 }, () => 'a').join('/');
  sixteenSegments.cases[1].mediaBindings.referenceImages[0].fileName = [
    ...Array.from({ length: 15 }, () => 'a'), 'input.png',
  ].join('/');
  assert.equal(validate(sixteenSegments), true, JSON.stringify(validate.errors));
  const seventeenSegments = JSON.parse(JSON.stringify(sixteenSegments));
  seventeenSegments.cases[0].filenamePrefix = Array.from({ length: 17 }, () => 'a').join('/');
  assert.equal(validate(seventeenSegments), false);
  seventeenSegments.cases[0].filenamePrefix = first.cases[0].filenamePrefix;
  seventeenSegments.cases[1].mediaBindings.referenceImages[0].fileName = [
    ...Array.from({ length: 16 }, () => 'a'), 'input.png',
  ].join('/');
  assert.equal(validate(seventeenSegments), false);
});

test('Phase 7 validation plan fails closed for incomplete coverage, drift, and hostile containers', () => {
  const missing = planInput();
  missing.cases.pop();
  assertH3Error(() => createH3Phase7ValidationPlan(missing), 'H3_REAL_VALIDATION_INVALID');

  const wrongOrder = planInput();
  [wrongOrder.cases[1], wrongOrder.cases[2]] = [wrongOrder.cases[2], wrongOrder.cases[1]];
  assertH3Error(() => createH3Phase7ValidationPlan(wrongOrder), 'H3_REAL_VALIDATION_INVALID');

  const noAudio = planInput();
  noAudio.cases[3] = validationCase('ref2va');
  const refSpec = noAudio.cases[3].generationSpec;
  noAudio.cases[3].generationSpec = normalizeH3GenerationSpec({
    mode: refSpec.mode,
    prompt: refSpec.prompt,
    width: refSpec.width,
    height: refSpec.height,
    durationSeconds: refSpec.durationSeconds,
    seed: refSpec.seed,
    referenceImages: refSpec.referenceImages,
    referenceAudio: null,
  });
  noAudio.cases[3].mediaBindings.referenceAudio = null;
  assertH3Error(() => createH3Phase7ValidationPlan(noAudio), 'H3_REAL_VALIDATION_INVALID');

  const drifted = structuredClone(createH3Phase7ValidationPlan(planInput()));
  drifted.cases[1].prompt['131'].inputs.width = 640;
  assertH3Error(() => validateH3Phase7ValidationPlan(drifted), 'H3_REAL_VALIDATION_INVALID');

  let trapReads = 0;
  const hostile = new Proxy({}, { ownKeys() { trapReads += 1; throw new Error('sentinel'); } });
  assertH3Error(() => createH3Phase7ValidationPlan(hostile), 'H3_REAL_VALIDATION_INVALID');
  assert.equal(trapReads, 0);
});

test('collector can seal an exact pinned candidate receipt while the trust gate remains closed', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-candidate-receipt-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic-local-candidate-video', 'utf8');
  fs.writeFileSync(path.join(tempRoot, 'candidate.mp4'), bytes);
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
                nb_read_frames: '39', avg_frame_rate: '24/1', duration: '1.625',
              },
              { codec_type: 'audio', codec_name: 'aac' },
            ],
            format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.625' },
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const collector = createH3RealValidationCollector({ inspector });
  const candidate = createH3Phase7ValidationPlan(planInput()).cases[1];
  const receipt = await collector.collect({
    receiptUid: uid(741),
    gpuClass: 'rtx4090-48gb',
    promptId: uid(742),
    manifest: candidate.manifest,
    generationSpec: candidate.generationSpec,
    assetVersionUid: uid(743),
    localRelativePath: 'candidate.mp4',
    remoteSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    remoteBytes: bytes.length,
  });
  assert.equal(processCalls, 2);
  assert.equal(validateH3RealValidationReceipt(receipt).mode, 'fl2va-first');
  assertH3Error(() => evaluateH3Phase7Evidence([receipt]), 'H3_REAL_VALIDATION_INVALID');
});

test('strict JSON boundary and CLI prepare create one immutable validation artifact', (t) => {
  assert.deepEqual(parseStrictJson('{"value":1}'), { value: 1 });
  assert.throws(() => parseStrictJson('{"value":1,"value":2}'), TypeError);
  assert.throws(() => parseStrictJson('{"value":1,"\\u0076alue":2}'), TypeError);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-validation-cli-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const inputPath = path.join(tempRoot, 'input.json');
  const outputPath = path.join(tempRoot, 'plan.json');
  fs.writeFileSync(inputPath, `${JSON.stringify(planInput(), null, 2)}\n`, 'utf8');
  const script = path.resolve(__dirname, '../../scripts/h3-real-validation.cjs');
  const first = spawnSync(process.execPath, [
    script, 'prepare', '--input', inputPath, '--output', outputPath,
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 0, first.stderr);
  const written = parseStrictJson(fs.readFileSync(outputPath, 'utf8'), 16 * 1024 * 1024);
  assert.equal(validateH3Phase7ValidationPlan(written).planUid, PLAN_UID);

  const original = fs.readFileSync(outputPath);
  const second = spawnSync(process.execPath, [
    script, 'prepare', '--input', inputPath, '--output', outputPath,
  ], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(second.status, 0);
  assert.deepEqual(fs.readFileSync(outputPath), original);
  assert.equal(second.stderr.includes(DRAMA_UID), false);

  const invalid = spawnSync(process.execPath, [
    script, 'invalid', '--input', inputPath, '--output', path.join(tempRoot, 'invalid.json'),
  ], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stderr, 'H3 validation command failed.\n');
  assert.equal(invalid.stderr.includes(script), false);
});
