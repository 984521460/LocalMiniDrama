'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
  MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
} = require('./mvpBenchmarkApprovedEnvironment');

const SEED_SCHEMA_VERSION = 'mvp-benchmark-operator-attestation-seed.v1';
const ATTESTATION_SCHEMA_VERSION = 'mvp-benchmark-operator-attestation.v1';
const LICENSE_ID = 'MiniMax-H3-Community-License-Agreement';
const LICENSE_SOURCE_REVISION = '42ed227ee7df40d41602854ae760620d6eb651fe';
const COMMERCIAL_ELIGIBILITY_BASES = Object.freeze([
  'annual-revenue-not-over-usd-20000000',
  'written-minimax-authorization',
]);
const SEED_KEYS = Object.freeze([
  'schemaVersion',
  'territoryEligibilityConfirmed',
  'commercialEligibilityBasis',
  'commercialUiAttributionAccepted',
  'acceptableUseAndSafeguardsAccepted',
  'downstreamUseRestrictionsAccepted',
  'publicAiContentDisclosureAccepted',
  'benchmarkInputRightsConfirmed',
]);
const ATTESTATION_KEYS = Object.freeze([
  'schemaVersion',
  'licenseId',
  'licenseSourceRevision',
  'requiredEnvironmentSha256',
  'territoryEligibilityConfirmed',
  'commercialEligibilityBasis',
  'commercialUiAttributionAccepted',
  'acceptableUseAndSafeguardsAccepted',
  'downstreamUseRestrictionsAccepted',
  'publicAiContentDisclosureAccepted',
  'benchmarkInputRightsConfirmed',
  'attestationSha256',
]);
const ARRAY_IS_ARRAY = Array.isArray;
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const SHA256 = /^[0-9a-f]{64}$/u;
const REFLECT_REGEXP_TEST = RegExp.prototype.test;

class MvpBenchmarkOperatorAttestationError extends Error {
  constructor(code) {
    const messages = {
      MVP_BENCHMARK_OPERATOR_ATTESTATION_DATA_INVALID:
        'MVP benchmark operator attestation data is invalid',
      MVP_BENCHMARK_OPERATOR_ATTESTATION_INPUT_INVALID:
        'MVP benchmark operator attestation input is invalid',
    };
    super(messages[code] ?? messages.MVP_BENCHMARK_OPERATOR_ATTESTATION_INPUT_INVALID);
    this.name = 'MvpBenchmarkOperatorAttestationError';
    this.code = code;
  }
}

function fail(code) {
  throw new MvpBenchmarkOperatorAttestationError(code);
}

function exactObject(value, keys, code) {
  try {
    if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) fail(code);
    const prototype = REFLECT_APPLY(OBJECT_GET_PROTOTYPE_OF, Object, [value]);
    const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
    const actualKeys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]);
    if ((prototype !== Object.prototype && prototype !== null)
      || actualKeys.length !== keys.length) fail(code);
    const output = REFLECT_APPLY(OBJECT_CREATE, Object, [null]);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptors, key])) fail(code);
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable
        || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) fail(code);
      REFLECT_APPLY(OBJECT_DEFINE_PROPERTY, Object, [output, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      }]);
    }
    return output;
  } catch (error) {
    if (error instanceof MvpBenchmarkOperatorAttestationError) throw error;
    return fail(code);
  }
}

function eligibilityBasis(value, code) {
  for (let index = 0; index < COMMERCIAL_ELIGIBILITY_BASES.length; index += 1) {
    if (value === COMMERCIAL_ELIGIBILITY_BASES[index]) return value;
  }
  return fail(code);
}

function confirmed(value, code) {
  if (value !== true) fail(code);
  return true;
}

function sha256(value, code) {
  if (typeof value !== 'string'
    || !REFLECT_APPLY(REFLECT_REGEXP_TEST, SHA256, [value])) fail(code);
  return value;
}

function serializeMvpBenchmarkOperatorAttestationJson(value) {
  if (typeof value === 'string') return REFLECT_APPLY(JSON_STRINGIFY, JSON, [value]);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (!value || typeof value !== 'object' || ARRAY_IS_ARRAY(value) || isProxy(value)) {
    throw new TypeError('MVP benchmark operator attestation JSON is invalid');
  }
  const descriptors = REFLECT_APPLY(OBJECT_GET_OWN_PROPERTY_DESCRIPTORS, Object, [value]);
  const keys = REFLECT_APPLY(REFLECT_OWN_KEYS, Reflect, [descriptors]);
  let output = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor?.enumerable
      || !REFLECT_APPLY(OBJECT_HAS_OWN, Object, [descriptor, 'value'])) {
      throw new TypeError('MVP benchmark operator attestation JSON is invalid');
    }
    if (index > 0) output += ',';
    output += `${REFLECT_APPLY(JSON_STRINGIFY, JSON, [key])}:${serializeMvpBenchmarkOperatorAttestationJson(descriptor.value)}`;
  }
  return `${output}}`;
}

function digest(value) {
  return createHash('sha256')
    .update(serializeMvpBenchmarkOperatorAttestationJson(value), 'utf8')
    .digest('hex');
}

