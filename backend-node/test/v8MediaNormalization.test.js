'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv2020 = require('ajv/dist/2020');

const profileSchema = require('../../schemas/v8/media-export-profile.schema.json');
const probeSchema = require('../../schemas/v8/media-probe-evidence.schema.json');
const planSchema = require('../../schemas/v8/media-normalization-plan.schema.json');
const {
  getMvpMediaExportProfile,
  parseMediaExportProfileRecord,
  requireTrustedMediaExportProfile,
} = require('../src/media/mediaExportProfile');
const {
  createMediaProbeEvidence,
  parseMediaProbeEvidenceRecord,
  requireTrustedMediaProbeEvidence,
} = require('../src/media/mediaProbeEvidence');
const {
  createMediaNormalizationPlan,
  parseMediaNormalizationPlanRecord,
  requireTrustedMediaNormalizationPlan,
} = require('../src/media/mediaNormalizationPlan');
const {
  createMediaNormalizationFixture,
  probeInput,
  trustedProbe,
} = require('./helpers/v8MediaFixture');
const { uid } = require('./helpers/v8AudioFixture');

function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addSchema(profileSchema);
  ajv.addSchema(probeSchema);
  ajv.addSchema(planSchema);
  return {
    profile: ajv.getSchema(profileSchema.$id),
    probe: ajv.getSchema(probeSchema.$id),
    plan: ajv.getSchema(planSchema.$id),
  };
}

test('fixes one hash-bound 1080p MVP export profile across runtime and Schema', () => {
  const profile = getMvpMediaExportProfile();
  const validate = validators().profile;
  assert.equal(validate(profile), true, JSON.stringify(validate.errors));
  assert.equal(profile.profileId, 'mvp-1080p-16x9');
  assert.deepEqual([profile.video.width, profile.video.height], [1920, 1080]);
  assert.deepEqual(profile.video.frameRate, { numerator: 24, denominator: 1, mode: 'cfr' });
  assert.equal(profile.video.codec, 'h264');
  assert.equal(profile.video.pixelFormat, 'yuv420p');
  assert.deepEqual(
    [profile.audio.codec, profile.audio.sampleRateHz, profile.audio.channels],
    ['aac', 48_000, 2],
  );
  assert.equal(profile.subtitles.mode, 'burn_in');
  assert.equal(profile.mux.fastStart, true);
  assert.deepEqual(parseMediaExportProfileRecord(JSON.parse(JSON.stringify(profile))), profile);
  assert.deepEqual(requireTrustedMediaExportProfile(profile), profile);
  assert.throws(() => requireTrustedMediaExportProfile(JSON.parse(JSON.stringify(profile))));
  assert.throws(() => parseMediaExportProfileRecord({ ...profile, profileSha256: '0'.repeat(64) }));
});

test('creates exact media probe evidence without exposing a local absolute path', () => {
  const fixture = createMediaNormalizationFixture();
  const input = fixture.probeInputs[0];
  const candidate = createMediaProbeEvidence(input);
  const validate = validators().probe;
  assert.equal(validate(candidate), true, JSON.stringify(validate.errors));
  assert.deepEqual(parseMediaProbeEvidenceRecord(JSON.parse(JSON.stringify(candidate))), candidate);
  assert.equal(candidate.assetVersionUid, input.assetVersion.uid);
  assert.equal(candidate.assetVersionSha256, input.assetVersion.sha256);
  assert.equal(candidate.relativePathSha256.length, 64);
  assert.equal(candidate.decoded, true);
  assert.equal(JSON.stringify(candidate).includes(input.assetVersion.relativePath), false);
  assert.equal(JSON.stringify(candidate).includes('C:\\'), false);
  assert.throws(() => requireTrustedMediaProbeEvidence(candidate));
  assert.deepEqual(requireTrustedMediaProbeEvidence(fixture.mediaProbes[0]), fixture.mediaProbes[0]);
});

test('normalizes every unique video, dialogue/native audio and BGM source in canonical order', () => {
  const fixture = createMediaNormalizationFixture('independent_tts');
  const { plan } = fixture;
  const validate = validators().plan;
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.equal(plan.productionTimelineSnapshotUid, fixture.timelineFixture.snapshot.uid);
  assert.equal(plan.productionTimelineSnapshotSha256, fixture.timelineFixture.snapshot.snapshotSha256);
  assert.deepEqual(plan.mediaProbeUids, fixture.mediaProbes.map((probe) => probe.uid));
  assert.equal(plan.videoInputs.length, 2);
  assert.deepEqual(plan.videoInputs.map((entry) => entry.target), [
    {
      width: 1920, height: 1080,
      frameRate: { numerator: 24, denominator: 1 },
      pixelFormat: 'yuv420p', scaleMode: 'contain', padColor: '#000000',
      sampleAspectRatio: '1:1',
    },
    {
      width: 1920, height: 1080,
      frameRate: { numerator: 24, denominator: 1 },
      pixelFormat: 'yuv420p', scaleMode: 'contain', padColor: '#000000',
      sampleAspectRatio: '1:1',
    },
  ]);
  assert.deepEqual(plan.audioInputs.map((entry) => entry.role), ['dialogue', 'dialogue', 'bgm']);
  assert.equal(plan.audioInputs.every((entry) => (
    entry.target.codec === 'aac'
      && entry.target.sampleRateHz === 48_000
      && entry.target.channels === 2
  )), true);
  assert.deepEqual(parseMediaNormalizationPlanRecord(JSON.parse(JSON.stringify(plan))), plan);
  assert.deepEqual(requireTrustedMediaNormalizationPlan(plan), plan);
  assert.throws(() => requireTrustedMediaNormalizationPlan(fixture.candidate));
});

