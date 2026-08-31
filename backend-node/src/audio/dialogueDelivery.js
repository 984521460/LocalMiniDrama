const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const INPUT_KEYS = Object.freeze([
  'schemaVersion', 'timingAlgorithmVersion', 'uid', 'dramaUid', 'scriptResultUid', 'shotId', 'dialogueEntryId',
  'characterUid', 'voiceProfileUid', 'text', 'emotion', 'emotionIntensityPermille',
  'speedPermille', 'pauseBeforeMs', 'pauseAfterMs',
]);
const RECORD_KEYS = Object.freeze([
  ...INPUT_KEYS,
  'textSha256', 'timingSha256', 'spokenUnitCount', 'punctuationPauseMs',
  'estimatedSpeechDurationMs', 'estimatedTotalDurationMs',
]);
const EMOTIONS = Object.freeze([
  'neutral', 'happy', 'sad', 'angry', 'fearful', 'surprised',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE_ID = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;
const FORBIDDEN_BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u;
const TIMING_ALGORITHM_VERSION = 'dialogue-timing.v1';
// Frozen from the Han, Hiragana, Katakana and Hangul script ranges in the
// project runtime's Unicode 17.0 data. Block tails reserved for Extension I
// and the three supplementary Kana blocks stay in v1 so future host tables
// cannot change how those scalars are timed.
const CJK_RANGES_V1 = Object.freeze([
  [0x1100, 0x11ff], [0x2e80, 0x2e99], [0x2e9b, 0x2ef3], [0x2f00, 0x2fd5],
  [0x3005, 0x3005], [0x3007, 0x3007], [0x3021, 0x3029], [0x302e, 0x302f],
  [0x3038, 0x303b], [0x3041, 0x3096], [0x309d, 0x309f], [0x30a1, 0x30fa],
  [0x30fd, 0x30ff], [0x3131, 0x318e], [0x31f0, 0x321e], [0x3260, 0x327e],
  [0x32d0, 0x32fe], [0x3300, 0x3357], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa960, 0xa97c], [0xac00, 0xd7a3], [0xd7b0, 0xd7c6], [0xd7cb, 0xd7fb],
  [0xf900, 0xfa6d], [0xfa70, 0xfad9], [0xff66, 0xff6f], [0xff71, 0xff9d],
  [0xffa0, 0xffbe], [0xffc2, 0xffc7], [0xffca, 0xffcf], [0xffd2, 0xffd7],
  [0xffda, 0xffdc], [0x16fe2, 0x16fe3], [0x16ff0, 0x16ff6],
  [0x1aff0, 0x1afff], [0x1b000, 0x1b0ff], [0x1b100, 0x1b12f],
  [0x1b130, 0x1b16f], [0x1f200, 0x1f200], [0x20000, 0x2a6df],
  [0x2a700, 0x2b81d], [0x2b820, 0x2cead], [0x2ceb0, 0x2ebe0],
  [0x2ebf0, 0x2ee5f], [0x2f800, 0x2fa1d], [0x30000, 0x3134a],
  [0x31350, 0x33479],
]);
const BASE_UNITS_PER_MINUTE = 240;
const MAX_TEXT_CODE_POINTS = 1024;
const MAX_TEXT_BYTES = 4096;
const MAX_TOTAL_DURATION_MS = 600_000;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const DEFINE_PROPERTY = Object.defineProperty;
const GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const HAS_OWN = Object.hasOwn;
const OWN_KEYS = Reflect.ownKeys;
const REGEXP_TEST = RegExp.prototype.test;
const STRING_CODE_POINT_AT = String.prototype.codePointAt;
const STRING_NORMALIZE = String.prototype.normalize;
const STRING_TRIM = String.prototype.trim;

function includes(values, expected) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === expected) return true;
  }
  return false;
}

function defineValue(target, key, value) {
  Reflect.apply(DEFINE_PROPERTY, Object, [target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  }]);
}

function invalid(kind) {
  throw new TypeError(`Dialogue delivery ${kind} is invalid`);
}

