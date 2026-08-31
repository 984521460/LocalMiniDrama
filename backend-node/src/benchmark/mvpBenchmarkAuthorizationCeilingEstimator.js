'use strict';

const { types: { isProxy } } = require('node:util');

const {
  MvpBenchmarkExecutionPreflightError,
} = require('./mvpBenchmarkExecutionPreflight');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAXIMUM_COST_CNY_FEN = 1_000_000;
const MVP_BENCHMARK_AUTHORIZATION_CEILING_POLICY_UID =
  '3ae021eb-88b8-4f02-a597-e93308861020';

function fail() {
  throw new MvpBenchmarkExecutionPreflightError(
    'MVP_BENCHMARK_EXECUTION_PREFLIGHT_UNAVAILABLE',
  );
}

function exactInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail();
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail();
  }
  const keys = ['authorizationUid', 'attestationUid', 'itemUid', 'requestSha256'];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== keys.length) fail();
  const output = Object.create(null);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = descriptors[keys[index]];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    output[keys[index]] = descriptor.value;
  }
  if (!UUID_V4.test(output.authorizationUid) || !UUID_V4.test(output.attestationUid)
    || !UUID_V4.test(output.itemUid) || !SHA256.test(output.requestSha256)) fail();
  return output;
}

function capturedRepositories(value) {
  if (!value || typeof value !== 'object' || isProxy(value)) {
    throw new TypeError('MVP benchmark cost estimator configuration is invalid');
  }
  const authorizations = Object.getOwnPropertyDescriptor(
    value, 'mvpBenchmarkExternalAuthorizations',
  )?.value;
  const sessions = Object.getOwnPropertyDescriptor(value, 'mvpBenchmarkSessions')?.value;
  const getAuthorization = authorizations
    && Object.getOwnPropertyDescriptor(authorizations, 'get')?.value;
  const getSession = sessions && Object.getOwnPropertyDescriptor(sessions, 'get')?.value;
  if (!authorizations || !sessions || typeof getAuthorization !== 'function'
    || typeof getSession !== 'function' || isProxy(getAuthorization) || isProxy(getSession)) {
    throw new TypeError('MVP benchmark cost estimator configuration is invalid');
  }
  return Object.freeze({ authorizations, getAuthorization, sessions, getSession });
}

function createMvpBenchmarkAuthorizationCeilingEstimator({ repositories } = {}) {
  const captured = capturedRepositories(repositories);

  function estimate(itemKind, value) {
    const input = exactInput(value);
    let authorization;
    let session;
    try {
      authorization = Reflect.apply(
        captured.getAuthorization, captured.authorizations, [input.authorizationUid],
      );
      session = Reflect.apply(captured.getSession, captured.sessions, [authorization.sessionUid]);
    } catch {
      return fail();
    }
    const h3Length = session?.h3Tasks?.length;
    const ttsLength = session?.audioIntents?.length;
    const maximum = authorization?.maximumCostCnyFen;
    if (!Number.isSafeInteger(h3Length) || h3Length < 1 || h3Length > 64
      || !Number.isSafeInteger(ttsLength) || ttsLength < 1 || ttsLength > 64
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAXIMUM_COST_CNY_FEN) fail();
    const totalItems = h3Length + ttsLength;
    let matchedIndex = -1;
    let matches = 0;
    for (let index = 0; index < h3Length; index += 1) {
      const item = session.h3Tasks[index];
      if (itemKind === 'h3' && item?.taskUid === input.itemUid
        && item.planEvidenceSha256 === input.requestSha256) {
        matchedIndex = index;
        matches += 1;
      }
    }
    for (let index = 0; index < ttsLength; index += 1) {
      const item = session.audioIntents[index];
      if (itemKind === 'tts' && item?.intentUid === input.itemUid
        && item.planSha256 === input.requestSha256) {
        matchedIndex = h3Length + index;
        matches += 1;
      }
    }
    if (matches !== 1 || matchedIndex < 0) fail();
    const base = Math.floor(maximum / totalItems);
    const remainder = maximum % totalItems;
    return Object.freeze({
      estimatedCostCnyFen: base + (matchedIndex < remainder ? 1 : 0),
      policyUid: MVP_BENCHMARK_AUTHORIZATION_CEILING_POLICY_UID,
    });
  }

  return Object.freeze({
    estimateH3: async (value) => estimate('h3', value),
    estimateTts: async (value) => estimate('tts', value),
  });
}

module.exports = Object.freeze({
  MVP_BENCHMARK_AUTHORIZATION_CEILING_POLICY_UID,
  createMvpBenchmarkAuthorizationCeilingEstimator,
});
