const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const {
  TIMING_ALGORITHM_VERSION,
  createDialogueDeliveryPlan,
  parseDialogueDeliveryPlan,
} = require('../src/audio/dialogueDelivery');

function uid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function input(overrides = {}) {
  return {
    schemaVersion: '8.0',
    timingAlgorithmVersion: TIMING_ALGORITHM_VERSION,
    uid: uid(81000),
    dramaUid: uid(81001),
    scriptResultUid: uid(81002),
    shotId: 'shot-01',
    dialogueEntryId: 'entry-upstairs-dialogue',
    characterUid: uid(81003),
    voiceProfileUid: uid(81004),
    text: '楼上有人。',
    emotion: 'neutral',
    emotionIntensityPermille: 500,
    speedPermille: 1000,
    pauseBeforeMs: 100,
    pauseAfterMs: 200,
    ...overrides,
  };
}

test('Chinese dialogue produces an exact deterministic duration and source hash', () => {
  const plan = createDialogueDeliveryPlan(input());

  assert.equal(plan.timingAlgorithmVersion, 'dialogue-timing.v1');
  assert.equal(plan.textSha256, createHash('sha256').update('楼上有人。', 'utf8').digest('hex'));
  assert.match(plan.timingSha256, /^[0-9a-f]{64}$/u);
  assert.equal(plan.spokenUnitCount, 4);
  assert.equal(plan.punctuationPauseMs, 320);
  assert.equal(plan.estimatedSpeechDurationMs, 1320);
  assert.equal(plan.estimatedTotalDurationMs, 1620);
  assert.deepEqual(parseDialogueDeliveryPlan(plan), plan);
  assert.ok(Object.isFrozen(plan));
});

test('versioned scalar clusters, word runs, punctuation groups and speed remain reproducible', () => {
  const unicode = createDialogueDeliveryPlan(input({
    text: 'Café family 👨‍👩‍👧‍👦!',
    speedPermille: 1250,
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }));
  assert.equal(unicode.spokenUnitCount, 3);
  assert.equal(unicode.punctuationPauseMs, 256);
  assert.equal(unicode.estimatedSpeechDurationMs, 856);
  assert.equal(unicode.estimatedTotalDurationMs, 856);
  assert.doesNotThrow(() => createDialogueDeliveryPlan(input({ text: '合法😀代理对。' })));

  for (const text of [
    String.fromCodePoint(0x2ebf0, 0x2ebf1),
    String.fromCodePoint(0x2ee5e, 0x2ee5f),
    String.fromCodePoint(0x1aff0, 0x1aff1),
    String.fromCodePoint(0x1b132, 0x1b150),
  ]) {
    const extendedCjk = createDialogueDeliveryPlan(input({ text }));
    assert.equal(extendedCjk.spokenUnitCount, 2);
  }
  const maximalExtensionI = createDialogueDeliveryPlan(input({
    text: String.fromCodePoint(0x2ebf0).repeat(1024),
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }));
  assert.equal(maximalExtensionI.spokenUnitCount, 1024);
  assert.equal(maximalExtensionI.estimatedSpeechDurationMs, 256000);

  const flags = [
    ['🇨🇳', 1],
    ['🇨🇳🇺🇸', 2],
    [String.fromCodePoint(0x1f1e8), 1],
    [String.fromCodePoint(0x1f1e8, 0x1f1f3, 0x1f1fa), 2],
    [String.fromCodePoint(
      0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f,
    ), 1],
    [String.fromCodePoint(
      0x1f3f4, 0xfe0f, 0xe0067, 0xe0062, 0xe007f,
    ), 1],
    [String.fromCodePoint(0x1f3f4, 0xfe0f, 0xfe0f), 1],
  ];
  for (const [text, units] of flags) {
    assert.equal(createDialogueDeliveryPlan(input({ text })).spokenUnitCount, units);
  }

  const grouped = createDialogueDeliveryPlan(input({
    text: '等等……什么？！',
    pauseBeforeMs: 0,
    pauseAfterMs: 0,
  }));
  assert.equal(grouped.spokenUnitCount, 4);
  assert.equal(grouped.punctuationPauseMs, 640);
  assert.equal(grouped.estimatedSpeechDurationMs, 1640);

  const slow = createDialogueDeliveryPlan(input({ speedPermille: 500 }));
  const fast = createDialogueDeliveryPlan(input({ speedPermille: 2000 }));
  assert.ok(slow.estimatedSpeechDurationMs > fast.estimatedSpeechDurationMs);
  assert.equal(slow.pauseBeforeMs, fast.pauseBeforeMs);
  assert.equal(slow.pauseAfterMs, fast.pauseAfterMs);
});