function parseMvpBenchmarkOperatorAttestationSeed(
  value,
  code = 'MVP_BENCHMARK_OPERATOR_ATTESTATION_INPUT_INVALID',
) {
  const input = exactObject(value, SEED_KEYS, code);
  if (input.schemaVersion !== SEED_SCHEMA_VERSION) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: SEED_SCHEMA_VERSION,
    territoryEligibilityConfirmed: confirmed(input.territoryEligibilityConfirmed, code),
    commercialEligibilityBasis: eligibilityBasis(input.commercialEligibilityBasis, code),
    commercialUiAttributionAccepted: confirmed(input.commercialUiAttributionAccepted, code),
    acceptableUseAndSafeguardsAccepted: confirmed(
      input.acceptableUseAndSafeguardsAccepted,
      code,
    ),
    downstreamUseRestrictionsAccepted: confirmed(input.downstreamUseRestrictionsAccepted, code),
    publicAiContentDisclosureAccepted: confirmed(input.publicAiContentDisclosureAccepted, code),
    benchmarkInputRightsConfirmed: confirmed(input.benchmarkInputRightsConfirmed, code),
  });
}

function baseAttestation(value, code) {
  const input = exactObject(value, ATTESTATION_KEYS, code);
  if (input.schemaVersion !== ATTESTATION_SCHEMA_VERSION
    || input.licenseId !== LICENSE_ID
    || input.licenseSourceRevision !== LICENSE_SOURCE_REVISION
    || input.requiredEnvironmentSha256 !== MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256) fail(code);
  return OBJECT_FREEZE({
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    licenseId: input.licenseId,
    licenseSourceRevision: input.licenseSourceRevision,
    requiredEnvironmentSha256: input.requiredEnvironmentSha256,
    territoryEligibilityConfirmed: confirmed(input.territoryEligibilityConfirmed, code),
    commercialEligibilityBasis: eligibilityBasis(input.commercialEligibilityBasis, code),
    commercialUiAttributionAccepted: confirmed(input.commercialUiAttributionAccepted, code),
    acceptableUseAndSafeguardsAccepted: confirmed(
      input.acceptableUseAndSafeguardsAccepted,
      code,
    ),
    downstreamUseRestrictionsAccepted: confirmed(input.downstreamUseRestrictionsAccepted, code),
    publicAiContentDisclosureAccepted: confirmed(input.publicAiContentDisclosureAccepted, code),
    benchmarkInputRightsConfirmed: confirmed(input.benchmarkInputRightsConfirmed, code),
    attestationSha256: sha256(input.attestationSha256, code),
  });
}

function createMvpBenchmarkOperatorAttestation(
  value,
  code = 'MVP_BENCHMARK_OPERATOR_ATTESTATION_INPUT_INVALID',
) {
  const seed = parseMvpBenchmarkOperatorAttestationSeed(value, code);
  const placeholder = baseAttestation({
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    licenseId: LICENSE_ID,
    licenseSourceRevision: LICENSE_SOURCE_REVISION,
    requiredEnvironmentSha256: MVP_BENCHMARK_APPROVED_ENVIRONMENT_SHA256,
    territoryEligibilityConfirmed: seed.territoryEligibilityConfirmed,
    commercialEligibilityBasis: seed.commercialEligibilityBasis,
    commercialUiAttributionAccepted: seed.commercialUiAttributionAccepted,
    acceptableUseAndSafeguardsAccepted: seed.acceptableUseAndSafeguardsAccepted,
    downstreamUseRestrictionsAccepted: seed.downstreamUseRestrictionsAccepted,
    publicAiContentDisclosureAccepted: seed.publicAiContentDisclosureAccepted,
    benchmarkInputRightsConfirmed: seed.benchmarkInputRightsConfirmed,
    attestationSha256: '0'.repeat(64),
  }, code);
  return OBJECT_FREEZE({ ...placeholder, attestationSha256: digest(placeholder) });
}

function parseMvpBenchmarkOperatorAttestation(
  value,
  code = 'MVP_BENCHMARK_OPERATOR_ATTESTATION_DATA_INVALID',
) {
  const parsed = baseAttestation(value, code);
  const placeholder = OBJECT_FREEZE({ ...parsed, attestationSha256: '0'.repeat(64) });
  if (parsed.attestationSha256 !== digest(placeholder)) fail(code);
  return parsed;
}

function isMvpBenchmarkOperatorAttestationError(error) {
  return error instanceof MvpBenchmarkOperatorAttestationError;
}

module.exports = OBJECT_FREEZE({
  ATTESTATION_SCHEMA_VERSION,
  COMMERCIAL_ELIGIBILITY_BASES,
  LICENSE_ID,
  LICENSE_SOURCE_REVISION,
  MvpBenchmarkOperatorAttestationError,
  SEED_SCHEMA_VERSION,
  createMvpBenchmarkOperatorAttestation,
  isMvpBenchmarkOperatorAttestationError,
  parseMvpBenchmarkOperatorAttestation,
  parseMvpBenchmarkOperatorAttestationSeed,
  serializeMvpBenchmarkOperatorAttestationJson,
});
