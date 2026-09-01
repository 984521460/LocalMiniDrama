'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const Ajv = require('ajv/dist/2020');

const schema = require(path.resolve(
  __dirname,
  '../../schemas/v9/narrative-execution-request.schema.json',
));
const {
  NarrativeExecutionRequestError,
  canonicalNarrativeExecutionRequest,
  narrativeExecutionRequestSha256,
  parseNarrativeExecutionRequest,
  parseNarrativeExecutionRequestJson,
} = require('../src/narrative/execution/request');

const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

function uid(suffix) {
  return `10000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
}

function request(resultType, overrides = {}) {
  return {
    schemaVersion: 'narrative-execution-request.v1',
    operationUid: uid(1),
    dramaUid: uid(2),
    sourceSelectionUid: uid(3),
    resultType,
    upstreamResultUid: resultType === 'extraction' ? null : uid(4),
    upstreamResultHash: resultType === 'extraction' ? null : 'a'.repeat(64),
    upstreamEnvelopeHash: resultType === 'extraction' ? null : 'b'.repeat(64),
    upstreamApprovalRef: resultType === 'extraction' ? null : `review:v1:${uid(6)}`,
    durationBudget: resultType === 'adaptation'
      ? { targetSeconds: 60, toleranceSeconds: 5 } : null,
    style: resultType === 'adaptation'
      ? { genre: 'historical', tone: 'tense', audience: 'general' } : null,
    assetVersions: resultType === 'shot' ? [{
      assetVersionRef: `asset-version:v1:${uid(5)}`,
      assetType: 'character',
      bindingRef: 'character-hero',
    }] : [],
    ...overrides,
  };
}

test('narrative execution request runtime and Schema accept four exact task variants', () => {
  for (const resultType of ['extraction', 'adaptation', 'script', 'shot']) {
    const parsed = parseNarrativeExecutionRequest(request(resultType));
    assert.equal(parsed.resultType, resultType);
    assert.equal(validate(parsed), true, JSON.stringify(validate.errors));
    const canonical = canonicalNarrativeExecutionRequest(parsed);
    assert.deepEqual(parseNarrativeExecutionRequestJson(canonical), parsed);
    assert.match(narrativeExecutionRequestSha256(parsed), /^[0-9a-f]{64}$/u);
  }
});

test('narrative execution request rejects cross-variant fields and coordinated JSON drift', () => {
  const cases = [
    request('extraction', { upstreamResultUid: uid(4) }),
    request('adaptation', { upstreamResultHash: null }),
    request('adaptation', { durationBudget: null }),
    request('script', { assetVersions: request('shot').assetVersions }),
    request('shot', { style: { genre: 'x', tone: 'y', audience: 'z' } }),
    request('shot', { assetVersions: [request('shot').assetVersions[0], request('shot').assetVersions[0]] }),
  ];
  for (const value of cases) {
    assert.throws(() => parseNarrativeExecutionRequest(value), NarrativeExecutionRequestError);
    assert.equal(validate(value), false);
  }
  const unicode = request('adaptation', {
    style: { genre: '古装悬疑', tone: '紧张😀', audience: '成年观众' },
  });
  assert.equal(validate(parseNarrativeExecutionRequest(unicode)), true, JSON.stringify(validate.errors));
  for (const style of [
    { genre: ' leading', tone: 'tense', audience: 'general' },
    { genre: '\ud800', tone: 'tense', audience: 'general' },
    { genre: '😀'.repeat(129), tone: 'tense', audience: 'general' },
  ]) {
    const value = request('adaptation', { style });
    assert.throws(() => parseNarrativeExecutionRequest(value), NarrativeExecutionRequestError);
    assert.equal(validate(value), false);
  }
  const valid = parseNarrativeExecutionRequest(request('extraction'));
  assert.throws(
    () => parseNarrativeExecutionRequestJson(` ${JSON.stringify(valid)}`),
    NarrativeExecutionRequestError,
  );
});

test('narrative execution request rejects Proxy/accessors without executing traps', () => {
  let rootReads = 0;
  const proxy = new Proxy(request('extraction'), {
    ownKeys() { rootReads += 1; throw new Error('root-sentinel'); },
  });
  assert.throws(() => parseNarrativeExecutionRequest(proxy), NarrativeExecutionRequestError);
  assert.equal(rootReads, 0);

  let getterReads = 0;
  const hostile = request('adaptation');
  Object.defineProperty(hostile.style, 'tone', {
    enumerable: true,
    get() { getterReads += 1; throw new Error('getter-sentinel'); },
  });
  assert.throws(() => parseNarrativeExecutionRequest(hostile), NarrativeExecutionRequestError);
  assert.equal(getterReads, 0);
});

test('narrative execution canonicalization does not execute inherited JSON hooks', () => {
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const joinDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'join');
  const stringifyDescriptor = Object.getOwnPropertyDescriptor(JSON, 'stringify');
  let reads = 0;
  let stringifyCalls = 0;
  const results = [];
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { reads += 1; throw new Error('object toJSON must not run'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { reads += 1; throw new Error('array toJSON must not run'); },
    });
    Object.defineProperty(Array.prototype, 'join', {
      configurable: true,
      get() { reads += 1; throw new Error('array join must not run'); },
    });
    Object.defineProperty(JSON, 'stringify', {
      configurable: true,
      value() { stringifyCalls += 1; throw new Error('polluted stringify must not run'); },
    });
    for (const resultType of ['extraction', 'adaptation', 'script', 'shot']) {
      const canonical = canonicalNarrativeExecutionRequest(request(resultType));
      results.push({
        parsedType: parseNarrativeExecutionRequestJson(canonical).resultType,
        resultType,
        sha256: narrativeExecutionRequestSha256(request(resultType)),
      });
    }
  } finally {
    if (objectDescriptor) Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
    else delete Object.prototype.toJSON;
    if (arrayDescriptor) Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    else delete Array.prototype.toJSON;
    Object.defineProperty(Array.prototype, 'join', joinDescriptor);
    Object.defineProperty(JSON, 'stringify', stringifyDescriptor);
  }
  for (const result of results) {
    assert.equal(result.parsedType, result.resultType);
    assert.match(result.sha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(reads, 0);
  assert.equal(stringifyCalls, 0);
});
