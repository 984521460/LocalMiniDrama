import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'

import {
  h3ExecutionIntentView,
  h3ProfileView,
  h3RealValidationMatrixView,
} from '../src/h3/contracts.js'

const PROFILE_UID = '70d4f190-d54d-4d27-9a45-c97807ea1b9d'

function profileFixture() {
  const model = (nodeType, inputName, fileName, sha256, bytes, digestStatus = 'verified') => ({
    nodeType, inputName, fileName, sha256, bytes, digestStatus,
  })
  return {
    schemaVersion: 'h3-profile.v1',
    uid: PROFILE_UID,
    profileId: 'minimax-h3-local-four-step-768p',
    revision: 1,
    engine: 'comfyui',
    modelFamily: 'minimax-h3',
    sourceRevision: '4cc1d817b6184899b41293954329f576cb5ae86b',
    fps: 24,
    frameGrid: { offset: 5, stride: 17, minimum: 5 },
    canvas: {
      multipleOf: 32,
      maximumLongEdge: 1344,
      maximumShortEdge: 768,
      maximumPixels: 1032192,
    },
    sampler: {
      steps: 4,
      samplerName: 'res_multistep',
      scheduler: 'simple',
      denoise: 1,
      loraStrength: 1,
    },
    models: {
      diffusion: model('UNETLoader', 'unet_name', 'diffusion.safetensors', 'a'.repeat(64), 10),
      textEncoder: model('CLIPLoader', 'clip_name', 'text.safetensors', 'b'.repeat(64), 11),
      videoVae: model('VAELoader', 'vae_name', 'video.safetensors', null, 12, 'historical-evidence-malformed'),
      audioVae: model('VAELoader', 'vae_name', 'audio.safetensors', 'c'.repeat(64), 13),
      turboLora: model('LoraLoaderModelOnly', 'lora_name', 'lora.safetensors', 'd'.repeat(64), 14),
    },
    modes: {
      t2v: {
        referenceImageRoles: [], minimumReferenceImages: 0, maximumReferenceImages: 0,
        nativeAudioOutput: true, realValidation: 'validated-rtx4090',
      },
      'fl2va-first': {
        referenceImageRoles: ['first'], minimumReferenceImages: 1, maximumReferenceImages: 1,
        nativeAudioOutput: true, realValidation: 'unverified',
      },
      'fl2va-first-last': {
        referenceImageRoles: ['first', 'last'], minimumReferenceImages: 2, maximumReferenceImages: 2,
        nativeAudioOutput: true, realValidation: 'unverified',
      },
      ref2va: {
        referenceImageRoles: ['reference'], minimumReferenceImages: 1, maximumReferenceImages: 4,
        nativeAudioOutput: true, realValidation: 'unverified',
      },
    },
  }
}

function matrixFixture() {
  const unverified = () => ({ status: 'unverified', measuredCases: [] })
  return {
    schemaVersion: 'h3-real-validation-matrix.v1',
    profileUid: PROFILE_UID,
    gpus: [
      {
        gpuClass: 'rtx4090-48gb',
        vramGiB: 48,
        modes: {
          t2v: {
            status: 'verified',
            measuredCases: [{
              caseId: 'h3-fight-15s', requestedSeconds: 15, width: 608, height: 352,
              fps: 24, frames: 362, videoCodec: 'h264', audioCodec: 'aac',
              outputSha256: 'e'.repeat(64), evidenceRef: 'phase-1:h3-fight-15s',
            }],
          },
          'fl2va-first': unverified(),
          'fl2va-first-last': unverified(),
          ref2va: unverified(),
        },
      },
      {
        gpuClass: 'rtx-pro-6000-blackwell-96gb',
        vramGiB: 96,
        modes: {
          t2v: unverified(),
          'fl2va-first': unverified(),
          'fl2va-first-last': unverified(),
          ref2va: unverified(),
        },
      },
    ],
  }
}

test('H3 frontend views preserve the exact local profile and validation evidence', () => {
  const profile = h3ProfileView(profileFixture())
  const matrix = h3RealValidationMatrixView(matrixFixture(), profile.uid)
  assert.equal(profile.modes.t2v.realValidation, 'validated-rtx4090')
  assert.equal(profile.models.videoVae.sha256, null)
  assert.equal(matrix.gpus[0].modes.t2v.measuredCases[0].frames, 362)
  assert(Object.isFrozen(profile))
  assert(Object.isFrozen(matrix.gpus))
})

test('H3 frontend views reject drift, forged verification, and extra fields', () => {
  assert.throws(() => h3ProfileView({ ...profileFixture(), apiKey: 'must-not-pass' }))
  const wrongDigest = profileFixture()
  wrongDigest.models.videoVae = { ...wrongDigest.models.videoVae, digestStatus: 'verified' }
  assert.throws(() => h3ProfileView(wrongDigest))

  const forged = matrixFixture()
  forged.gpus[1].modes.ref2va = { status: 'verified', measuredCases: [] }
  assert.throws(() => h3RealValidationMatrixView(forged, PROFILE_UID))
  assert.throws(() => h3RealValidationMatrixView(matrixFixture(), '00000000-0000-4000-8000-000000000000'))
})

test('H3 validation panel compiles as a standalone component', () => {
  const filename = path.resolve('src/components/h3/H3ValidationPanel.vue')
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [])
  assert.doesNotThrow(() => compileScript(parsed.descriptor, { id: 'h3-validation-panel' }))
  const compiled = compileTemplate({
    id: 'h3-validation-panel',
    filename,
    source: parsed.descriptor.template.content,
  })
  assert.deepEqual(compiled.errors, [])
})

test('H3 frontend intent view accepts only the secret-free durable identity projection', () => {
  const intent = {
    schemaVersion: 'h3-local-execution-intent.v1',
    uid: '10000000-0000-4000-8000-000000000001',
    taskUid: '10000000-0000-4000-8000-000000000002',
    generationRunUid: '10000000-0000-4000-8000-000000000003',
    historyUid: '10000000-0000-4000-8000-000000000004',
    assetUid: '10000000-0000-4000-8000-000000000005',
    manifestUid: '10000000-0000-4000-8000-000000000006',
    parentVersionUid: null,
    createdAtEpochMs: 0,
  }
  const view = h3ExecutionIntentView(intent)
  assert.deepEqual(view, intent)
  assert(Object.isFrozen(view))
  assert.throws(() => h3ExecutionIntentView({ ...intent, prompt: 'must-not-pass' }))
  assert.throws(() => h3ExecutionIntentView({ ...intent, createdAtEpochMs: -1 }))
})