function ownDataSnapshot(value, keys, kind) {
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) invalid(kind);
  const prototype = Reflect.apply(GET_PROTOTYPE_OF, Object, [value]);
  if (prototype !== Object.prototype && prototype !== null) invalid(kind);
  const descriptors = Reflect.apply(GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  const actualKeys = Reflect.apply(OWN_KEYS, Reflect, [descriptors]);
  if (actualKeys.length !== keys.length) invalid(kind);
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (typeof actualKeys[index] !== 'string') invalid(kind);
  }
  const snapshot = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !HAS_OWN(descriptor, 'value')) invalid(kind);
    defineValue(snapshot, key, descriptor.value);
  }
  return snapshot;
}

function canonicalUid(value, kind) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, UUID_V4, [value])) invalid(kind);
  return value;
}

function sourceId(value, kind) {
  if (typeof value !== 'string' || !Reflect.apply(REGEXP_TEST, SOURCE_ID, [value])) invalid(kind);
  return value;
}

function boundedInteger(value, minimum, maximum, kind) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(kind);
  return value;
}

function isEmojiTag(codePoint) {
  return inRange(codePoint, 0xe0020, 0xe007f);
}

function hasInvalidEmojiTagSequence(value) {
  let blackFlagOpen = false;
  let tagSequenceOpen = false;
  let variationSelectorCount = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = Reflect.apply(STRING_CODE_POINT_AT, value, [index]);
    index += codePoint > 0xffff ? 2 : 1;
    if (inRange(codePoint, 0xe0020, 0xe007e)) {
      if (!blackFlagOpen && !tagSequenceOpen) return true;
      if (blackFlagOpen && variationSelectorCount > 1) return true;
      blackFlagOpen = false;
      tagSequenceOpen = true;
      variationSelectorCount = 0;
      continue;
    }
    if (codePoint === 0xe007f) {
      if (!tagSequenceOpen) return true;
      tagSequenceOpen = false;
      blackFlagOpen = false;
      variationSelectorCount = 0;
      continue;
    }
    if (tagSequenceOpen) return true;
    if (codePoint === 0xfe0f && blackFlagOpen) {
      variationSelectorCount += 1;
      continue;
    }
    blackFlagOpen = codePoint === 0x1f3f4;
    variationSelectorCount = 0;
  }
  return tagSequenceOpen;
}

function canonicalText(value, kind) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_BYTES) {
    invalid(kind);
  }
  if (
    value !== Reflect.apply(STRING_TRIM, value, [])
    || value !== Reflect.apply(STRING_NORMALIZE, value, ['NFC'])
    || Reflect.apply(REGEXP_TEST, FORBIDDEN_CONTROL, [value])
    || Reflect.apply(REGEXP_TEST, FORBIDDEN_BIDI, [value])
    || Reflect.apply(REGEXP_TEST, UNPAIRED_SURROGATE, [value])
    || hasInvalidEmojiTagSequence(value)
    || Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) invalid(kind);
  let codePoints = 0;
  for (let index = 0; index < value.length;) {
    const codePoint = Reflect.apply(STRING_CODE_POINT_AT, value, [index]);
    index += codePoint > 0xffff ? 2 : 1;
    codePoints += 1;
    if (codePoints > MAX_TEXT_CODE_POINTS) invalid(kind);
  }
  return value;
}

function inRange(codePoint, minimum, maximum) {
  return codePoint >= minimum && codePoint <= maximum;
}

// dialogue-timing.v1 owns these numeric ranges. They are deliberately not
// delegated to Intl, locale data, ICU, or Unicode property escapes.
function isCjk(codePoint) {
  for (let index = 0; index < CJK_RANGES_V1.length; index += 1) {
    const range = CJK_RANGES_V1[index];
    if (inRange(codePoint, range[0], range[1])) return true;
  }
  return false;
}

function isExtender(codePoint) {
  return inRange(codePoint, 0x0300, 0x036f)
    || inRange(codePoint, 0x1ab0, 0x1aff)
    || inRange(codePoint, 0x1dc0, 0x1dff)
    || inRange(codePoint, 0x20d0, 0x20ff)
    || inRange(codePoint, 0xfe00, 0xfe0f)
    || inRange(codePoint, 0xfe20, 0xfe2f)
    || inRange(codePoint, 0x1f3fb, 0x1f3ff)
    || inRange(codePoint, 0xe0100, 0xe01ef);
}

