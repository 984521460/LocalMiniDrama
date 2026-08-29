'use strict';

const { sha256Canonical, snapshot } = require('./contract');
const { fail } = require('./errors');

const CODE = 'H3_REAL_VALIDATION_INVALID';
const H3_PHASE_7_ENVIRONMENT_SHA256 =
  '541f91c78fedfd097abb6eced612fdcf916e8472fdccbb19b0097b90390c39f8';
const ENVIRONMENT_LIMITS = Object.freeze({
  maxArrayLength: 32,
  maxDepth: 8,
  maxEntries: 256,
  maxStringBytes: 1024,
  maxTotalBytes: 64 * 1024,
});

function validateH3RealGpuEnvironment(value) {
  const environment = snapshot(value, CODE, ENVIRONMENT_LIMITS);
  if (sha256Canonical(environment) !== H3_PHASE_7_ENVIRONMENT_SHA256) fail(CODE);
  return environment;
}

module.exports = Object.freeze({
  H3_PHASE_7_ENVIRONMENT_SHA256,
  validateH3RealGpuEnvironment,
});
