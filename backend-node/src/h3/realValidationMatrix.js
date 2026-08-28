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
          ],
        },
        'fl2va-first': unverified(),
        'fl2va-first-last': unverified(),
        ref2va: unverified(),
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