function isSymbol(codePoint) {
  return inRange(codePoint, 0x20a0, 0x20cf)
    || inRange(codePoint, 0x2100, 0x23ff)
    || inRange(codePoint, 0x2460, 0x27bf)
    || inRange(codePoint, 0x2b00, 0x2bff)
    || inRange(codePoint, 0x1f000, 0x1faff);
}

function isRegionalIndicator(codePoint) {
  return inRange(codePoint, 0x1f1e6, 0x1f1ff);
}

function isSeparatorOrPunctuation(codePoint) {
  return codePoint <= 0x20
    || inRange(codePoint, 0x21, 0x2f)
    || inRange(codePoint, 0x3a, 0x40)
    || inRange(codePoint, 0x5b, 0x60)
    || inRange(codePoint, 0x7b, 0x7e)
    || inRange(codePoint, 0x00a0, 0x00bf)
    || inRange(codePoint, 0x2000, 0x206f)
    || inRange(codePoint, 0x2e00, 0x2e7f)
    || inRange(codePoint, 0x3000, 0x303f)
    || inRange(codePoint, 0xfe10, 0xfe1f)
    || inRange(codePoint, 0xfe30, 0xfe6f)
    || inRange(codePoint, 0xff01, 0xff65);
}

function spokenUnitCount(text) {
  let count = 0;
  let inWord = false;
  let previousBaseWasSymbol = false;
  let joinNextSymbol = false;
  let regionalIndicatorParity = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = Reflect.apply(STRING_CODE_POINT_AT, text, [index]);
    index += codePoint > 0xffff ? 2 : 1;
    if (isExtender(codePoint) || isEmojiTag(codePoint)) continue;
    if (codePoint === 0x200d) {
      joinNextSymbol = previousBaseWasSymbol;
      inWord = false;
      regionalIndicatorParity = 0;
      continue;
    }
    if (isRegionalIndicator(codePoint)) {
      if (regionalIndicatorParity === 0) count += 1;
      regionalIndicatorParity = regionalIndicatorParity === 0 ? 1 : 0;
      inWord = false;
      previousBaseWasSymbol = true;
      joinNextSymbol = false;
      continue;
    }
    regionalIndicatorParity = 0;
    if (isCjk(codePoint)) {
      count += 1;
      inWord = false;
      previousBaseWasSymbol = false;
      joinNextSymbol = false;
      continue;
    }
    if (isSymbol(codePoint)) {
      if (!joinNextSymbol) count += 1;
      inWord = false;
      previousBaseWasSymbol = true;
      joinNextSymbol = false;
      continue;
    }
    if (!isSeparatorOrPunctuation(codePoint)) {
      if (!inWord) count += 1;
      inWord = true;
      previousBaseWasSymbol = false;
      joinNextSymbol = false;
      continue;
    }
    inWord = false;
    previousBaseWasSymbol = false;
    joinNextSymbol = false;
  }
  return count;
}

function rawPunctuationPauseMs(text) {
  let total = 0;
  let group = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = Reflect.apply(STRING_CODE_POINT_AT, text, [index]);
    index += codePoint > 0xffff ? 2 : 1;
    if (isExtender(codePoint) || isEmojiTag(codePoint)) continue;
    let pause = 0;
    if (codePoint === 0x2e || codePoint === 0x21 || codePoint === 0x3f
      || codePoint === 0x3002 || codePoint === 0xff01 || codePoint === 0xff1f
      || codePoint === 0x2026 || codePoint === 0x0a) pause = 320;
    else if (codePoint === 0x2c || codePoint === 0xff0c || codePoint === 0x3001
      || codePoint === 0x3b || codePoint === 0xff1b || codePoint === 0x3a
      || codePoint === 0xff1a) pause = 180;
    if (pause > 0) {
      group = Math.max(group, pause);
    } else {
      total += group;
      group = 0;
    }
  }
  return total + group;
}