test('all delivery parameters are exact, bounded and preserve the original line', () => {
  const plan = createDialogueDeliveryPlan(input({
    emotion: 'surprised',
    emotionIntensityPermille: 1000,
    speedPermille: 2000,
    pauseBeforeMs: 5000,
    pauseAfterMs: 5000,
  }));
  assert.equal(plan.text, '楼上有人。');

  for (const mutation of [
    { timingAlgorithmVersion: 'dialogue-timing.v2' },
    { emotion: '警惕' },
    { emotionIntensityPermille: -1 },
    { emotionIntensityPermille: 1001 },
    { speedPermille: 499 },
    { speedPermille: 2001 },
    { pauseBeforeMs: -1 },
    { pauseAfterMs: 5001 },
    { text: '！？？' },
    { text: 'Cafe\u0301' },
    { text: 'bad\u0000text' },
    { text: '\ud800a' },
    { text: '\udfffa' },
    { text: String.fromCodePoint(0xe0067) },
    { text: String.fromCodePoint(0x1f3f4, 0xe0067) },
    { text: String.fromCodePoint(0x1f3f4, 0xfe0f, 0xfe0f, 0xe0067, 0xe007f) },
    { text: '字'.repeat(1025) },
  ]) {
    assert.throws(() => createDialogueDeliveryPlan(input(mutation)), /Dialogue delivery input is invalid/u);
  }
  assert.throws(
    () => createDialogueDeliveryPlan({ ...input(), provider: 'synthetic-provider' }),
    /Dialogue delivery input is invalid/u,
  );
});

test('persisted derived values are recomputed instead of trusted', () => {
  const plan = createDialogueDeliveryPlan(input());
  for (const mutation of [
    { textSha256: '0'.repeat(64) },
    { timingSha256: '0'.repeat(64) },
    { spokenUnitCount: plan.spokenUnitCount + 1 },
    { punctuationPauseMs: plan.punctuationPauseMs + 1 },
    { estimatedSpeechDurationMs: plan.estimatedSpeechDurationMs + 1 },
    { estimatedTotalDurationMs: plan.estimatedTotalDurationMs + 1 },
  ]) {
    assert.throws(
      () => parseDialogueDeliveryPlan({ ...plan, ...mutation }),
      /Dialogue delivery record is invalid/u,
    );
  }

  const high = '\ud800a';
  const adjacentHigh = '\ud801a';
  assert.notEqual(high, adjacentHigh);
  assert.equal(
    createHash('sha256').update(high, 'utf8').digest('hex'),
    createHash('sha256').update(adjacentHigh, 'utf8').digest('hex'),
  );
  assert.throws(() => createDialogueDeliveryPlan(input({ text: high })),
    /Dialogue delivery input is invalid/u);
  assert.throws(() => createDialogueDeliveryPlan(input({ text: adjacentHigh })),
    /Dialogue delivery input is invalid/u);
});

