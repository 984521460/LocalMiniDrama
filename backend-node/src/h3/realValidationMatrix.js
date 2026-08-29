'use strict';

const {
  RTX_4090_GPU_CLASS,
  RTX_4090_VRAM_GIB,
  RTX_PRO_6000_GPU_CLASS,
  RTX_PRO_6000_VRAM_GIB,
} = require('./gpuClasses');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function unverified() {
  return { status: 'unverified', measuredCases: [] };
}

function phase7Case(caseId, outputSha256) {
  return {
    caseId,
    requestedSeconds: 1.625,
    width: 608,
    height: 352,
    fps: 24,
    frames: 39,
    videoCodec: 'h264',
    audioCodec: 'aac',
    outputSha256,
    evidenceRef: `phase-7:${caseId}`,
  };
}

const H3_REAL_VALIDATION_MATRIX = deepFreeze({
  schemaVersion: 'h3-real-validation-matrix.v1',
  profileUid: '70d4f190-d54d-4d27-9a45-c97807ea1b9d',
  gpus: [
    {
      gpuClass: RTX_4090_GPU_CLASS,
      vramGiB: RTX_4090_VRAM_GIB,
      modes: {
        t2v: {
          status: 'verified',
          measuredCases: [
            {
              caseId: 'h3-client-smoke',
              requestedSeconds: 0.2,
              width: 608,
              height: 352,
              fps: 24,
              frames: 5,
              videoCodec: 'h264',
              audioCodec: 'aac',
              outputSha256: 'd8d9af12a1ea45fe054308dd83ad7183421471fd3fbb534b54f7e10c425e29cf',
              evidenceRef: 'phase-1:h3-client-smoke',
            },
            {
              caseId: 'h3-fight-15s',
              requestedSeconds: 15,
              width: 608,
              height: 352,
              fps: 24,
              frames: 362,
              videoCodec: 'h264',
              audioCodec: 'aac',
              outputSha256: '4fc449c09f34efbe7955e056f4108ae36c469097f70e93480996f0a8fadd8ecf',
              evidenceRef: 'phase-1:h3-fight-15s',
            },
            phase7Case(
              'h3-real-t2v',
              '49aa825a1f8c20e5c3a71038ec795aa28ec2fab3e07a14eb316ee632f462f525',
            ),
          ],
        },
        'fl2va-first': {
          status: 'verified',
          measuredCases: [phase7Case(
            'h3-real-fl2va-first',
            '63cb57efe4cb466c3ce8b479a1239aff510baa63891959cabf1bdcf4b94e8f9a',
          )],
        },
        'fl2va-first-last': {
          status: 'verified',
          measuredCases: [phase7Case(
            'h3-real-fl2va-first-last',
            'd65c380d207d5a35ef484af2135b0fbbac0df95230f00f4cad53efd4272537ae',
          )],
        },
        ref2va: {
          status: 'verified',
          measuredCases: [phase7Case(
            'h3-real-ref2va',
            '7fa3e5f46c95a06c6f144afd4663425c1a1af2c2a5f28974f4fb7baab86d3033',
          )],
        },
      },
    },
    {
      gpuClass: RTX_PRO_6000_GPU_CLASS,
      vramGiB: RTX_PRO_6000_VRAM_GIB,
      modes: {
        t2v: unverified(),
        'fl2va-first': unverified(),
        'fl2va-first-last': unverified(),
        ref2va: unverified(),
      },
    },
  ],
});

module.exports = Object.freeze({ H3_REAL_VALIDATION_MATRIX });