function estimate(text, speedPermille, pauseBeforeMs, pauseAfterMs, kind) {
  const units = spokenUnitCount(text);
  if (units < 1) invalid(kind);
  const articulationMs = Math.ceil(
    (units * 60_000 * 1000) / (BASE_UNITS_PER_MINUTE * speedPermille),
  );
  const punctuationPauseMs = Math.ceil((rawPunctuationPauseMs(text) * 1000) / speedPermille);
  const estimatedSpeechDurationMs = articulationMs + punctuationPauseMs;
  const estimatedTotalDurationMs = pauseBeforeMs + estimatedSpeechDurationMs + pauseAfterMs;
  if (estimatedTotalDurationMs > MAX_TOTAL_DURATION_MS) invalid(kind);
  return Object.freeze({
    spokenUnitCount: units,
    punctuationPauseMs,
    estimatedSpeechDurationMs,
    estimatedTotalDurationMs,
  });
}

function createDialogueDeliveryPlan(value) {
  const kind = 'input';
  const input = ownDataSnapshot(value, INPUT_KEYS, kind);
  if (
    input.schemaVersion !== '8.0'
    || input.timingAlgorithmVersion !== TIMING_ALGORITHM_VERSION
    || !includes(EMOTIONS, input.emotion)
  ) invalid(kind);
  const text = canonicalText(input.text, kind);
  const emotionIntensityPermille = boundedInteger(
    input.emotionIntensityPermille, 0, 1000, kind,
  );
  const speedPermille = boundedInteger(input.speedPermille, 500, 2000, kind);
  const pauseBeforeMs = boundedInteger(input.pauseBeforeMs, 0, 5000, kind);
  const pauseAfterMs = boundedInteger(input.pauseAfterMs, 0, 5000, kind);
  const timing = estimate(text, speedPermille, pauseBeforeMs, pauseAfterMs, kind);
  const textSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const timingParts = [
    TIMING_ALGORITHM_VERSION,
    textSha256,
    speedPermille,
    pauseBeforeMs,
    pauseAfterMs,
    timing.spokenUnitCount,
    timing.punctuationPauseMs,
    timing.estimatedSpeechDurationMs,
    timing.estimatedTotalDurationMs,
  ];
  const timingSha256 = createHash('sha256')
    .update(Reflect.apply(ARRAY_JOIN, timingParts, ['\n']), 'utf8')
    .digest('hex');
  return Object.freeze({
    schemaVersion: '8.0',
    timingAlgorithmVersion: TIMING_ALGORITHM_VERSION,
    uid: canonicalUid(input.uid, kind),
    dramaUid: canonicalUid(input.dramaUid, kind),
    scriptResultUid: canonicalUid(input.scriptResultUid, kind),
    shotId: sourceId(input.shotId, kind),
    dialogueEntryId: sourceId(input.dialogueEntryId, kind),
    characterUid: canonicalUid(input.characterUid, kind),
    voiceProfileUid: canonicalUid(input.voiceProfileUid, kind),
    text,
    textSha256,
    timingSha256,
    emotion: input.emotion,
    emotionIntensityPermille,
    speedPermille,
    pauseBeforeMs,
    pauseAfterMs,
    ...timing,
  });
}

function parseDialogueDeliveryPlan(value) {
  try {
    const stored = ownDataSnapshot(value, RECORD_KEYS, 'record');
    const input = Object.create(null);
    for (let index = 0; index < INPUT_KEYS.length; index += 1) {
      defineValue(input, INPUT_KEYS[index], stored[INPUT_KEYS[index]]);
    }
    const canonical = createDialogueDeliveryPlan(input);
    for (let index = 0; index < RECORD_KEYS.length; index += 1) {
      const key = RECORD_KEYS[index];
      if (canonical[key] !== stored[key]) invalid('record');
    }
    return canonical;
  } catch {
    invalid('record');
  }
}

module.exports = {
  EMOTIONS,
  TIMING_ALGORITHM_VERSION,
  createDialogueDeliveryPlan,
  parseDialogueDeliveryPlan,
};