test('hostile accessors and proxies are rejected without execution', () => {
  let reads = 0;
  const hostile = input();
  Object.defineProperty(hostile, 'text', {
    enumerable: true,
    get() {
      reads += 1;
      return 'leaked';
    },
  });
  assert.throws(() => createDialogueDeliveryPlan(hostile), /Dialogue delivery input is invalid/u);
  assert.equal(reads, 0);

  const proxy = new Proxy(input(), {
    ownKeys() {
      reads += 1;
      return [];
    },
  });
  assert.throws(() => createDialogueDeliveryPlan(proxy), /Dialogue delivery input is invalid/u);
  assert.equal(reads, 0);

  const plan = createDialogueDeliveryPlan(input());
  const storedProxy = new Proxy(plan, {
    getOwnPropertyDescriptor() {
      reads += 1;
      return undefined;
    },
  });
  assert.throws(() => parseDialogueDeliveryPlan(storedProxy), /Dialogue delivery record is invalid/u);
  assert.equal(reads, 0);
});

test('timing does not depend on host locale or Intl segmentation data', () => {
  const original = Intl.Segmenter;
  let constructorCalls = 0;
  Intl.Segmenter = class ForbiddenSegmenter {
    constructor() {
      constructorCalls += 1;
      throw new Error('host segmenter must not execute');
    }
  };
  try {
    const first = createDialogueDeliveryPlan(input({ text: 'Café 家庭 👨‍👩‍👧‍👦！' }));
    const second = createDialogueDeliveryPlan(input({ text: 'Café 家庭 👨‍👩‍👧‍👦！' }));
    assert.deepEqual(second, first);
    assert.equal(first.spokenUnitCount, 4);
    assert.equal(constructorCalls, 0);
  } finally {
    Intl.Segmenter = original;
  }
});

test('oversized text is rejected before normalization or trimming scans', () => {
  const originalTrim = String.prototype.trim;
  const originalNormalize = String.prototype.normalize;
  let trimCalls = 0;
  let normalizeCalls = 0;
  let failure;
  String.prototype.trim = function countedTrim() {
    trimCalls += 1;
    return Reflect.apply(originalTrim, this, []);
  };
  String.prototype.normalize = function countedNormalize(form) {
    normalizeCalls += 1;
    return Reflect.apply(originalNormalize, this, [form]);
  };
  try {
    createDialogueDeliveryPlan(input({ text: 'x'.repeat(4097) }));
  } catch (error) {
    failure = error;
  } finally {
    String.prototype.trim = originalTrim;
    String.prototype.normalize = originalNormalize;
  }
  assert.match(failure?.message, /Dialogue delivery input is invalid/u);
  assert.equal(trimCalls, 0);
  assert.equal(normalizeCalls, 0);
});

test('public Schema accepts only the same exact dialogue delivery record', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v8/dialogue-delivery.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const plan = createDialogueDeliveryPlan(input());
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  const tagFlag = String.fromCodePoint(
    0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f,
  );
  assert.equal(validate({ ...plan, text: tagFlag }), true, JSON.stringify(validate.errors));
  const tagFlagWithVs = String.fromCodePoint(
    0x1f3f4, 0xfe0f, 0xe0067, 0xe0062, 0xe007f,
  );
  assert.equal(validate({ ...plan, text: tagFlagWithVs }), true, JSON.stringify(validate.errors));
  const blackFlagWithTwoVs = String.fromCodePoint(0x1f3f4, 0xfe0f, 0xfe0f);
  assert.equal(
    validate({ ...plan, text: blackFlagWithTwoVs }),
    true,
    JSON.stringify(validate.errors),
  );

  for (const mutation of [
    { ...plan, extra: true },
    { ...plan, timingAlgorithmVersion: 'dialogue-timing.v2' },
    { ...plan, emotion: '警惕' },
    { ...plan, speedPermille: 499 },
    { ...plan, textSha256: 'invalid' },
    { ...plan, timingSha256: 'invalid' },
    { ...plan, estimatedTotalDurationMs: 0 },
    { ...plan, text: '\ud800a' },
    { ...plan, text: '\udfffa' },
    { ...plan, text: String.fromCodePoint(0xe0067) },
    { ...plan, text: String.fromCodePoint(0x1f3f4, 0xe0067) },
    {
      ...plan,
      text: String.fromCodePoint(0x1f3f4, 0xfe0f, 0xfe0f, 0xe0067, 0xe007f),
    },
  ]) {
    assert.equal(validate(mutation), false);
  }
});
