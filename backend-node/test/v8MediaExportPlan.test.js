'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv2020 = require('ajv/dist/2020');

const {
  createAssSubtitleDocument,
  escapeAssSubtitleText,
  formatAssTimestamp,
} = require('../src/media/assSubtitleDocument');
const {
  createMediaExportExecutionPlan,
  requireTrustedMediaExportExecutionPlan,
} = require('../src/media/mediaExportExecutionPlan');
const { createFfmpegComposition } = require('../src/media/ffmpegComposition');
const {
  createMediaExportReceipt,
  parseMediaExportReceiptRecord,
} = require('../src/media/mediaExportReceipt');
const { canonicalHash } = require('../src/audio/audioContract');
const { createMediaNormalizationFixture } = require('./helpers/v8MediaFixture');
const { uid } = require('./helpers/v8AudioFixture');

function executionInput(mode = 'independent_tts') {
  const fixture = createMediaNormalizationFixture(mode);
  return {
    fixture,
    input: {
      schemaVersion: '8.0',
      uid: uid(1500),
      productionTimelineSnapshot: fixture.input.productionTimelineSnapshot,
      normalizationPlan: fixture.plan,
      createdAtEpochMs: 1_800_000_800_000,
    },
  };
}

test('creates one trusted, deterministic execution plan for all three audio modes', () => {
  for (const mode of ['independent_tts', 'h3_native', 'hybrid']) {
    const { input } = executionInput(mode);
    const plan = createMediaExportExecutionPlan(input);

    assert.equal(plan.schemaVersion, 'media-export-execution-plan.v1');
    assert.equal(plan.algorithmVersion, 'local-ffmpeg-export.v1');
    assert.equal(plan.mode, mode);
    assert.equal(plan.outputRelativePath, `projects/${plan.dramaUid}/exports/${plan.uid}.mp4`);
    assert.equal(plan.videoSources.length, input.productionTimelineSnapshot.shots.length);
    assert.equal(plan.audioSources.at(-1).role, 'bgm');
    assert.equal(plan.subtitleDocument.trackSha256, plan.subtitleTrackSha256);
    assert.equal(plan.profile.video.width, 1920);
    assert.equal(plan.profile.video.height, 1080);
    assert.equal(plan.profile.video.frameRate.numerator, 24);
    assert.match(plan.executionPlanSha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(requireTrustedMediaExportExecutionPlan(plan), plan);
    assert.throws(() => requireTrustedMediaExportExecutionPlan(JSON.parse(JSON.stringify(plan))),
      (error) => error.code === 'MEDIA_EXPORT_DATA_INVALID');
  }
});

test('execution plan rejects untrusted, rebound, stale, and identity-colliding inputs', () => {
  const { fixture, input } = executionInput();
  const cases = [
    { ...input, normalizationPlan: JSON.parse(JSON.stringify(input.normalizationPlan)) },
    { ...input, productionTimelineSnapshot: fixture.timelineFixture.candidate },
    { ...input, uid: input.normalizationPlan.uid },
    { ...input, createdAtEpochMs: input.normalizationPlan.createdAtEpochMs - 1 },
  ];
  for (const value of cases) {
    assert.throws(() => createMediaExportExecutionPlan(value),
      (error) => error.code === 'MEDIA_EXPORT_INPUT_INVALID');
  }
});

test('ASS rendering is deterministic, bounded, and escapes override syntax', () => {
  const { input } = executionInput();
  const document = createAssSubtitleDocument(input.productionTimelineSnapshot);

  assert.equal(document.schemaVersion, 'ass-subtitle-document.v1');
  assert.equal(document.algorithmVersion, 'ass-burn-in-centisecond.v1');
  assert.equal(document.trackSha256, input.productionTimelineSnapshot.subtitleTrack.trackSha256);
  assert.match(document.content, /^\[Script Info\]/u);
  assert.match(document.content, /Dialogue: 0,0:00:00\.00,0:00:00\.70/u);
  assert.equal(formatAssTimestamp(3_599_990), '0:59:59.99');
  assert.equal(escapeAssSubtitleText('{\\pos(1,2)}\r\nnext'), '\\{\\\\pos(1,2)\\}\\Nnext');
  assert.throws(() => escapeAssSubtitleText('bad\u0000text'),
    (error) => error.code === 'MEDIA_EXPORT_INPUT_INVALID');
  assert.match(document.contentSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(document), true);
});

test('ASS quantization rejects cues that cannot occupy one centisecond', () => {
  assert.throws(() => formatAssTimestamp(-1),
    (error) => error.code === 'MEDIA_EXPORT_INPUT_INVALID');
  assert.throws(() => formatAssTimestamp(3_600_001),
    (error) => error.code === 'MEDIA_EXPORT_INPUT_INVALID');
});

test('builds deterministic bounded FFmpeg composition graphs for every audio mode', () => {
  const expectedForeground = {
    independent_tts: ['dialogue', 'dialogue', 'bgm'],
    h3_native: ['native', 'bgm'],
    hybrid: ['dialogue', 'dialogue', 'native', 'bgm'],
  };
  for (const mode of Object.keys(expectedForeground)) {
    const { input } = executionInput(mode);
    const plan = createMediaExportExecutionPlan(input);
    const composition = createFfmpegComposition(plan);
    assert.equal(composition.videoJobs.length, plan.videoSources.length);
    assert.equal(composition.videoConcatDocument.split('\n').filter(Boolean).length,
      plan.videoSources.length);
    assert.deepEqual(composition.audioInputs.map((entry) => entry.kind), expectedForeground[mode]);
    assert.match(composition.audioFilterScript, /amix=inputs=/u);
    assert.match(composition.audioFilterScript, /volume=/u);
    if (mode !== 'h3_native') {
      assert.match(composition.audioFilterScript, /adelay=[0-9]+\|[0-9]+/u);
      assert.equal(composition.dialogueConcatDocument, null);
    }
    assert.match(composition.videoFilterScript, /ass=filename=subtitles\.ass/u);
    assert.doesNotMatch(composition.audioFilterScript, /projects\//u);
    assert.match(composition.compositionSha256, /^[0-9a-f]{64}$/u);
  }
  const { fixture } = executionInput();
  assert.throws(() => createFfmpegComposition(fixture.candidate),
    (error) => error.code === 'MEDIA_EXPORT_INPUT_INVALID');
});

test('creates a profile-bound export receipt that agrees with the public Schema', () => {
  const { input } = executionInput();
  const plan = createMediaExportExecutionPlan(input);
  const receipt = createMediaExportReceipt({
    schemaVersion: '8.0',
    executionPlan: plan,
    output: {
      relativePath: plan.outputRelativePath,
      sha256: 'd'.repeat(64),
      bytes: 123456,
      durationMs: plan.durationMs,
      formatNames: ['mov', 'mp4'],
      video: {
        codecName: 'h264', width: 1920, height: 1080, pixelFormat: 'yuv420p',
        averageFrameRate: { numerator: 24, denominator: 1 },
        timeBase: { numerator: 1, denominator: 90000 },
        sampleAspectRatio: '1:1', displayAspectRatio: '16:9', frameCount: 36,
      },
      audio: {
        codecName: 'aac', sampleRateHz: 48000, channels: 2,
        channelLayout: 'stereo', sampleFormat: 'fltp',
      },
      decoded: true,
      fastStart: true,
    },
    completedAtEpochMs: input.createdAtEpochMs + 1,
  });
  const schema = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../schemas/v8/media-export-receipt.schema.json'), 'utf8',
  ));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  assert.equal(validate(receipt), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseMediaExportReceiptRecord(JSON.parse(JSON.stringify(receipt))), receipt);

  const drifted = JSON.parse(JSON.stringify(receipt));
  drifted.output.video.width = 1919;
  const driftedBase = { ...drifted };
  delete driftedBase.receiptSha256;
  drifted.receiptSha256 = canonicalHash(driftedBase);
  assert.throws(() => parseMediaExportReceiptRecord(drifted),
    (error) => error.code === 'MEDIA_EXPORT_DATA_INVALID');
  assert.equal(validate(drifted), false);

  const rebound = JSON.parse(JSON.stringify(receipt));
  rebound.output.relativePath = `projects/${rebound.dramaUid}/exports/${uid(1599)}.mp4`;
  const reboundBase = { ...rebound };
  delete reboundBase.receiptSha256;
  rebound.receiptSha256 = canonicalHash(reboundBase);
  assert.throws(() => parseMediaExportReceiptRecord(rebound),
    (error) => error.code === 'MEDIA_EXPORT_DATA_INVALID');
});
