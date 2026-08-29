'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Ajv2020 = require('ajv/dist/2020');

const { H3_REAL_VALIDATION_MATRIX } = require('../src/h3');

test('H3 real-validation matrix preserves measured 4090 evidence and explicit GPU gaps', () => {
  const schema = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../schemas/v7/h3-real-validation-matrix.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(H3_REAL_VALIDATION_MATRIX), true, JSON.stringify(validate.errors));
  const rtx4090 = H3_REAL_VALIDATION_MATRIX.gpus.find(({ gpuClass }) => gpuClass === 'rtx4090-24gb');
  const pro6000 = H3_REAL_VALIDATION_MATRIX.gpus.find(
    ({ gpuClass }) => gpuClass === 'rtx-pro-6000-blackwell-96gb',
  );
  assert.equal(rtx4090.modes.t2v.status, 'verified');
  assert.equal(rtx4090.vramGiB, 24);
  assert.deepEqual(rtx4090.modes.t2v.measuredCases.map(({ width, height, frames }) => (
    { width, height, frames }
  )), [
    { width: 608, height: 352, frames: 5 },
    { width: 608, height: 352, frames: 362 },
    { width: 608, height: 352, frames: 39 },
  ]);
  for (const mode of ['fl2va-first', 'fl2va-first-last', 'ref2va']) {
    assert.equal(rtx4090.modes[mode].status, 'verified');
    assert.equal(rtx4090.modes[mode].measuredCases.length, 1);
    assert.equal(rtx4090.modes[mode].measuredCases[0].frames, 39);
    assert.match(rtx4090.modes[mode].measuredCases[0].evidenceRef, /^phase-7:/u);
  }
  for (const value of Object.values(pro6000.modes)) {
    assert.equal(value.status, 'unverified');
    assert.deepEqual(value.measuredCases, []);
  }
  const forgedEmptyVerification = structuredClone(H3_REAL_VALIDATION_MATRIX);
  forgedEmptyVerification.gpus[1].modes.ref2va.status = 'verified';
  assert.equal(validate(forgedEmptyVerification), false);
  const unverifiedWithEvidence = structuredClone(H3_REAL_VALIDATION_MATRIX);
  unverifiedWithEvidence.gpus[1].modes.ref2va.measuredCases = [
    structuredClone(rtx4090.modes.t2v.measuredCases[0]),
  ];
  assert.equal(validate(unverifiedWithEvidence), false);
  const measuredCases = H3_REAL_VALIDATION_MATRIX.gpus[0].modes.t2v.measuredCases;
  const invalidMeasuredCases = [
    measuredCases.slice(1),
    [...measuredCases, structuredClone(measuredCases[0])],
    measuredCases.map((value, index) => (index === 0 ? { ...value, caseId: 'fabricated-case' } : value)),
    measuredCases.map((value, index) => (index === 2 ? { ...value, outputSha256: '0'.repeat(64) } : value)),
    [...measuredCases].reverse(),
  ];
  for (const replacement of invalidMeasuredCases) {
    const drifted = structuredClone(H3_REAL_VALIDATION_MATRIX);
    drifted.gpus[0].modes.t2v.measuredCases = structuredClone(replacement);
    assert.equal(validate(drifted), false);
  }
  assert.equal(Object.isFrozen(H3_REAL_VALIDATION_MATRIX.gpus), true);
});