test('fails closed on missing, extra, duplicate, reordered and media-type-incompatible probes', () => {
  const fixture = createMediaNormalizationFixture();
  const source = fixture.input;
  const cases = [
    source.mediaProbes.slice(0, -1),
    [...source.mediaProbes, source.mediaProbes[0]],
    [source.mediaProbes[1], source.mediaProbes[0], ...source.mediaProbes.slice(2)],
  ];
  for (const mediaProbes of cases) {
    assert.throws(() => createMediaNormalizationPlan({ ...source, mediaProbes }));
  }

  const first = fixture.probeInputs[0];
  assert.throws(() => {
    const incompatible = trustedProbe({
      ...first,
      uid: uid(1490),
      video: null,
      audio: {
        codecName: 'pcm_s16le', sampleRateHz: 48_000, channels: 2,
        channelLayout: 'stereo', sampleFormat: 's16',
      },
    });
    createMediaNormalizationPlan({
      ...source,
      mediaProbes: [incompatible, ...source.mediaProbes.slice(1)],
    });
  });
});

test('requires an audio stream when an H3 video is the native audio source', () => {
  const fixture = createMediaNormalizationFixture('h3_native');
  const sharedIndex = fixture.probeInputs.findIndex((input) => (
    input.assetVersion.uid === fixture.timelineFixture.snapshot.audioSources[0].assetVersion.uid
  ));
  assert.notEqual(sharedIndex, -1);
  const input = fixture.probeInputs[sharedIndex];
  const withoutAudio = trustedProbe({ ...input, uid: uid(1491), audio: null });
  const probes = [...fixture.mediaProbes];
  probes[sharedIndex] = withoutAudio;
  assert.throws(() => createMediaNormalizationPlan({ ...fixture.input, mediaProbes: probes }));
});

test('external envelopes reject coordinated plan/probe drift and hostile objects without trap execution', () => {
  const fixture = createMediaNormalizationFixture();
  const drifted = JSON.parse(JSON.stringify(fixture.plan));
  drifted.createdAtEpochMs += 1;
  const unsigned = { ...drifted };
  delete unsigned.planSha256;
  const { createHash } = require('node:crypto');
  drifted.planSha256 = createHash('sha256').update(JSON.stringify(unsigned), 'utf8').digest('hex');
  assert.throws(() => fixture.verifier.verify(drifted, fixture.input.uid));

  let rootReads = 0;
  const rootProxy = new Proxy(fixture.plan, {
    ownKeys() { rootReads += 1; return []; },
    getOwnPropertyDescriptor() { rootReads += 1; return undefined; },
    getPrototypeOf() { rootReads += 1; return Object.prototype; },
  });
  assert.throws(() => fixture.verifier.verify(rootProxy, fixture.input.uid));
  assert.equal(rootReads, 0);

  let arrayReads = 0;
  const probesProxy = new Proxy(fixture.input.mediaProbes, {
    ownKeys() { arrayReads += 1; return []; },
    getOwnPropertyDescriptor() { arrayReads += 1; return undefined; },
    getPrototypeOf() { arrayReads += 1; return Array.prototype; },
  });
  assert.throws(() => createMediaNormalizationPlan({ ...fixture.input, mediaProbes: probesProxy }));
  assert.equal(arrayReads, 0);

  let getterReads = 0;
  const hostileProbe = { ...fixture.probeInputs[0] };
  Object.defineProperty(hostileProbe, 'bytes', {
    enumerable: true,
    get() { getterReads += 1; return 1; },
  });
  assert.throws(() => createMediaProbeEvidence(hostileProbe));
  assert.equal(getterReads, 0);
});

test('probe and plan parsers reject hash drift and unknown fields', () => {
  const fixture = createMediaNormalizationFixture();
  const probe = JSON.parse(JSON.stringify(fixture.mediaProbes[0]));
  assert.throws(() => parseMediaProbeEvidenceRecord({ ...probe, evidenceSha256: 'f'.repeat(64) }));
  assert.throws(() => parseMediaProbeEvidenceRecord({ ...probe, unexpected: true }));
  assert.throws(() => parseMediaNormalizationPlanRecord({ ...fixture.plan, unexpected: true }));

  const wrongDurationInput = probeInput(
    fixture.timelineFixture.snapshot.shots[0].assetVersion,
    1492,
  );
  wrongDurationInput.durationMs += 301;
  assert.throws(() => createMediaProbeEvidence(wrongDurationInput));
});
